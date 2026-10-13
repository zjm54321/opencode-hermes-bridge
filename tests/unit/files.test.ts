import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Bridge, LIMITS, snapshot, snapshotFiles, type Asset, type JobRequest, type OutboxJob } from '../../src/core.js'
import { contentDisposition, hashBytes } from '../../src/protocol.js'
import { cfg, complete, FakeClock, fetchMock, MemoryStorage } from './helpers.js'

const dirs: string[] = []
async function temp() { const dir = await mkdtemp('/tmp/opencode/hermes-ts-test-'); dirs.push(dir); return dir }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

test('local snapshots preserve bytes and enforce upload roots, symlinks, limits and image/file separation', async () => {
  const dir = await temp()
  const root = join(dir, 'root')
  await mkdir(root)
  const path = join(root, 'original.zip')
  const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 128])
  await writeFile(path, bytes)
  const input = [{ path, mime: 'application/zip' }]
  await expect(snapshotFiles(input, cfg())).rejects.toThrow('uploads disabled')
  const configuration = { ...cfg(), uploadRoots: [root] }
  const [file] = await snapshotFiles(input, configuration)
  await writeFile(path, 'changed after acceptance')
  expect(file).toMatchObject({ size: bytes.length, sha256: hashBytes(bytes), base64: bytes.toString('base64') })
  await expect(snapshotFiles([{ path: join(dir, 'root-evil/a.zip'), mime: 'application/zip' }], configuration)).rejects.toThrow('outside')
  await symlink(root, join(root, 'alias'))
  await expect(snapshotFiles([{ path: join(root, 'alias/original.zip'), mime: 'application/zip' }], configuration)).rejects.toThrow('Symbolic')
  await expect(snapshotFiles([{ path: 'https://example.org/a.zip', mime: 'application/zip' }], configuration)).rejects.toThrow('remote')
  await truncate(path, LIMITS.file + 1)
  await expect(snapshotFiles(input, configuration)).rejects.toThrow('10 MiB')
  // Both APIs use snapshotInputs/readUpload; do not repeat the path matrix for images.
  await expect(snapshot(input, configuration)).rejects.toThrow('ordinary file attachments are not supported')
  await expect(snapshot([{ name: 'pixel.png', mime: 'image/png', base64: 'YR==' }], configuration)).rejects.toThrow('base64')
  expect(await snapshot([{ name: 'pixel.png', data: 'data:image/png;base64,AP+A' }], configuration)).toEqual([
    { name: 'pixel.png', mime: 'image/png', base64: 'AP+A' },
  ])
})

test('raw assets retry the same upload; corrupt downloads never publish and verified private outputs never overwrite', async () => {
  const root = await temp()
  const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 128])
  const configuration = { ...cfg(), outputDir: join(root, 'outputs') }
  const storage = new MemoryStorage()
  const clock = new FakeClock()
  const stored = (id: string) => (JSON.parse(storage.value!) as { jobs: Record<string, OutboxJob> }).jobs[id]!
  const output: Asset = { asset_id: randomUUID(), name: 'original.zip', mime: 'application/zip', size: bytes.length, sha256: hashBytes(bytes) }
  const putIDs: string[] = []
  let posts = 0
  let downloads = 0
  let corrupt = true
  const fetch = fetchMock((url, init) => {
    if (url.endsWith('/v1/capabilities')) return Response.json({ object: 'hermes.bridge.capabilities', version: 1, assets: true, max_asset_bytes: LIMITS.file, max_total_asset_bytes: LIMITS.total, max_assets: LIMITS.count })
    const parts = new URL(url).pathname.split('/')
    if (init.method === 'PUT') {
      const job = stored(parts[3]!)
      const { base64, ...metadata } = job.files![0]!
      expect(job.postAttempted).toBe(false)
      expect(parts[5]).toBe(metadata.asset_id)
      expect(Buffer.from(init.body as Uint8Array)).toEqual(bytes)
      expect(base64).toBe(bytes.toString('base64'))
      putIDs.push(metadata.asset_id)
      if (putIDs.length === 1) throw new Error('Input accepted but PUT acknowledgement lost')
      return Response.json(metadata)
    }
    if (init.method === 'POST') {
      posts++
      const body = JSON.parse(String(init.body)) as JobRequest
      expect(stored(body.id).uploadedAssets).toEqual(body.input_assets!)
      expect(body.input_assets).toEqual([putIDs[0]!])
      expect(String(init.body)).not.toContain('base64')
      return Response.json({ id: body.id }, { status: 202 })
    }
    if (parts[4] === 'assets') {
      downloads++
      return new Response(corrupt ? Buffer.alloc(bytes.length) : bytes, { headers: {
        'Content-Type': output.mime, 'Content-Length': String(output.size),
        'Content-Disposition': contentDisposition(output.name), 'X-Content-SHA256': output.sha256,
      } })
    }
    return Response.json(complete(parts[3]!, { output_assets: [output] }))
  }, { capabilities: true })
  let bridge = await Bridge.create(configuration, { storage, clock, fetch })
  try {
    const job = await bridge.ask('owner', { text: 'return original bytes', files: [{ name: 'input.zip', mime: 'application/zip', base64: bytes.toString('base64') }] })
    await bridge.tick()
    expect(posts).toBe(0)
    await bridge.dispose()
    bridge = await Bridge.create(configuration, { storage, clock, fetch })
    clock.advance(4_000); await bridge.tick()
    expect(putIDs).toEqual([putIDs[0]!, putIDs[0]!])
    clock.advance(2_000); await bridge.tick()
    expect(downloads).toBe(0) // Polling does not materialize files.
    const path = join(configuration.outputDir, job.id, output.asset_id, output.name)
    await expect(bridge.result('owner', job.id)).rejects.toThrow('size/SHA-256 mismatch')
    await expect(stat(path)).rejects.toThrow()
    expect(stored(job.id).status).toBe('completed')
    corrupt = false
    const result = await bridge.result('owner', job.id)
    expect(result.metadata?.artifacts).toEqual([{ ...output, path }])
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('binary contents have NOT been read') }])
    expect(await readFile(path)).toEqual(bytes)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(configuration.outputDir, job.id, output.asset_id))).mode & 0o777).toBe(0o700)
    await writeFile(path, Buffer.alloc(bytes.length))
    await expect(bridge.result('owner', job.id)).rejects.toThrow('refusing to overwrite')
    expect(await readFile(path)).toEqual(Buffer.alloc(bytes.length))
    await rm(path)
    const unrelated = join(root, 'unrelated')
    await writeFile(unrelated, bytes)
    await symlink(unrelated, path)
    await expect(bridge.result('owner', job.id)).rejects.toThrow('Symbolic')
    await rm(path)
    await writeFile(path, bytes, { mode: 0o600 })
    await bridge.dispose()
    bridge = await Bridge.create({ ...configuration, token: 'changed-test-token' }, { storage, clock, fetch })
    expect(await bridge.result('owner', job.id)).toEqual(result) // Local verified bytes remain readable across scope changes.
    await rm(path)
    await expect(bridge.result('owner', job.id)).rejects.toThrow('endpoint or credential')
    expect(downloads).toBe(2)
    expect(posts).toBe(1)
  } finally { await bridge.dispose() }
})
