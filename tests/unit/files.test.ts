import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Bridge, LIMITS, saveOutputs, snapshot, snapshotFiles, type Asset, type Attachment, type JobRequest, type OutboxJob } from '../../src/core.js'
import { contentDisposition, hashBytes } from '../../src/protocol.js'
import { cfg, complete, FakeClock, fetchMock, MemoryStorage } from './helpers.js'

const dirs: string[] = []
async function temp() { const dir = await mkdtemp('/tmp/opencode/hermes-ts-test-'); dirs.push(dir); return dir }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe('attachment boundaries', () => {
  test('file snapshots contain true bytes; roots explicit and boundary-aware; no remote URIs', async () => {
    const dir = await temp()
    const root = join(dir, 'root')
    await mkdir(root)
    const path = join(root, 'bytes.png')
    const bytes = Buffer.from([0, 255, 128, 13, 10])
    await writeFile(path, bytes)
    const input = [{ path, mime: 'image/png' }]
    await expect(snapshot(input, cfg())).rejects.toThrow('uploads disabled')
    const configured = { ...cfg(), uploadRoots: [root] }
    const result = await snapshot(input, configured)
    expect(Buffer.from(result[0]!.base64, 'base64')).toEqual(bytes)
    await writeFile(path, 'changed')
    expect(Buffer.from(result[0]!.base64, 'base64')).toEqual(bytes)
    await expect(snapshot([{ path: join(dir, 'root-evil/a'), mime: 'image/png' }], configured)).rejects.toThrow('outside')
    await expect(snapshot([{ path: 'https://example.org/a', mime: 'image/png' }], configured)).rejects.toThrow('remote')
    await expect(snapshot([{ path: `${root}/../root/bytes.png`, mime: 'image/png' }], configured)).rejects.toThrow('Unsafe')
  })

  test('rejects final, ancestor and configured-root symlinks plus nonregular files', async () => {
    const dir = await temp()
    const root = join(dir, 'root')
    await mkdir(root)
    const file = join(root, 'ok')
    await writeFile(file, 'ok')
    await symlink(file, join(root, 'linked'))
    await symlink(root, join(dir, 'linked-root'))
    const configured = { ...cfg(), uploadRoots: [dir] }
    for (const path of [join(root, 'linked'), join(dir, 'linked-root/ok')]) {
      await expect(snapshot([{ path, mime: 'image/png' }], configured)).rejects.toThrow('Symbolic')
    }
    await expect(snapshot([{ path: join(dir, 'linked-root/ok'), mime: 'image/png' }], { ...cfg(), uploadRoots: [join(dir, 'linked-root')] })).rejects.toThrow('Symbolic')
    await expect(snapshot([{ path: root, mime: 'image/png' }], configured)).rejects.toThrow('regular file')
  })

  test('validates names, canonical base64, MIME and data URL lengths before decoding', async () => {
    for (const name of ['../x', '/x', 'a/b', 'a\\b', '..', '.', 'a\0b', 'C:evil']) {
      await expect(snapshot([{ name, mime: 'image/png', base64: 'YQ==' }], cfg())).rejects.toThrow('basename')
    }
    for (const base64 of ['a', '!!!!', 'YQ=', 'YQ==\n', 'YR==', '=YQ=']) {
      await expect(snapshot([{ name: 'a', mime: 'image/png', base64 }], cfg())).rejects.toThrow('base64')
    }
    await expect(snapshot([{ name: 'a', mime: 'text/plain; charset=utf8', base64: '' }], cfg())).rejects.toThrow('MIME')
    await expect(snapshot([{ name: 'a', data: 'data:text/plain;base64,YQ==', mime: 'image/png' }], cfg())).rejects.toThrow('mismatch')
    await expect(snapshot([{ name: 'a', data: `data:text/plain;base64,${'A'.repeat(Math.ceil(LIMITS.file / 3) * 4 + 300)}` }], cfg())).rejects.toThrow('too large')
    expect(await snapshot([{ name: 'a', data: 'data:image/png;base64,YQ==' }], cfg())).toEqual([{ name: 'a', mime: 'image/png', base64: 'YQ==' }])
    await expect(snapshot([{ name: 'a', mime: 'image/png', base64: '' }, { name: 'a', mime: 'image/png', base64: '' }], cfg())).rejects.toThrow('Duplicate')
    await expect(snapshot(Array.from({ length: 9 }, (_, i) => ({ name: String(i), mime: 'image/png', base64: '' })), cfg())).rejects.toThrow('8 attachments')
  })

  test('enforces per-file and aggregate decoded limits including disk uploads', async () => {
    const dir = await temp()
    const file = join(dir, 'large')
    await writeFile(file, '')
    await truncate(file, LIMITS.file + 1)
    await expect(snapshot([{ path: file, mime: 'image/png' }], { ...cfg(), uploadRoots: [dir] })).rejects.toThrow('10 MiB')
    const large = Buffer.alloc(LIMITS.file).toString('base64')
    await expect(snapshot([{ name: 'a', mime: 'image/png', base64: large }, { name: 'b', mime: 'image/png', base64: large }, { name: 'c', mime: 'image/png', base64: 'YQ==' }], cfg())).rejects.toThrow('20 MiB')
  })

  test('only four image MIME types enter new jobs; ordinary files are rejected before reading or queueing', async () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(await snapshot([{ name: 'image', mime, base64: 'YQ==' }], cfg())).toEqual([{ name: 'image', mime, base64: 'YQ==' }])
    }
    const storage = new MemoryStorage()
    const bridge = await Bridge.create(cfg(), { storage })
    for (const mime of ['text/plain', 'application/pdf', 'application/zip', 'application/octet-stream', 'image/svg+xml']) {
      for (const attachment of [
        // This missing/disallowed path would fail differently if readUpload ran first.
        { path: '/does-not-exist/ordinary-file', mime },
        { name: 'ordinary-file', mime, base64: 'YQ==' },
        { name: 'ordinary-file', data: `data:${mime};base64,YQ==` },
      ]) {
        await expect(bridge.ask('s', { text: 'do not send as text', attachments: [attachment] })).rejects.toThrow('ordinary file attachments are not supported')
      }
    }
    expect(storage.value).toBeUndefined()
    expect(await bridge.status('s')).toEqual([])
    await bridge.dispose()
  })

  test('explicit Tool.Result materializes once concurrently; restart reuses bytes and conflicts never overwrite', async () => {
    const dir = await temp()
    const values: Attachment[] = [
      { name: 'pixel.png', mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=' },
      { name: 'note.txt', mime: 'text/plain', base64: Buffer.from('hello').toString('base64') },
      { name: 'doc.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.7\0\xff', 'binary').toString('base64') },
      { name: 'archive.zip', mime: 'application/zip', base64: 'UEsDBAAA' },
    ]
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    let saves = 0
    let posts = 0
    const configuration = { ...cfg(), outputDir: dir }
    const bridge = await Bridge.create(configuration, { storage, clock,
      saveOutputs: (id, attachments) => { saves++; return saveOutputs(dir, id, attachments) },
      fetch: fetchMock((url, init) => {
        if (init.method === 'POST') { posts++; return Response.json({ id: (JSON.parse(String(init.body)) as JobRequest).id }, { status: 202 }) }
        return Response.json(complete(url.split('/').at(-1)!, { attachments: values }))
      }),
    })
    const job = await bridge.ask('original', { text: 'artifacts' })
    await bridge.tick(); clock.advance(2_000); await bridge.tick()
    expect(saves).toBe(0)
    await expect(stat(join(dir, job.id))).rejects.toThrow()
    await expect(bridge.result('other-session', job.id)).rejects.toThrow('current session')
    const [result, duplicate] = await Promise.all([bridge.result('original', job.id), bridge.result('original', job.id)])
    expect(duplicate).toEqual(result)
    expect(saves).toBe(1)
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('binary contents have NOT been read') },
      { type: 'file', name: 'pixel.png', mime: 'image/png', uri: `data:image/png;base64,${values[0]!.base64}` },
      { type: 'file', name: 'note.txt', mime: 'text/plain', uri: 'data:text/plain;base64,aGVsbG8=' },
    ])
    expect(result.metadata?.artifacts).toHaveLength(4)
    const times = []
    for (const a of values) {
      const path = join(dir, job.id, a.name)
      expect(await readFile(path)).toEqual(Buffer.from(a.base64, 'base64'))
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(JSON.stringify(result)).toContain(path)
      times.push((await stat(path)).mtimeMs)
    }
    expect((await stat(join(dir, job.id))).mode & 0o777).toBe(0o700)
    await bridge.dispose()
    const restarted = await Bridge.create(configuration, { storage, clock, fetch: fetchMock(() => { throw new Error('No upstream replay') }) })
    expect(await restarted.result('original', job.id)).toEqual(result)
    expect(await Promise.all(values.map(a => stat(join(dir, job.id, a.name)).then(s => s.mtimeMs)))).toEqual(times)
    const conflict = join(dir, job.id, 'note.txt')
    await writeFile(conflict, 'other bytes')
    await expect(restarted.result('original', job.id)).rejects.toThrow('refusing to overwrite')
    expect(await readFile(conflict, 'utf8')).toBe('other bytes')
    expect((await restarted.status('original', job.id))[0]?.status).toBe('completed')
    await writeFile(conflict, 'hello')
    expect(await restarted.result('original', job.id)).toEqual(result)
    expect(posts).toBe(1)
    await restarted.dispose()
  })

  test('output destinations reject symlinks and unsafe artifact names', async () => {
    const dir = await temp()
    const link = join(dir, 'link')
    await symlink(dir, link)
    await expect(saveOutputs(link, randomUUID(), [])).rejects.toThrow('Symbolic')
    await expect(saveOutputs(dir, randomUUID(), [{ name: '../escape', mime: 'text/plain', base64: '' }])).rejects.toThrow('basename')
    const id = randomUUID()
    await mkdir(join(dir, id))
    await symlink(join(dir, 'unrelated'), join(dir, id, 'result.txt'))
    await expect(saveOutputs(dir, id, [{ name: 'result.txt', mime: 'text/plain', base64: '' }])).rejects.toThrow('Symbolic')
  })

  test('opaque file snapshots preserve ZIP bytes and retain root, symlink, URL and aggregate boundaries', async () => {
    const root = await temp()
    const path = join(root, 'opaque.zip')
    const bytes = Buffer.from([0x50, 0x4b, 0, 0xff, 0x80])
    await writeFile(path, bytes)
    const configuration = { ...cfg(), uploadRoots: [root] }
    const [file] = await snapshotFiles([{ path, mime: 'application/zip' }], configuration)
    expect(file).toMatchObject({ name: 'opaque.zip', mime: 'application/zip', size: bytes.length, sha256: hashBytes(bytes), base64: bytes.toString('base64') })
    await symlink(path, join(root, 'link'))
    for (const unsafe of [join(root, 'link'), 'https://example.org/a.zip', join(root, '../outside.zip')]) {
      await expect(snapshotFiles([{ path: unsafe, mime: 'application/zip' }], configuration)).rejects.toThrow()
    }
    const bridge = await Bridge.create(configuration, { storage: new MemoryStorage() })
    await expect(bridge.ask('s', { text: 'too many', attachments: Array.from({ length: 8 }, (_, i) => ({ name: `${i}.png`, mime: 'image/png', base64: '' })), files: [{ name: 'x.zip', mime: 'application/zip', base64: '' }] })).rejects.toThrow('8 attachments and files combined')
    await bridge.dispose()
  })

  test('binary assets survive lost PUT/POST acknowledgements; explicit result retries only missing downloads', async () => {
    const root = await temp()
    const source = join(root, 'input.zip')
    const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 128])
    await writeFile(source, bytes)
    const configuration = { ...cfg(), uploadRoots: [root], outputDir: join(root, 'outputs') }
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const storedJob = (id: string) => (JSON.parse(storage.value!) as { jobs: Record<string, OutboxJob> }).jobs[id]!
    const secondBytes = Buffer.from('opaque output, not a chat instruction')
    const outputs: Asset[] = [
      { asset_id: randomUUID(), name: 'same-name.zip', mime: 'application/zip', size: bytes.length, sha256: hashBytes(bytes) },
      { asset_id: randomUUID(), name: 'same-name.zip', mime: 'application/zip', size: secondBytes.length, sha256: hashBytes(secondBytes) },
    ]
    let puts = 0
    let posts = 0
    let jobGets = 0
    let downloads = 0
    let corrupt = true
    const putIDs: string[] = []
    const fetch = fetchMock((url, init) => {
      expect(init.redirect).toBe('error')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-secret')
      if (url.endsWith('/v1/capabilities')) return Response.json({ object: 'hermes.bridge.capabilities', version: 1, assets: true, max_asset_bytes: LIMITS.file, max_total_asset_bytes: LIMITS.total, max_assets: LIMITS.count })
      const parts = new URL(url).pathname.split('/')
      if (init.method === 'PUT') {
        puts++
        const job = storedJob(parts[3]!)
        const file = job.files![0]!
        const { base64, ...metadata } = file
        expect(job.postAttempted).toBe(false)
        expect(job.input_assets).toEqual([file.asset_id])
        expect(parts[5]).toBe(file.asset_id)
        putIDs.push(file.asset_id)
        expect(Buffer.from(init.body as Uint8Array)).toEqual(bytes)
        expect(base64).toBe(bytes.toString('base64'))
        const headers = new Headers(init.headers)
        expect(headers.get('content-length')).toBe(String(bytes.length))
        expect(headers.get('content-disposition')).toBe(contentDisposition(file.name))
        expect(headers.get('x-content-sha256')).toBe(file.sha256)
        if (puts === 1) throw new Error('Input accepted but PUT acknowledgement lost')
        return Response.json(metadata, { status: 200 })
      }
      if (init.method === 'POST') {
        posts++
        const body = JSON.parse(String(init.body)) as JobRequest
        const durable = storedJob(body.id)
        expect(durable.postAttempted).toBe(true)
        expect(durable.uploadedAssets).toEqual(body.input_assets!)
        expect(body.input_assets).toEqual([putIDs[0]!])
        expect(body.attachments).toEqual([])
        expect(String(init.body)).not.toContain('base64')
        throw new Error('Job accepted but POST acknowledgement lost')
      }
      if (parts[4] === 'assets') {
        downloads++
        const a = outputs.find(a => a.asset_id === parts[5])!
        const original = a === outputs[0] ? bytes : secondBytes
        const data = a === outputs[1] && corrupt ? Buffer.alloc(original.length) : original
        return new Response(data, { headers: { 'Content-Type': a.mime, 'Content-Length': String(a.size), 'Content-Disposition': contentDisposition(a.name), 'X-Content-SHA256': a.sha256 } })
      }
      jobGets++
      return Response.json(complete(parts[3]!, { output_assets: outputs }))
    }, { capabilities: true })
    let bridge = await Bridge.create(configuration, { storage, clock, fetch })
    const job = await bridge.ask('s', { text: 'opaque files', files: [{ path: source, mime: 'application/zip' }] })
    await writeFile(source, 'changed after acceptance')
    await bridge.tick()
    expect(posts).toBe(0)
    expect(storedJob(job.id).postAttempted).toBe(false)
    await bridge.dispose()
    bridge = await Bridge.create(configuration, { storage, clock, fetch })
    clock.advance(4_000); await bridge.tick()
    expect(putIDs).toEqual([putIDs[0]!, putIDs[0]!])
    expect(posts).toBe(1)
    await bridge.dispose()
    bridge = await Bridge.create(configuration, { storage, clock, fetch })
    clock.advance(8_000); await bridge.tick()
    expect(storedJob(job.id).status).toBe('completed')
    expect(storedJob(job.id).result?.output_assets).toEqual(outputs)
    await expect(bridge.result('other-session', job.id)).rejects.toThrow('current session')
    expect(downloads).toBe(0)
    await expect(bridge.result('s', job.id)).rejects.toThrow('size/SHA-256 mismatch')
    expect(storedJob(job.id).status).toBe('completed')
    corrupt = false
    const result = await bridge.result('s', job.id)
    expect(downloads).toBe(3) // First verified file was reused after second-file failure.
    expect(result.metadata?.artifacts).toEqual(outputs.map(a => ({ ...a, path: join(configuration.outputDir, job.id, a.asset_id, a.name) })))
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('binary contents have NOT been read') }])
    for (let i = 0; i < outputs.length; i++) {
      const a = outputs[i]!
      const path = join(configuration.outputDir, job.id, a.asset_id, a.name)
      expect(hashBytes(await readFile(path))).toBe(a.sha256)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(configuration.outputDir, job.id, a.asset_id))).mode & 0o777).toBe(0o700)
    }
    expect(await bridge.result('s', job.id)).toEqual(result)
    expect(downloads).toBe(3)
    expect(posts).toBe(1)
    expect(jobGets).toBe(1)
    await bridge.dispose()
    const blocked = await Bridge.create({ ...configuration, token: 'changed-test-token' }, { storage, clock, fetch: fetchMock(() => { throw new Error('Cross-scope HTTP forbidden') }, { capabilities: true }) })
    expect(await blocked.result('s', job.id)).toEqual(result) // Verified local files remain readable.
    await rm(join(configuration.outputDir, job.id, outputs[1]!.asset_id, outputs[1]!.name))
    await expect(blocked.result('s', job.id)).rejects.toThrow('endpoint or credential')
    await blocked.dispose()
  })
})
