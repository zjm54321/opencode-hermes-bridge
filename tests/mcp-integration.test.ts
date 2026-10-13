import { expect, test } from 'bun:test'
import { request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { configuredPrincipal, mcpConfig } from '../mcp/config.js'
import { createMcpHttpServer } from '../mcp/http.js'
import { McpBridgeService } from '../mcp/service.js'
import type { PublicResult } from '../mcp/contracts.js'
import { hashBytes } from '../src/protocol.js'
import { withFixture } from './integration/harness.js'

test('private MCP tools → real local Bridge/GatewayRunner/file plugin → Resources preserves ZIP and one native run across restart', async () => {
  await withFixture(async h => {
    const original = await readFile(h.nativeZip)
    const config = mcpConfig({ HERMES_MCP_PRIVATE_OWNER: 'integration-owner', HERMES_MCP_TUNNEL_ID: `tunnel_${'c'.repeat(32)}`,
      HERMES_MCP_STATE_DIR: join(h.root, 'mcp-state'), HERMES_MCP_FILE_ORIGINS: '["https://files.example.test"]' })
    const input = { request_id: randomUUID(), text: 'Return the original ZIP without extracting it.', wait_seconds: 5, require_files: true,
      file: { file_id: 'file-1', download_url: 'https://files.example.test/input?signature=first', file_name: 'native-original.zip', mime_type: 'application/zip' } }
    let imports = 0, id = 0
    const start = async () => {
      const service = await McpBridgeService.open({
        stateDirectory: config.stateDirectory, allowedPrincipal: configuredPrincipal(config),
        bridgeConfig: { url: h.url, token: h.token, uploadRoots: [], directory: h.root, outputDir: join(h.root, 'outputs'), pollMs: 10, httpTimeoutMs: 2000, jobTimeoutMs: 30_000 },
        // Only platform-file retrieval is substituted; real ingress boundaries have a separate focused test.
        downloadFile: async ref => { imports++; return { file_id: ref.file_id, name: 'native-original.zip', mime: 'application/zip', bytes: original } },
      })
      const server = createMcpHttpServer(config, service)
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
      return {
        rpc: (method: string, params?: unknown) => new Promise<string>((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port: address.port, path: '/mcp', method: 'POST', agent: false,
            headers: { Host: `127.0.0.1:${address.port}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25' } }, res => {
            const chunks: Buffer[] = []; res.on('data', b => chunks.push(Buffer.from(b))); res.on('error', reject)
            res.on('end', () => res.statusCode === 200 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error(`Fixture HTTP ${res.statusCode}`)))
          })
          req.on('error', reject); req.setTimeout(10_000, () => req.destroy(new Error('Fixture timeout')))
          req.end(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }))
        }),
        close: async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }); await service.close() },
      }
    }
    let edge = await start()
    const call = async (name: string, args: unknown) => {
      const raw = await edge.rpc('tools/call', { name, arguments: args }), reply = JSON.parse(raw)
      if (reply.error || reply.result?.isError) throw new Error(`Fixture ${name} failed`)
      return { raw, result: reply.result.structuredContent as PublicResult, content: reply.result.content }
    }
    try {
      const initialized = JSON.parse(await edge.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }))
      expect(initialized.result.capabilities.resources).toBeDefined()
      const tools = JSON.parse(await edge.rpc('tools/list')).result.tools as { name: string; _meta?: Record<string, unknown> }[]
      expect(tools.map(tool => tool.name)).toEqual(['hermes_submit', 'hermes_status', 'hermes_result'])
      expect(tools[0]?._meta?.['openai/fileParams']).toEqual(['file'])
      const submitted = await call('hermes_submit', input), file = submitted.result.files![0]!
      expect(submitted.result).toMatchObject({ status: 'completed', final: true })
      expect(file).toMatchObject({ size: original.length, sha256: hashBytes(original), mime: 'application/zip' })
      expect(submitted.content).toContainEqual({ type: 'resource_link', uri: file.uri, name: file.name, mimeType: file.mime, size: file.size })
      expect(submitted.raw).not.toContain(h.root)
      expect(submitted.raw).not.toContain(h.token)
      expect(submitted.raw).not.toContain(original.toString('base64'))
      expect((await call('hermes_status', { job_id: submitted.result.job_id })).result.status).toBe('completed')
      const read = async () => JSON.parse(await edge.rpc('resources/read', { uri: file.uri })).result.contents[0]
      expect(Buffer.from((await read()).blob, 'base64')).toEqual(original)
      await edge.close(); edge = await start()
      const retried = await call('hermes_submit', { ...input, file: { ...input.file, download_url: 'https://files.example.test/input?signature=renewed' } })
      expect(retried.result.job_id).toBe(submitted.result.job_id)
      expect((await call('hermes_result', { job_id: submitted.result.job_id })).result.files![0]!.uri).toBe(file.uri)
      expect(hashBytes(Buffer.from((await read()).blob, 'base64'))).toBe(file.sha256)
      const native = await h.nativeStats()
      expect(native.native_posts).toBe(1)
      expect(native.plugin_calls).toEqual(['bridge_files', 'bridge_publish_file'])
      expect(native.http.filter(c => c.method === 'GET' && c.path.endsWith(`/assets/${file.asset_id}`))).toHaveLength(1)
      expect(imports).toBe(1)
      const saved = await readFile(join(config.stateDirectory, 'state.json'), 'utf8')
      expect(saved).not.toContain('signature=')
      expect(saved).not.toContain(h.token)
    } finally { await edge.close() }
  }, { nativeFiles: true })
}, 30_000)
