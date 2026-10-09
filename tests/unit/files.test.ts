import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Bridge, LIMITS, saveOutputs, snapshot, type Attachment, type JobRequest } from '../../src/core.js'
import { cfg, collector, complete, FakeClock, fetchMock, MemoryStorage } from './helpers.js'

const dirs: string[] = []
async function temp() { const dir = await mkdtemp('/tmp/opencode/hermes-ts-test-'); dirs.push(dir); return dir }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe('attachment boundaries', () => {
  test('file snapshots contain true bytes; roots explicit and boundary-aware; no remote URIs', async () => {
    const dir = await temp()
    const root = join(dir, 'root')
    await mkdir(root)
    const path = join(root, 'bytes.dat')
    const bytes = Buffer.from([0, 255, 128, 13, 10])
    await writeFile(path, bytes)
    const input = [{ path, mime: 'application/octet-stream' }]
    await expect(snapshot(input, cfg())).rejects.toThrow('uploads disabled')
    const configured = { ...cfg(), uploadRoots: [root] }
    const result = await snapshot(input, configured)
    expect(Buffer.from(result[0]!.base64, 'base64')).toEqual(bytes)
    await writeFile(path, 'changed')
    expect(Buffer.from(result[0]!.base64, 'base64')).toEqual(bytes)
    await expect(snapshot([{ path: join(dir, 'root-evil/a'), mime: 'text/plain' }], configured)).rejects.toThrow('outside')
    await expect(snapshot([{ path: 'https://example.org/a', mime: 'text/plain' }], configured)).rejects.toThrow('remote')
    await expect(snapshot([{ path: `${root}/../root/bytes.dat`, mime: 'text/plain' }], configured)).rejects.toThrow('Unsafe')
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
      await expect(snapshot([{ path, mime: 'text/plain' }], configured)).rejects.toThrow('Symbolic')
    }
    await expect(snapshot([{ path: join(dir, 'linked-root/ok'), mime: 'text/plain' }], { ...cfg(), uploadRoots: [join(dir, 'linked-root')] })).rejects.toThrow('Symbolic')
    await expect(snapshot([{ path: root, mime: 'text/plain' }], configured)).rejects.toThrow('regular file')
  })

  test('validates names, canonical base64, MIME and data URL lengths before decoding', async () => {
    for (const name of ['../x', '/x', 'a/b', 'a\\b', '..', '.', 'a\0b', 'C:evil']) {
      await expect(snapshot([{ name, mime: 'text/plain', base64: 'YQ==' }], cfg())).rejects.toThrow('basename')
    }
    for (const base64 of ['a', '!!!!', 'YQ=', 'YQ==\n', 'YR==', '=YQ=']) {
      await expect(snapshot([{ name: 'a', mime: 'text/plain', base64 }], cfg())).rejects.toThrow('base64')
    }
    await expect(snapshot([{ name: 'a', mime: 'text/plain; charset=utf8', base64: '' }], cfg())).rejects.toThrow('MIME')
    await expect(snapshot([{ name: 'a', data: 'data:text/plain;base64,YQ==', mime: 'image/png' }], cfg())).rejects.toThrow('mismatch')
    await expect(snapshot([{ name: 'a', data: `data:text/plain;base64,${'A'.repeat(Math.ceil(LIMITS.file / 3) * 4 + 300)}` }], cfg())).rejects.toThrow('too large')
    expect(await snapshot([{ name: 'a', data: 'data:text/plain;base64,YQ==' }], cfg())).toEqual([{ name: 'a', mime: 'text/plain', base64: 'YQ==' }])
    await expect(snapshot([{ name: 'a', mime: 'text/plain', base64: '' }, { name: 'a', mime: 'text/plain', base64: '' }], cfg())).rejects.toThrow('Duplicate')
    await expect(snapshot(Array.from({ length: 9 }, (_, i) => ({ name: String(i), mime: 'text/plain', base64: '' })), cfg())).rejects.toThrow('8 attachments')
  })

  test('enforces per-file and aggregate decoded limits including disk uploads', async () => {
    const dir = await temp()
    const file = join(dir, 'large')
    await writeFile(file, '')
    await truncate(file, LIMITS.file + 1)
    await expect(snapshot([{ path: file, mime: 'application/octet-stream' }], { ...cfg(), uploadRoots: [dir] })).rejects.toThrow('10 MiB')
    const large = Buffer.alloc(LIMITS.file).toString('base64')
    await expect(snapshot([{ name: 'a', mime: 'application/octet-stream', base64: large }, { name: 'b', mime: 'application/octet-stream', base64: large }, { name: 'c', mime: 'text/plain', base64: 'YQ==' }], cfg())).rejects.toThrow('20 MiB')
  })

  test('PNG/text enter V2 prompt files, PDF/ZIP remain byte-perfect private artifacts with explicit path notice', async () => {
    const dir = await temp()
    const values: Attachment[] = [
      { name: 'pixel.png', mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=' },
      { name: 'note.txt', mime: 'text/plain', base64: Buffer.from('hello').toString('base64') },
      { name: 'doc.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.7\0\xff', 'binary').toString('base64') },
      { name: 'archive.zip', mime: 'application/zip', base64: 'UEsDBAAA' },
    ]
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const sink = collector()
    const bridge = await Bridge.create({ ...cfg(), outputDir: dir }, { storage, clock, prompt: sink.prompt, fetch: fetchMock((url, init) => init.method === 'POST'
      ? Response.json({ id: (JSON.parse(String(init.body)) as JobRequest).id }, { status: 202 })
      : Response.json(complete(url.split('/').at(-1)!, { attachments: values }))) })
    const job = await bridge.ask('original', { text: 'artifacts' })
    await bridge.tick(); clock.advance(2_000); await bridge.tick()
    const prompt = sink.prompts[0]!
    expect(prompt.sessionID).toBe('original')
    expect(prompt.files).toHaveLength(2)
    expect(prompt.files[0]?.uri).toStartWith('data:image/png;base64,')
    expect(prompt.files[1]?.uri).toBe('data:text/plain;base64,aGVsbG8=')
    expect(prompt.text).toContain('binary contents have NOT been read')
    for (const a of values) {
      const path = join(dir, job.id, a.name)
      expect(await readFile(path)).toEqual(Buffer.from(a.base64, 'base64'))
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(prompt.text).toContain(path)
    }
    expect((await stat(join(dir, job.id))).mode & 0o777).toBe(0o700)
    await bridge.dispose()
  })

  test('output destinations reject symlinks and unsafe artifact names', async () => {
    const dir = await temp()
    const link = join(dir, 'link')
    await symlink(dir, link)
    await expect(saveOutputs(link, randomUUID(), [])).rejects.toThrow('Symbolic')
    await expect(saveOutputs(dir, randomUUID(), [{ name: '../escape', mime: 'text/plain', base64: '' }])).rejects.toThrow('basename')
  })
})
