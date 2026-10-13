import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bridge, config, type Asset, type Attachment, type JobResponse, type OutboxJob, type Storage } from '../../src/core.js'

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
export interface NativeFileEvidence {
  runner: string; plugin_module: string; run_id: string; native_posts: number; native_gets: number
  native_requests: { input: string; session_id: string }[]
  native_job_ids: string[]; plugin_calls: string[]
  plugin: { error?: string; workspace?: string; input?: Asset & { path: string }; published?: Asset }
  http: { method: string; path: string; status: number }[]
}
export class Harness {
  readonly storage = new MemoryStorage()
  private readonly bridges: Bridge[] = []
  constructor(readonly root: string, readonly url: string, readonly token: string) {}
  get workspace() { return join(this.root, 'server') }
  get uploads() { return join(this.root, 'uploads') }
  get outputs() { return join(this.root, 'client-outputs') }
  get nativeZip() { return join(this.uploads, 'native-original.zip') }
  async nativeStats(): Promise<NativeFileEvidence> {
    return JSON.parse(await readFile(join(this.root, 'native-stats.json'), 'utf8')) as NativeFileEvidence
  }
  async bridge(storage = this.storage, token = this.token): Promise<Bridge> {
    const cfg = config({ url: this.url, uploadRoots: [this.uploads], outputDir: this.outputs }, { HERMES_BRIDGE_TOKEN: token }, project)
    // Real native fetch and filesystem output writer; only polling cadence is shortened.
    const bridge = await Bridge.create({ ...cfg, pollMs: 10, httpTimeoutMs: 2_000 }, { storage })
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
  async result(bridge: Bridge, session: string, id: string) {
    const result = await bridge.result(session, id, { waitSeconds: 5 })
    if (!result.metadata?.final) throw new Error(`No final tool result for job ${id} within 5s`)
    return result
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
export async function withFixture(run: (harness: Harness) => Promise<void>, options: { files?: boolean; nativeFiles?: boolean } = {}): Promise<void> {
  const root = await mkdtemp('/tmp/opencode/hermes-http-integration-')
  const token = `integration-${randomUUID()}-${randomUUID()}`
  const fileToken = options.files || options.nativeFiles ? `integration-files-${randomUUID()}-${randomUUID()}` : ''
  let child: Child | undefined
  let harness: Harness | undefined
  let stderr: Promise<string> | undefined
  try {
    child = Bun.spawn(['python', '-B', '-u', fixture, '--workspace', join(root, 'server'), '--port', '0', ...(options.nativeFiles ? ['--native-files'] : [])], {
      cwd: project, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      // Native mode inherits only the executable search path, never real Hermes,
      // proxy, provider credentials, tokens, or profile/environment configuration.
      env: { ...(options.nativeFiles ? { PATH: process.env.PATH ?? '', HOME: join(root, 'unused-home'), XDG_CONFIG_HOME: join(root, 'unused-config') } : process.env),
        PYTHONPATH: join(project, 'companion'), HERMES_BRIDGE_TOKEN: token, HERMES_BRIDGE_FILE_TOKEN: fileToken, PYTHONDONTWRITEBYTECODE: '1' },
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
    if (logs?.includes(token) || (fileToken && logs?.includes(fileToken))) throw new Error('Fixture leaked authentication token to stderr')
  }
}
