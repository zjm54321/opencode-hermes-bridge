import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { asset, decode, hashBytes, LIMITS, uuid, verifyBytes, type Asset } from '../src/protocol.js'
import type { OutboxJob } from '../src/core.js'
import { McpError, resourceURI, unavailable, type PublicFile } from './contracts.js'
import { McpState, openDirectory, type CapabilityRecord } from './state.js'

interface Expected extends Asset { kind: 'inline' | 'asset'; path: string }
function inlineID(jobId: string, name: string): string {
  const hash = hashBytes(Buffer.from(JSON.stringify([jobId, name])))
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
function expectedOutputs(root: string, job: OutboxJob): Expected[] {
  if (job.status !== 'completed' || job.result?.status !== 'completed') return []
  const folder = resolve(root, uuid(job.id))
  return [
    ...job.result.attachments.map(a => {
      const bytes = decode(a.base64)
      const metadata = asset({ asset_id: inlineID(job.id, a.name), name: a.name, mime: a.mime, size: bytes.length, sha256: hashBytes(bytes) })
      return { ...metadata, kind: 'inline' as const, path: resolve(folder, metadata.name) }
    }),
    ...(job.result.output_assets ?? []).map(a => {
      const metadata = asset(a)
      return { ...metadata, kind: 'asset' as const, path: resolve(folder, metadata.asset_id, metadata.name) }
    }),
  ]
}

/** Public capabilities authorize only an immutable, known completed-job asset. */
export class McpOutputs {
  constructor(private readonly state: McpState, private readonly root: string,
    private readonly publicOrigin: string, private readonly ttlSeconds: number, private readonly httpDownloads = false) {}
  private publicFile(c: CapabilityRecord, capability: string): PublicFile {
    return { ...asset(c), uri: resourceURI(c.jobId, c.asset_id), url: `${this.publicOrigin}/files/${capability}`, expires_at: c.expiresAt }
  }
  descriptors(jobId: string): PublicFile[] {
    this.state.assertReady()
    const job = this.state.snapshot().coreOutbox.jobs[jobId]
    return job ? expectedOutputs(this.root, job).map(a => ({ ...asset(a), uri: resourceURI(jobId, a.asset_id) })) : []
  }
  async readResource(jobId: string, assetId: string): Promise<{ mimeType: string; bytes: Uint8Array }> {
    this.state.assertReady()
    const job = this.state.snapshot().coreOutbox.jobs[jobId]
    const expected = job && expectedOutputs(this.root, job).find(a => a.asset_id.toLowerCase() === assetId)
    if (!expected) throw new McpError(404, 'not_found', 'Resource not found')
    return { mimeType: expected.mime, bytes: await this.read(expected) }
  }
  private async read(expected: Expected): Promise<Uint8Array> {
    if (expected.size > LIMITS.file) throw unavailable()
    const directory = await openDirectory(dirname(expected.path))
    try {
      const folder = await directory.stat()
      if (folder.uid !== process.getuid?.() || (folder.mode & 0o777) !== 0o700) throw unavailable()
      const local = `/proc/self/fd/${directory.fd}/${expected.name}`
      const file = await open(local, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const before = await file.stat()
        if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size !== expected.size) throw unavailable()
        const buffer = Buffer.alloc(expected.size + 1)
        let size = 0
        while (size < buffer.length) {
          const read = await file.read(buffer, size, buffer.length - size, size)
          if (!read.bytesRead) break
          size += read.bytesRead
        }
        const [after, pathStat, location] = await Promise.all([file.stat(), lstat(local), realpath(`/proc/self/fd/${file.fd}`)])
        if (location !== expected.path || !pathStat.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino
            || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw unavailable()
        const bytes = buffer.subarray(0, size)
        verifyBytes(expected, bytes)
        // Re-walk the public pathname as well, catching a replaced parent component.
        const current = await openDirectory(dirname(expected.path))
        try {
          const now = await current.stat()
          if (now.dev !== folder.dev || now.ino !== folder.ino) throw unavailable()
        } finally { await current.close() }
        return bytes
      } finally { await file.close() }
    } finally { await directory.close() }
  }
  async issue(jobId: string): Promise<PublicFile[]> {
    this.state.assertReady()
    if (!this.httpDownloads) return this.descriptors(jobId)
    const envelope = this.state.snapshot(), job = envelope.coreOutbox.jobs[jobId]
    if (!job) throw unavailable()
    const expected = expectedOutputs(this.root, job)
    const records: Record<string, CapabilityRecord> = {}, files: PublicFile[] = []
    for (const a of expected) {
      await this.read(a)
      const capability = randomBytes(32).toString('base64url')
      const c: CapabilityRecord = { ...a, owner: this.state.owner, jobId, expiresAt: Date.now() + this.ttlSeconds * 1000 }
      records[hashBytes(Buffer.from(capability))] = c
      files.push(this.publicFile(c, capability))
    }
    if (files.length) await this.state.addCapabilities(records)
    return files
  }
  async download(capability: string): Promise<{ file: PublicFile; bytes: Uint8Array }> {
    this.state.assertReady()
    if (!this.httpDownloads) throw new McpError(404, 'not_found', 'File not found')
    if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new McpError(404, 'not_found', 'File not found')
    const envelope = this.state.snapshot(), c = envelope.capabilities[hashBytes(Buffer.from(capability))]
    if (!c || c.owner !== this.state.owner) throw new McpError(404, 'not_found', 'File not found')
    if (c.expiresAt <= Date.now()) throw new McpError(410, 'expired', 'Download link expired; request the result again')
    const job = envelope.coreOutbox.jobs[c.jobId]
    const expected = job && expectedOutputs(this.root, job).find(a => a.asset_id === c.asset_id && a.kind === c.kind)
    if (!expected || expected.path !== c.path || expected.name !== c.name || expected.mime !== c.mime
        || expected.size !== c.size || expected.sha256 !== c.sha256) throw new McpError(410, 'unavailable_file', 'File is no longer available')
    try {
      const bytes = await this.read(expected)
      if (c.expiresAt <= Date.now()) throw new McpError(410, 'expired', 'Download link expired; request the result again')
      return { file: this.publicFile(c, capability), bytes }
    } catch (error) {
      if (error instanceof McpError && error.code === 'expired') throw error
      throw new McpError(410, 'unavailable_file', 'File is no longer available')
    }
  }
}
