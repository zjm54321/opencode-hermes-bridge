import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { McpBridgeService, type McpBridgeOptions } from '../mcp/service.js'
import { McpState, type Envelope } from '../mcp/state.js'
import { configuredPrincipal, mcpConfig } from '../mcp/config.js'
import { resourceURI } from '../mcp/contracts.js'
import { contentDisposition, hashBytes, LIMITS, type Asset, type JobRequest } from '../src/protocol.js'

const principal = configuredPrincipal(mcpConfig({ HERMES_MCP_PRIVATE_OWNER: 'core-fixture', HERMES_MCP_TUNNEL_ID: `tunnel_${'b'.repeat(32)}`, HERMES_MCP_STATE_DIR: '/tmp/opencode/unused' }))
const originalFetch = globalThis.fetch, roots: string[] = [], services: McpBridgeService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  globalThis.fetch = originalFetch
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(losePost = false) {
  const root = await mkdtemp('/tmp/opencode/mcp-core-'); roots.push(root)
  const bytes = Buffer.from([0x50, 0x4b, 0, 255, 128])
  const output: Asset = { asset_id: randomUUID(), name: 'original.bin', mime: 'application/octet-stream', size: bytes.length, sha256: hashBytes(bytes) }
  const statePath = join(root, 'state/state.json'), jobs = new Map<string, JobRequest>()
  const counts = { posts: 0, calls: 0, imports: 0, downloads: 0 }, control = { missing: false }
  const options: McpBridgeOptions = {
    stateDirectory: join(root, 'state'), allowedPrincipal: principal,
    bridgeConfig: { url: 'https://fake-bridge.invalid', token: 'fixture-bridge-secret', uploadRoots: [], directory: root, outputDir: join(root, 'outputs'), pollMs: 5, httpTimeoutMs: 1000, jobTimeoutMs: 10_000 },
    downloadFile: async ref => { counts.imports++; return { file_id: ref.file_id, name: ref.file_name!, mime: ref.mime_type!, bytes } },
  }
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    counts.calls++
    const url = new URL(String(input))
    if (url.origin !== options.bridgeConfig.url) throw new Error('Unexpected external request')
    if (url.pathname === '/v1/capabilities') return Response.json({ object: 'hermes.bridge.capabilities', version: 1, assets: true, max_asset_bytes: LIMITS.file, max_total_asset_bytes: LIMITS.total, max_assets: LIMITS.count })
    if (init?.method === 'PUT') return Response.json({ ...output, asset_id: url.pathname.split('/').at(-1) }, { status: 201 })
    if (init?.method === 'POST') {
      counts.posts++
      const job = JSON.parse(String(init.body)) as JobRequest
      const saved = JSON.parse(await readFile(statePath, 'utf8')) as Envelope
      expect(saved.coreOutbox.jobs[job.id]?.postAttempted).toBe(true)
      expect(Object.values(saved.requests).some(request => request.jobId === job.id)).toBe(true)
      jobs.set(job.id, job)
      if (losePost && counts.posts === 1) throw new Error('Accepted remotely; response lost')
      return Response.json({ id: job.id }, { status: 202 })
    }
    if (url.pathname.includes('/assets/')) {
      counts.downloads++
      return new Response(bytes, { headers: { 'Content-Type': output.mime, 'Content-Length': String(output.size), 'Content-Disposition': contentDisposition(output.name), 'X-Content-SHA256': output.sha256 } })
    }
    const id = url.pathname.split('/').at(-1)!
    return control.missing || !jobs.has(id) ? new Response(null, { status: 404 }) : Response.json({ id, status: 'completed', text: 'done', attachments: [], output_assets: [output], error: null })
  }, { preconnect: () => {} })
  const open = async (override: Partial<McpBridgeOptions> = {}) => { const service = await McpBridgeService.open({ ...options, ...override }); services.push(service); return service }
  const input = { request_id: randomUUID(), text: 'original input', file: { file_id: 'file-1', download_url: 'https://files.example/input?signature=not-persisted', file_name: output.name, mime_type: output.mime } }
  return { root, bytes, output, counts, control, options, input, open, statePath, state: async () => JSON.parse(await readFile(statePath, 'utf8')) as Envelope }
}

test('uncertain atomic admission recovers one request/job; writer and owner binding survive legacy metadata removal', async () => {
  const f = await fixture(), service = await f.open()
  await expect(f.open()).rejects.toMatchObject({ code: 'state_locked' })
  const prototype = McpState.prototype as unknown as { persist(next: Envelope): Promise<void> }, persist = prototype.persist
  prototype.persist = async function(next) { await persist.call(this, next); throw new Error('Failure after atomic rename') }
  try {
    await expect(service.submit(principal, f.input)).rejects.toMatchObject({ status: 503 })
    await expect(service.submit(principal, f.input)).rejects.toMatchObject({ status: 503 })
    expect(f.counts.calls).toBe(0)
  } finally { prototype.persist = persist; await service.close() }
  const saved = await f.state(), id = saved.requests[f.input.request_id]!.jobId
  expect(Object.keys(saved.coreOutbox.jobs)).toEqual([id])
  await writeFile(f.statePath, JSON.stringify({ ...saved, capabilities: { obsolete: {} } }))
  const restarted = await f.open()
  const results = await Promise.all([restarted.submit(principal, { ...f.input, wait_seconds: 1 }), restarted.submit(principal, f.input)])
  expect(results.map(r => r.job_id)).toEqual([id, id])
  expect(f.counts.posts).toBe(1)
  expect(f.counts.imports).toBe(1)
  await expect(restarted.submit(principal, { ...f.input, text: 'conflict' })).rejects.toMatchObject({ status: 409 })
  const current = await f.state()
  expect(Object.hasOwn(current, 'capabilities')).toBe(false)
  expect(current.owner).toBe(saved.owner)
  expect(current.requests).toEqual(saved.requests)
  expect(JSON.stringify(current)).not.toContain('signature=')
  await restarted.close()
  const before = await readFile(f.statePath)
  const calls = f.counts.calls
  await expect(f.open({ allowedPrincipal: { ...principal, subject: 'another-owner' } })).rejects.toMatchObject({ status: 503 })
  expect(await readFile(f.statePath)).toEqual(before)
  expect(f.counts.calls).toBe(calls)
})

test('lost acceptance and unknown outcome only GET the same job; changed outbound scope stays offline', async () => {
  const f = await fixture(true), service = await f.open()
  f.control.missing = true
  const admitted = await service.submit(principal, { ...f.input, wait_seconds: 1 })
  expect(admitted.status).toBe('paused')
  await service.close()
  const restarted = await f.open()
  const known = await restarted.submit(principal, { ...f.input, wait_seconds: 1 })
  expect(known).toMatchObject({ job_id: admitted.job_id, status: 'paused' })
  f.control.missing = false
  expect((await restarted.result(principal, admitted.job_id, 1)).status).toBe('completed')
  expect(f.counts.posts).toBe(1)
  await restarted.close()
  // A new unsent request may not migrate to a changed backend scope either.
  const pending = await f.open({ bridgeConfig: { ...f.options.bridgeConfig, pollMs: 60_000 } })
  const unsent = await pending.submit(principal, { request_id: randomUUID(), text: 'not yet sent' })
  await pending.close()
  const before = f.counts.calls
  const changed = await f.open({ bridgeConfig: { ...f.options.bridgeConfig, token: 'changed-fixture-token' } })
  expect((await changed.result(principal, unsent.job_id, 1)).status).toBe('paused')
  expect(f.counts.calls).toBe(before)
  expect(f.counts.posts).toBe(1)
})

test('native resources enforce namespace, hash and no-symlink paths without overwriting corrupt originals', async () => {
  const f = await fixture(), service = await f.open()
  const result = await service.submit(principal, { ...f.input, wait_seconds: 1 }), file = result.files![0]!
  expect((await service.readResource(principal, file.uri)).blob).toBe(f.bytes.toString('base64'))
  await expect(service.readResource({ ...principal, subject: 'other' }, file.uri)).rejects.toMatchObject({ status: 403 })
  await expect(service.readResource(principal, resourceURI(randomUUID(), file.asset_id))).rejects.toMatchObject({ status: 404 })
  await expect(service.readResource(principal, `${file.uri}/../${file.asset_id}`)).rejects.toMatchObject({ status: 404 })
  const owner = (await f.state()).owner, path = join(f.root, 'outputs', owner, result.job_id, file.asset_id, file.name)
  const corrupt = Buffer.alloc(f.bytes.length, 7)
  await writeFile(path, corrupt)
  await expect(service.readResource(principal, file.uri)).rejects.toMatchObject({ status: 503 })
  expect(await readFile(path)).toEqual(corrupt)
  await unlink(path)
  const outside = join(f.root, 'outside'); await writeFile(outside, f.bytes)
  await symlink(outside, path)
  await expect(service.readResource(principal, file.uri)).rejects.toMatchObject({ status: 503 })
  await unlink(path); await writeFile(path, f.bytes, { mode: 0o600 })
  const parent = dirname(path)
  await rename(parent, `${parent}-moved`); await symlink(`${parent}-moved`, parent)
  await expect(service.readResource(principal, file.uri)).rejects.toMatchObject({ status: 503 })
  expect(f.counts.downloads).toBe(1)
  expect(f.counts.posts).toBe(1)
})
