import { createHash } from 'node:crypto'

export const LIMITS = { count: 8, file: 10 * 1024 ** 2, total: 20 * 1024 ** 2, text: 64 * 1024, wire: 32 * 1024 ** 2 } as const
export interface Attachment { name: string; mime: string; base64: string }
export interface Asset { asset_id: string; name: string; mime: string; size: number; sha256: string }
export interface InputAsset extends Asset { base64: string }
export interface JobRequest { id: string; threadId: string; text: string; attachments: Attachment[]; input_assets?: string[] }
export interface JobResponse {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  text: string
  attachments: Attachment[]
  output_assets?: Asset[]
  error: null | { code: string; message: string }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > LIMITS.text) throw new Error('Text must be a string of at most 64 KiB UTF-8')
  return value
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid UUID')
  return value
}
export function name(value: unknown): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 255 || /^[a-z]:/i.test(value)) throw new Error('Attachment name must be a safe basename')
  return value
}
export function mime(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value) || value.length > 127) throw new Error('Invalid MIME type (lowercase, no parameters)')
  return value
}
export function decode(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(LIMITS.file / 3) * 4) throw new Error('Attachment exceeds decoded 10 MiB limit')
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid canonical base64')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > LIMITS.file) throw new Error('Attachment exceeds decoded 10 MiB limit')
  if (bytes.toString('base64') !== value) throw new Error('Invalid canonical base64')
  return bytes
}
export function attachments(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length > LIMITS.count) throw new Error('At most 8 attachments allowed')
  const names = new Set<string>()
  let total = 0
  return value.map(item => {
    const a = record(item)
    const result = { name: name(a.name), mime: mime(a.mime), base64: a.base64 }
    const bytes = decode(result.base64)
    if (names.has(result.name)) throw new Error('Duplicate attachment name')
    names.add(result.name)
    total += bytes.length
    if (total > LIMITS.total) throw new Error('Attachments exceed total decoded 20 MiB limit')
    return { ...result, base64: bytes.toString('base64') }
  })
}
export const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
export function asset(value: unknown): Asset {
  const a = record(value)
  if (typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size < 0 || a.size > LIMITS.file) throw new Error('Invalid asset size (maximum 10 MiB)')
  if (typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256)) throw new Error('Invalid asset SHA-256')
  return { asset_id: uuid(a.asset_id), name: name(a.name), mime: mime(a.mime), size: a.size, sha256: a.sha256 }
}
export function assets(value: unknown): Asset[] {
  if (!Array.isArray(value) || value.length > LIMITS.count) throw new Error('At most 8 assets allowed')
  const result = value.map(asset)
  if (new Set(result.map(a => a.asset_id)).size !== result.length) throw new Error('Duplicate asset ID')
  combinedLimits([], result)
  return result
}
export function inputAssets(value: unknown): InputAsset[] {
  const metadata = assets(value)
  return metadata.map((a, index) => {
    const bytes = decode(record((value as unknown[])[index]).base64)
    verifyBytes(a, bytes)
    return { ...a, base64: bytes.toString('base64') }
  })
}
export function assetIDs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > LIMITS.count) throw new Error('At most 8 input asset IDs allowed')
  const ids = value.map(uuid)
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate asset ID')
  return ids
}
export function combinedLimits(inline: Attachment[], files: Asset[]): void {
  if (inline.length + files.length > LIMITS.count) throw new Error('At most 8 attachments and files combined allowed')
  if (inline.reduce((total, a) => total + decode(a.base64).length, 0) + files.reduce((total, a) => total + a.size, 0) > LIMITS.total) throw new Error('Attachments and files exceed total decoded 20 MiB limit')
}
export function verifyBytes(a: Asset, bytes: Uint8Array): void {
  if (bytes.byteLength !== a.size || hashBytes(bytes) !== a.sha256) throw new Error('Asset size/SHA-256 mismatch')
}
export function capabilities(value: unknown): boolean {
  const c = record(value)
  if (c.object !== 'hermes.bridge.capabilities' || c.version !== 1 || typeof c.assets !== 'boolean'
      || c.max_asset_bytes !== LIMITS.file || c.max_total_asset_bytes !== LIMITS.total || c.max_assets !== LIMITS.count) throw new Error('Invalid companion capabilities')
  return c.assets
}
export function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name(filename)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}
export function verifyAssetHeaders(headers: Headers, expected: Asset): void {
  const disposition = /^attachment;\s*filename\*=UTF-8''([^;]*)$/i.exec(headers.get('content-disposition') ?? '')
  const length = headers.get('content-length') ?? ''
  const encoding = headers.get('content-encoding')
  if (!disposition || decodeURIComponent(disposition[1]!) !== expected.name || !/^(0|[1-9][0-9]*)$/.test(length)
      || Number(length) !== expected.size || headers.get('content-type') !== expected.mime
      || headers.get('x-content-sha256') !== expected.sha256 || (encoding !== null && encoding !== 'identity')) throw new Error('Asset response metadata mismatch')
}
export function response(value: unknown, id: string): JobResponse {
  const r = record(value)
  if (uuid(r.id) !== id) throw new Error('Response job ID mismatch')
  if (r.status !== 'queued' && r.status !== 'running' && r.status !== 'completed' && r.status !== 'failed') throw new Error('Invalid job status')
  let error: JobResponse['error'] = null
  if (r.error !== null) {
    const e = record(r.error)
    error = { code: text(e.code), message: text(e.message) }
  }
  const inline = attachments(r.attachments)
  const files = r.output_assets === undefined ? undefined : assets(r.output_assets)
  if (r.status !== 'completed' && files?.length) throw new Error('Output assets require a completed job')
  combinedLimits(inline, files ?? [])
  return { id, status: r.status, text: text(r.text), attachments: inline, error, ...(files === undefined ? {} : { output_assets: files }) }
}
export async function readBytes(res: Response, maximum: number = LIMITS.file): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) {
    if (maximum === 0) return Buffer.alloc(0)
    throw new Error('Empty HTTP response')
  }
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > maximum) throw new Error(maximum === LIMITS.wire ? 'HTTP response exceeds 32 MiB' : 'HTTP asset response exceeds size limit')
      chunks.push(item.value)
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
export async function readJSON(res: Response): Promise<unknown> {
  return JSON.parse((await readBytes(res, LIMITS.wire)).toString('utf8')) as unknown
}
