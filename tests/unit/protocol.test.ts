import { describe, expect, test } from 'bun:test'
import { config } from '../../src/core.js'
import { asset, assets, contentDisposition, hashBytes, LIMITS, readBytes, readJSON, response, text, verifyAssetHeaders, verifyBytes } from '../../src/protocol.js'
import { randomUUID } from 'node:crypto'

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
  test('raw asset headers, manifest, size/hash and bounded stream are validated independently', async () => {
    const bytes = Buffer.from([0, 255, 0x50, 0x4b])
    const a = { asset_id: randomUUID(), name: "测试 'file'.zip", mime: 'application/zip', size: bytes.length, sha256: hashBytes(bytes) }
    expect(asset({ ...a, path: '/private/Hermes/path-must-not-leak' })).toEqual(a)
    const headers = new Headers({ 'Content-Type': a.mime, 'Content-Length': String(a.size), 'Content-Disposition': contentDisposition(a.name), 'X-Content-SHA256': a.sha256 })
    expect(() => verifyAssetHeaders(headers, a)).not.toThrow()
    verifyBytes(a, await readBytes(new Response(bytes, { headers }), a.size))
    for (const [key, value] of [['Content-Length', '100'], ['Content-Disposition', "attachment; filename*=UTF-8''..%2Fescape"], ['X-Content-SHA256', '0'.repeat(64)], ['Content-Type', 'text/plain'], ['Content-Encoding', 'gzip']]) {
      const changed = new Headers(headers)
      changed.set(key!, value!)
      expect(() => verifyAssetHeaders(changed, a)).toThrow('metadata mismatch')
    }
    for (const patch of [{ asset_id: 'bad' }, { name: '../escape' }, { size: LIMITS.file + 1 }, { size: -1 }, { sha256: 'bad' }]) expect(() => asset({ ...a, ...patch })).toThrow()
    expect(() => assets([a, a])).toThrow('Duplicate asset ID')
    expect(() => assets([a, { ...a, asset_id: randomUUID() }])).not.toThrow() // Same names are isolated by asset ID.
    for (const status of ['queued', 'running', 'failed']) {
      const pending = { id: a.asset_id, status, text: '', attachments: [], error: null, output_assets: [] }
      expect(response(pending, a.asset_id).output_assets).toEqual([])
      expect(() => response({ ...pending, output_assets: [a] }, a.asset_id)).toThrow('require a completed job')
    }
    expect(response({ id: a.asset_id, status: 'completed', text: '', attachments: [], error: null, output_assets: [a] }, a.asset_id).output_assets).toEqual([a])
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.alloc(a.size + 1)) }, cancel() { cancelled = true } })
    await expect(readBytes(new Response(stream, { headers }), a.size)).rejects.toThrow('size limit')
    expect(cancelled).toBe(true)
    expect(() => verifyBytes(a, Buffer.alloc(a.size))).toThrow('size/SHA-256 mismatch')
    expect(await readBytes(new Response(null), 0)).toEqual(Buffer.alloc(0))
  })
})
