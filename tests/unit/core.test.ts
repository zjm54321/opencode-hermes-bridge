import { describe, expect, test } from 'bun:test'
import { Bridge, type JobRequest, type OutboxJob } from '../../src/core.js'
import { cfg, collector, complete, FakeClock, fetchMock, MemoryStorage } from './helpers.js'

describe('durable session-bound outbox', () => {
  test('accepts locally before HTTP; stable per-session threads, byte snapshots, original-session delivery', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const sink = collector()
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
    const bridge = await Bridge.create(cfg(), { storage, clock, fetch, prompt: sink.prompt })
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
    await bridge.tick()
    expect(sent).toHaveLength(3)
    expect(sent[0]?.attachments[0]?.base64).toBe('AP+A')
    clock.advance(2_000)
    await bridge.tick()
    expect(sink.prompts.map(p => p.sessionID)).toEqual(['session-a', 'session-a', 'session-b'])
    expect(sink.prompts.every(p => p.delivery === 'queue')).toBe(true)
    expect(sink.prompts[0]?.text).toContain(first.id)
    expect(sink.prompts[0]?.text).toContain('may duplicate')
    expect((await bridge.status('session-a', first.id))[0]?.delivered).toBe(true)
    await bridge.tick()
    expect(sink.prompts).toHaveLength(3)
    await bridge.dispose()
  })

  test('lost 202 survives restart; only GET retries 429/5xx and recovers acceptance after one POST', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const bodies: string[] = []
    const methods: string[] = []
    let count = 0
    const deps = {
      storage, clock, prompt: async () => {},
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
    expect((await bridge.status('s', job.id))[0]).toMatchObject({ status: 'completed', submitted: true, delivered: true, threadId: job.threadId })
    await bridge.dispose()
  })

  test('401 stops automatic retry and queues exactly one normal-operation failure notice', async () => {
    const clock = new FakeClock()
    const sink = collector()
    let calls = 0
    const methods: string[] = []
    const bridge = await Bridge.create(cfg(), { storage: new MemoryStorage(), clock, prompt: sink.prompt, fetch: fetchMock((_url, init) => { calls++; methods.push(init.method!); return new Response('', { status: 401 }) }) })
    const job = await bridge.ask('s', { text: 'auth' })
    await bridge.tick()
    clock.advance(90_000); await bridge.tick()
    expect(calls).toBe(1)
    expect(sink.prompts).toHaveLength(1)
    expect(sink.prompts[0]?.text).toContain('HTTP 401')
    expect((await bridge.status('s', job.id))[0]?.status).toBe('failed')
    await bridge.resume('s', job.id); await bridge.tick()
    expect(methods).toEqual(['POST', 'GET'])
    await bridge.dispose()
  })

  test('deadline pauses/notifies, resume only polls the same ID, failed prompt stays pending', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const urls: string[] = []
    let failPrompt = true
    const sink = collector()
    const bridge = await Bridge.create(cfg(), { storage, clock,
      prompt: async p => { if (failPrompt) throw new Error('queue offline'); await sink.prompt(p) },
      fetch: fetchMock((url, init) => { urls.push(url); return init.method === 'POST' ? Response.json({ id: (JSON.parse(String(init.body)) as JobRequest).id }, { status: 202 }) : Response.json(complete(url.split('/').at(-1)!)) }),
    })
    const job = await bridge.ask('s', { text: 'slow' })
    await bridge.tick()
    clock.advance(cfg().jobTimeoutMs); await bridge.tick()
    expect((await bridge.status('s', job.id))[0]).toMatchObject({ status: 'paused', delivered: false })
    failPrompt = false
    clock.advance(4_000); await bridge.tick()
    expect(sink.prompts).toHaveLength(1)
    expect(urls).toHaveLength(1)
    await bridge.resume('s', job.id)
    await bridge.tick()
    expect(urls[1]).toEndWith(`/v1/jobs/${job.id}`)
    expect(sink.prompts).toHaveLength(2)
    await bridge.dispose()
  })

  test('recovers accepted jobs and thread IDs after restart', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const sink = collector()
    const requests: JobRequest[] = []
    const deps = { storage, clock, prompt: sink.prompt, fetch: fetchMock((_url, init) => {
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

  test('single consumer, HTTP abort on cleanup, no post-dispose prompts or scheduling', async () => {
    const clock = new FakeClock()
    let calls = 0
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    let signal: AbortSignal | null | undefined
    const sink = collector()
    const bridge = await Bridge.create(cfg(), { storage: new MemoryStorage(), clock, prompt: sink.prompt, fetch: fetchMock((_url, init) => {
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
    expect(sink.prompts).toHaveLength(0)
    await expect(bridge.ask('s', { text: 'after' })).rejects.toThrow('disposed')
  })

  test('HTTP timeout aborts without reopening the POST gate', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    let began!: () => void
    const started = new Promise<void>(r => { began = r })
    const bridge = await Bridge.create(cfg(), { storage, clock, prompt: async () => {}, fetch: fetchMock((_url, init) => {
      began()
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
    }) })
    const job = await bridge.ask('s', { text: 'timeout' })
    const tick = bridge.tick()
    await started
    clock.advance(10_000)
    await tick
    expect((await bridge.status('s', job.id))[0]).toMatchObject({ status: 'accepted', delivered: false })
    expect((JSON.parse(storage.value!) as { jobs: Record<string, OutboxJob> }).jobs[job.id]?.postAttempted).toBe(true)
    await bridge.dispose()
  })

  test('failed prompt persists result, restart delivers without repeating HTTP', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    let calls = 0
    const fetch = fetchMock((url, init) => { calls++; return init.method === 'POST' ? Response.json({ id: (JSON.parse(String(init.body)) as JobRequest).id }, { status: 202 }) : Response.json(complete(url.split('/').at(-1)!)) })
    const bridge = await Bridge.create(cfg(), { storage, clock, fetch, prompt: async () => { throw new Error('no prompt') } })
    const job = await bridge.ask('s', { text: 'x' })
    await bridge.tick(); clock.advance(2_000); await bridge.tick()
    expect((await bridge.status('s', job.id))[0]).toMatchObject({ status: 'completed', delivered: false })
    await bridge.dispose()
    const sink = collector()
    const restarted = await Bridge.create(cfg(), { storage, clock, fetch, prompt: sink.prompt })
    clock.advance(4_000); await restarted.tick()
    expect(calls).toBe(2)
    expect(sink.prompts).toHaveLength(1)
    await restarted.dispose()
  })

  test('GET transport failure retries; 404 pauses with unknown outcome and resume never POSTs', async () => {
    const clock = new FakeClock()
    const sink = collector()
    const bodies: string[] = []
    let gets = 0
    const bridge = await Bridge.create(cfg(), { storage: new MemoryStorage(), clock, prompt: sink.prompt, fetch: fetchMock((url, init) => {
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
    expect(sink.prompts[0]?.text).toContain('Outcome unknown')
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
    const original = await Bridge.create(cfg(), { storage, clock, prompt: async () => {}, fetch: fetchMock((url, init) => init.method === 'POST'
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
      const sink = collector()
      let requests = 0
      const restarted = await Bridge.create(scenario.config, { storage, clock, prompt: sink.prompt, fetch: fetchMock(() => { requests++; throw new Error('must not send') }) })
      for (const job of [attempted, unsent]) {
        expect((await restarted.status('s', job.id))[0]).toMatchObject({ status: 'paused', threadId: job.threadId })
        expect((await restarted.resume('s', job.id)).status).toBe('paused')
      }
      await restarted.tick()
      expect(requests).toBe(0)
      expect(sink.prompts).toHaveLength(2)
      expect(sink.prompts.every(p => p.text.includes(scenario.notice))).toBe(true)
      expect((await restarted.status('s', terminal.id))[0]).toMatchObject({ status: 'completed', delivered: true })
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
      prompt: async () => {}, fetch: fetchMock(() => { calls++; throw new Error('must not send') }),
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

  test('invalid remote attachments stop polling and notify without exposing unvalidated files', async () => {
    const clock = new FakeClock()
    const sink = collector()
    const bridge = await Bridge.create(cfg(), { storage: new MemoryStorage(), clock, prompt: sink.prompt, fetch: fetchMock((url, init) => init.method === 'POST'
      ? Response.json({ id: (JSON.parse(String(init.body)) as JobRequest).id }, { status: 202 })
      : Response.json(complete(url.split('/').at(-1)!, { attachments: [{ name: '../unsafe', mime: 'text/plain', base64: 'YQ==' }] }))) })
    const job = await bridge.ask('s', { text: 'unsafe' })
    await bridge.tick(); clock.advance(2_000); await bridge.tick()
    expect((await bridge.status('s', job.id))[0]?.status).toBe('failed')
    expect(sink.prompts[0]?.files).toEqual([])
    expect(sink.prompts[0]?.text).toContain('Invalid companion job response')
    await bridge.dispose()
  })

  test('tool cancellation before local acceptance persists no job', async () => {
    const storage = new MemoryStorage()
    const bridge = await Bridge.create(cfg(), { storage, prompt: async () => {} })
    await expect(bridge.ask('s', { text: 'cancel' }, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
    expect(storage.value).toBeUndefined()
    await bridge.dispose()
  })
})
