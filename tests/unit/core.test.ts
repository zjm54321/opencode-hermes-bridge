import { expect, test } from 'bun:test'
import { Bridge, type JobRequest, type OutboxJob } from '../../src/core.js'
import { cfg, complete, FakeClock, fetchMock, MemoryStorage } from './helpers.js'

test('durable intent: lost 202/404 pauses; scope cannot rebind; original scope resumes by GET after restart', async () => {
  const storage = new MemoryStorage()
  const clock = new FakeClock()
  const requests: string[] = []
  const stored = (id: string) => (JSON.parse(storage.value!) as { jobs: Record<string, OutboxJob> }).jobs[id]!
  let known = false
  const fetch = fetchMock((url, init) => {
    requests.push(`${init.method} ${new URL(url).pathname}`)
    expect(init.redirect).toBe('error')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-secret')
    if (init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as JobRequest
      expect(stored(body.id)).toMatchObject({ postAttempted: true, submitted: false, text: body.text })
      throw new Error('Accepted remotely but 202 was lost')
    }
    return known ? Response.json(complete(url.split('/').at(-1)!)) : new Response(null, { status: 404 })
  })
  let bridge = await Bridge.create(cfg(), { storage, clock, fetch })
  try {
    const job = await bridge.ask('owner', { text: 'recover the original job' })
    expect(stored(job.id)).toMatchObject({ postAttempted: false, submitted: false, threadId: job.threadId })
    expect(await bridge.status('owner')).toEqual([job])
    expect(await bridge.status('other')).toEqual([])
    await expect(bridge.status('other', job.id)).rejects.toThrow('current session')
    await expect(bridge.result('other', job.id)).rejects.toThrow('current session')
    await expect(bridge.resume('other', job.id)).rejects.toThrow('current session')
    expect(requests).toEqual([])
    await bridge.tick()
    clock.advance(4_000); await bridge.tick()
    expect((await bridge.result('owner', job.id)).metadata).toMatchObject({ status: 'paused', final: false })
    expect(stored(job.id).notice).toContain('Outcome unknown')
    clock.advance(90_000); await bridge.tick()
    expect(requests).toEqual(['POST /v1/jobs', `GET /v1/jobs/${job.id}`])
    const scope = stored(job.id).scopeHash
    await bridge.dispose()

    bridge = await Bridge.create({ ...cfg(), token: 'changed-test-token' }, { storage, clock, fetch })
    expect((await bridge.resume('owner', job.id)).notice).toContain('endpoint or credential')
    await bridge.tick()
    expect(requests).toHaveLength(2)
    expect(stored(job.id).scopeHash).toBe(scope)
    expect(storage.value).not.toContain('changed-test-token')
    expect(storage.value).not.toContain('test-secret')
    await bridge.dispose()

    known = true
    bridge = await Bridge.create(cfg(), { storage, clock, fetch })
    await bridge.resume('owner', job.id)
    await bridge.tick()
    const result = await bridge.result('owner', job.id)
    expect(result.metadata).toMatchObject({ id: job.id, threadId: job.threadId, status: 'completed', final: true })
    expect(requests).toEqual(['POST /v1/jobs', `GET /v1/jobs/${job.id}`, `GET /v1/jobs/${job.id}`])
    await bridge.dispose()

    bridge = await Bridge.create(cfg(), { storage, clock, fetch })
    expect(await bridge.result('owner', job.id)).toEqual(result)
    await bridge.tick()
    expect(requests).toHaveLength(3)
    expect((await bridge.ask('owner', { text: 'next request' })).threadId).toBe(job.threadId)
  } finally { await bridge.dispose() }
})

test('pre-scope v1 outboxes remain locally readable but cannot be replayed or rebound', async () => {
  const storage = new MemoryStorage()
  let bridge = await Bridge.create(cfg(), { storage })
  const job = await bridge.ask('owner', { text: 'existing legacy job' })
  await bridge.dispose()
  const state = JSON.parse(storage.value!) as { jobs: Record<string, Partial<OutboxJob>> }
  delete state.jobs[job.id]!.postAttempted
  delete state.jobs[job.id]!.scopeHash
  // Old outboxes allowed inline ordinary files. They must still load, not send.
  state.jobs[job.id]!.attachments = [{ name: 'old.txt', mime: 'text/plain', base64: 'YQ==' }]
  storage.value = JSON.stringify(state)
  let calls = 0
  bridge = await Bridge.create(cfg(), { storage, fetch: fetchMock(() => { calls++; throw new Error('Legacy HTTP forbidden') }) })
  try {
    expect((await bridge.status('owner', job.id))[0]).toMatchObject({ status: 'paused', threadId: job.threadId })
    expect((await bridge.resume('owner', job.id)).notice).toContain('legacy job')
    expect((await bridge.result('owner', job.id)).metadata?.final).toBe(false)
    await bridge.tick()
    const saved = (JSON.parse(storage.value!) as typeof state).jobs[job.id]!
    expect(saved).toMatchObject({ postAttempted: true, attachments: state.jobs[job.id]!.attachments })
    expect(saved.scopeHash).toBeUndefined()
    expect(calls).toBe(0)
  } finally { await bridge.dispose() }
})

test('bounded result wait and caller cancellation leave the admitted job running once', async () => {
  const clock = new FakeClock()
  const methods: string[] = []
  const bridge = await Bridge.create(cfg(), { storage: new MemoryStorage(), clock, fetch: fetchMock((url, init) => {
    methods.push(init.method!)
    return init.method === 'POST' ? Response.json({ id: (JSON.parse(String(init.body)) as JobRequest).id }, { status: 202 })
      : Response.json(complete(url.split('/').at(-1)!))
  }) })
  try {
    const job = await bridge.ask('s', { text: 'long task' })
    const timed = bridge.result('s', job.id, { waitSeconds: 1 })
    await bridge.tick()
    clock.advance(1_000)
    expect((await timed).metadata).toMatchObject({ id: job.id, status: 'queued', final: false })
    const caller = new AbortController()
    const cancelled = bridge.result('s', job.id, { waitSeconds: 120, signal: caller.signal })
    caller.abort(new Error('caller stopped waiting'))
    await expect(cancelled).rejects.toThrow('caller stopped waiting')
    expect(clock.timers.size).toBe(1) // Only the independent job pump remains.
    expect((await bridge.status('s', job.id))[0]?.status).toBe('queued')
    clock.advance(1_000); await bridge.tick()
    expect((await bridge.result('s', job.id)).metadata?.final).toBe(true)
    expect(methods).toEqual(['POST', 'GET'])
  } finally { await bridge.dispose() }
  expect(clock.timers.size).toBe(0)
})
