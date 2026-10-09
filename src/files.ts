import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, rename } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Config } from './config.js'
import { attachments, decode, LIMITS, mime, name, record, uuid, type Attachment } from './protocol.js'

export interface PromptFile { uri: string; name?: string; description?: string }
export interface SavedOutputs { files: PromptFile[]; paths: string[] }
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
/** Inputs: {name,mime,base64}, {name?,mime?,data}, or {name?,mime,path}. */
export async function snapshot(value: unknown, cfg: Config, signal?: AbortSignal): Promise<Attachment[]> {
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
      type = mime(a.mime)
      bytes = await readUpload(a.path, cfg, signal)
    } else if ('data' in a) {
      if (typeof a.data !== 'string' || a.data.length > Math.ceil(LIMITS.file / 3) * 4 + 256) throw new Error('Data URL too large')
      const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(a.data)
      if (!match) throw new Error('Expected a base64 data URL')
      type = mime(match[1])
      if (a.mime !== undefined && mime(a.mime) !== type) throw new Error('Data URL MIME mismatch')
      filename = name(a.name)
      bytes = decode(match[2])
    } else {
      filename = name(a.name)
      type = mime(a.mime)
      bytes = decode(a.base64)
    }
    total += bytes.length
    if (total > LIMITS.total) throw new Error('Attachments exceed total decoded 20 MiB limit')
    result.push({ name: filename, mime: type, base64: bytes.toString('base64') })
  }
  return attachments(result)
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await noSymlinks(path)
  const info = await lstat(path)
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error('Output directory must be owned by the current user')
  await chmod(path, 0o700)
}
/** Binary artifacts are never misrepresented as model-readable attachments. */
export async function saveOutputs(outputDir: string, id: string, values: Attachment[]): Promise<SavedOutputs> {
  const safe = attachments(values)
  await privateDirectory(outputDir)
  const folder = resolve(outputDir, uuid(id))
  await privateDirectory(folder)
  const files: PromptFile[] = []
  const paths: string[] = []
  for (const a of safe) {
    const path = resolve(folder, a.name)
    const temp = resolve(dirname(path), `.tmp-${randomUUID()}`)
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(decode(a.base64)); await handle.sync() } finally { await handle.close() }
    await rename(temp, path)
    paths.push(path)
    if (/^image\/(png|jpeg|gif|webp)$/.test(a.mime) || a.mime.startsWith('text/')) {
      files.push({ uri: `data:${a.mime};base64,${a.base64}`, name: a.name, description: `Hermes job ${id}; saved at ${pathToFileURL(path).href}` })
    }
  }
  return { files, paths }
}
