import { config, type Clock, type JobResponse, type Prompt, type Storage } from '../../src/core.js'

export class MemoryStorage implements Storage {
  value?: string
  async load() { return this.value }
  async save(value: string) { this.value = value }
}
export class FakeClock implements Clock {
  time = 1_000
  timers = new Set<{ callback: () => void; at: number }>()
  now = () => this.time
  schedule = (callback: () => void, delay: number) => {
    const item = { callback, at: this.time + delay }
    this.timers.add(item)
    return () => { this.timers.delete(item) }
  }
  advance(ms: number) {
    this.time += ms
    for (const timer of [...this.timers]) {
      if (timer.at <= this.time) { this.timers.delete(timer); timer.callback() }
    }
  }
}
export function cfg() { return config({}, { HERMES_BRIDGE_TOKEN: 'test-secret' }, '/tmp/opencode') }
export function fetchMock(handler: (url: string, init: RequestInit) => Promise<Response> | Response): typeof globalThis.fetch {
  return Object.assign((input: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(input), init ?? {})), { preconnect: () => {} })
}
export function complete(id: string, changes: Partial<JobResponse> = {}): JobResponse {
  return { id, status: 'completed', text: 'Hermes reply', attachments: [], error: null, ...changes }
}
export function collector() {
  const prompts: Prompt[] = []
  return { prompts, prompt: async (p: Prompt) => { prompts.push(p) } }
}
