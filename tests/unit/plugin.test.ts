import { afterEach, expect, test } from 'bun:test'
import type { Plugin } from '@opencode/plugin'
import plugin from '../../src/index.js'

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
  expect(tools.map(t => t.name)).toEqual(['hermes_ask', 'hermes_status', 'hermes_resume'])
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
