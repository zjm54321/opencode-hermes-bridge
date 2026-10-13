import { expect, spyOn, test } from 'bun:test'
import { request as httpRequest, IncomingMessage, type ClientRequest, type IncomingHttpHeaders } from 'node:http'
import { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import type { RequestOptions } from 'node:https'
import type { DetailedPeerCertificate } from 'node:tls'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { JwtAuthenticator, privateTunnelAuthority } from '../mcp/auth.js'
import { configuredPrincipal, mcpConfig, type McpConfig } from '../mcp/config.js'
import { startMcp } from '../mcp/index.js'
import { McpBridgeService } from '../mcp/service.js'
import { createFileIngress, publicAddress, type IngressIO } from '../mcp/file-ingress.js'
import { createMcpHttpServer, type EdgeService } from '../mcp/http.js'
import { McpError, resourceURI, type Principal, type PublicFile, type PublicResult, type SubmitInput } from '../mcp/contracts.js'
import { hashBytes } from '../src/protocol.js'

const configEnv = {
  HERMES_MCP_PUBLIC_ORIGIN: 'https://mcp.example.test', HERMES_MCP_ISSUER: 'https://issuer.example.test/realm',
  HERMES_MCP_JWKS_URL: 'https://issuer.example.test/keys', HERMES_MCP_SUBJECT: 'allowed-test-subject',
  HERMES_MCP_STATE_DIR: '/tmp/opencode/mcp-edge-unused', HERMES_MCP_FILE_ORIGINS: '["https://files.example.test"]',
}
const parsedConfig = mcpConfig(configEnv)
if (parsedConfig.authMode !== 'oauth') throw new Error('Expected the default OAuth config')
const config = parsedConfig
async function identity() {
  const pair = await generateKeyPair('ES256')
  const jwk = await exportJWK(pair.publicKey)
  const authenticator = new JwtAuthenticator(config, createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'ES256' }] }))
  const token = async (patch: JWTPayload = {}, omit: string[] = []) => {
    const now = Math.floor(Date.now() / 1000)
    const claims: JWTPayload = { iss: config.issuer, sub: config.allowedSubject, aud: config.resource, exp: now + 300, scope: 'hermes:use', ...patch }
    for (const key of omit) delete claims[key]
    return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).sign(pair.privateKey)
  }
  return { authenticator, token }
}
const jobID = randomUUID()
const threadID = randomUUID()
const capability = 'fixture-short-lived-capability-0123456789'
const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xde, 0xad, 0xbe, 0xef])
const assetID = randomUUID()
const file: PublicFile = { asset_id: assetID, name: 'report ü.zip', mime: 'application/zip', size: bytes.length, sha256: hashBytes(bytes), uri: resourceURI(jobID, assetID) }
const dto: PublicResult = { job_id: jobID, thread_id: threadID, status: 'completed', final: true, text: 'Fixture Hermes reply', files: [file] }
function stub() {
  const calls: { principal: Principal; input: SubmitInput }[] = []
  const reads: { principal: Principal; uri: string }[] = []
  let poison = false
  const service: EdgeService = {
    submit: async (principal, input) => { calls.push({ principal, input }); return dto },
    status: async () => { throw new Error('/private/state/test-secret-must-not-leak') },
    result: async () => poison ? Object.assign({}, dto, { internal_path: '/private/state/test-secret-must-not-leak' }) : dto,
    readResource: async (principal, uri) => {
      reads.push({ principal, uri })
      if (poison) throw new Error('/private/state/test-secret-must-not-leak')
      if (uri !== file.uri) throw new McpError(404, 'not_found', 'Resource not found')
      return { uri, mimeType: file.mime, blob: bytes.toString('base64') }
    },
    download: async value => {
      if (value === 'expired-fixture-capability') throw new McpError(410, 'expired', 'File link expired')
      if (value !== capability) throw new Error('/private/invalid-capability')
      return { file: { ...file, url: `${config.publicOrigin}/files/${capability}`, expires_at: Date.now() + 300_000 }, bytes }
    },
    close: async () => {},
  }
  return { service, calls, reads, poison: () => { poison = true } }
}
async function listening(authenticator?: JwtAuthenticator, service = stub().service, configuration: McpConfig = config, bindHost = configuration.host) {
  const server = createMcpHttpServer(configuration, service, authenticator)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, bindHost, () => { server.off('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener')
  const authority = `${configuration.host === '::1' ? '[::1]' : configuration.host}:${address.port}`
  return {
    authority,
    request: (path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer; text: string }>((resolve, reject) => {
      const req = httpRequest({ host: configuration.host, port: address.port, path, method: options.method ?? 'GET', headers: { Host: configuration.authMode === 'private-tunnel' ? authority : new URL(configuration.publicOrigin).host, ...options.headers }, agent: false }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.once('error', reject)
        res.once('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode!, headers: res.headers, bytes, text: bytes.toString('utf8') }) })
      })
      req.once('error', reject); req.end(options.body)
    }),
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }),
  }
}

test('OAuth resource authentication: signature/claims/subject/scope and exact Host/Origin boundaries', async () => {
  const { authenticator, token } = await identity()
  const good = await token()
  // Standard OAuth JWTs need neither a custom resource claim nor nbf.
  expect(await authenticator.authenticate(`Bearer ${good}`)).toEqual({ issuer: config.issuer, subject: config.allowedSubject })
  expect(await authenticator.authenticate(`Bearer ${await token({ aud: [config.resource, 'https://another-resource.example.test'] })}`)).toEqual({ issuer: config.issuer, subject: config.allowedSubject })
  for (const [patch, missing, status] of [
    [{ iss: 'https://other.example.test' }, [], 401], [{ aud: 'https://other.example.test/mcp' }, [], 401],
    [{ aud: ['https://other.example.test'] }, [], 401],
    [{ exp: 1 }, [], 401], [{ nbf: Math.floor(Date.now() / 1000) + 3600 }, [], 401],
    [{}, ['iss'], 401], [{}, ['sub'], 401], [{}, ['aud'], 401], [{}, ['exp'], 401],
    [{ sub: 'different-subject' }, [], 403], [{ scope: 'other' }, [], 403], [{}, ['scope'], 403],
  ] as [JWTPayload, string[], number][]) {
    await expect(authenticator.authenticate(`Bearer ${await token(patch, missing)}`)).rejects.toMatchObject({ status })
  }
  const hs = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('test-only-symmetric-key-never-accepted'))
  for (const invalid of ['Basic abc', `Bearer ${hs}`, `Bearer ${good.slice(0, good.lastIndexOf('.') + 1)}invalid`, 'Bearer eyJhbGciOiJub25lIn0.e30.']) {
    await expect(authenticator.authenticate(invalid)).rejects.toMatchObject({ status: 401 })
  }
  expect(() => mcpConfig({})).toThrow('HERMES_MCP_PUBLIC_ORIGIN')
  expect(config.httpDownloads).toBe(false)
  expect(mcpConfig({ ...configEnv, HERMES_MCP_HTTP_DOWNLOADS: '1' }).httpDownloads).toBe(true)
  for (const value of ['true', 'false', '2', '', ' 1']) expect(() => mcpConfig({ ...configEnv, HERMES_MCP_HTTP_DOWNLOADS: value })).toThrow('HERMES_MCP_HTTP_DOWNLOADS')
  for (const url of ['http://mcp.example.test', 'https://u:p@mcp.example.test', 'https://mcp.example.test/#', 'https://mcp.example.test/path']) {
    expect(() => mcpConfig({ HERMES_MCP_PUBLIC_ORIGIN: url })).toThrow()
  }
  const h = await listening(authenticator)
  try {
    const unauth = await h.request('/mcp')
    expect(unauth.status).toBe(401)
    expect(unauth.headers['www-authenticate']).toBe(`Bearer resource_metadata="${config.publicOrigin}/.well-known/oauth-protected-resource", scope="hermes:use"`)
    expect((await h.request('/mcp', { headers: { Cookie: `access_token=${good}` } })).status).toBe(401)
    expect((await h.request(`/mcp?access_token=${good}`)).status).not.toBe(200)
    const invalidHeaders: Record<string, string>[] = [{ Host: 'attacker.example.test' }, { Host: `${new URL(config.publicOrigin).host}:444` }, { Origin: 'https://chatgpt.com.evil.test' }, { Origin: 'http://chatgpt.com' }]
    for (const headers of invalidHeaders) {
      expect((await h.request('/health', { headers })).status).toBe(403)
    }
    expect((await h.request('/mcp', { headers: { 'X-Forwarded-User': config.allowedSubject, 'X-Forwarded-Authorization': `Bearer ${good}` } })).status).toBe(401)
    const metadata = await h.request('/.well-known/oauth-protected-resource')
    expect(JSON.parse(metadata.text)).toEqual({ resource: config.resource, authorization_servers: [config.issuer], scopes_supported: ['hermes:use'], bearer_methods_supported: ['header'] })
    expect(JSON.parse((await h.request('/health')).text)).toEqual({ ok: true })
    const forbidden = await h.request('/mcp', { headers: { Authorization: `Bearer ${await token({ sub: 'wrong' })}` } })
    expect(forbidden.status).toBe(403)
    expect(forbidden.text).not.toContain(good)
  } finally { await h.close() }
})

const privateEnv = {
  HERMES_MCP_AUTH_MODE: 'private-tunnel', HERMES_MCP_PRIVATE_OWNER: 'fixture-owner',
  HERMES_MCP_TUNNEL_ID: `tunnel_${'a'.repeat(32)}`, HERMES_MCP_STATE_DIR: '/tmp/opencode/mcp-private-unused',
  HERMES_MCP_FILE_ORIGINS: '["https://files.example.test"]',
}

test('private tunnel is a fixed-owner loopback trust domain, without JWT/JWKS or public discovery', async () => {
  const privateConfig = mcpConfig(privateEnv)
  if (privateConfig.authMode !== 'private-tunnel') throw new Error('Expected private mode')
  const owner = configuredPrincipal(privateConfig)
  expect(owner).toEqual({ issuer: 'urn:hermes-mcp:private-tunnel:v1', subject: hashBytes(Buffer.from(JSON.stringify(['fixture-owner', privateEnv.HERMES_MCP_TUNNEL_ID]))) })
  expect(config.authMode).toBe('oauth')
  expect(privateConfig.httpDownloads).toBe(false)
  expect('jwksURL' in privateConfig).toBe(false)
  expect('issuer' in privateConfig).toBe(false)
  expect(configuredPrincipal(mcpConfig({ ...privateEnv, OPENAI_API_KEY: 'fixture-key-rotation-not-an-identity' }))).toEqual(owner)
  for (const mode of ['', 'none', 'PRIVATE-TUNNEL']) expect(() => mcpConfig({ ...privateEnv, HERMES_MCP_AUTH_MODE: mode })).toThrow('HERMES_MCP_AUTH_MODE')
  for (const key of ['HERMES_MCP_PRIVATE_OWNER', 'HERMES_MCP_TUNNEL_ID']) {
    for (const value of [undefined, '', ' ', 'x\ny', 'x\u0085y', 'a'.repeat(257)]) expect(() => mcpConfig({ ...privateEnv, [key]: value })).toThrow()
  }
  for (const host of ['0.0.0.0', '::', 'localhost', '127.0.0.2', '::ffff:127.0.0.1']) expect(() => mcpConfig({ ...privateEnv, HERMES_MCP_HOST: host })).toThrow()
  for (const tunnelID of ['fixture-tunnel', `tunnel_${'A'.repeat(32)}`, `tunnel_${'a'.repeat(31)}`]) expect(() => mcpConfig({ ...privateEnv, HERMES_MCP_TUNNEL_ID: tunnelID })).toThrow('HERMES_MCP_TUNNEL_ID')
  expect(() => mcpConfig({ ...privateEnv, HERMES_MCP_HTTP_DOWNLOADS: '1' })).toThrow('HTTP_DOWNLOADS=0')
  expect(() => mcpConfig({ ...privateEnv, HERMES_MCP_PORT: '0' })).toThrow('HERMES_MCP_PORT')
  const bound = { address: '127.0.0.1', family: 'IPv4', port: 8790 }
  expect(privateTunnelAuthority(privateConfig, bound, { localAddress: '::ffff:127.0.0.1', remoteAddress: '::ffff:127.0.0.1' })).toBe('127.0.0.1:8790')
  for (const socket of [{ localAddress: '10.0.0.1', remoteAddress: '127.0.0.1' }, { localAddress: '127.0.0.1', remoteAddress: '::ffff:10.0.0.1' }, { localAddress: undefined, remoteAddress: undefined }]) expect(privateTunnelAuthority(privateConfig, bound, socket)).toBeUndefined()
  expect(privateTunnelAuthority(privateConfig, { ...bound, address: '0.0.0.0' }, { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' })).toBeUndefined()
  let outgoing = 0
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => { outgoing++; throw new Error('No private-mode JWKS or sentinel HTTP') }, { preconnect: () => {} }))
  try {
    for (const host of ['127.0.0.1', '::1']) {
      const configured = mcpConfig({ ...privateEnv, HERMES_MCP_HOST: host })
      const fake = stub()
      const h = await listening(undefined, fake.service, configured)
      const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25' }
      let id = 0
      const rpc = (method: string, params?: unknown, extraHeaders: Record<string, string> = {}) => h.request('/mcp', { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }) })
      try {
        const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'private-fixture', version: '1' } })
        expect(init.status).toBe(200)
        expect(init.headers['www-authenticate']).toBeUndefined()
        expect(init.text).not.toContain('private-tunnel.invalid')
        expect(JSON.parse((await rpc('tools/list')).text).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['hermes_submit', 'hermes_status', 'hermes_result'])
        const input = { request_id: randomUUID(), text: 'fixed private owner', wait_seconds: 0 }
        const submitted = await rpc('tools/call', { name: 'hermes_submit', arguments: input }, {
          Authorization: 'Bearer invalid-and-ignored', 'X-Forwarded-User': 'attacker', 'X-Forwarded-Host': 'attacker.test',
          'Cf-Access-Authenticated-User-Email': 'attacker@example.test', 'Cf-Access-Jwt-Assertion': 'not-an-identity',
        })
        expect(JSON.parse(submitted.text).result.structuredContent).toEqual(dto)
        expect(fake.calls).toEqual([{ principal: owner, input }])
        const read = await rpc('resources/read', { uri: file.uri })
        expect(JSON.parse(read.text).result.contents).toEqual([{ uri: file.uri, mimeType: file.mime, blob: bytes.toString('base64') }])
        expect(fake.reads).toEqual([{ principal: owner, uri: file.uri }])
        for (const path of ['/.well-known/oauth-protected-resource', `/files/${capability}`]) {
          const response = await h.request(path)
          expect(response.status).toBe(404)
          expect(response.headers['www-authenticate']).toBeUndefined()
          expect(response.text).not.toContain('private-tunnel.invalid')
        }
        const rejected: Record<string, string>[] = [{ Host: 'attacker.test' }, { Host: `localhost:${h.authority.split(':').at(-1)}` }, { Origin: 'https://chatgpt.com.evil.test' }, { Origin: 'http://attacker.test' }]
        for (const bad of rejected) expect((await h.request('/health', { headers: bad })).status).toBe(403)
        expect((await h.request('/health', { headers: { Origin: `http://${h.authority}` } })).status).toBe(200)
        expect((await h.request('/health', { headers: { Origin: 'https://chatgpt.com' } })).status).toBe(200)
      } finally { await h.close() }
    }
    const wildcard = await listening(undefined, stub().service, privateConfig, '0.0.0.0')
    try {
      for (const path of ['/health', '/mcp', '/.well-known/oauth-protected-resource', `/files/${capability}`]) {
        const response = await wildcard.request(path)
        expect(response.status).toBe(403)
        expect(response.headers['www-authenticate']).toBeUndefined()
      }
    } finally { await wildcard.close() }
    expect(outgoing).toBe(0)
  } finally { fetch.mockRestore() }
})

test('private owner state survives restart; mode/owner/tunnel changes fail before Bridge HTTP or state rebinding', async () => {
  const root = await mkdtemp('/tmp/opencode/hermes-private-state-')
  const jobs = new Map<string, unknown>()
  let requests = 0
  let posts = 0
  const backend = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    requests++
    const url = new URL(request.url)
    if (url.pathname === '/v1/capabilities') return new Response(null, { status: 404 })
    if (request.method === 'POST' && url.pathname === '/v1/jobs') {
      posts++
      const input = await request.json() as { id: string }
      jobs.set(input.id, { id: input.id, status: 'completed', text: 'private fixture done', attachments: [], error: null })
      return Response.json({ id: input.id }, { status: 202 })
    }
    const job = jobs.get(url.pathname.split('/').at(-1)!)
    return job ? Response.json(job) : new Response(null, { status: 404 })
  } })
  const env = { ...privateEnv, HERMES_MCP_STATE_DIR: join(root, 'state'), HERMES_BRIDGE_URL: backend.url.origin,
    HERMES_BRIDGE_TOKEN: 'private-test-bridge-token', HERMES_BRIDGE_OUTPUT_DIR: join(root, 'outputs') }
  const privateConfig = mcpConfig(env)
  const owner = configuredPrincipal(privateConfig)
  let service: McpBridgeService | undefined
  const open = () => McpBridgeService.open({
    bridgeConfig: { url: backend.url.origin, token: env.HERMES_BRIDGE_TOKEN, directory: root, outputDir: env.HERMES_BRIDGE_OUTPUT_DIR,
      uploadRoots: [], pollMs: 5, httpTimeoutMs: 1000, jobTimeoutMs: 30_000 },
    stateDirectory: privateConfig.stateDirectory, publicOrigin: privateConfig.publicOrigin, allowedPrincipal: owner,
    downloadFile: async () => { throw new Error('No file import in state fixture') }, httpDownloads: false,
  })
  try {
    const input = { request_id: randomUUID(), text: 'persist private request', wait_seconds: 1 }
    service = await open()
    const first = await service.submit(owner, input)
    expect(first.status).toBe('completed')
    expect(posts).toBe(1)
    await service.close()
    service = await open()
    expect(await service.submit(owner, input)).toEqual(first)
    expect(posts).toBe(1)
    await service.close(); service = undefined
    const saved = await readFile(join(root, 'state/state.json'))
    const before = requests
    for (const change of [
      { HERMES_MCP_PRIVATE_OWNER: 'another-owner' }, { HERMES_MCP_TUNNEL_ID: `tunnel_${'b'.repeat(32)}` },
      { HERMES_MCP_AUTH_MODE: 'oauth', ...configEnv, HERMES_MCP_STATE_DIR: env.HERMES_MCP_STATE_DIR },
    ]) {
      // Exercise the real index startup path: owner validation precedes Bridge.start and listener creation.
      await expect((async () => {
        const unexpected = await startMcp({ ...env, ...change })
        await unexpected.close()
      })()).rejects.toThrow('Service unavailable')
      expect(await readFile(join(root, 'state/state.json'))).toEqual(saved)
      await expect(stat(join(root, 'state/writer.lock'))).rejects.toThrow()
      expect(requests).toBe(before)
    }
    expect(posts).toBe(1)
  } finally { await service?.close(); backend.stop(true); await rm(root, { recursive: true, force: true }) }
})

test('official MCP resources/read returns authenticated binary blobs; HTTP downloads are opt-in', async () => {
  const { authenticator, token } = await identity()
  const fake = stub()
  const h = await listening(authenticator, fake.service)
  const headers = { Authorization: `Bearer ${await token()}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25' }
  let id = 0
  const rpc = (method: string, params?: unknown) => h.request('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) }) })
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })
    expect(init.status).toBe(200)
    expect(JSON.parse(init.text).result.protocolVersion).toBe('2025-11-25')
    expect(JSON.parse(init.text).result.capabilities.resources).toBeDefined()
    expect(init.headers['mcp-session-id']).toBeUndefined()
    const templates = await rpc('resources/templates/list')
    expect(JSON.parse(templates.text).result.resourceTemplates).toContainEqual(expect.objectContaining({ uriTemplate: 'hermes://jobs/{job_id}/assets/{asset_id}' }))
    expect(JSON.parse((await rpc('resources/list')).text).result.resources).toEqual([])
    const listed = await rpc('tools/list')
    expect(listed.status).toBe(200)
    const tools = (JSON.parse(listed.text) as { result: ListToolsResult }).result.tools
    expect(tools.map(t => t.name)).toEqual(['hermes_submit', 'hermes_status', 'hermes_result'])
    const submit = tools[0]!
    expect(submit._meta?.['openai/fileParams']).toEqual(['file'])
    expect(submit.inputSchema.required).toContain('request_id')
    expect(submit.inputSchema.properties?.file).toBeDefined()
    expect(submit.inputSchema.properties?.files).toBeUndefined()
    expect(JSON.stringify(submit.outputSchema)).toContain('Unix time in milliseconds')
    expect(submit.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true })
    expect(tools[1]?.annotations?.readOnlyHint).toBe(true)
    expect(tools[2]?.annotations?.readOnlyHint).toBe(true)
    const input = { request_id: randomUUID(), text: 'fixture request', file: { file_id: 'file-fixture', download_url: 'https://files.example.test/original?signature=fixture' }, wait_seconds: 0 }
    const reply = await rpc('tools/call', { name: 'hermes_submit', arguments: input })
    const result = (JSON.parse(reply.text) as { result: CallToolResult }).result
    expect(result.structuredContent).toEqual(dto)
    expect(result.content).toContainEqual({ type: 'resource_link', uri: file.uri, name: file.name, mimeType: file.mime, size: file.size })
    expect(reply.text).not.toContain('/files/')
    expect(reply.text).not.toContain(bytes.toString('base64'))
    expect(reply.text).not.toContain('openaiFileResponse')
    expect(fake.calls).toEqual([{ principal: { issuer: config.issuer, subject: config.allowedSubject }, input }])
    const resource = await rpc('resources/read', { uri: file.uri })
    expect(JSON.parse(resource.text).result.contents).toEqual([{ uri: file.uri, mimeType: file.mime, blob: bytes.toString('base64') }])
    expect(fake.reads).toEqual([{ principal: { issuer: config.issuer, subject: config.allowedSubject }, uri: file.uri }])
    for (const uri of [resourceURI(randomUUID(), assetID), resourceURI(jobID, randomUUID()), `${file.uri}/../${assetID}`]) {
      const missing = await rpc('resources/read', { uri })
      // Installed SDK 2.3.1 emits -32602 on all revisions, including legacy.
      expect(JSON.parse(missing.text).error).toMatchObject({ code: -32602, message: expect.stringContaining('Resource not found') })
    }
    const readBody = JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'resources/read', params: { uri: file.uri } })
    expect((await h.request('/mcp', { method: 'POST', body: readBody, headers: { 'Content-Type': 'application/json' } })).status).toBe(401)
    expect((await h.request('/mcp', { method: 'POST', body: readBody, headers: { ...headers, Authorization: `Bearer ${await token({ sub: 'wrong' })}` } })).status).toBe(403)
    const bad = await rpc('tools/call', { name: 'hermes_submit', arguments: { text: 'missing request ID', file: { path: '/private/file' } } })
    expect(JSON.parse(bad.text).result?.isError ?? !!JSON.parse(bad.text).error).toBe(true)
    expect(fake.calls).toHaveLength(1)
    const failure = await rpc('tools/call', { name: 'hermes_status', arguments: { job_id: jobID } })
    expect(JSON.parse(failure.text).result.isError).toBe(true)
    expect(failure.text).not.toContain('/private/')
    expect(failure.text).not.toContain('test-secret')
    fake.poison()
    const brokenResource = await rpc('resources/read', { uri: file.uri })
    expect(JSON.parse(brokenResource.text).error.code).toBe(-32603)
    expect(brokenResource.text).not.toContain('/private/')
    expect(brokenResource.text).not.toContain('test-secret')
    const privateResult = await rpc('tools/call', { name: 'hermes_result', arguments: { job_id: jobID } })
    expect(JSON.parse(privateResult.text).result.isError).toBe(true)
    expect(privateResult.text).not.toContain('internal_path')
    for (const method of ['GET', 'DELETE']) expect((await h.request('/mcp', { method, headers })).status).toBe(405)
    const large = await h.request('/mcp', { method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(128 * 1024) }) })
    expect(large.status).toBe(413)
    const downloaded = await h.request(`/files/${capability}`)
    expect(downloaded.status).toBe(404)
    for (const path of ['/files/invalid-capability-value', '/files/..%2fprivate', `/files/${capability}?path=/private`, '/files/etc/passwd']) expect((await h.request(path)).status).toBe(404)
  } finally { await h.close() }
  const compatible = await listening(authenticator, fake.service, { ...config, httpDownloads: true })
  try {
    const downloaded = await compatible.request(`/files/${capability}`)
    expect(downloaded.status).toBe(200)
    expect(downloaded.bytes).toEqual(bytes)
    expect(downloaded.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-content-sha256': file.sha256, 'content-length': String(bytes.length), 'content-disposition': "attachment; filename*=UTF-8''report%20%C3%BC.zip" })
    const expired = await compatible.request('/files/expired-fixture-capability')
    expect(expired.status).toBe(410)
    expect(JSON.parse(expired.text)).toEqual({ error: { code: 'expired', message: 'File link expired' } })
    expect(expired.headers['cache-control']).toBe('no-store')
    expect((await compatible.request('/files/invalid-capability-value')).text).not.toContain('/private/')
    expect(downloaded.headers['access-control-allow-origin']).toBeUndefined()
  } finally { await compatible.close() }
  const disabled = await listening(authenticator, fake.service, { ...config, fileOrigins: [] })
  try {
    const call = (argumentsValue: unknown) => disabled.request('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hermes_submit', arguments: argumentsValue } }) })
    const before = fake.calls.length
    const refused = await call({ request_id: randomUUID(), text: 'file disabled', file: { file_id: 'file-fixture', download_url: 'https://files.example.test/original' } })
    expect(JSON.parse(refused.text).result.isError).toBe(true)
    expect(refused.text).toContain('File import is disabled')
    expect(fake.calls).toHaveLength(before)
    const textOnly = await call({ request_id: randomUUID(), text: 'text remains enabled' })
    expect(JSON.parse(textOnly.text).result.isError).not.toBe(true)
    expect(fake.calls).toHaveLength(before + 1)
  } finally { await disabled.close() }
})

test('file ingress pins public DNS and verified TLS; no proxy/redirect/private access, bounded raw bytes', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '0.0.0.0', '169.254.169.254', '100.100.100.200', '192.168.1.1', '192.0.2.1', '198.18.0.1', '168.63.129.16', '::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1', 'fe80::1', 'fc00::1', '2001:db8::1', 'ff02::1']) expect(publicAddress(address)).toBe(false)
  expect(publicAddress('93.184.216.34')).toBe(true)
  expect(publicAddress('2606:4700:4700::1111')).toBe(true)
  let resolved = 0
  let requested = 0
  let mixedDNS = false
  let status = 200
  let responseHeaders: IncomingHttpHeaders = { 'content-length': String(bytes.length) }
  let responseBytes = bytes
  let options: RequestOptions | undefined
  const io: IngressIO = {
    resolve: async () => { resolved++; return mixedDNS ? [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }] },
    request: (provided, callback) => {
      requested++; options = provided
      const request = new EventEmitter() as ClientRequest
      request.destroy = () => request
      request.end = (() => {
        queueMicrotask(() => {
          const res = new IncomingMessage(new Socket())
          res.statusCode = status; res.headers = responseHeaders
          callback(res)
          res.push(responseBytes); res.push(null)
        })
        return request
      }) as ClientRequest['end']
      return request
    },
  }
  const download = createFileIngress(config.fileOrigins, io)
  const ref = { file_id: 'file-safe', download_url: 'https://files.example.test/original?signature=fixture', file_name: 'original.zip', mime_type: 'application/zip' }
  const normalized = await download(ref)
  expect(normalized).toEqual({ file_id: ref.file_id, name: 'original.zip', mime: 'application/zip', bytes })
  expect(JSON.stringify(normalized)).not.toContain('signature')
  expect(resolved).toBe(1)
  expect(requested).toBe(1)
  expect(options).toMatchObject({ hostname: '93.184.216.34', servername: 'files.example.test', port: 443, rejectUnauthorized: true, agent: false, method: 'GET', path: '/original?signature=fixture', headers: { Host: 'files.example.test', 'Accept-Encoding': 'identity' } })
  expect(options?.checkServerIdentity).toBeFunction()
  expect(options?.checkServerIdentity?.('93.184.216.34', { subjectaltname: 'DNS:files.example.test' } as DetailedPeerCertificate)).toBeUndefined()
  expect(options?.checkServerIdentity?.('93.184.216.34', { subjectaltname: 'DNS:attacker.example.test' } as DetailedPeerCertificate)).toBeInstanceOf(Error)
  expect(options?.lookup).toBeUndefined() // Address is already pinned; there is no second hostname resolution.
  expect(Object.keys(options?.headers ?? {}).map(k => k.toLowerCase())).not.toContain('authorization')
  mixedDNS = true
  await expect(download(ref)).rejects.toThrow('failed safely')
  expect(requested).toBe(1)
  mixedDNS = false
  for (const url of ['http://files.example.test/a', 'https://files.example.test.evil.test/a', 'https://user:password@files.example.test/a', 'https://files.example.test/a#', 'https://files.example.test:8443/a', 'file:///etc/passwd']) await expect(download({ ...ref, download_url: url })).rejects.toThrow()
  await expect(createFileIngress([], io)(ref)).rejects.toThrow('disabled')
  await expect(download({ ...ref, file_name: '../escape' })).rejects.toThrow('basename')
  await expect(download({ ...ref, mime_type: 'text/plain; charset=utf8' })).rejects.toThrow('MIME')
  for (const headers of [{}, { 'content-length': String(10 * 1024 ** 2 + 1) }, { 'content-length': String(bytes.length), 'content-encoding': 'gzip' }, { 'content-length': String(bytes.length - 1) }, { 'content-length': String(bytes.length + 1) }]) {
    responseHeaders = headers
    await expect(download(ref)).rejects.toThrow('failed safely')
  }
  responseHeaders = { 'content-length': String(bytes.length), location: 'https://files.example.test/redirected' }
  status = 302
  const before = requested
  await expect(download(ref)).rejects.toThrow('failed safely')
  expect(requested).toBe(before + 1) // No follow-up request, even to the allowed origin.
  const neverDNS = createFileIngress(config.fileOrigins, { ...io, resolve: () => new Promise(() => {}) })
  await expect(neverDNS(ref)).rejects.toThrow('failed safely') // Absolute 10s deadline also covers DNS.
}, 20_000)
