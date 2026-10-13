import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { OutboxJob, Storage } from '../src/core.js'
import { record, uuid } from '../src/protocol.js'
import { McpError, unavailable } from './contracts.js'

export const MAX_STATE_BYTES = 128 * 1024 ** 2
export const MAX_JOBS = 256
const uid = () => process.getuid?.()
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

/** Walk from a held parent descriptor, never following a path-component symlink. */
export async function openDirectory(path: string, create = false): Promise<FileHandle> {
  if (!isAbsolute(path) || path.includes('\0') || path.split(sep).includes('..')) throw unavailable()
  let current = await open(sep, directoryFlags)
  try {
    for (const part of resolve(path).split(sep).filter(Boolean)) {
      const child = `/proc/self/fd/${current.fd}/${part}`
      let next: FileHandle
      try { next = await open(child, directoryFlags) } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await mkdir(child, { mode: 0o700 })
        await current.sync()
        next = await open(child, directoryFlags)
      }
      await current.close()
      current = next
    }
    if (await realpath(`/proc/self/fd/${current.fd}`) !== resolve(path)) throw unavailable()
    return current
  } catch (error) { await current.close(); throw error }
}

export async function privateDirectory(path: string): Promise<FileHandle> {
  const handle = await openDirectory(path, true)
  const stat = await handle.stat()
  if (stat.uid !== uid() || (stat.mode & 0o777) !== 0o700) { await handle.close(); throw unavailable() }
  return handle
}

export interface CoreOutbox { version: 1; threads: Record<string, string>; jobs: Record<string, OutboxJob> }
export interface ThreadRecord { owner: string; sessionID: string }
export interface RequestRecord { owner: string; fingerprint: string; threadId: string; jobId: string }
export interface Envelope {
  version: 1; owner: string; coreOutbox: CoreOutbox
  threads: Record<string, ThreadRecord>; requests: Record<string, RequestRecord>
}
interface Admission { requestId: string; fingerprint: string; threadId: string; sessionID: string }
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function validate(value: unknown, owner: string): Envelope {
  const e = record(value)
  if (e.version !== 1 || e.owner !== owner) throw unavailable()
  const core = record(e.coreOutbox)
  if (core.version !== 1 || Object.keys(record(core.jobs)).length > MAX_JOBS) throw unavailable()
  const threads = record(e.threads), requests = record(e.requests)
  if (Object.keys(threads).length > MAX_JOBS || Object.keys(requests).length > MAX_JOBS) throw unavailable()
  const sessions = record(core.threads)
  for (const [id, raw] of Object.entries(threads)) {
    const thread = record(raw)
    if (uuid(id) !== id || thread.owner !== owner || thread.sessionID !== `${owner}:${id}`) throw unavailable()
    uuid(sessions[String(thread.sessionID)])
  }
  const mapped = new Set<string>()
  for (const [id, raw] of Object.entries(requests)) {
    const r = record(raw), thread = record(threads[uuid(r.threadId)]), job = record(record(core.jobs)[uuid(r.jobId)])
    if (uuid(id) !== id || r.owner !== owner || !digest(r.fingerprint) || job.id !== r.jobId
        || job.sessionID !== thread.sessionID || job.threadId !== sessions[String(thread.sessionID)] || mapped.has(String(r.jobId))) throw unavailable()
    mapped.add(String(r.jobId))
  }
  if (Object.keys(record(core.jobs)).some(id => !mapped.has(id)) || Object.keys(sessions).length !== Object.keys(threads).length) throw unavailable()
  // The undeployed HTTP-link experiment is retired; retain all identity/job records.
  const { capabilities: _retired, ...current } = e
  return current as unknown as Envelope
}

/** One writer and one atomic envelope for both Bridge and public identity mappings.
 * A leftover writer.lock is never stolen. An operator must confirm the previous
 * process has ended before removing it. No live OpenCode storage is accessed.
 */
export class McpState implements Storage {
  private envelope: Envelope
  private pending?: Admission
  private serial: Promise<unknown> = Promise.resolve()
  private failed = false
  private closed = false
  private constructor(readonly directory: string, readonly owner: string, private readonly handle: FileHandle,
    private readonly lockHandle: FileHandle, envelope: Envelope) { this.envelope = envelope }
  private at(name: string): string { return `/proc/self/fd/${this.handle.fd}/${name}` }
  static async open(directory: string, owner: string): Promise<McpState> {
    let handle: FileHandle | undefined, lock: FileHandle | undefined
    let state: McpState | undefined
    try {
      handle = await privateDirectory(directory)
      try { lock = await open(`/proc/self/fd/${handle.fd}/writer.lock`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new McpError(503, 'state_locked', 'State is locked; confirm the previous process has ended before removing writer.lock')
        throw error
      }
      state = new McpState(resolve(directory), owner, handle, lock, {
        version: 1, owner, coreOutbox: { version: 1, threads: {}, jobs: {} }, threads: {}, requests: {},
      })
      await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: randomBytes(32).toString('hex') }))
      await lock.sync(); await handle.sync()
      let file: FileHandle | undefined
      try {
        file = await open(state.at('state.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const info = await file.stat()
        if (!info.isFile() || info.uid !== uid() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > MAX_STATE_BYTES) throw unavailable()
        const bytes = Buffer.alloc(info.size + 1)
        let length = 0
        while (length < bytes.length) {
          const read = await file.read(bytes, length, bytes.length - length, length)
          if (!read.bytesRead) break
          length += read.bytesRead
        }
        const after = await file.stat()
        if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw unavailable()
        const saved: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'))
        state.envelope = validate(saved, owner)
        if (Object.hasOwn(record(saved), 'capabilities')) await state.persist(state.envelope)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      finally { await file?.close() }
      return state
    } catch (error) {
      if (state) await state.close().catch(() => {})
      else { await lock?.close(); await handle?.close() }
      if (error instanceof McpError) throw error
      throw unavailable()
    }
  }
  assertReady(): void { if (this.failed || this.closed) throw unavailable() }
  snapshot(): Envelope { return structuredClone(this.envelope) }
  begin(admission: Admission): void {
    this.assertReady()
    if (this.pending || this.envelope.requests[admission.requestId]) throw unavailable()
    this.pending = { ...admission }
  }
  cancelAdmission(): void { this.pending = undefined }
  async load(): Promise<string> { this.assertReady(); return JSON.stringify(this.envelope.coreOutbox) }
  private async mutate(operation: (next: Envelope) => void): Promise<void> {
    const run = this.serial.then(async () => {
      this.assertReady()
      try {
        const next = structuredClone(this.envelope)
        operation(next)
        validate(next, this.owner)
        await this.persist(next)
        this.envelope = next
      } catch { this.failed = true; throw unavailable() }
    })
    this.serial = run.catch(() => {})
    await run
  }
  async save(value: string): Promise<void> {
    let admitted = false
    await this.mutate(next => {
      if (Buffer.byteLength(value) > MAX_STATE_BYTES) throw unavailable()
      const core = JSON.parse(value) as CoreOutbox
      const ids = Object.keys(core.jobs)
      const added = ids.filter(id => !Object.hasOwn(next.coreOutbox.jobs, id))
      if (Object.keys(next.coreOutbox.jobs).some(id => !Object.hasOwn(core.jobs, id))) throw unavailable()
      if (added.length) {
        const p = this.pending, jobId = added[0]!, job = core.jobs[jobId]!
        if (added.length !== 1 || !p || job.sessionID !== p.sessionID || next.requests[p.requestId]) throw unavailable()
        next.requests[p.requestId] = { owner: this.owner, fingerprint: p.fingerprint, threadId: p.threadId, jobId }
        next.threads[p.threadId] = { owner: this.owner, sessionID: p.sessionID }
        admitted = true
      }
      next.coreOutbox = core
    })
    if (admitted) this.pending = undefined
  }
  private async persist(next: Envelope): Promise<void> {
    const value = JSON.stringify(next)
    if (Buffer.byteLength(value) > MAX_STATE_BYTES) throw unavailable()
    const check = await openDirectory(this.directory)
    try {
      const [a, b, lock, lockPath] = await Promise.all([this.handle.stat(), check.stat(), this.lockHandle.stat(), lstat(this.at('writer.lock'))])
      if (a.dev !== b.dev || a.ino !== b.ino || a.uid !== uid() || (a.mode & 0o777) !== 0o700
          || lock.dev !== lockPath.dev || lock.ino !== lockPath.ino || !lockPath.isFile()) throw unavailable()
    } finally { await check.close() }
    // Reject an unexpected existing target instead of overwriting someone else's file.
    try {
      const info = await lstat(this.at('state.json'))
      if (!info.isFile() || info.uid !== uid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw unavailable()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const temp = this.at(`.state-${randomBytes(16).toString('hex')}`)
    try {
      const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(value); await file.sync() } finally { await file.close() }
      await rename(temp, this.at('state.json'))
      await this.handle.sync()
    } finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.serial
    try {
      const [ours, current] = await Promise.all([this.lockHandle.stat(), lstat(this.at('writer.lock'))])
      if (current.isFile() && ours.dev === current.dev && ours.ino === current.ino) { await unlink(this.at('writer.lock')); await this.handle.sync() }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable() }
    finally { await this.lockHandle.close(); await this.handle.close() }
  }
}
