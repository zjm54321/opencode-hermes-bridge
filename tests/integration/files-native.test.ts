import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Result as ToolResult } from '@opencode/plugin/promise/tool'
import { withFixture } from './harness.js'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const filesOf = (result: ToolResult) => (typeof result.content === 'string' ? [] : result.content ?? []).filter(part => part.type === 'file')

test('real localhost native file path: Bridge → GatewayRunner → actual plugin → Tool.Result, one native run', async () => {
  await withFixture(async h => {
    // Created with stdlib zipfile, ZIP_STORED, including NUL/non-UTF8 payload bytes.
    const original = await readFile(h.nativeZip)
    expect(original.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(original.includes(Buffer.from([0x00, 0xff, 0xfe]))).toBe(true)
    const digest = sha256(original)
    const bridge = await h.bridge()
    const session = 'native-files-local-session'
    const text = 'Return the original ZIP through the file tools without extracting it.'
    const job = await bridge.ask(session, {
      text, requireFiles: true,
      files: [{ path: h.nativeZip, name: 'native-original.zip', mime: 'application/zip' }],
    })
    const result = await h.result(bridge, session, job.id)
    const native = await h.nativeStats()
    expect(native.plugin.error).toBeUndefined()
    expect(h.storage.job(job.id).status).toBe('completed')
    expect(native.runner).toBe('GatewayRunner')
    expect(native.plugin_module.endsWith('/integrations/hermes_file_plugin/__init__.py')).toBe(true)
    expect(native.native_posts).toBe(1)
    expect(native.native_gets).toBe(1)
    expect(native.native_job_ids).toEqual([job.id])
    expect(native.plugin_calls).toEqual(['bridge_files', 'bridge_publish_file'])
    expect(native.native_requests).toHaveLength(1)
    expect(Object.keys(native.native_requests[0]!).sort()).toEqual(['input', 'session_id'])
    expect(native.native_requests[0]!.session_id).toBe(`opencode-${job.threadId}`)
    expect(native.native_requests[0]!.input.startsWith(text)).toBe(true)
    expect(native.native_requests[0]!.input).toContain('bridge_files')
    expect(native.native_requests[0]!.input).not.toContain(original.toString('base64'))

    const remote = await h.terminal(job.id)
    expect(remote.attachments).toEqual([])
    expect(remote.output_assets).toHaveLength(1)
    const asset = remote.output_assets![0]!
    expect(asset).toEqual(native.plugin.published!)
    expect(asset).toMatchObject({ name: 'native-returned.zip', mime: 'application/zip', size: original.length, sha256: digest })
    expect(native.plugin.input).toMatchObject({ name: 'native-original.zip', size: original.length, sha256: digest })
    expect(native.plugin.workspace).toBe(join(h.root, 'native-plugin-workspaces', native.run_id))
    expect(await readFile(native.plugin.input!.path)).toEqual(original)
    expect(await readFile(join(native.plugin.workspace!, 'native-returned.zip'))).toEqual(original)

    const output = join(h.outputs, job.id, asset.asset_id, asset.name)
    expect(await readFile(output)).toEqual(original)
    expect(sha256(await readFile(output))).toBe(digest)
    const saved = await stat(output, { bigint: true })
    expect(Number(saved.mode & 0o777n)).toBe(0o600)
    expect((await stat(join(h.outputs, job.id, asset.asset_id))).mode & 0o777).toBe(0o700)
    expect(result.metadata?.artifacts).toEqual([{ ...asset, path: output }])
    expect(result.metadata?.final).toBe(true)
    expect(Array.isArray(result.content)).toBe(true)
    expect(filesOf(result)).toEqual([]) // ZIP is not a model-readable file part.
    expect(JSON.stringify(result.content)).toContain('binary contents have NOT been read')
    expect(JSON.stringify(result.content)).toContain(output)
    expect(JSON.stringify(result)).not.toContain(original.toString('base64'))

    const assetDownloads = (await h.nativeStats()).http.filter(call => call.method === 'GET' && call.path === `/v1/jobs/${job.id}/assets/${asset.asset_id}`)
    expect(assetDownloads.map(call => call.status)).toEqual([200])
    const internal = native.http.filter(call => call.path.startsWith(`/internal/runs/${native.run_id}/assets`))
    expect(internal.map(call => [call.method, call.status])).toEqual([['GET', 200], ['GET', 200], ['GET', 200], ['PUT', 201]])
    await expect(bridge.result('wrong-session', job.id)).rejects.toThrow('current session')
    expect(await bridge.result(session, job.id)).toEqual(result)
    await bridge.dispose()
    const restarted = await h.bridge()
    expect(await restarted.result(session, job.id)).toEqual(result)
    const repeated = await h.nativeStats()
    expect(repeated.native_posts).toBe(1)
    expect(repeated.native_gets).toBe(1)
    expect(repeated.plugin_calls).toEqual(native.plugin_calls)
    expect(repeated.http.filter(call => call.method === 'GET' && call.path === `/v1/jobs/${job.id}/assets/${asset.asset_id}`)).toEqual(assetDownloads)
    const unchanged = await stat(output, { bigint: true })
    expect(unchanged.ino).toBe(saved.ino)
    expect(unchanged.mtimeNs).toBe(saved.mtimeNs)
    const evidence = await h.evidence(job.id, job.threadId)
    expect(evidence.rows).toHaveLength(1)
    expect(evidence.rows[0]!.status).toBe('completed')
    expect(evidence.messages).toEqual([]) // No generated/reinjected chat messages.
    expect(h.storage.value).not.toContain(h.token)
  }, { nativeFiles: true })
}, 30_000)
