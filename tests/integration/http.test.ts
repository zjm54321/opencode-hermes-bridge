import { expect, test } from 'bun:test'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Bridge, type JobRequest } from '../../src/core.js'
import { hashBytes } from '../../src/protocol.js'
import { withFixture } from './harness.js'

test('HTTP admission and restart: auth, one UUID, lost ACK, PNG/PDF originals and cached Tool.Result', async () => {
  await withFixture(async h => {
    const [png, , pdf] = await h.files()
    if (!png || !pdf) throw new Error('Missing generated fixtures')
    const initial = await h.bridge()
    const configuration = initial.config
    await initial.dispose()
    const methods: string[] = []
    const fetcher: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/v1/jobs' || /^\/v1\/jobs\/[^/]+$/.test(path)) methods.push(init!.method!)
      const reply = await fetch(input, init)
      if (init?.method === 'POST') {
        expect(reply.status).toBe(202)
        await reply.arrayBuffer()
        throw new Error('Real server accepted the job; client lost the acknowledgement')
      }
      return reply
    }, { preconnect: () => {} })
    let bridge = await Bridge.create(configuration, { storage: h.storage, fetch: fetcher })
    try {
      const session = 'http-owner'
      const job = await bridge.ask(session, {
        text: 'Echo these original bytes; not a model-understanding test.',
        attachments: [{ path: join(h.uploads, png.name), mime: png.mime }],
        files: [{ path: join(h.uploads, pdf.name), mime: pdf.mime }],
      })
      const { id, threadId, text, attachments } = h.storage.job(job.id)
      expect(h.storage.job(id)).toMatchObject({ submitted: false, postAttempted: false })
      expect(methods).toEqual([])
      const rejected = await h.http('/v1/jobs', { id, threadId, text, attachments }, 'wrong-fixture-token')
      expect(rejected.status).toBe(401)
      expect(await rejected.text()).not.toContain(h.token)
      expect((await h.evidence(id, threadId)).rows).toEqual([])
      await writeFile(join(h.uploads, png.name), 'changed after snapshot')
      await writeFile(join(h.uploads, pdf.name), 'changed after snapshot')
      await bridge.tick()
      const remote = await h.terminal(id)
      expect(remote.status).toBe('completed')
      expect(h.storage.job(id)).toMatchObject({ submitted: false, postAttempted: true })
      const evidence = await h.evidence(id, threadId)
      expect(evidence.rows).toHaveLength(1)
      const request = JSON.parse(evidence.rows[0]!.input) as JobRequest
      expect(request.attachments).toEqual([{ name: png.name, mime: png.mime, base64: png.base64 }])
      expect((await h.http('/v1/jobs', request)).status).toBe(202)
      expect((await h.http('/v1/jobs', { ...request, text: 'conflicting body' })).status).toBe(409)
      expect((await h.evidence(id, threadId)).rows).toEqual(evidence.rows)
      expect(evidence.messages).toEqual([])
      await bridge.dispose()

      bridge = await Bridge.create(configuration, { storage: h.storage, fetch: fetcher })
      const result = await h.result(bridge, session, id)
      expect(methods).toEqual(['POST', 'GET'])
      expect(result.metadata).toMatchObject({ id, status: 'completed', final: true })
      expect(result.content).toContainEqual({ type: 'file', name: png.name, mime: png.mime, uri: `data:${png.mime};base64,${png.base64}` })
      expect(JSON.stringify(result.content)).toContain(text)
      const pdfAsset = remote.output_assets![0]!
      const pdfPath = join(h.outputs, id, pdfAsset.asset_id, pdfAsset.name)
      expect(pdfAsset).toMatchObject({ name: pdf.name, mime: pdf.mime, sha256: pdf.sha256 })
      expect(hashBytes(await readFile(pdfPath))).toBe(pdf.sha256)
      expect(hashBytes(await readFile(join(h.outputs, id, png.name)))).toBe(png.sha256)
      expect((await stat(pdfPath)).mode & 0o777).toBe(0o600)
      await expect(bridge.result('other-session', id)).rejects.toThrow('current session')
      const saved = await stat(pdfPath, { bigint: true })
      await bridge.dispose()
      bridge = await Bridge.create(configuration, { storage: h.storage, fetch: fetcher })
      expect(await bridge.result(session, id)).toEqual(result)
      expect((await stat(pdfPath, { bigint: true })).mtimeNs).toBe(saved.mtimeNs)
      expect(methods).toEqual(['POST', 'GET'])
      expect(h.storage.value).not.toContain(h.token)
    } finally { await bridge.dispose() }
  }, { files: true })
}, 30_000)
