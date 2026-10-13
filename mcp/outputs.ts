import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { asset, decode, hashBytes, LIMITS, uuid, verifyBytes, type Asset } from '../src/protocol.js'
import type { OutboxJob } from '../src/core.js'
import { McpError, resourceURI, unavailable, type PublicFile } from './contracts.js'
import { McpState, openDirectory } from './state.js'

interface Expected extends Asset { path: string }
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
      return { ...metadata, path: resolve(folder, metadata.name) }
    }),
    ...(job.result.output_assets ?? []).map(a => {
      const metadata = asset(a)
      return { ...metadata, path: resolve(folder, metadata.asset_id, metadata.name) }
    }),
  ]
}

/** Native resources expose only verified, known completed-job assets. */
export class McpOutputs {
  constructor(private readonly state: McpState, private readonly root: string) {}
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
}
