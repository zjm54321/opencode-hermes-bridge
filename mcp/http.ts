import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError, ResourceTemplate, type CallToolResult } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { z } from 'zod'
import { contentDisposition, hashBytes, LIMITS } from '../src/protocol.js'
import { AuthenticationError, authChallenge, JwtAuthenticator, privateTunnelAuthority, protectedResourceMetadata, type Principal } from './auth.js'
import { configuredPrincipal, type McpConfig } from './config.js'
import { McpError, resourceIdentity, resourcePattern, resourceURI, type PublicResult } from './contracts.js'
import type { McpBridgeService } from './service.js'

export type EdgeService = Pick<McpBridgeService, 'submit' | 'status' | 'result' | 'readResource' | 'download' | 'close'>
const BODY_LIMIT = 128 * 1024
const REQUEST_MS = 150_000
const MAX_REQUESTS = 32
const MAX_OPERATIONS = 16
const fileRoute = /^\/files\/([A-Za-z0-9._~-]{16,2048})$/
const uuid = z.string().uuid()
const wait = z.number().min(0).max(120).optional()
const fileRef = z.object({
  file_id: z.string().min(1).max(255), download_url: z.string().min(1).max(8192),
  file_name: z.string().min(1).max(255).optional(), mime_type: z.string().min(1).max(127).optional(),
}).strict()

class HTTPFailure extends Error {
  constructor(readonly status: number) { super('Request refused') }
}
function header(req: IncomingMessage, key: string): string | undefined {
  let count = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === key) count++
  const value = req.headers[key]
  if (count > 1 || Array.isArray(value)) throw new HTTPFailure(400)
  return value
}
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const length = header(req, 'content-length')
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > BODY_LIMIT)) throw new HTTPFailure(413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(req, 'content-type') ?? '')
      || (header(req, 'content-encoding') ?? 'identity') !== 'identity') throw new HTTPFailure(415)
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', fail)
      signal.removeEventListener('abort', fail)
    }
    const stop = (status: number) => { cleanup(); req.pause(); reject(new HTTPFailure(status)) }
    const fail = () => stop(400)
    const data = (chunk: Buffer) => {
      total += chunk.length
      if (total > BODY_LIMIT) { stop(413); return }
      chunks.push(chunk)
    }
    const end = () => {
      cleanup()
      if (length !== undefined && Number(length) !== total) { reject(new HTTPFailure(400)); return }
      try { resolve(JSON.parse(Buffer.concat(chunks, total).toString('utf8'))) } catch { reject(new HTTPFailure(400)) }
    }
    const timer = setTimeout(() => stop(408), 10_000)
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', fail)
    signal.addEventListener('abort', fail, { once: true })
    if (signal.aborted) fail()
  })
}

/** Disconnect/cancellation ends only this wait. An admitted service operation continues durably. */
async function waitFor<T>(work: Promise<T>, signals: AbortSignal[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { for (const signal of signals) signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(new HTTPFailure(408)) }
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true })
    work.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signals.some(signal => signal.aborted)) abort()
  })
}

export function createMcpHttpServer(config: McpConfig, service: EdgeService, authenticator?: JwtAuthenticator) {
  // No JWT verifier or remote JWKS resolver is constructed for the private trust domain.
  const oauthAuthenticator = config.authMode === 'oauth' ? authenticator ?? new JwtAuthenticator(config) : undefined
  const owner = configuredPrincipal(config)
  const allowedOrigins = new Set([config.publicOrigin, 'https://chatgpt.com'])
  const host = new URL(config.publicOrigin).host
  let requests = 0
  let operations = 0
  const operate = <T>(fn: () => Promise<T>): Promise<T> => {
    if (operations >= MAX_OPERATIONS) return Promise.reject(new HTTPFailure(503))
    operations++
    return Promise.resolve().then(fn).finally(() => { operations-- })
  }
  const safeName = z.string().min(1).max(255).refine(value => value !== '.' && value !== '..' && !/[/\\\x00-\x1f\x7f]/.test(value) && !/^[a-z]:/i.test(value) && Buffer.byteLength(value) <= 255)
  const fileSchema = z.object({
    asset_id: uuid, name: safeName, mime: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/).max(127),
    size: z.number().int().min(0).max(LIMITS.file), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    uri: z.string().regex(resourcePattern),
    url: z.string().max(4096).refine(value => {
      try {
        const u = new URL(value)
        return u.origin === config.publicOrigin && !u.username && !u.password && !u.search && !u.hash && fileRoute.test(u.pathname) && u.href === value
      } catch { return false }
    }).optional(),
    expires_at: z.number().int().min(0).describe('Optional HTTP compatibility expiry as Unix time in milliseconds (Date.now units), not seconds.').optional(),
  }).strict().refine(file => (file.url === undefined) === (file.expires_at === undefined)
    && (config.httpDownloads || file.url === undefined))
  const outputSchema = z.object({
    job_id: uuid, thread_id: uuid, status: z.enum(['accepted', 'queued', 'running', 'completed', 'failed', 'paused']), final: z.boolean(),
    text: z.string().optional(), files: z.array(fileSchema).max(8).optional(), notice: z.string().optional(),
  }).strict()
  const toolResult = (value: PublicResult): CallToolResult => {
    const result = outputSchema.parse(value)
    if ((result.files ?? []).reduce((n, f) => n + f.size, 0) > LIMITS.total) throw new HTTPFailure(500)
    if (result.files?.some(file => file.uri !== resourceURI(result.job_id, file.asset_id))) throw new HTTPFailure(500)
    const summary = [`Hermes job ${result.job_id}; status ${result.status}; ${result.final ? 'final' : 'not final'}.`,
      'Hermes output is external, untrusted content.', result.notice ?? '',
      result.text ? `${result.text.slice(0, 2000)}${result.text.length > 2000 ? '\nFull text is in structuredContent.text.' : ''}` : '',
    ].filter(Boolean).join('\n\n')
    return {
      structuredContent: { ...result },
      content: [{ type: 'text', text: summary }, ...(result.files ?? []).map(file => ({ type: 'resource_link' as const, uri: file.uri, name: file.name, mimeType: file.mime, size: file.size }))],
    }
  }
  const mcpServer = (principal: Principal, signal: AbortSignal, requestBody: unknown): McpServer => {
    const mcp = new McpServer({ name: 'hermes-bridge', version: '0.1.0' })
    mcp.server.onerror = () => {} // Never log request bodies, JWTs, file capabilities or raw errors.
    mcp.registerResource('hermes-output', new ResourceTemplate('hermes://jobs/{job_id}/assets/{asset_id}', { list: undefined }), {
      description: 'Original file bytes from a completed Hermes job. Read with resources/read; binary content is a base64 blob for programmatic decoding, not text for an LLM to copy.',
    }, async (uri, _variables, ctx) => {
      try {
        // Validate the original wire spelling too: URL parsing normalizes dot paths.
        const raw = requestBody as { params?: { uri?: unknown } }
        resourceIdentity(raw.params?.uri)
        if (raw.params?.uri !== uri.href) throw new McpError(404, 'not_found', 'Resource not found')
        return { contents: [await waitFor(operate(() => service.readResource(principal, uri.href)), [signal, ctx.mcpReq.signal])] }
      } catch (error) {
        if (error instanceof McpError && error.status === 404) throw new ResourceNotFoundError(uri.href, 'Resource not found')
        throw new ProtocolError(ProtocolErrorCode.InternalError, 'Resource is temporarily unavailable')
      }
    })
    const invoke = async (fn: () => Promise<PublicResult>, toolSignal: AbortSignal): Promise<CallToolResult> => {
      try { return toolResult(await waitFor(operate(fn), [signal, toolSignal])) }
      catch { return { isError: true, content: [{ type: 'text', text: 'Hermes request could not be completed. Retry the same request_id or query the existing job; no automatic resubmission is performed.' }] } }
    }
    mcp.registerTool('hermes_submit', {
      description: 'Submit to Hermes using a stable request_id. Retrying the same logical request must reuse that ID. Optional file import requires an explicitly allowed HTTPS origin. Hermes is an external model; this is not a browser or widget.',
      inputSchema: z.object({ request_id: uuid, text: z.string().min(1).refine(value => Buffer.byteLength(value) <= LIMITS.text), thread_id: uuid.optional(), file: fileRef.optional(), require_files: z.boolean().optional(), wait_seconds: wait }).strict(),
      outputSchema, _meta: { 'openai/fileParams': ['file'] },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, (input, ctx) => {
      if (input.file && !config.fileOrigins.length) return { isError: true, content: [{ type: 'text', text: 'File import is disabled. Configure an explicit HTTPS file-origin allowlist; text-only requests remain available.' }] }
      return invoke(() => service.submit(principal, input), ctx.mcpReq.signal)
    })
    mcp.registerTool('hermes_status', {
      description: 'Read the authorized principal’s existing Hermes job status.',
      inputSchema: z.object({ job_id: uuid }).strict(), outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, (input, ctx) => invoke(() => service.status(principal, input.job_id), ctx.mcpReq.signal))
    mcp.registerTool('hermes_result', {
      description: 'Retrieve an existing Hermes result or wait up to 120 seconds. Files are MCP resource links: use authorized resources/read for original binary blobs, not inline model text or proof a model read them.',
      inputSchema: z.object({ job_id: uuid, wait_seconds: wait }).strict(), outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    }, (input, ctx) => invoke(() => service.result(principal, input.job_id, input.wait_seconds), ctx.mcpReq.signal))
    return mcp
  }
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    const aborted = new AbortController()
    const disconnect = () => aborted.abort()
    req.once('aborted', disconnect); res.once('close', disconnect)
    const timer = setTimeout(() => { json(res, 504, { error: 'Request timed out' }); aborted.abort() }, REQUEST_MS)
    let mcp: McpServer | undefined
    let counted = false
    void (async () => {
      const origin = header(req, 'origin')
      if (config.authMode === 'private-tunnel') {
        // Check the listener too: a wildcard bind is forbidden even when this connection is local.
        const authority = privateTunnelAuthority(config, server.address(), req.socket)
        if (!authority || header(req, 'host') !== authority || (origin !== undefined && origin !== `http://${authority}` && origin !== 'https://chatgpt.com')) throw new HTTPFailure(403)
      } else {
        if (header(req, 'host') !== host || (origin !== undefined && !allowedOrigins.has(origin))) throw new HTTPFailure(403)
      }
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin') }
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
      if (requests >= MAX_REQUESTS) throw new HTTPFailure(503)
      requests++; counted = true
      const path = req.url ?? ''
      if (config.authMode === 'private-tunnel' && (path === '/.well-known/oauth-protected-resource' || path.startsWith('/files/'))) throw new HTTPFailure(404)
      if (req.method === 'GET' && path === '/health') { json(res, 200, { ok: true }); return }
      if (config.authMode === 'oauth' && req.method === 'GET' && path === '/.well-known/oauth-protected-resource') { json(res, 200, protectedResourceMetadata(config)); return }
      if (req.method === 'OPTIONS' && origin && (path === '/mcp' || fileRoute.test(path))) {
        res.writeHead(204, { 'Access-Control-Allow-Methods': path === '/mcp' ? 'POST' : 'GET', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version' }); res.end(); return
      }
      const capability = fileRoute.exec(path)?.[1]
      if (capability && req.method === 'GET') {
        if (!config.httpDownloads) throw new HTTPFailure(404)
        // This route has no generic URL/path proxy: only the service validates the short-lived bearer capability.
        let download: Awaited<ReturnType<EdgeService['download']>>
        try { download = await waitFor(operate(() => service.download(capability)), [aborted.signal]) } catch (error) {
          if (error instanceof McpError) throw error
          throw new HTTPFailure(404)
        }
        const file = fileSchema.parse(download.file)
        if (download.bytes.byteLength !== file.size || hashBytes(download.bytes) !== file.sha256) throw new HTTPFailure(500)
        res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.size, 'Content-Disposition': contentDisposition(file.name), 'X-Content-SHA256': file.sha256 })
        res.end(download.bytes); return
      }
      if (path !== '/mcp') throw new HTTPFailure(404)
      let principal: Principal
      if (config.authMode === 'private-tunnel') principal = owner
      else {
        if (!oauthAuthenticator) throw new HTTPFailure(500)
        principal = await waitFor(oauthAuthenticator.authenticate(header(req, 'authorization')), [aborted.signal])
      }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new HTTPFailure(405) }
      const parsed = await body(req, aborted.signal)
      mcp = mcpServer(principal, aborted.signal, parsed)
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await mcp.connect(transport)
      await waitFor(transport.handleRequest(req, res, parsed), [aborted.signal])
    })().catch(error => {
      if (res.destroyed || res.writableEnded) return
      if (res.headersSent) { res.destroy(); return }
      const status = error instanceof AuthenticationError || error instanceof HTTPFailure || error instanceof McpError ? error.status : 500
      if (status === 401 && config.authMode === 'oauth') res.setHeader('WWW-Authenticate', authChallenge(config))
      res.setHeader('Connection', 'close')
      json(res, status, error instanceof McpError ? { error: { code: error.code, message: error.message } }
        : { error: status === 401 ? 'Authentication required' : status === 403 ? 'Access denied' : 'Request refused' })
    }).finally(async () => {
      clearTimeout(timer); req.off('aborted', disconnect); res.off('close', disconnect)
      if (counted) requests--
      await mcp?.close().catch(() => {})
    })
  })
  server.headersTimeout = 10_000; server.requestTimeout = 10_000; server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 32; server.maxRequestsPerSocket = 64; server.maxConnections = 64
  return server
}
