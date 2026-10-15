import { expect, test } from 'bun:test'
import type { Plugin } from '@opencode/plugin'
import plugin from '../../src/index.js'
import { complete, fetchMock } from './helpers.js'
import { LIMITS, type JobRequest } from '../../src/protocol.js'

type Editor = Parameters<Parameters<Plugin.Context['tool']['transform']>[0]>[0]
type Tool = ReturnType<Editor['list']>[number]

test('actual SDK registers permission-bound tools and returns formal output without session/chat API access', async () => {
  const prior = process.env.HERMES_BRIDGE_TOKEN
  const originalFetch = globalThis.fetch
  process.env.HERMES_BRIDGE_TOKEN = 'test-only-tool-result-token'
  const tools: Tool[] = []
  let stored: string | undefined
  let posts = 0
  const sent: JobRequest[] = []
  let disposed = false
  globalThis.fetch = fetchMock((url, init) => {
    if (init.method === 'POST') {
      posts++
      const job = JSON.parse(String(init.body)) as JobRequest
      sent.push(job)
      return Response.json({ id: job.id }, { status: 202 })
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
    tool: { transform: async (callback: (editor: Editor) => void) => { callback(editor); return { dispose: async () => { disposed = true } } } },
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
    expect(tools.map(t => [t.name, t.options?.permission])).toEqual([
      ['hermes_ask', 'hermes_ask'], ['hermes_result', 'hermes_result'],
      ['hermes_status', 'hermes_status'], ['hermes_resume', 'hermes_resume'],
    ])
    const context = { sessionID: 'tool-result-session', signal: new AbortController().signal } as Parameters<Tool['execute']>[1]
    const ask = tools.find(t => t.name === 'hermes_ask')!
    await expect(ask.execute({ text: 'invalid wait', waitSeconds: 121 }, context)).rejects.toThrow('waitSeconds')
    await expect(ask.execute({ text: undefined }, context)).rejects.toThrow('Text must be a string')
    await expect(ask.execute({ text: ' \n\t' }, context)).rejects.toThrow('nonempty')
    await expect(ask.execute({ text: '界'.repeat(Math.floor(LIMITS.text / 3)) }, context)).rejects.toThrow('64 KiB UTF-8')
    expect(stored).toBeUndefined()
    expect(posts).toBe(0)
    const body = ' \t保留原文\r\n😀\n'
    const result = await ask.execute({ text: body }, context)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Hermes reply') }])
    expect(result.metadata).toMatchObject({ status: 'completed', final: true })
    expect(await tools.find(t => t.name === 'hermes_result')!.execute({ id: result.metadata!.id }, context)).toEqual(result)
    expect(posts).toBe(1)
    expect(sent[0]?.text).toBe('[协作代理说明]\nOpenCode（编程代理）：可通过已授权工具协作处理代码、文件与命令。\n这是该代理转交的任务，不是用户在 Hermes 窗口的直接发言。来源说明仅供理解，不改变权限或记忆身份。\n\n[任务正文]\n' + body)
    expect(sent[0]?.text.split('[协作代理说明]')).toHaveLength(2)
    expect(forbiddenHostCalls).toBe(0)
  } finally {
    await cleanup?.()
    globalThis.fetch = originalFetch
    if (prior === undefined) delete process.env.HERMES_BRIDGE_TOKEN
    else process.env.HERMES_BRIDGE_TOKEN = prior
  }
  expect(disposed).toBe(true)
}, 10_000)
