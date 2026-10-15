import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { Bridge, waitSeconds, type Config, type OutboxJob } from '../src/core.js'
import { hashBytes, LIMITS, mime, name, record, text, uuid } from '../src/protocol.js'
import { agentContext } from '../src/agent-context.js'
import { invalidInput, McpError, resourceIdentity, unavailable, type FileRef, type NormalizedFile, type Principal, type PublicFile, type PublicResult, type SubmitInput } from './contracts.js'
import { McpOutputs } from './outputs.js'
import { McpState, privateDirectory } from './state.js'

export interface McpBridgeOptions {
  bridgeConfig: Config; stateDirectory: string; allowedPrincipal: Principal
  downloadFile: (ref: FileRef) => Promise<NormalizedFile>
}
interface ValidatedInput extends SubmitInput { fingerprint: string }
function validateInput(input: SubmitInput): ValidatedInput {
  try {
    const raw = record(input)
    if (Object.keys(raw).some(k => !['request_id', 'text', 'thread_id', 'file', 'require_files', 'wait_seconds'].includes(k))) throw invalidInput()
    const request_id = uuid(raw.request_id).toLowerCase(), message = text(raw.text)
    if (!message.trim() || (raw.require_files !== undefined && typeof raw.require_files !== 'boolean')) throw invalidInput()
    const thread_id = raw.thread_id === undefined ? undefined : uuid(raw.thread_id).toLowerCase()
    const wait_seconds = waitSeconds(raw.wait_seconds)
    let file: FileRef | undefined
    if (raw.file !== undefined) {
      const f = record(raw.file)
      if (Object.keys(f).some(k => !['file_id', 'download_url', 'file_name', 'mime_type'].includes(k))) throw invalidInput()
      if (typeof f.download_url !== 'string' || f.download_url.length > 8192 || /[\x00-\x20\x7f\\]/.test(f.download_url)) throw invalidInput()
      const url = new URL(f.download_url)
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw invalidInput()
      file = { file_id: name(f.file_id), download_url: f.download_url,
        file_name: name(f.file_name ?? f.file_id), mime_type: mime(f.mime_type ?? 'application/octet-stream') }
    }
    const require_files = raw.require_files === true
    const fingerprint = hashBytes(Buffer.from(JSON.stringify([message, thread_id ?? null,
      file ? [file.file_id, file.file_name, file.mime_type] : null, require_files])))
    return { request_id, text: message, thread_id, file, require_files, wait_seconds, fingerprint }
  } catch { throw invalidInput() }
}

export class McpBridgeService {
  private serial: Promise<unknown> = Promise.resolve()
  private closing = false
  private closeWork?: Promise<void>
  private constructor(private readonly state: McpState, private readonly bridge: Bridge,
    private readonly outputs: McpOutputs, private readonly principal: Principal,
    private readonly downloadFile: (ref: FileRef) => Promise<NormalizedFile>) {}
  static async open(options: McpBridgeOptions): Promise<McpBridgeService> {
    let state: McpState | undefined, bridge: Bridge | undefined
    try {
      const { issuer, subject } = options.allowedPrincipal
      if (typeof issuer !== 'string' || typeof subject !== 'string' || !issuer || !subject
          || issuer.length > 8192 || subject.length > 8192 || !isAbsolute(options.bridgeConfig.outputDir)) throw invalidInput()
      const owner = hashBytes(Buffer.from(JSON.stringify([issuer, subject])))
      state = await McpState.open(options.stateDirectory, owner)
      const outputRoot = resolve(options.bridgeConfig.outputDir, owner)
      const directory = await privateDirectory(outputRoot)
      await directory.close()
      bridge = await Bridge.create({ ...options.bridgeConfig, outputDir: outputRoot, uploadRoots: [] }, { storage: state })
      const service = new McpBridgeService(state, bridge, new McpOutputs(state, outputRoot),
        Object.freeze({ issuer, subject }), options.downloadFile)
      bridge.start()
      return service
    } catch (error) {
      await bridge?.dispose(); await state?.close()
      if (error instanceof McpError) throw error
      throw unavailable()
    }
  }
  private authorize(principal: Principal): void {
    if (!principal || principal.issuer !== this.principal.issuer || principal.subject !== this.principal.subject) throw new McpError(403, 'forbidden', 'Access denied')
    if (this.closing) throw unavailable()
    this.state.assertReady()
  }
  private owned(jobId: string): { job: OutboxJob; threadId: string } {
    try { jobId = uuid(jobId).toLowerCase() } catch { throw invalidInput() }
    const e = this.state.snapshot(), job = e.coreOutbox.jobs[jobId]
    const request = Object.values(e.requests).find(r => r.jobId === jobId && r.owner === this.state.owner)
    if (!job || !request || e.threads[request.threadId]?.owner !== this.state.owner
        || e.threads[request.threadId]?.sessionID !== job.sessionID) throw new McpError(404, 'not_found', 'Job not found')
    return { job, threadId: request.threadId }
  }
  private view(jobId: string, withText = false, files?: PublicFile[]): PublicResult {
    const { job, threadId } = this.owned(jobId)
    const final = job.status === 'completed' || job.status === 'failed'
    return { job_id: job.id, thread_id: threadId, status: job.status, final,
      ...(withText && job.status === 'completed' && job.result ? { text: job.result.text } : {}),
      ...(files?.length ? { files } : {}),
      ...(job.status === 'failed' ? { notice: 'The job failed; no automatic resubmission will occur' }
        : job.status === 'paused' ? { notice: 'Waiting is paused; the original job may still be running' } : {}) }
  }
  async submit(principal: Principal, raw: SubmitInput): Promise<PublicResult> {
    this.authorize(principal)
    const input = validateInput(raw)
    const work = this.serial.then(async () => {
      this.authorize(principal)
      const e = this.state.snapshot(), existing = e.requests[input.request_id]
      if (existing) {
        if (existing.owner !== this.state.owner || existing.fingerprint !== input.fingerprint) throw new McpError(409, 'request_conflict', 'Request ID already used with different content')
        return existing.jobId
      }
      if (input.thread_id && e.threads[input.thread_id]?.owner !== this.state.owner) throw new McpError(404, 'not_found', 'Thread not found')
      let message: string
      try { message = agentContext('chatgpt', input.text) }
      catch { throw new McpError(400, 'invalid_input', 'Task text including agent context must fit within 64 KiB UTF-8') }
      const threadId = input.thread_id ?? randomUUID(), sessionID = `${this.state.owner}:${threadId}`
      let files: { name: string; mime: string; base64: string }[] = []
      if (input.file) {
        try {
          const file = await this.downloadFile({ ...input.file })
          if (file.file_id !== input.file.file_id || file.name !== input.file.file_name || file.mime !== input.file.mime_type
              || !(file.bytes instanceof Uint8Array) || file.bytes.byteLength > LIMITS.file) throw invalidInput()
          files = [{ name: name(file.name), mime: mime(file.mime), base64: Buffer.from(file.bytes).toString('base64') }]
        } catch { throw new McpError(400, 'file_import_failed', 'File import failed safely; no job was created') }
      }
      this.state.begin({ requestId: input.request_id, fingerprint: input.fingerprint, threadId, sessionID })
      try {
        const job = await this.bridge.ask(sessionID, { text: message, files, requireFiles: input.require_files })
        return job.id
      } catch { throw unavailable() }
      finally { this.state.cancelAdmission() }
    })
    this.serial = work.catch(() => {})
    const jobId = await work
    return input.wait_seconds ? this.readResult(principal, jobId, input.wait_seconds, false) : this.view(jobId)
  }
  async status(principal: Principal, jobId: string): Promise<PublicResult> {
    this.authorize(principal)
    const { job } = this.owned(jobId)
    return this.view(job.id)
  }
  async result(principal: Principal, jobId: string, seconds = 0): Promise<PublicResult> {
    return this.readResult(principal, jobId, seconds, true)
  }
  private async readResult(principal: Principal, jobId: string, seconds: number, resumePaused: boolean): Promise<PublicResult> {
    this.authorize(principal)
    try { waitSeconds(seconds) } catch { throw invalidInput() }
    const { job } = this.owned(jobId)
    try {
      // Only an explicit result call reopens GET-only waiting on this same job.
      // Bridge retains the outbound-scope guard; terminal failures stay terminal.
      if (resumePaused && job.status === 'paused') await this.bridge.resume(job.sessionID, job.id)
      // This materializes verified local artifacts, but its content contains local
      // paths/data URIs and must never be forwarded to a remote model context.
      await this.bridge.result(job.sessionID, job.id, { waitSeconds: seconds })
      const files = this.outputs.descriptors(job.id)
      return this.view(job.id, true, files)
    } catch (error) {
      if (error instanceof McpError) throw error
      throw new McpError(503, 'result_unavailable', 'Result is temporarily unavailable; query the same job again')
    }
  }
  async readResource(principal: Principal, uri: string): Promise<{ uri: string; mimeType: string; blob: string }> {
    this.authorize(principal)
    const { jobId, assetId } = resourceIdentity(uri)
    const { job } = this.owned(jobId)
    if (!this.outputs.descriptors(jobId).some(file => file.uri === uri)) throw new McpError(404, 'not_found', 'Resource not found')
    try {
      // Unlike explicit result, resource reads never resume paused/failed jobs.
      // Materialization preserves Bridge's scope guard and verified local cache.
      await this.bridge.result(job.sessionID, job.id)
      const file = await this.outputs.readResource(jobId, assetId)
      return { uri, mimeType: file.mimeType, blob: Buffer.from(file.bytes).toString('base64') }
    } catch (error) {
      if (error instanceof McpError) throw error
      throw new McpError(503, 'resource_unavailable', 'Resource is temporarily unavailable')
    }
  }
  close(): Promise<void> {
    if (!this.closeWork) {
      this.closing = true
      this.closeWork = (async () => { await this.serial; await this.bridge.dispose(); await this.state.close() })()
    }
    return this.closeWork
  }
}
