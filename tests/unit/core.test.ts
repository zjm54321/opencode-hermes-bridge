import { describe, expect, test } from 'bun:test'
import { Bridge, type JobRequest, type OutboxJob } from '../../src/core.js'
import { cfg, complete, FakeClock, fetchMock, MemoryStorage } from './helpers.js'

describe('durable session-bound outbox', () => {
  test('accepts locally before HTTP; stable threads, snapshots and session-bound explicit results', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const sent: JobRequest[] = []
    const fetch = fetchMock((url, init) => {
      expect(init.redirect).toBe('error')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-secret')
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as JobRequest
        sent.push(body)
        return Response.json({ id: body.id }, { status: 202 })
      }
      return Response.json(complete(url.split('/').at(-1)!))
    })
    const bridge = await Bridge.create(cfg(), { storage, clock, fetch })
    const first = await bridge.ask('session-a', { text: 'first', attachments: [{ name: 'image.png', mime: 'image/png', base64: 'AP+A' }] })
    const second = await bridge.ask('session-a', { text: 'second' })
    const other = await bridge.ask('session-b', { text: 'other' })
    expect(sent).toHaveLength(0)
    expect(storage.value).toContain(first.id)
    expect(storage.value).not.toContain('test-secret')
    expect(first.threadId).toBe(second.threadId)
    expect(other.threadId).not.toBe(first.threadId)
    expect(await bridge.status('session-a')).toHaveLength(2)
    await expect(bridge.status('session-b', first.id)).rejects.toThrow('current session')
    await expect(bridge.resume('session-b', first.id)).rejects.toThrow('current session')
    await expect(bridge.result('session-b', first.id)).rejects.toThrow('current session')
    await bridge.tick()
    expect(sent).toHaveLength(3)
    expect(sent[0]?.attachments[0]?.base64).toBe('AP+A')
    clock.advance(2_000)
    await bridge.tick()
    const result = await bridge.result('session-a', first.id)
    expect(result.metadata).toMatchObject({ id: first.id, status: 'completed', final: true })
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Hermes reply') }])
    expect((await bridge.status('session-a', first.id))[0]?.resultAvailable).toBe(true)
    await bridge.tick()
    expect(await bridge.result('session-a', first.id)).toEqual(result)
    await bridge.dispose()
  })

  test('lost 202 survives restart; only GET retries 429/5xx and recovers acceptance after one POST', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const bodies: string[] = []
    const methods: string[] = []
    let count = 0
    const deps = {
      storage, clock,
      fetch: fetchMock((url, init) => {
        methods.push(init.method!)
        if (init.method === 'POST') {
          bodies.push(String(init.body))
          const body = JSON.parse(String(init.body)) as JobRequest
          const durable = JSON.parse(storage.value!) as { jobs: Record<string, OutboxJob> }
          expect(durable.jobs[body.id]?.postAttempted).toBe(true)
          expect(durable.jobs[body.id]?.submitted).toBe(false)
        } else expect(init.body).toBeUndefined()
        count++
        if (count === 1) throw new Error('Accepted remotely but 202 was lost')
        if (count === 2) return new Response('', { status: 429, headers: { 'Retry-After': '10' } })
        if (count === 3) return new Response('', { status: 503 })
        return Response.json(complete(url.split('/').at(-1)!))
      }),
    }
    const first = await Bridge.create(cfg(), deps)
    const job = await first.ask('s', { text: 'retry', attachments: [{ name: 'image.png', mime: 'image/png', base64: 'AP+A' }] })
    await first.tick(); await first.tick()
    expect(count).toBe(1)
    await first.dispose()
    const bridge = await Bridge.create(cfg(), deps)
    clock.advance(4_000); await bridge.tick()
    clock.advance(9_999); await bridge.tick()
    expect(count).toBe(2)
    clock.advance(1); await bridge.tick()
    clock.advance(16_000); await bridge.tick()
    expect(count).toBe(4)
    expect(methods).toEqual(['POST', 'GET', 'GET', 'GET'])
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain(job.id)
    expect((JSON.parse(bodies[0]!) as JobRequest).attachments[0]?.base64).toBe('AP+A')
    expect((await bridge.status('s', job.id))[0]).toMatchObject({ status: 'completed', submitted: true, resultAvailable: true, threadId: job.threadId })
    await bridge.dispose()
  })

  test('401 stops automatic retry and exposes a local failure result; resume only GETs', async () => {
    const clock = new FakeClock()
    let calls = 0
    const methods: string[] = []
    const bridge = await Bridge.create(cfg(), { storage: new MemoryStorage(), clock, fetch: fetchMock((_url, init) => { calls++; methods.push(init.method!); return new Response('', { status: 401 }) }) })
    const job = await bridge.ask('s', { text: 'auth' })
    await bridge.tick()
    clock.advance(90_000); await bridge.tick()
    expect(calls).toBe(1)
    expect(JSON.stringify(await bridge.result('s', job.id))).toContain('HTTP 401')
    expect((await bridge.status('s', job.id))[0]).toMatchObject({ status: 'failed', resultAvailable: true })
    await bridge.resume('s', job.id); await bridge.tick()
    expect(methods).toEqual(['POST', 'GET'])
    await bridge.dispose()
  })

  test('job deadline pauses; explicit result remains non-final and resume only polls the same ID', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const urls: string[] = []
    const bridge = await Bridge.create(cfg(), { storage, clock,
      fetch: fetchMock((url, init) => { urls.push(url); return init.method === 'POST' ? Response.json({ id: (JSON.parse(String(init.body)) as JobRequest).id }, { status: 202 }) : Response.json(complete(url.split('/').at(-1)!)) }),
    })
    const job = await bridge.ask('s', { text: 'slow' })
    await bridge.tick()
    clock.advance(cfg().jobTimeoutMs); await bridge.tick()
    expect((await bridge.status('s', job.id))[0]).toMatchObject({ status: 'paused', resultAvailable: false })
    clock.advance(4_000); await bridge.tick()
    expect((await bridge.result('s', job.id)).metadata?.final).toBe(false)
    expect(urls).toHaveLength(1)
    await bridge.resume('s', job.id)
    await bridge.tick()
    expect(urls[1]).toEndWith(`/v1/jobs/${job.id}`)
    expect((await bridge.result('s', job.id)).metadata?.final).toBe(true)
    await bridge.dispose()
  })

  test('recovers accepted jobs and thread IDs after restart', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const requests: JobRequest[] = []
    const deps = { storage, clock, fetch: fetchMock((_url, init) => {
      const body = JSON.parse(String(init.body)) as JobRequest
      requests.push(body)
      return Response.json({ id: body.id }, { status: 202 })
    }) }
    const first = await Bridge.create(cfg(), deps)
    const job = await first.ask('s', { text: 'persist' })
    await first.dispose()
    const second = await Bridge.create(cfg(), deps)
    const next = await second.ask('s', { text: 'next' })
    expect(next.threadId).toBe(job.threadId)
    await second.tick()
    expect(requests[0]?.id).toBe(job.id)
    await second.dispose()
  })

  test('single consumer, HTTP abort on cleanup, no post-dispose scheduling', async () => {
    const clock = new FakeClock()
    let calls = 0
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    let signal: AbortSignal | null | undefined
    const bridge = await Bridge.create(cfg(), { storage: new MemoryStorage(), clock, fetch: fetchMock((_url, init) => {
      calls++; signal = init.signal; began()
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
    }) })
    await bridge.ask('s', { text: 'wait' })
    bridge.start(); bridge.start()
    expect(clock.timers.size).toBe(1)
    const a = bridge.tick(); const b = bridge.tick()
    expect(a).toBe(b)
    await started
    await bridge.dispose()
    await a
    expect(signal?.aborted).toBe(true)
    expect(clock.timers.size).toBe(0)
    await bridge.tick()
    clock.advance(100_000)
    expect(calls).toBe(1)
    await expect(bridge.ask('s', { text: 'after' })).rejects.toThrow('disposed')
  })

  test('HTTP timeout aborts without reopening the POST gate', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    let began!: () => void
    const started = new Promise<void>(r => { began = r })
    const bridge = await Bridge.create(cfg(), { storage, clock, fetch: fetchMock((_url, init) => {
      began()
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
    }) })
    const job = await bridge.ask('s', { text: 'timeout' })
    const tick = bridge.tick()
    await started
    clock.advance(10_000)
    await tick
    expect((await bridge.status('s', job.id))[0]).toMatchObject({ status: 'accepted', resultAvailable: false })
    expect((JSON.parse(storage.value!) as { jobs: Record<string, OutboxJob> }).jobs[job.id]?.postAttempted).toBe(true)
    await bridge.dispose()
  })

  test('persisted result survives restart and repeated explicit reads without HTTP', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    let calls = 0
    const fetch = fetchMock((url, init) => { calls++; return init.method === 'POST' ? Response.json({ id: (JSON.parse(String(init.body)) as JobRequest).id }, { status: 202 }) : Response.json(complete(url.split('/').at(-1)!)) })
    const bridge = await Bridge.create(cfg(), { storage, clock, fetch })
    const job = await bridge.ask('s', { text: 'x' })
    await bridge.tick(); clock.advance(2_000); await bridge.tick()
    expect((await bridge.status('s', job.id))[0]).toMatchObject({ status: 'completed', resultAvailable: true })
    await bridge.dispose()
    const restarted = await Bridge.create(cfg(), { storage, clock, fetch })
    clock.advance(4_000); await restarted.tick()
    expect(calls).toBe(2)
    const result = await restarted.result('s', job.id)
    expect(result.metadata?.final).toBe(true)
    expect(await restarted.result('s', job.id)).toEqual(result)
    expect(calls).toBe(2)
    await restarted.dispose()
    const saved = storage.value!
    for (const status of ['accepted', 'queued', 'running', 'paused', 'failed'] as const) {
      const state = JSON.parse(saved) as { jobs: Record<string, OutboxJob> }
      const cached = state.jobs[job.id]!
      cached.status = status
      // Even a cached completed payload must not publish files under a non-completed local status.
      cached.result = complete(job.id, {
        attachments: [{ name: 'partial.txt', mime: 'text/plain', base64: 'YQ==' }],
        output_assets: [{ asset_id: job.id, name: 'partial.zip', mime: 'application/zip', size: 1, sha256: '0'.repeat(64) }],
      })
      storage.value = JSON.stringify(state)
      let downloads = 0
      let materializations = 0
      const pending = await Bridge.create(cfg(), {
        storage, clock,
        fetch: fetchMock(() => { downloads++; throw new Error('Must not download pending files') }, { capabilities: true }),
        saveOutputs: async () => { materializations++; throw new Error('Must not materialize pending files') },
      })
      const output = await pending.result('s', job.id)
      expect(output.metadata).toMatchObject({ status, final: status === 'failed', resultAvailable: status === 'failed', artifacts: [] })
      expect(output.content).toHaveLength(1)
      expect((await pending.status('s', job.id))[0]?.resultAvailable).toBe(status === 'failed')
      expect(downloads).toBe(0)
      expect(materializations).toBe(0)
      await pending.dispose()
    }
  })

  test('GET transport failure retries; 404 pauses with unknown outcome and resume never POSTs', async () => {
    const clock = new FakeClock()
    const bodies: string[] = []
    let gets = 0
    const bridge = await Bridge.create(cfg(), { storage: new MemoryStorage(), clock, fetch: fetchMock((url, init) => {
      if (init.method === 'POST') {
        bodies.push(String(init.body))
        return Response.json({ id: (JSON.parse(String(init.body)) as JobRequest).id }, { status: 202 })
      }
      expect(url).toEndWith(`/v1/jobs/${(JSON.parse(bodies[0]!) as JobRequest).id}`)
      if (++gets === 1) throw new Error('network failed')
      return new Response('', { status: 404 })
    }) })
    const job = await bridge.ask('s', { text: 'recover' })
    await bridge.tick(); clock.advance(2_000); await bridge.tick()
    expect((await bridge.status('s', job.id))[0]?.status).toBe('queued')
    clock.advance(4_000); await bridge.tick()
    expect((await bridge.status('s', job.id))[0]).toMatchObject({ status: 'paused', submitted: true })
    expect(JSON.stringify(await bridge.result('s', job.id))).toContain('Outcome unknown')
    clock.advance(8_000); await bridge.tick()
    expect(gets).toBe(2)
    for (let attempt = 0; attempt < 2; attempt++) {
      await bridge.resume('s', job.id); await bridge.tick()
      expect((await bridge.status('s', job.id))[0]?.status).toBe('paused')
    }
    expect(gets).toBe(4)
    expect(bodies).toHaveLength(1)
    await bridge.dispose()
  })

  test('changed URL/token and unbound legacy outboxes block all HTTP, including resume, without losing terminal output', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const original = await Bridge.create(cfg(), { storage, clock, fetch: fetchMock((url, init) => init.method === 'POST'
      ? Response.json({ id: (JSON.parse(String(init.body)) as JobRequest).id }, { status: 202 })
      : Response.json(complete(url.split('/').at(-1)!))) })
    const terminal = await original.ask('s', { text: 'saved output' })
    await original.tick(); clock.advance(2_000); await original.tick()
    const attempted = await original.ask('s', { text: 'already attempted' })
    await original.tick()
    const unsent = await original.ask('s', { text: 'not yet attempted' })
    const bound = storage.value!
    await original.dispose()
    const state = JSON.parse(bound) as { version: 1; threads: Record<string, string>; jobs: Record<string, OutboxJob> }
    const legacy = JSON.stringify({ ...state, jobs: Object.fromEntries(Object.entries(state.jobs).map(([id, { postAttempted, scopeHash, ...job }]) => [id, {
      ...job, attachments: [{ name: 'old.txt', mime: 'text/plain', base64: 'YQ==' }],
    }])) })
    for (const scenario of [
      { config: { ...cfg(), url: 'http://127.0.0.1:9999' }, raw: bound, notice: 'endpoint or credential' },
      { config: { ...cfg(), token: 'changed-test-token' }, raw: bound, notice: 'endpoint or credential' },
      { config: cfg(), raw: legacy, notice: 'legacy job' },
    ]) {
      storage.value = scenario.raw
      let requests = 0
      const restarted = await Bridge.create(scenario.config, { storage, clock, fetch: fetchMock(() => { requests++; throw new Error('must not send') }) })
      for (const job of [attempted, unsent]) {
        expect((await restarted.status('s', job.id))[0]).toMatchObject({ status: 'paused', threadId: job.threadId })
        expect((await restarted.resume('s', job.id)).status).toBe('paused')
        const result = await restarted.result('s', job.id, { waitSeconds: 120 })
        expect(result.metadata?.final).toBe(false)
        expect(JSON.stringify(result)).toContain(scenario.notice)
      }
      await restarted.tick()
      expect(requests).toBe(0)
      expect((await restarted.status('s', terminal.id))[0]).toMatchObject({ status: 'completed', resultAvailable: true })
      const durable = JSON.parse(storage.value!) as { jobs: Record<string, OutboxJob> }
      expect(durable.jobs[terminal.id]?.result?.text).toBe('Hermes reply')
      expect(durable.jobs[unsent.id]?.postAttempted).toBe(scenario.raw === legacy)
      expect(durable.jobs[unsent.id]?.scopeHash).toBe(scenario.raw === legacy ? undefined : state.jobs[unsent.id]!.scopeHash)
      expect(storage.value).not.toContain(scenario.config.token)
      await restarted.dispose()
    }
  })

  test('POST waits for durable attempt marker; disposal during that save prevents HTTP', async () => {
    const storage = new MemoryStorage()
    let saving!: () => void
    const started = new Promise<void>(resolve => { saving = resolve })
    let finish!: () => void
    const blocked = new Promise<void>(resolve => { finish = resolve })
    let calls = 0
    let delaySave = false
    const bridge = await Bridge.create(cfg(), {
      storage: { load: () => storage.load(), save: async value => {
        if (delaySave) { saving(); await blocked }
        await storage.save(value)
      } },
      fetch: fetchMock(() => { calls++; throw new Error('must not send') }),
    })
    const job = await bridge.ask('s', { text: 'dispose while saving' })
    delaySave = true
    const ticking = bridge.tick()
    await started
    expect(calls).toBe(0)
    const disposing = bridge.dispose()
    finish()
    await Promise.all([ticking, disposing])
    expect(calls).toBe(0)
    expect((JSON.parse(storage.value!) as { jobs: Record<string, OutboxJob> }).jobs[job.id]?.postAttempted).toBe(true)
  })

  test('invalid remote attachments stop polling without exposing unvalidated files', async () => {
    const clock = new FakeClock()
    const bridge = await Bridge.create(cfg(), { storage: new MemoryStorage(), clock, fetch: fetchMock((url, init) => init.method === 'POST'
      ? Response.json({ id: (JSON.parse(String(init.body)) as JobRequest).id }, { status: 202 })
      : Response.json(complete(url.split('/').at(-1)!, { attachments: [{ name: '../unsafe', mime: 'text/plain', base64: 'YQ==' }] }))) })
    const job = await bridge.ask('s', { text: 'unsafe' })
    await bridge.tick(); clock.advance(2_000); await bridge.tick()
    expect((await bridge.status('s', job.id))[0]?.status).toBe('failed')
    const result = await bridge.result('s', job.id)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Invalid companion job response') }])
    expect(result.metadata?.artifacts).toEqual([])
    await bridge.dispose()
  })

  test('bounded wait timeout and abort preserve one upstream job and clean up wait timers', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const methods: string[] = []
    const bridge = await Bridge.create(cfg(), { storage, clock, fetch: fetchMock((url, init) => {
      methods.push(init.method!)
      return init.method === 'POST' ? Response.json({ id: (JSON.parse(String(init.body)) as JobRequest).id }, { status: 202 })
        : Response.json(complete(url.split('/').at(-1)!))
    }) })
    const job = await bridge.ask('s', { text: 'bounded waiting' })
    expect((await bridge.result('s', job.id)).metadata).toMatchObject({ status: 'accepted', final: false })
    expect(methods).toEqual([])
    const timed = bridge.result('s', job.id, { waitSeconds: 1 })
    await bridge.tick()
    clock.advance(1_000)
    expect((await timed).metadata).toMatchObject({ status: 'queued', final: false })
    expect(clock.timers.size).toBe(1) // only the independent pump remains
    const caller = new AbortController()
    const cancelled = bridge.wait('s', job.id, 120, caller.signal)
    caller.abort(new Error('caller stopped waiting'))
    await expect(cancelled).rejects.toThrow('caller stopped waiting')
    expect(clock.timers.size).toBe(1)
    expect((await bridge.status('s', job.id))[0]?.status).toBe('queued')
    clock.advance(1_000); await bridge.tick()
    expect((await bridge.result('s', job.id)).metadata).toMatchObject({ status: 'completed', final: true })
    expect(methods).toEqual(['POST', 'GET'])
    for (const seconds of [-1, 121, NaN]) await expect(bridge.wait('s', job.id, seconds)).rejects.toThrow('waitSeconds')
    await bridge.dispose()
    expect(clock.timers.size).toBe(0)
  })

  test('capabilities gate files before any model POST; legacy text/images remain compatible', async () => {
    for (const support of [undefined, false, true]) {
      const storage = new MemoryStorage()
      const sent: JobRequest[] = []
      const bridge = await Bridge.create(cfg(), { storage, clock: new FakeClock(), fetch: fetchMock((url, init) => {
        if (url.endsWith('/v1/capabilities')) return support === undefined ? new Response(null, { status: 404 })
          : Response.json({ object: 'hermes.bridge.capabilities', version: 1, assets: support, max_asset_bytes: 10485760, max_total_asset_bytes: 20971520, max_assets: 8 })
        expect(init.method).toBe('POST')
        const body = JSON.parse(String(init.body)) as JobRequest
        sent.push(body)
        return Response.json({ id: body.id }, { status: 202 })
      }, { capabilities: true }) })
      if (!support) {
        for (const input of [
          { requireFiles: true },
          { files: [{ name: 'archive.zip', mime: 'application/zip', base64: 'UEsDBAAA' }] },
        ]) {
          const job = await bridge.ask('s', { text: 'need files', ...input })
          await bridge.tick()
          expect((await bridge.status('s', job.id))[0]).toMatchObject({ status: 'failed', submitted: false })
          expect(JSON.stringify(await bridge.result('s', job.id))).toContain('File transfer unsupported')
          expect((JSON.parse(storage.value!) as { jobs: Record<string, OutboxJob> }).jobs[job.id]?.postAttempted).toBe(false)
        }
        expect(sent).toEqual([])
      }
      const ordinary = await bridge.ask('s', { text: 'legacy image', attachments: [{ name: 'pixel.png', mime: 'image/png', base64: 'YQ==' }] })
      await bridge.tick()
      expect(sent).toHaveLength(1)
      expect(sent[0]?.id).toBe(ordinary.id)
      expect(sent[0]?.input_assets).toEqual(support ? [] : undefined)
      expect(sent[0]?.attachments).toEqual([{ name: 'pixel.png', mime: 'image/png', base64: 'YQ==' }])
      await bridge.dispose()
    }
  })

  test('unverified upload metadata blocks the POST gate', async () => {
    const storage = new MemoryStorage()
    let puts = 0
    const bridge = await Bridge.create(cfg(), { storage, clock: new FakeClock(), fetch: fetchMock((url, init) => {
      if (url.endsWith('/v1/capabilities')) return Response.json({ object: 'hermes.bridge.capabilities', version: 1, assets: true, max_asset_bytes: 10485760, max_total_asset_bytes: 20971520, max_assets: 8 })
      expect(init.method).toBe('PUT')
      puts++
      const job = Object.values((JSON.parse(storage.value!) as { jobs: Record<string, OutboxJob> }).jobs)[0]!
      const { base64, ...a } = job.files![0]!
      return Response.json({ ...a, sha256: '0'.repeat(64) }, { status: 201 })
    }, { capabilities: true }) })
    const job = await bridge.ask('s', { text: 'must not run', files: [{ name: 'x.zip', mime: 'application/zip', base64: 'YQ==' }] })
    await bridge.tick()
    expect(puts).toBe(1)
    expect((await bridge.status('s', job.id))[0]?.notice).toBe('Uploaded asset metadata mismatch')
    expect((JSON.parse(storage.value!) as { jobs: Record<string, OutboxJob> }).jobs[job.id]?.postAttempted).toBe(false)
    await bridge.dispose()
  })

  test('tool cancellation before local acceptance persists no job', async () => {
    const storage = new MemoryStorage()
    const bridge = await Bridge.create(cfg(), { storage })
    await expect(bridge.ask('s', { text: 'cancel' }, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
    expect(storage.value).toBeUndefined()
    await bridge.dispose()
  })
})
