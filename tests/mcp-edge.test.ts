import { expect, spyOn, test } from 'bun:test'
import { request, IncomingMessage, type ClientRequest } from 'node:http'
import { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import type { RequestOptions } from 'node:https'
import type { DetailedPeerCertificate } from 'node:tls'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { configuredPrincipal, mcpConfig } from '../mcp/config.js'
import { privateTunnelAuthority } from '../mcp/auth.js'
import { createMcpHttpServer, type EdgeService } from '../mcp/http.js'
import { createFileIngress, publicAddress, type IngressIO } from '../mcp/file-ingress.js'
import { McpBridgeService } from '../mcp/service.js'
import { LIMITS } from '../src/protocol.js'

const config = mcpConfig({ HERMES_MCP_PRIVATE_OWNER: 'fixture-owner', HERMES_MCP_TUNNEL_ID: `tunnel_${'a'.repeat(32)}`, HERMES_MCP_STATE_DIR: '/tmp/opencode/unused-edge-state' })

test('MCP trusts only its bound loopback owner, never request identity or arbitrary Host/Origin', async () => {
  const owner = configuredPrincipal(config), calls: unknown[] = []
  const result = { job_id: randomUUID(), thread_id: randomUUID(), status: 'completed', final: true }
  const service: EdgeService = {
    submit: async (principal, input) => { calls.push(principal, input); return result }, status: async () => result,
    result: async () => { throw new Error('/private/path/secret') },
    readResource: async () => { throw new Error('not used') }, close: async () => {},
  }
  const start = async (bind: string) => {
    const server = createMcpHttpServer(config, service)
    await new Promise<void>(resolve => server.listen(0, bind, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
    const authority = `127.0.0.1:${address.port}`
    return {
      call: (path: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: address.port, path, method: body ? 'POST' : 'GET', agent: false,
          headers: { Host: authority, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25', ...headers } }, res => {
          const chunks: Buffer[] = []; res.on('data', b => chunks.push(Buffer.from(b)))
          res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString() })); res.on('error', reject)
        }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined)
      }),
      close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }),
    }
  }
  const h = await start('127.0.0.1')
  try {
    const input = { request_id: randomUUID(), text: 'same owner' }
    const reply = await h.call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hermes_submit', arguments: input } }, { Authorization: 'ignored', 'X-Forwarded-User': 'attacker', 'Cf-Access-Jwt-Assertion': 'ignored' })
    expect(JSON.parse(reply.text).result.structuredContent).toEqual(result)
    expect(calls).toEqual([owner, input])
    expect((await h.call('/health', undefined, { Host: 'attacker.test' })).status).toBe(403)
    expect((await h.call('/health', undefined, { Origin: 'https://chatgpt.com.evil.test' })).status).toBe(403)
    expect((await h.call('/.well-known/oauth-protected-resource')).status).toBe(404)
    expect((await h.call('/files/retired-link')).status).toBe(404)
    const failed = await h.call('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hermes_result', arguments: { job_id: result.job_id } } })
    expect(JSON.parse(failed.text).result.isError).toBe(true)
    expect(failed.text).not.toContain('/private/')
    expect((await h.call('/mcp', { value: 'x'.repeat(128 * 1024) })).status).toBe(413)
  } finally { await h.close() }
  const wildcard = await start('0.0.0.0')
  try { expect((await wildcard.call('/health')).status).toBe(403) } finally { await wildcard.close() }
  const bound = { address: '127.0.0.1', family: 'IPv4', port: 8790 }
  expect(privateTunnelAuthority(config, bound, { localAddress: '::ffff:127.0.0.1', remoteAddress: '::ffff:127.0.0.1' })).toBe('127.0.0.1:8790')
  expect(privateTunnelAuthority(config, bound, { localAddress: '127.0.0.1', remoteAddress: '10.0.0.1' })).toBeUndefined()
  expect(() => mcpConfig({})).toThrow('PRIVATE_OWNER')
})

test('file imports pin public DNS and TLS; rejected origins, redirects and oversized bytes create no job', async () => {
  const root = await mkdtemp('/tmp/opencode/mcp-ingress-'), bytes = Buffer.from([0x50, 0x4b, 0, 255])
  let options: RequestOptions | undefined, requests = 0, upstream = 0, mixedDNS = false, status = 200, length = bytes.length
  const io: IngressIO = {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }, ...(mixedDNS ? [{ address: '169.254.169.254', family: 4 }] : [])],
    request: (provided, callback) => {
      requests++; options = provided
      const req = new EventEmitter() as ClientRequest
      req.destroy = () => req
      req.end = (() => {
        queueMicrotask(() => { const res = new IncomingMessage(new Socket()); res.statusCode = status; res.headers = { 'content-length': String(length) }; callback(res); res.push(bytes); res.push(null) })
        return req
      }) as ClientRequest['end']
      return req
    },
  }
  const download = createFileIngress(['https://files.example.test'], io)
  const ref = { file_id: 'file-1', file_name: 'original.zip', mime_type: 'application/zip', download_url: 'https://files.example.test/input?signature=fixture' }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => { upstream++; throw new Error('No Bridge HTTP expected') }, { preconnect: () => {} }))
  let service: McpBridgeService | undefined
  try {
    expect((await download(ref)).bytes).toEqual(bytes)
    expect(options).toMatchObject({ hostname: '93.184.216.34', servername: 'files.example.test', rejectUnauthorized: true, agent: false })
    expect(options?.checkServerIdentity?.('93.184.216.34', { subjectaltname: 'DNS:attacker.test' } as DetailedPeerCertificate)).toBeInstanceOf(Error)
    expect(Object.keys(options?.headers ?? {}).map(k => k.toLowerCase())).not.toContain('authorization')
    expect(publicAddress('::ffff:8.8.8.8')).toBe(false)
    expect(publicAddress('168.63.129.16')).toBe(false)
    mixedDNS = true
    await expect(download(ref)).rejects.toThrow('failed safely')
    expect(requests).toBe(1)
    mixedDNS = false
    await expect(download({ ...ref, download_url: 'https://other.test/input' })).rejects.toThrow('origin')
    status = 302
    await expect(download(ref)).rejects.toThrow('failed safely')
    expect(requests).toBe(2) // No redirect follow-up.
    status = 200; length = bytes.length - 1
    await expect(download(ref)).rejects.toThrow('failed safely')
    length = LIMITS.file + 1
    service = await McpBridgeService.open({ stateDirectory: join(root, 'state'), allowedPrincipal: configuredPrincipal(config), downloadFile: download,
      bridgeConfig: { url: 'https://unused.invalid', token: 'fixture-token', uploadRoots: [], directory: root, outputDir: join(root, 'outputs'), pollMs: 5, httpTimeoutMs: 1000, jobTimeoutMs: 1000 } })
    await expect(service.submit(configuredPrincipal(config), { request_id: randomUUID(), text: 'reject before admission', file: ref })).rejects.toMatchObject({ code: 'file_import_failed' })
    await expect(readFile(join(root, 'state/state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(upstream).toBe(0)
  } finally { await service?.close(); fetch.mockRestore(); await rm(root, { recursive: true, force: true }) }
})
