import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bridge, config, type Attachment, type JobResponse, type OutboxJob, type Prompt, type Storage } from '../../src/core.js'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixture = join(project, 'companion/tests/http_fixture.py')
const probe = join(project, 'tests/integration/probe.py')
type Child = ReturnType<typeof Bun.spawn< 'ignore', 'pipe', 'pipe' >>

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    })])
  } finally { clearTimeout(timer) }
}
async function stop(child: Child): Promise<void> {
  if (child.exitCode !== null) { await child.exited; return }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
    child.kill(signal)
    try { await bounded(child.exited, 2_000, `fixture ${signal}`); return } catch { /* escalate only this owned child */ }
  }
  throw new Error('Owned fixture process did not exit after SIGKILL')
}
async function readiness(stream: ReadableStream<Uint8Array>): Promise<{ host: string; port: number }> {
  const reader = stream.getReader()
  let output = ''
  try {
    while (!output.includes('\n')) {
      const { value, done } = await reader.read()
      if (done) throw new Error('Fixture exited before readiness')
      output += new TextDecoder().decode(value)
      if (output.length > 4096) throw new Error('Unexpected fixture readiness output')
    }
    const result: unknown = JSON.parse(output.slice(0, output.indexOf('\n')))
    if (!result || typeof result !== 'object' || !('host' in result) || result.host !== '127.0.0.1' || !('port' in result) || typeof result.port !== 'number' || !Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error('Invalid fixture readiness address')
    return { host: result.host, port: result.port }
  } finally { reader.releaseLock() }
}
export class MemoryStorage implements Storage {
  value?: string
  async load() { return this.value }
  async save(value: string) { this.value = value }
  job(id: string): OutboxJob {
    const state = JSON.parse(this.value ?? '{}') as { jobs?: Record<string, OutboxJob> }
    const job = state.jobs?.[id]
    if (!job) throw new Error('Expected a persisted outbox job')
    return job
  }
}
export interface Evidence {
  rows: { id: string; thread_id: string; status: string; input: string }[]
  messages: { role: string; content: string }[]
}
export interface FixtureBytes extends Attachment { sha256: string }
export class Harness {
  readonly storage = new MemoryStorage()
  readonly prompts: Prompt[] = []
  private readonly bridges: Bridge[] = []
  constructor(readonly root: string, readonly url: string, readonly token: string) {}
  get workspace() { return join(this.root, 'server') }
  get uploads() { return join(this.root, 'uploads') }
  get outputs() { return join(this.root, 'client-outputs') }
  async bridge(storage = this.storage, token = this.token): Promise<Bridge> {
    const cfg = config({ url: this.url, uploadRoots: [this.uploads], outputDir: this.outputs }, { HERMES_BRIDGE_TOKEN: token }, project)
    // Real native fetch and filesystem output writer; only polling cadence is shortened.
    const bridge = await Bridge.create({ ...cfg, pollMs: 10, httpTimeoutMs: 2_000 }, { storage, prompt: async p => { this.prompts.push(p) } })
    this.bridges.push(bridge)
    return bridge
  }
  async close() { for (const bridge of this.bridges) await bridge.dispose() }
  async http(path: string, body?: unknown, token: string | null = this.token): Promise<Response> {
    return fetch(`${this.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(2_000),
      headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  async runProbe(args: string[]): Promise<unknown> {
    const child = Bun.spawn(['python', '-B', probe, ...args], { cwd: project, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    try {
      const code = await bounded(child.exited, 5_000, 'fixture evidence helper')
      if (code !== 0) throw new Error(`Evidence helper failed: ${(await errors).replaceAll(this.token, '[redacted]')}`)
      return JSON.parse(await output) as unknown
    } finally { await stop(child) }
  }
  async files(): Promise<FixtureBytes[]> { return await this.runProbe(['files', this.uploads]) as FixtureBytes[] }
  async evidence(id: string, threadId: string): Promise<Evidence> {
    return await this.runProbe(['inspect', join(this.workspace, 'bridge.sqlite3'), id, threadId]) as Evidence
  }
  async delivered(bridge: Bridge, session: string, id: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      await bridge.tick()
      if ((await bridge.status(session, id))[0]?.delivered) return
      await Bun.sleep(10)
    }
    throw new Error(`No local delivery for job ${id} within 5s`)
  }
  async terminal(id: string): Promise<JobResponse> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const response = await this.http(`/v1/jobs/${id}`)
      if (response.status !== 200) throw new Error(`Unexpected polling HTTP ${response.status}`)
      const job = await response.json() as JobResponse
      if (job.status === 'completed' || job.status === 'failed') return job
      await Bun.sleep(10)
    }
    throw new Error(`No remote terminal status for job ${id} within 5s`)
  }
}
export async function withFixture(run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp('/tmp/opencode/hermes-http-integration-')
  const token = `integration-${randomUUID()}-${randomUUID()}`
  let child: Child | undefined
  let harness: Harness | undefined
  let stderr: Promise<string> | undefined
  try {
    child = Bun.spawn(['python', '-B', '-u', fixture, '--workspace', join(root, 'server'), '--port', '0'], {
      cwd: project, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, PYTHONPATH: join(project, 'companion'), HERMES_BRIDGE_TOKEN: token, PYTHONDONTWRITEBYTECODE: '1' },
    })
    stderr = new Response(child.stderr).text()
    const { host, port } = await bounded(readiness(child.stdout), 5_000, 'Python HTTP readiness')
    harness = new Harness(root, `http://${host}:${port}`, token)
    await run(harness)
  } finally {
    try { await harness?.close() } finally {
      try { if (child) await stop(child) } finally {
        // Delete only the directory created by this invocation, never fixture/source/user paths.
        await rm(root, { recursive: true, force: true })
      }
    }
    const logs = await stderr
    if (logs?.includes(token)) throw new Error('Fixture leaked authentication token to stderr')
  }
}
