import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { config } from '../../src/core.js'
import { contentDisposition, LIMITS, readJSON, response, text, verifyAssetHeaders } from '../../src/protocol.js'

test('wire admission rejects credential-bearing config, oversized UTF-8/streams and unsafe result manifests', async () => {
  const env = { HERMES_BRIDGE_TOKEN: 'test-secret' }
  expect(config({}, env).uploadRoots).toEqual([])
  expect(() => config({}, {})).toThrow('HERMES_BRIDGE_TOKEN')
  expect(() => config({ token: 'do-not-store' }, env)).toThrow('environment')
  expect(() => config({ url: 'http://user:pass@localhost:8787' }, env)).toThrow('HTTP(S) origin')
  expect(text('a'.repeat(LIMITS.text))).toHaveLength(LIMITS.text)
  expect(() => text('你'.repeat(Math.ceil(LIMITS.text / 3)))).toThrow('64 KiB')

  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(LIMITS.wire + 1)) },
    cancel() { cancelled = true },
  })
  await expect(readJSON(new Response(stream, { headers: { 'Content-Length': '1' } }))).rejects.toThrow('32 MiB')
  expect(cancelled).toBe(true)
  const id = randomUUID()
  const output = { id, status: 'completed' as const, text: 'done', attachments: [], error: null }
  expect(response(await readJSON(Response.json(output)), id)).toEqual(output)
  const file = { asset_id: randomUUID(), name: 'safe.zip', mime: 'application/zip', size: 1, sha256: '0'.repeat(64) }
  expect(() => verifyAssetHeaders(new Headers({
    'Content-Type': file.mime, 'Content-Length': '2', 'Content-Disposition': contentDisposition(file.name), 'X-Content-SHA256': file.sha256,
  }), file)).toThrow('metadata mismatch')
  expect(() => response({ ...output, output_assets: [{ ...file, name: '../escape.zip' }] }, id)).toThrow('basename')
  expect(() => response({ ...output, status: 'running', output_assets: [file] }, id)).toThrow('require a completed job')
})
