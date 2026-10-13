import { expect, test } from 'bun:test'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/server'
import { JwtAuthenticator } from '../mcp/auth.js'
import { configuredPrincipal, mcpConfig } from '../mcp/config.js'
import type { PublicResult, SubmitInput } from '../mcp/contracts.js'
import { createMcpHttpServer } from '../mcp/http.js'
import { McpBridgeService, type McpBridgeOptions } from '../mcp/service.js'
import { hashBytes } from '../src/protocol.js'
import { withFixture } from './integration/harness.js'

for (const authMode of ['oauth', 'private-tunnel'] as const) {
test(`${authMode} MCP → actual Bridge/GatewayRunner/file plugin → native ZIP resource survives restart with one run`, async () => {
  await withFixture(async h => {
    const original = await readFile(h.nativeZip)
    expect(original.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(original.includes(Buffer.from([0x00, 0xff, 0xfe]))).toBe(true)
    const digest = hashBytes(original)
    const config = mcpConfig({
      HERMES_MCP_AUTH_MODE: authMode,
      HERMES_MCP_PRIVATE_OWNER: 'native-private-fixture-owner',
      HERMES_MCP_TUNNEL_ID: `tunnel_${'c'.repeat(32)}`,
      HERMES_MCP_PUBLIC_ORIGIN: 'https://mcp.example.test',
      HERMES_MCP_ISSUER: 'https://issuer.example.test/realm',
      HERMES_MCP_JWKS_URL: 'https://issuer.example.test/keys',
      HERMES_MCP_SUBJECT: 'native-integration-subject',
      HERMES_MCP_STATE_DIR: join(h.root, 'mcp-state'),
      HERMES_MCP_FILE_ORIGINS: '["https://files.example.test"]',
    })
    let authenticator: JwtAuthenticator | undefined
    let token: ((subject?: string) => Promise<string>) | undefined
    if (config.authMode === 'oauth') {
      const oauth = config
      const pair = await generateKeyPair('ES256')
      const jwk = await exportJWK(pair.publicKey)
      authenticator = new JwtAuthenticator(oauth, createLocalJWKSet({ keys: [{ ...jwk, kid: 'native-fixture-key', alg: 'ES256' }] }))
      token = (subject = oauth.allowedSubject) => new SignJWT({
        iss: oauth.issuer, sub: subject, aud: oauth.resource,
        exp: Math.floor(Date.now() / 1000) + 300, scope: 'hermes:use',
      }).setProtectedHeader({ alg: 'ES256', kid: 'native-fixture-key' }).sign(pair.privateKey)
    }
    const goodToken = await token?.()
    const input: SubmitInput = {
      request_id: 'ba0299e6-84ba-4fe5-a0cc-2f0b4e0c31bf',
      text: 'Return the original ZIP through the file tools without extracting it.',
      file: { file_id: 'file-fixture', download_url: 'https://files.example.test/zip?signature=first',
        file_name: 'native-original.zip', mime_type: 'application/zip' },
      require_files: true, wait_seconds: 5,
    }
    let imports = 0
    const serviceOptions: McpBridgeOptions = {
      bridgeConfig: { url: h.url, token: h.token, uploadRoots: [], directory: h.root,
        outputDir: join(h.root, 'mcp-outputs'), pollMs: 10, httpTimeoutMs: 2000, jobTimeoutMs: 30_000 },
      stateDirectory: config.stateDirectory, publicOrigin: config.publicOrigin,
      allowedPrincipal: configuredPrincipal(config),
      // The sole file-boundary substitution: platform HTTPS reference retrieval.
      // SSRF/TLS/DNS enforcement belongs to edge tests; no ChatGPT binding claim.
      downloadFile: async ref => {
        imports++
        expect(ref).toEqual(input.file!)
        return { file_id: ref.file_id, name: 'native-original.zip', mime: 'application/zip', bytes: original }
      },
    }
    const start = async () => {
      const service = await McpBridgeService.open(serviceOptions)
      const server = createMcpHttpServer(config, service, authenticator)
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
        })
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing fixture MCP listener')
        let closeWork: Promise<void> | undefined
        return {
          request: (path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
            new Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer; text: string }>((resolve, reject) => {
              // Test-only loopback transport with the production HTTPS public Host.
              // No TLS bypass or localhost allowance is added to production code.
              const req = httpRequest({ host: '127.0.0.1', port: address.port, path,
                method: options.method ?? 'GET', agent: false,
                headers: { Host: config.authMode === 'private-tunnel' ? `127.0.0.1:${address.port}` : new URL(config.publicOrigin).host, ...options.headers },
              }, res => {
                const chunks: Buffer[] = []
                res.on('data', chunk => chunks.push(Buffer.from(chunk)))
                res.once('error', reject)
                res.once('aborted', () => reject(new Error('Fixture MCP response aborted')))
                res.once('end', () => {
                  const bytes = Buffer.concat(chunks)
                  resolve({ status: res.statusCode!, headers: res.headers, bytes, text: bytes.toString('utf8') })
                })
              })
              req.setTimeout(10_000, () => req.destroy(new Error('Fixture MCP HTTP timeout')))
              req.once('error', reject)
              req.end(options.body)
            }),
          close: () => closeWork ??= (async () => {
            try {
              await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve())
                server.closeAllConnections()
              })
            } finally { await service.close() }
          })(),
        }
      } catch (error) {
        server.closeAllConnections()
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
        await service.close()
        throw error
      }
    }
    let edge = await start(), id = 0
    const rpc = (method: string, params?: unknown, bearer = goodToken) => edge.request('/mcp', {
      method: 'POST', headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) }),
    })
    const initialize = async () => {
      const response = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'native-fixture', version: '1' } })
      expect(response.status).toBe(200)
      expect(JSON.parse(response.text).result.protocolVersion).toBe('2025-11-25')
      expect(JSON.parse(response.text).result.capabilities.resources).toBeDefined()
      expect(response.headers['mcp-session-id']).toBeUndefined()
    }
    const call = async (name: string, args: unknown) => {
      const response = await rpc('tools/call', { name, arguments: args })
      expect(response.status).toBe(200)
      const envelope = JSON.parse(response.text) as { error?: unknown; result: CallToolResult }
      expect(envelope.error).toBeUndefined()
      expect(envelope.result.isError).not.toBe(true)
      return { response, result: envelope.result, dto: envelope.result.structuredContent as unknown as PublicResult }
    }
    try {
      await initialize()
      const listed = await rpc('tools/list')
      expect(listed.status).toBe(200)
      const tools = (JSON.parse(listed.text) as { result: ListToolsResult }).result.tools
      expect(tools.map(tool => tool.name)).toEqual(['hermes_submit', 'hermes_status', 'hermes_result'])
      expect(tools[0]!._meta?.['openai/fileParams']).toEqual(['file'])
      expect(tools[0]!.inputSchema.required).toContain('request_id')
      expect(tools[0]!.inputSchema.properties?.file).toBeDefined()
      const submitted = await call('hermes_submit', input)
      expect(submitted.dto).toMatchObject({ status: 'completed', final: true, text: 'Original ZIP published through the file plugin.' })
      expect(submitted.dto.files).toHaveLength(1)
      const file = submitted.dto.files![0]!
      expect(file).toMatchObject({ name: 'native-returned.zip', mime: 'application/zip', size: original.length, sha256: digest })
      expect(file.uri).toBe(`hermes://jobs/${submitted.dto.job_id}/assets/${file.asset_id}`)
      expect(file.url).toBeUndefined()
      expect(file.expires_at).toBeUndefined()
      expect(submitted.result.content).toContainEqual({ type: 'resource_link', uri: file.uri, name: file.name, mimeType: file.mime, size: file.size })
      expect(submitted.result.content.every(part => part.type === 'text' || part.type === 'resource_link')).toBe(true)
      for (const forbidden of [h.root, '"path"', h.url, h.token, input.file!.download_url, 'signature=first', original.toString('base64'), 'data:application/zip', 'private-tunnel.invalid']) {
        expect(submitted.response.text).not.toContain(forbidden)
      }
      const publicStatus = await call('hermes_status', { job_id: submitted.dto.job_id })
      expect(publicStatus.dto).toMatchObject({ job_id: submitted.dto.job_id, thread_id: submitted.dto.thread_id, status: 'completed', final: true })
      const downloaded = await rpc('resources/read', { uri: file.uri })
      expect(downloaded.status).toBe(200)
      const contents = JSON.parse(downloaded.text).result.contents
      expect(contents).toEqual([{ uri: file.uri, mimeType: 'application/zip', blob: original.toString('base64') }])
      expect(Buffer.from(contents[0].blob, 'base64')).toEqual(original)
      expect(hashBytes(Buffer.from(contents[0].blob, 'base64'))).toBe(digest)
      const native = await h.nativeStats()
      expect(native.runner).toBe('GatewayRunner')
      expect(native.plugin_module.endsWith('/integrations/hermes_file_plugin/__init__.py')).toBe(true)
      expect(native.plugin.error).toBeUndefined()
      expect(native.native_posts).toBe(1)
      expect(native.native_job_ids).toEqual([submitted.dto.job_id])
      expect(native.plugin_calls).toEqual(['bridge_files', 'bridge_publish_file'])
      expect(native.plugin.input).toMatchObject({ name: 'native-original.zip', mime: 'application/zip', size: original.length, sha256: digest })
      expect(native.plugin.published).toMatchObject({ asset_id: file.asset_id, name: file.name, mime: file.mime, size: file.size, sha256: file.sha256 })
      expect(await readFile(native.plugin.input!.path)).toEqual(original)
      expect(await readFile(join(native.plugin.workspace!, 'native-returned.zip'))).toEqual(original)
      expect(native.native_requests).toHaveLength(1)
      expect(native.native_requests[0]!.input).toContain('bridge_files')
      expect(native.native_requests[0]!.input).not.toContain(original.toString('base64'))
      expect(imports).toBe(1)
      expect((await stat(config.stateDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(config.stateDirectory, 'state.json'))).mode & 0o777).toBe(0o600)
      await edge.close()
      edge = await start()
      await initialize()
      const retried = await call('hermes_submit', { ...input, file: { ...input.file!, download_url: 'https://files.example.test/zip?signature=refreshed' } })
      expect(retried.dto).toMatchObject({ job_id: submitted.dto.job_id, thread_id: submitted.dto.thread_id, status: 'completed', final: true })
      expect(imports).toBe(1)
      const oldDownloaded = await rpc('resources/read', { uri: file.uri })
      expect(oldDownloaded.status).toBe(200)
      expect(JSON.parse(oldDownloaded.text).result.contents).toEqual(contents)
      const renewed = await call('hermes_result', { job_id: submitted.dto.job_id, wait_seconds: 5 })
      expect(renewed.dto).toMatchObject({ job_id: submitted.dto.job_id, thread_id: submitted.dto.thread_id, status: 'completed', final: true })
      expect(renewed.dto.files![0]!.asset_id).toBe(file.asset_id)
      expect(renewed.dto.files![0]!.uri).toBe(file.uri)
      const freshDownloaded = await rpc('resources/read', { uri: renewed.dto.files![0]!.uri })
      expect(freshDownloaded.status).toBe(200)
      expect(JSON.parse(freshDownloaded.text).result.contents).toEqual(contents)
      if (token) {
        const denied = await rpc('resources/read', { uri: file.uri }, await token('wrong-subject'))
        expect(denied.status).toBe(403)
      }
      const repeated = await h.nativeStats()
      expect(repeated.native_posts).toBe(1)
      expect(repeated.native_job_ids).toEqual([submitted.dto.job_id])
      expect(repeated.plugin_calls).toEqual(native.plugin_calls)
      expect(repeated.native_requests).toEqual(native.native_requests)
      expect(repeated.http.filter(request => request.method === 'GET' && request.path === `/v1/jobs/${submitted.dto.job_id}/assets/${file.asset_id}`)).toHaveLength(1)
      expect(imports).toBe(1)
      const persisted = await readFile(join(config.stateDirectory, 'state.json'), 'utf8')
      expect(JSON.parse(persisted).capabilities).toEqual({})
      for (const forbidden of [h.token, ...(goodToken ? [goodToken] : []), 'signature=first', 'signature=refreshed', 'download_url']) expect(persisted).not.toContain(forbidden)
    } finally { await edge.close() }
  }, { nativeFiles: true })
}, 30_000)
}
