export interface Principal { issuer: string; subject: string }
export interface FileRef { file_id: string; download_url: string; file_name?: string; mime_type?: string }
export interface NormalizedFile { file_id: string; name: string; mime: string; bytes: Uint8Array }
export interface SubmitInput {
  request_id: string; text: string; thread_id?: string; file?: FileRef
  require_files?: boolean; wait_seconds?: number
}
export interface PublicFile {
  asset_id: string; name: string; mime: string; size: number; sha256: string; uri: string
  url?: string; expires_at?: number
}
export interface PublicResult {
  job_id: string; thread_id: string; status: string; final: boolean
  text?: string; files?: PublicFile[]; notice?: string
}

/** Only fixed messages cross the public boundary; never expose underlying exceptions. */
export class McpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'McpError' }
}
export const invalidInput = () => new McpError(400, 'invalid_request', 'Invalid request')
export const unavailable = () => new McpError(503, 'unavailable', 'Service unavailable; operator recovery may be required')

const resourceID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
export const resourcePattern = new RegExp(`^hermes://jobs/(${resourceID})/assets/(${resourceID})$`)
export function resourceIdentity(uri: unknown): { jobId: string; assetId: string } {
  const match = typeof uri === 'string' ? resourcePattern.exec(uri) : null
  if (!match || match[0] !== uri) throw new McpError(404, 'not_found', 'Resource not found')
  return { jobId: match[1]!, assetId: match[2]! }
}
export const resourceURI = (jobId: string, assetId: string): string => `hermes://jobs/${jobId.toLowerCase()}/assets/${assetId.toLowerCase()}`
