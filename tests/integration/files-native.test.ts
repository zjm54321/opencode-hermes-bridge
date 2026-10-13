import { expect, test } from 'bun:test'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { hashBytes } from '../../src/protocol.js'
import { withFixture } from './harness.js'

test('localhost native path: PNG + ZIP → GatewayRunner → actual file plugin → original ZIP Tool.Result', async () => {
  await withFixture(async h => {
    const [png] = await h.files()
    if (!png) throw new Error('Missing generated PNG fixture')
    const original = await readFile(h.nativeZip)
    const digest = hashBytes(original)
    const bridge = await h.bridge()
    const session = 'native-files-local-session'
    const text = 'Return the original ZIP through the file tools without extracting it.'
    const job = await bridge.ask(session, {
      text, requireFiles: true,
      attachments: [{ path: join(h.uploads, png.name), mime: png.mime }],
      files: [{ path: h.nativeZip, name: 'native-original.zip', mime: 'application/zip' }],
    })
    const result = await h.result(bridge, session, job.id)
    const native = await h.nativeStats()
    expect(native.plugin.error).toBeUndefined()
    expect(native.runner).toBe('GatewayRunner')
    expect(native.plugin_module.endsWith('/integrations/hermes_file_plugin/__init__.py')).toBe(true)
    expect(native.native_posts).toBe(1)
    expect(native.native_job_ids).toEqual([job.id])
    expect(native.plugin_calls).toEqual(['bridge_files', 'bridge_publish_file'])
    expect(native.native_requests[0]!.session_id).toBe(`opencode-${job.threadId}`)
    // The shared fixture type describes text-only input. Images use the production
    // Gateway multimodal input shape; inspect the wire value without changing it.
    const input: unknown = native.native_requests[0]!.input
    expect(input).toEqual([{ role: 'user', content: [
      { type: 'text', text: expect.stringContaining(text) },
      { type: 'image_url', image_url: { url: `data:${png.mime};base64,${png.base64}` } },
    ] }])
    expect(JSON.stringify(input)).toContain('bridge_files')
    expect(JSON.stringify(input)).not.toContain(original.toString('base64'))

    const remote = await h.terminal(job.id)
    expect(remote.output_assets).toHaveLength(1)
    const asset = remote.output_assets![0]!
    expect(asset).toEqual(native.plugin.published!)
    expect(asset).toMatchObject({ name: 'native-returned.zip', mime: 'application/zip', size: original.length, sha256: digest })
    expect(native.plugin.input).toMatchObject({ name: 'native-original.zip', size: original.length, sha256: digest })
    expect(await readFile(native.plugin.input!.path)).toEqual(original)

    const output = join(h.outputs, job.id, asset.asset_id, asset.name)
    expect(await readFile(output)).toEqual(original)
    const saved = await stat(output, { bigint: true })
    expect(Number(saved.mode & 0o777n)).toBe(0o600)
    expect((await stat(join(h.outputs, job.id, asset.asset_id))).mode & 0o777).toBe(0o700)
    expect(result.metadata?.artifacts).toEqual([{ ...asset, path: output }])
    expect(result.metadata?.final).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(output) }])
    expect(JSON.stringify(result)).not.toContain(original.toString('base64'))

    const assetDownloads = (await h.nativeStats()).http.filter(call => call.method === 'GET' && call.path === `/v1/jobs/${job.id}/assets/${asset.asset_id}`)
    expect(assetDownloads.map(call => call.status)).toEqual([200])
    await bridge.dispose()
    const restarted = await h.bridge()
    expect(await restarted.result(session, job.id)).toEqual(result)
    const repeated = await h.nativeStats()
    expect(repeated.native_posts).toBe(1)
    expect(repeated.plugin_calls).toEqual(native.plugin_calls)
    expect(repeated.http.filter(call => call.method === 'GET' && call.path === `/v1/jobs/${job.id}/assets/${asset.asset_id}`)).toEqual(assetDownloads)
    const unchanged = await stat(output, { bigint: true })
    expect(unchanged.ino).toBe(saved.ino)
    expect(unchanged.mtimeNs).toBe(saved.mtimeNs)
  }, { nativeFiles: true })
}, 30_000)
