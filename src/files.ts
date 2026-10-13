import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Config } from './config.js'
import type { Result as ToolResult } from '@opencode/plugin/promise/tool'
import { attachments, assets, decode, hashBytes, LIMITS, mime, name, record, uuid, verifyBytes, type Asset, type Attachment, type InputAsset } from './protocol.js'

export type ResultFile = Extract<Exclude<ToolResult['content'], string | undefined>[number], { type: 'file' }>
export interface LocalArtifact { name: string; mime: string; path: string; size: number; sha256: string; asset_id?: string }
export interface SavedOutputs { files: ResultFile[]; paths: string[]; artifacts: LocalArtifact[] }
function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
async function noSymlinks(path: string): Promise<void> {
  const parts = resolve(path).split(sep).filter(Boolean)
  let current: string = sep
  for (const part of parts) {
    current = resolve(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not allowed')
  }
}
async function readUpload(raw: string, cfg: Config, signal?: AbortSignal): Promise<Buffer> {
  if (!cfg.uploadRoots.length) throw new Error('File uploads disabled: configure uploadRoots explicitly')
  if (raw.includes('\0') || raw.split(/[\\/]/).includes('..')) throw new Error('Unsafe upload path')
  let path = raw
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    const url = new URL(path)
    if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) throw new Error('Only local file paths/file: URIs are allowed; remote downloads are forbidden')
    path = fileURLToPath(url)
    if (path.split(/[\\/]/).includes('..')) throw new Error('Unsafe upload path')
  }
  path = resolve(cfg.directory, path)
  const root = cfg.uploadRoots.find(r => within(r, path))
  if (!root) throw new Error('Upload path is outside uploadRoots')
  await noSymlinks(path)
  await noSymlinks(root)
  const rootReal = await realpath(root)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const verify = async () => {
      signal?.throwIfAborted()
      const fdPath = await realpath(`/proc/self/fd/${handle.fd}`)
      if (fdPath !== path || !within(rootReal, fdPath)) throw new Error('Upload changed location while opening/reading')
      await noSymlinks(path)
      const [stat, pathStat] = await Promise.all([handle.stat(), lstat(path)])
      if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) throw new Error('Upload must remain the same regular file')
      if (stat.size > LIMITS.file) throw new Error('Attachment exceeds decoded 10 MiB limit')
    }
    await verify()
    const chunks: Buffer[] = []
    let length = 0
    while (true) {
      signal?.throwIfAborted()
      const buffer = Buffer.alloc(Math.min(64 * 1024, LIMITS.file + 1 - length))
      const { bytesRead } = await handle.read(buffer)
      if (!bytesRead) break
      chunks.push(buffer.subarray(0, bytesRead))
      length += bytesRead
      if (length > LIMITS.file) throw new Error('Attachment exceeds decoded 10 MiB limit')
    }
    await verify()
    return Buffer.concat(chunks)
  } finally { await handle.close() }
}
function imageMime(value: unknown): string {
  const type = mime(value)
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) throw new Error('Only PNG, JPEG, GIF and WebP images are supported; ordinary file attachments are not supported')
  return type
}
/** Image inputs: {name,mime,base64}, {name?,mime?,data}, or {name?,mime,path}. */
async function snapshotInputs(value: unknown, cfg: Config, signal: AbortSignal | undefined, validateMime: (value: unknown) => string): Promise<Attachment[]> {
  if (!Array.isArray(value) || value.length > LIMITS.count) throw new Error('At most 8 attachments allowed')
  const result: Attachment[] = []
  let total = 0
  for (const raw of value) {
    signal?.throwIfAborted()
    const a = record(raw)
    if (['base64', 'data', 'path'].filter(k => k in a).length !== 1) throw new Error('Specify exactly one of base64, data or path')
    let bytes: Buffer
    let filename: string
    let type: string
    if ('path' in a) {
      if (typeof a.path !== 'string') throw new Error('Invalid upload path')
      filename = name(a.name ?? basename(a.path))
      type = validateMime(a.mime)
      bytes = await readUpload(a.path, cfg, signal)
    } else if ('data' in a) {
      if (typeof a.data !== 'string' || a.data.length > Math.ceil(LIMITS.file / 3) * 4 + 256) throw new Error('Data URL too large')
      const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(a.data)
      if (!match) throw new Error('Expected a base64 data URL')
      type = mime(match[1])
      if (a.mime !== undefined && mime(a.mime) !== type) throw new Error('Data URL MIME mismatch')
      type = validateMime(type)
      filename = name(a.name)
      bytes = decode(match[2])
    } else {
      filename = name(a.name)
      type = validateMime(a.mime)
      bytes = decode(a.base64)
    }
    total += bytes.length
    if (total > LIMITS.total) throw new Error('Attachments exceed total decoded 20 MiB limit')
    result.push({ name: filename, mime: type, base64: bytes.toString('base64') })
  }
  return result
}
export async function snapshot(value: unknown, cfg: Config, signal?: AbortSignal): Promise<Attachment[]> {
  return attachments(await snapshotInputs(value, cfg, signal, imageMime))
}
/** Opaque files are snapshotted as bytes only: no archive extraction or text conversion. */
export async function snapshotFiles(value: unknown, cfg: Config, signal?: AbortSignal): Promise<InputAsset[]> {
  return (await snapshotInputs(value, cfg, signal, mime)).map(a => {
    const bytes = decode(a.base64)
    return { ...a, asset_id: randomUUID(), size: bytes.length, sha256: hashBytes(bytes) }
  })
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
async function privateDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 })
  await noSymlinks(path)
  const info = await lstat(path)
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error('Output directory must be owned by the current user')
  await chmod(path, 0o700)
  const last = dirname(created ?? path)
  for (let current = path; ; current = dirname(current)) {
    await syncDirectory(current)
    if (current === last || current === dirname(current)) break
  }
}
async function existingBytes(path: string, expected: { size: number; sha256: string }): Promise<Buffer | undefined> {
  try { await noSymlinks(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600) throw new Error('Output must be a private regular file owned by the current user')
    if (before.size !== expected.size) throw new Error('Existing output differs; refusing to overwrite')
    const actual = Buffer.alloc(expected.size + 1)
    let length = 0
    while (length < actual.length) {
      const { bytesRead } = await handle.read(actual, length, actual.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await lstat(path)
    if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
        || length !== expected.size || hashBytes(actual.subarray(0, length)) !== expected.sha256) throw new Error('Existing output differs; refusing to overwrite')
    await noSymlinks(path)
    return actual.subarray(0, length)
  } finally { await handle.close() }
}
async function publish(path: string, bytes: Buffer, expected: { size: number; sha256: string }): Promise<void> {
  const folder = dirname(path)
  const temp = resolve(folder, `.tmp-${randomUUID()}`)
  try {
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await noSymlinks(folder)
    // Hard-link publication is atomic and can never overwrite an existing artifact.
    try { await link(temp, path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
  if (!await existingBytes(path, expected)) throw new Error('Output disappeared during publication')
  await syncDirectory(folder)
}
function appendOutput(output: SavedOutputs, metadata: LocalArtifact, bytes: Buffer): void {
  output.paths.push(metadata.path)
  output.artifacts.push(metadata)
  if (/^image\/(png|jpeg|gif|webp)$/.test(metadata.mime) || metadata.mime.startsWith('text/')) {
    output.files.push({ type: 'file', uri: `data:${metadata.mime};base64,${bytes.toString('base64')}`, mime: metadata.mime, name: metadata.name })
  }
}
/** Binary artifacts are never misrepresented as model-readable attachments. */
export async function saveOutputs(outputDir: string, id: string, values: Attachment[]): Promise<SavedOutputs> {
  const safe = attachments(values)
  await privateDirectory(outputDir)
  const folder = resolve(outputDir, uuid(id))
  await privateDirectory(folder)
  const output: SavedOutputs = { files: [], paths: [], artifacts: [] }
  for (const a of safe) {
    const path = resolve(folder, a.name)
    const bytes = decode(a.base64)
    const metadata = { name: a.name, mime: a.mime, path, size: bytes.length, sha256: hashBytes(bytes) }
    if (!await existingBytes(path, metadata)) await publish(path, bytes, metadata)
    await syncDirectory(folder)
    appendOutput(output, metadata, bytes)
  }
  return output
}
/** Reuse verified private outputs before downloading. Failures never modify the job. */
export async function saveAssetOutputs(outputDir: string, id: string, values: Asset[], download: (asset: Asset) => Promise<Buffer>): Promise<SavedOutputs> {
  const safe = assets(values)
  await privateDirectory(outputDir)
  const jobFolder = resolve(outputDir, uuid(id))
  await privateDirectory(jobFolder)
  const output: SavedOutputs = { files: [], paths: [], artifacts: [] }
  for (const a of safe) {
    const folder = resolve(jobFolder, a.asset_id)
    await privateDirectory(folder)
    const path = resolve(folder, a.name)
    let bytes = await existingBytes(path, a)
    if (!bytes) {
      bytes = await download(a)
      verifyBytes(a, bytes)
      await publish(path, bytes, a)
    }
    await syncDirectory(folder)
    appendOutput(output, { ...a, path }, bytes)
  }
  return output
}
