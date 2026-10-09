import { describe, expect, test } from 'bun:test'
import { config } from '../../src/core.js'
import { LIMITS, readJSON, text } from '../../src/protocol.js'

describe('configuration and wire limits', () => {
  test('defaults, env-only secret, explicit roots, unsafe endpoints rejected', () => {
    const env = { HERMES_BRIDGE_TOKEN: 'secret' }
    expect(config({}, env).url).toBe('http://127.0.0.1:8787')
    expect(config({}, env).uploadRoots).toEqual([])
    expect(() => config({}, {})).toThrow('HERMES_BRIDGE_TOKEN')
    expect(() => config({ token: 'do-not-store' }, env)).toThrow('environment')
    expect(config({ tokenEnv: 'CUSTOM_TOKEN' }, { CUSTOM_TOKEN: 'custom' }).token).toBe('custom')
    expect(config({}, { ...env, HERMES_BRIDGE_UPLOAD_ROOTS: '["/tmp/opencode"]' }).uploadRoots).toEqual(['/tmp/opencode'])
    for (const url of ['file:///etc/passwd', 'http://user:pass@localhost:8787', 'http://localhost/?key=x', 'http://localhost/#x', 'http://localhost/path']) {
      expect(() => config({ url }, env)).toThrow()
    }
  })
  test('counts streamed actual response bytes rather than trusting Content-Length', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 33; i++) controller.enqueue(new Uint8Array(1024 ** 2))
      },
      cancel() { cancelled = true },
    })
    const result = new Response(stream, { headers: { 'Content-Length': '1' } })
    await expect(readJSON(result)).rejects.toThrow('32 MiB')
    expect(cancelled).toBe(true)
    expect(await readJSON(Response.json({ ok: true }))).toEqual({ ok: true })
    await expect(readJSON(new Response('invalid'))).rejects.toThrow()
  })
  test('text limit measures UTF-8 bytes', () => {
    expect(text('a'.repeat(LIMITS.text))).toHaveLength(LIMITS.text)
    expect(() => text('你'.repeat(Math.ceil(LIMITS.text / 3)))).toThrow('64 KiB')
  })
})
