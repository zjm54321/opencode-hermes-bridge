import { afterEach, expect, test } from 'bun:test'
import type { Plugin } from '@opencode/plugin'
import plugin from '../../src/index.js'
import { complete, fetchMock } from './helpers.js'

type Editor = Parameters<Parameters<Plugin.Context['tool']['transform']>[0]>[0]
type Tool = ReturnType<Editor['list']>[number]
const prior = process.env.HERMES_BRIDGE_TOKEN
afterEach(() => { if (prior === undefined) delete process.env.HERMES_BRIDGE_TOKEN; else process.env.HERMES_BRIDGE_TOKEN = prior })

test('actual V2 plugin registers permission-bound tools and tolerates missing token without host mutation', async () => {
  delete process.env.HERMES_BRIDGE_TOKEN
  const tools: Tool[] = []
  let disposed = false
  const editor: Editor = {
    list: () => tools, get: id => tools.find(t => t.id === id), namespace: () => {},
    add: tool => { tools.push({ ...tool, id: tool.name }) },
    update: () => {}, remove: () => {},
  }
  const provided = {
    options: {}, location: { directory: '/tmp/opencode' },
    tool: { transform: async (callback: (editor: Editor) => void) => { callback(editor); return { dispose: async () => { disposed = true } } } },
  }
  // A strict runtime mock: missing host APIs throw if plugin setup accidentally touches them.
  const ctx = new Proxy(provided, { get(target, key) {
    if (key in target) return Reflect.get(target, key)
    throw new Error(`Unexpected host API ${String(key)}`)
  } }) as unknown as Plugin.Context
  expect(plugin.id).toBe('hermes-bridge')
  const cleanup = await plugin.setup(ctx)
  expect(tools.map(t => t.name)).toEqual(['hermes_ask', 'hermes_result', 'hermes_status', 'hermes_resume'])
  for (const tool of tools) {
    expect(tool.options?.permission).toBe(tool.name)
    // Unconfigured execution must return before reading any tool-context fields.
    const unused = new Proxy({}, { get() { throw new Error('Unexpected context access') } }) as Parameters<Tool['execute']>[1]
    const result = await tool.execute({}, unused)
    expect(result.content).toContain('HERMES_BRIDGE_TOKEN')
    expect(result.content).toContain('No HTTP request was made')
  }
  await cleanup?.()
  expect(disposed).toBe(true)
})

test('actual SDK tool execution returns Hermes output without any session/chat API access', async () => {
  process.env.HERMES_BRIDGE_TOKEN = 'test-only-tool-result-token'
  const originalFetch = globalThis.fetch
  const tools: Tool[] = []
  let stored: string | undefined
  let posts = 0
  globalThis.fetch = fetchMock((url, init) => {
    if (init.method === 'POST') {
      posts++
      return Response.json({ id: (JSON.parse(String(init.body)) as { id: string }).id }, { status: 202 })
    }
    return Response.json(complete(url.split('/').at(-1)!))
  })
  const editor: Editor = {
    list: () => tools, get: id => tools.find(t => t.id === id), namespace: () => {},
    add: tool => { tools.push({ ...tool, id: tool.name }) }, update: () => {}, remove: () => {},
  }
  const provided = {
    options: {}, location: { directory: '/tmp/opencode' },
    storage: { get: async () => stored, set: async (_key: string, value: string) => { stored = value } },
    tool: { transform: async (callback: (editor: Editor) => void) => { callback(editor); return { dispose: async () => {} } } },
  }
  let forbiddenHostCalls = 0
  const ctx = new Proxy(provided, { get(target, key) {
    if (key in target) return Reflect.get(target, key)
    forbiddenHostCalls++
    throw new Error(`Forbidden host API ${String(key)}`)
  } }) as unknown as Plugin.Context
  let cleanup: Awaited<ReturnType<typeof plugin.setup>> = undefined
  try {
    cleanup = await plugin.setup(ctx)
    const context = { sessionID: 'tool-result-session', signal: new AbortController().signal } as Parameters<Tool['execute']>[1]
    const ask = tools.find(t => t.name === 'hermes_ask')!
    const result = await ask.execute({ text: 'formal tool output' }, context)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Hermes reply') }])
    expect(result.metadata).toMatchObject({ status: 'completed', final: true })
    const read = tools.find(t => t.name === 'hermes_result')!
    expect(await read.execute({ id: result.metadata!.id }, context)).toEqual(result)
    const pending = await ask.execute({ text: 'return immediately', waitSeconds: 0 }, context)
    expect(pending.metadata).toMatchObject({ status: 'accepted', final: false })
    expect(JSON.stringify(pending.content)).toContain('Not a final result')
    await expect(ask.execute({ text: 'invalid wait', waitSeconds: 121 }, context)).rejects.toThrow('waitSeconds')
    expect(posts).toBe(1)
    expect(forbiddenHostCalls).toBe(0)
  } finally {
    await cleanup?.()
    globalThis.fetch = originalFetch
  }
}, 10_000)
