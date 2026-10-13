import { config, type Clock, type JobResponse, type Storage } from '../../src/core.js'

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
export function fetchMock(handler: (url: string, init: RequestInit) => Promise<Response> | Response, options: { capabilities?: boolean } = {}): typeof globalThis.fetch {
  // Existing cases model a legacy companion. File-protocol cases opt into explicit capability handling.
  return Object.assign((input: string | URL | Request, init?: RequestInit) => {
    if (!options.capabilities && new URL(String(input)).pathname === '/v1/capabilities') return Promise.resolve(new Response(null, { status: 404 }))
    return Promise.resolve(handler(String(input), init ?? {}))
  }, { preconnect: () => {} })
}
export function complete(id: string, changes: Partial<JobResponse> = {}): JobResponse {
  return { id, status: 'completed', text: 'Hermes reply', attachments: [], error: null, ...changes }
}
