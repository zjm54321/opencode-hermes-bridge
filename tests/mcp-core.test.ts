import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { McpBridgeService, type McpBridgeOptions } from '../mcp/service.js'
import { MAX_JOBS, MAX_STATE_BYTES, McpState, type Envelope } from '../mcp/state.js'
import { resourceURI, type Principal, type PublicResult, type SubmitInput } from '../mcp/contracts.js'
import { contentDisposition, hashBytes, LIMITS, type Asset, type JobRequest } from '../src/protocol.js'

const principal: Principal = { issuer: 'https://issuer.example', subject: 'business-user' }
const secret = 'internal-companion-secret-not-an-oauth-token'
const originalFetch = globalThis.fetch
const roots: string[] = [], services: McpBridgeService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close().catch(() => {})
  globalThis.fetch = originalFetch
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) { if (await check()) return; await Bun.sleep(5) }
  throw new Error('Timed out waiting for fake Bridge IO')
}
async function fixture(options: { losePost?: boolean; ttl?: number; failed?: boolean; inline?: boolean } = {}) {
  const root = await mkdtemp('/tmp/opencode/mcp-core-')
  roots.push(root)
  const bytes = Buffer.from([0, 255, 1, 128, 80, 75, 3, 4, 0, 10, 13, 42])
  const output: Asset = { asset_id: randomUUID(), name: 'report.bin', mime: 'application/octet-stream', size: bytes.length, sha256: hashBytes(bytes) }
  let posts = 0, downloads = 0, outputGets = 0, calls = 0
  const uploads: Buffer[] = [], jobs = new Map<string, JobRequest>(), diskAtIO: Envelope[] = []
  const config: McpBridgeOptions = {
    stateDirectory: join(root, 'state'), publicOrigin: 'https://mcp.example', allowedPrincipal: principal,
    bridgeConfig: { url: 'https://companion.example', token: secret, uploadRoots: [], directory: root,
      outputDir: join(root, 'outputs'), pollMs: 5, httpTimeoutMs: 1000, jobTimeoutMs: 10_000 },
    linkTtlSeconds: options.ttl,
    downloadFile: async ref => { downloads++; return { file_id: ref.file_id, name: ref.file_name!, mime: ref.mime_type!, bytes } },
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls++
    const url = new URL(String(input))
    expect(url.origin).toBe('https://companion.example')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`)
    expect(init?.redirect).toBe('error')
    diskAtIO.push(JSON.parse(await readFile(join(config.stateDirectory, 'state.json'), 'utf8')) as Envelope)
    if (url.pathname === '/v1/capabilities') return Response.json({ object: 'hermes.bridge.capabilities', version: 1, assets: true,
      max_asset_bytes: LIMITS.file, max_total_asset_bytes: LIMITS.total, max_assets: LIMITS.count })
    if (init?.method === 'PUT') {
      const body = Buffer.from(init.body as Uint8Array), headers = new Headers(init.headers)
      uploads.push(body)
      return Response.json({ asset_id: url.pathname.split('/').at(-1), name: 'original.bin', mime: headers.get('content-type'),
        size: body.length, sha256: hashBytes(body) }, { status: 201 })
    }
    if (init?.method === 'POST') {
      posts++
      const job = JSON.parse(String(init.body)) as JobRequest
      jobs.set(job.id, job)
      if (options.losePost && posts === 1) throw new Error('Fake response lost after remote acceptance')
      return Response.json({ id: job.id }, { status: 202 })
    }
    if (url.pathname.endsWith(`/assets/${output.asset_id}`)) {
      outputGets++
      return new Response(bytes, { headers: { 'content-type': output.mime, 'content-length': String(output.size),
        'content-disposition': contentDisposition(output.name), 'x-content-sha256': output.sha256 } })
    }
    const id = url.pathname.split('/').at(-1)!
    if (!jobs.has(id)) return new Response(null, { status: 404 })
    return Response.json({ id, status: options.failed ? 'failed' : 'completed', text: options.failed ? 'failure' : 'Opaque original processed.',
      attachments: options.inline ? [{ name: 'note.txt', mime: 'text/plain', base64: Buffer.from('original text').toString('base64') }] : [],
      output_assets: options.failed ? [] : [output], error: options.failed ? { code: 'INTERNAL', message: `${root}/${secret}` } : null })
  }) as typeof globalThis.fetch
  const open = async (overrides: Partial<McpBridgeOptions> = {}) => {
    const service = await McpBridgeService.open({ ...config, ...overrides })
    services.push(service)
    return service
  }
  const request = (overrides: Partial<SubmitInput> = {}): SubmitInput => ({ request_id: randomUUID(), text: 'Process this original.',
    file: { file_id: 'file-1', download_url: 'https://files.example/object?signature=DO-NOT-PERSIST', file_name: 'original.bin', mime_type: 'application/octet-stream' }, ...overrides })
  const completed = async (service: McpBridgeService, id: string): Promise<PublicResult> => {
    await until(async () => (await service.status(principal, id)).final)
    return service.result(principal, id)
  }
  return { root, config, open, request, bytes, output, completed, jobs, uploads, diskAtIO,
    counts: () => ({ posts, downloads, outputGets, calls }),
    state: async () => JSON.parse(await readFile(join(config.stateDirectory, 'state.json'), 'utf8')) as Envelope }
}
const capability = (result: PublicResult): string => new URL(result.files![0]!.url!).pathname.split('/').at(-1)!

describe('MCP admission and identity', () => {
  test('lost response, restart and URL refresh reuse one atomically mapped job and one POST', async () => {
    const f = await fixture({ losePost: true }), first = await f.open(), input = f.request()
    const admitted = await first.submit(principal, input)
    await f.completed(first, admitted.job_id)
    await first.close()
    const second = await f.open()
    const retry = await second.submit(principal, { ...input, file: { ...input.file!, download_url: 'https://files.example/object?signature=CHANGED' }, wait_seconds: 1 })
    expect(retry.job_id).toBe(admitted.job_id)
    expect(retry.thread_id).toBe(admitted.thread_id)
    expect(f.counts().posts).toBe(1)
    expect(f.counts().downloads).toBe(1)
    const state = await f.state()
    expect(Object.keys(state.coreOutbox.jobs)).toEqual([admitted.job_id])
    expect(state.requests[input.request_id]?.jobId).toBe(admitted.job_id)
    for (const snapshot of f.diskAtIO) {
      expect(snapshot.requests[input.request_id]?.jobId).toBe(admitted.job_id)
      expect(snapshot.threads[admitted.thread_id]?.sessionID).toBe(`${snapshot.owner}:${admitted.thread_id}`)
    }
    const raw = JSON.stringify(state)
    expect(raw).not.toContain('DO-NOT-PERSIST')
    expect(raw).not.toContain('CHANGED')
    expect(raw).not.toContain('download_url')
    expect(raw).not.toContain(secret)
    expect((await lstat(f.config.stateDirectory)).mode & 0o777).toBe(0o700)
    expect((await lstat(join(f.config.stateDirectory, 'state.json'))).mode & 0o777).toBe(0o600)
  })
  test('concurrent retries serialize; conflicts, unknown threads, spoofed fields and owners fail safely', async () => {
    const f = await fixture(), service = await f.open(), input = f.request()
    const results = await Promise.all([service.submit(principal, input), service.submit(principal, input)])
    expect(results[0]!.job_id).toBe(results[1]!.job_id)
    expect(f.counts().downloads).toBe(1)
    await expect(service.submit(principal, { ...input, text: 'different' })).rejects.toMatchObject({ status: 409 })
    await expect(service.submit(principal, f.request({ thread_id: randomUUID() }))).rejects.toMatchObject({ status: 404 })
    await expect(service.submit(principal, { ...f.request(), owner: principal } as SubmitInput)).rejects.toMatchObject({ status: 400 })
    const attacker = { ...principal, subject: 'other-user' }
    await expect(service.submit(attacker, f.request())).rejects.toMatchObject({ status: 403 })
    await expect(service.status(attacker, results[0]!.job_id)).rejects.toMatchObject({ status: 403 })
    await expect(service.result({ ...principal, issuer: 'https://other.example' }, results[0]!.job_id)).rejects.toMatchObject({ status: 403 })
    const followup = await service.submit(principal, f.request({ thread_id: results[0]!.thread_id, file: undefined }))
    expect(followup.thread_id).toBe(results[0]!.thread_id)
    const state = await f.state()
    expect(state.coreOutbox.jobs[followup.job_id]?.threadId).toBe(state.coreOutbox.jobs[results[0]!.job_id]?.threadId)
    await service.close()
    await expect(f.open({ allowedPrincipal: attacker })).rejects.toMatchObject({ status: 503 })
  })
  test('file import failure admits no job, and public origin never permits HTTP', async () => {
    const f = await fixture()
    await expect(f.open({ publicOrigin: 'http://mcp.example' })).rejects.toMatchObject({ status: 503 })
    const service = await f.open({ downloadFile: async () => { throw new Error(`secret ${f.root}`) } })
    await expect(service.submit(principal, f.request())).rejects.toMatchObject({ status: 400, message: 'File import failed safely; no job was created' })
    expect(f.counts().posts).toBe(0)
    await expect(readFile(join(f.config.stateDirectory, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('only explicit result resumes a paused same-scope job GET-only; changed scope remains offline', async () => {
    const f = await fixture()
    const fakeFetch = globalThis.fetch
    let missing = true, jobGets = 0
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET' && /^\/v1\/jobs\/[^/]+$/.test(new URL(String(input)).pathname)) {
        jobGets++
        if (missing) return new Response(null, { status: 404 })
      }
      return fakeFetch(input, init)
    }) as typeof globalThis.fetch
    const first = await f.open()
    const input = f.request({ file: undefined }), admitted = await first.submit(principal, input)
    await until(async () => (await first.status(principal, admitted.job_id)).status === 'paused')
    expect(f.counts().posts).toBe(1)
    expect(jobGets).toBe(1)
    missing = false
    expect((await first.submit(principal, { ...input, wait_seconds: 1 })).status).toBe('paused')
    await Bun.sleep(30)
    expect((await first.status(principal, admitted.job_id)).status).toBe('paused')
    expect(jobGets).toBe(1)
    const recovered = await first.result(principal, admitted.job_id, 1)
    expect(recovered).toMatchObject({ job_id: admitted.job_id, thread_id: admitted.thread_id, status: 'completed', final: true })
    expect(jobGets).toBe(2)
    expect(f.counts().posts).toBe(1)
    expect(Object.keys((await f.state()).coreOutbox.jobs)).toEqual([admitted.job_id])
    await first.close()

    const blocked = await fixture()
    const before = await blocked.open({ bridgeConfig: { ...blocked.config.bridgeConfig, pollMs: 60_000 } })
    const blockedInput = blocked.request({ file: undefined }), unsent = await before.submit(principal, blockedInput)
    await before.close()
    const second = await blocked.open({ bridgeConfig: { ...blocked.config.bridgeConfig, token: 'changed-companion-token' } })
    expect((await second.submit(principal, blockedInput)).job_id).toBe(unsent.job_id)
    expect((await second.status(principal, unsent.job_id)).status).toBe('paused')
    expect((await second.result(principal, unsent.job_id, 1)).status).toBe('paused')
    await Bun.sleep(30)
    expect(blocked.counts().calls).toBe(0)
  })
})

describe('MCP original bytes and public outputs', () => {
  test('binary originals use authenticated MCP blobs, with no HTTP links or capabilities by default', async () => {
    const f = await fixture({ inline: true }), service = await f.open()
    const admitted = await service.submit(principal, f.request())
    expect(admitted.files).toBeUndefined()
    const result = await f.completed(service, admitted.job_id)
    expect(f.uploads).toEqual([f.bytes])
    expect(f.jobs.get(admitted.job_id)?.attachments).toEqual([])
    expect(f.jobs.get(admitted.job_id)?.input_assets).toHaveLength(1)
    expect(result.files).toHaveLength(2)
    expect(result.text).toBe('Opaque original processed.')
    const publicJSON = JSON.stringify(result)
    for (const forbidden of [f.root, 'path', 'base64', 'data:', secret, 'companion.example']) expect(publicJSON).not.toContain(forbidden)
    for (const file of result.files!) {
      expect(file.uri).toBe(resourceURI(admitted.job_id, file.asset_id))
      expect(file.url).toBeUndefined()
      expect(file.expires_at).toBeUndefined()
    }
    const binary = result.files!.find(file => file.asset_id === f.output.asset_id)!
    expect((await f.state()).capabilities).toEqual({})
    const downloaded = await service.readResource(principal, binary.uri)
    expect(downloaded).toEqual({ uri: binary.uri, mimeType: binary.mime, blob: f.bytes.toString('base64') })
    expect(hashBytes(Buffer.from(downloaded.blob, 'base64'))).toBe(binary.sha256)
    await expect(service.readResource({ ...principal, subject: 'other' }, binary.uri)).rejects.toMatchObject({ status: 403 })
    for (const uri of [resourceURI(randomUUID(), binary.asset_id), resourceURI(admitted.job_id, randomUUID()),
      `${binary.uri}?path=secret`, `${binary.uri}#`, `${binary.uri}\n`, binary.uri.replace('jobs/', 'user@jobs/'),
      binary.uri.replace('/assets/', '/%61ssets/'), `${binary.uri}/../${binary.asset_id}`, 'file:///etc/passwd']) {
      await expect(service.readResource(principal, uri)).rejects.toMatchObject({ status: 404 })
    }
    await expect(service.download('a'.repeat(43))).rejects.toMatchObject({ status: 404 })
    await service.close()
    const restarted = await f.open()
    expect(await restarted.readResource(principal, binary.uri)).toEqual(downloaded)
    await restarted.result(principal, admitted.job_id)
    expect(f.counts().posts).toBe(1)
    expect(f.counts().outputGets).toBe(1)
    await restarted.close()
    const changed = await f.open({ bridgeConfig: { ...f.config.bridgeConfig, token: 'changed' } })
    expect(await changed.readResource(principal, binary.uri)).toEqual(downloaded)
    expect(f.counts().outputGets).toBe(1)
  })
  test('uncached native resource obeys the original outbound scope and never reruns a model', async () => {
    const f = await fixture(), service = await f.open()
    const admitted = await service.submit(principal, f.request())
    await until(async () => (await service.status(principal, admitted.job_id)).final)
    await service.close()
    const calls = f.counts().calls
    const changed = await f.open({ bridgeConfig: { ...f.config.bridgeConfig, token: 'changed' } })
    await expect(changed.readResource(principal, resourceURI(admitted.job_id, f.output.asset_id))).rejects.toMatchObject({ status: 503 })
    expect(f.counts().calls).toBe(calls)
    expect(f.counts().outputGets).toBe(0)
    expect(f.counts().posts).toBe(1)
  })
  test('upstream errors do not expose raw messages or generate capabilities', async () => {
    const f = await fixture({ failed: true }), service = await f.open()
    const admitted = await service.submit(principal, f.request({ file: undefined }))
    const result = await f.completed(service, admitted.job_id)
    expect(result.status).toBe('failed')
    expect(result.files).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(f.root)
    expect(Object.keys((await f.state()).capabilities)).toHaveLength(0)
  })
})

describe('MCP expiry, tamper, writer exclusion and fail-closed storage', () => {
  test('expired links are 410; authenticated re-signing does not rerun the model', async () => {
    const f = await fixture({ ttl: 1 }), service = await f.open({ httpDownloads: true })
    const admitted = await service.submit(principal, f.request())
    const result = await f.completed(service, admitted.job_id), token = capability(result)
    await Bun.sleep(1050)
    await expect(service.download(token)).rejects.toMatchObject({ status: 410, code: 'expired' })
    const renewed = await service.result(principal, admitted.job_id)
    expect(capability(renewed)).not.toBe(token)
    expect((await service.download(capability(renewed))).bytes).toEqual(f.bytes)
    expect(f.counts().posts).toBe(1)
    await expect(service.download('../../etc/passwd')).rejects.toMatchObject({ status: 404 })
    await service.close()
    const disabled = await f.open()
    await expect(disabled.download(capability(renewed))).rejects.toMatchObject({ status: 404 })
    expect((await disabled.result(principal, admitted.job_id)).files![0]!.url).toBeUndefined()
    await disabled.close()
    const enabled = await f.open({ httpDownloads: true })
    expect((await enabled.download(capability(renewed))).bytes).toEqual(f.bytes)
    expect(f.counts().posts).toBe(1)
  })
  test('modified bytes, file symlinks and symlinked parents are rejected', async () => {
    const f = await fixture(), service = await f.open({ httpDownloads: true })
    const admitted = await service.submit(principal, f.request()), result = await f.completed(service, admitted.job_id)
    const token = capability(result), entry = Object.values((await f.state()).capabilities)[0]!
    await writeFile(entry.path, Buffer.alloc(f.bytes.length, 7))
    await expect(service.download(token)).rejects.toMatchObject({ status: 410 })
    await expect(service.readResource(principal, result.files![0]!.uri)).rejects.toMatchObject({ status: 503 })
    await unlink(entry.path)
    const outside = join(f.root, 'outside.bin')
    await writeFile(outside, f.bytes, { mode: 0o600 })
    await symlink(outside, entry.path)
    await expect(service.download(token)).rejects.toMatchObject({ status: 410 })
    await unlink(entry.path)
    await writeFile(entry.path, f.bytes, { mode: 0o600 })
    const parent = dirname(entry.path), moved = `${parent}-moved`
    await rename(parent, moved)
    await symlink(moved, parent)
    await expect(service.download(token)).rejects.toMatchObject({ status: 410 })
    const alias = join(f.root, 'alias')
    await symlink(f.config.stateDirectory, alias)
    await expect(f.open({ stateDirectory: alias })).rejects.toMatchObject({ status: 503 })
    await service.close()
    await chmod(f.config.stateDirectory, 0o755)
    await expect(f.open()).rejects.toMatchObject({ status: 503 })
  })
  test('writer lock is exclusive, never stolen, and close never removes a replacement lock', async () => {
    const f = await fixture(), service = await f.open()
    await expect(f.open()).rejects.toMatchObject({ status: 503, code: 'state_locked' })
    const lock = join(f.config.stateDirectory, 'writer.lock')
    await unlink(lock)
    await writeFile(lock, 'operator replacement', { mode: 0o600 })
    await service.close()
    expect(await readFile(lock, 'utf8')).toBe('operator replacement')
    await expect(f.open()).rejects.toMatchObject({ code: 'state_locked' })
    // Simulates explicit operator recovery after the old process is confirmed stopped.
    await unlink(lock)
    await f.open()
  })
  test('uncertain persistence stops submissions; restart recovers the same atomically admitted job', async () => {
    const f = await fixture(), service = await f.open(), input = f.request({ file: undefined })
    const prototype = McpState.prototype as unknown as { persist(next: Envelope): Promise<void> }
    const persist = prototype.persist
    let injected = false
    prototype.persist = async function(next: Envelope) {
      await persist.call(this, next)
      if (!injected && Object.keys(next.requests).length) { injected = true; throw new Error('simulated fsync uncertainty after rename') }
    }
    try {
      await expect(service.submit(principal, input)).rejects.toMatchObject({ status: 503 })
      await expect(service.submit(principal, input)).rejects.toMatchObject({ status: 503 })
      await expect(service.submit(principal, f.request())).rejects.toMatchObject({ status: 503 })
      expect(f.counts().posts).toBe(0)
      const state = await f.state()
      expect(Object.keys(state.requests)).toEqual([input.request_id])
      expect(Object.keys(state.coreOutbox.jobs)).toEqual([state.requests[input.request_id]!.jobId])
      await service.close()
      prototype.persist = persist
      const restarted = await f.open(), retry = await restarted.submit(principal, input)
      expect(retry.job_id).toBe(state.requests[input.request_id]!.jobId)
      await f.completed(restarted, retry.job_id)
      expect(f.counts().posts).toBe(1)
    } finally { prototype.persist = persist }
  })
  test('a blocked storage target fails before admission or model HTTP', async () => {
    const f = await fixture(), service = await f.open()
    await mkdir(join(f.config.stateDirectory, 'state.json'), { mode: 0o700 })
    await expect(service.submit(principal, f.request())).rejects.toMatchObject({ status: 503 })
    await expect(service.submit(principal, f.request())).rejects.toMatchObject({ status: 503 })
    expect(f.counts().posts).toBe(0)
    expect(f.counts().calls).toBe(0)
  })
  test('oversized state and too many jobs are rejected before loading Bridge', async () => {
    const f = await fixture(), service = await f.open({ bridgeConfig: { ...f.config.bridgeConfig, pollMs: 60_000 } })
    const input = f.request({ file: undefined }), admitted = await service.submit(principal, input)
    await service.close()
    const state = await f.state(), original = state.coreOutbox.jobs[admitted.job_id]!
    for (let i = 0; i < MAX_JOBS; i++) {
      const jobId = randomUUID(), requestId = randomUUID()
      state.coreOutbox.jobs[jobId] = { ...original, id: jobId }
      state.requests[requestId] = { ...state.requests[input.request_id]!, jobId }
    }
    const path = join(f.config.stateDirectory, 'state.json')
    await writeFile(path, JSON.stringify(state))
    await expect(f.open()).rejects.toMatchObject({ status: 503 })
    await truncate(path, MAX_STATE_BYTES + 1)
    await expect(f.open()).rejects.toMatchObject({ status: 503 })
    expect(f.counts().calls).toBe(0)
  })
})
