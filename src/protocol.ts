export const LIMITS = { count: 8, file: 10 * 1024 ** 2, total: 20 * 1024 ** 2, text: 64 * 1024, wire: 32 * 1024 ** 2 } as const
export interface Attachment { name: string; mime: string; base64: string }
export interface JobRequest { id: string; threadId: string; text: string; attachments: Attachment[] }
export interface JobResponse {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  text: string
  attachments: Attachment[]
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
export function response(value: unknown, id: string): JobResponse {
  const r = record(value)
  if (uuid(r.id) !== id) throw new Error('Response job ID mismatch')
  if (r.status !== 'queued' && r.status !== 'running' && r.status !== 'completed' && r.status !== 'failed') throw new Error('Invalid job status')
  let error: JobResponse['error'] = null
  if (r.error !== null) {
    const e = record(r.error)
    error = { code: text(e.code), message: text(e.message) }
  }
  return { id, status: r.status, text: text(r.text), attachments: attachments(r.attachments), error }
}
export async function readJSON(res: Response): Promise<unknown> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('Empty HTTP response')
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > LIMITS.wire) throw new Error('HTTP response exceeds 32 MiB')
      chunks.push(item.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
