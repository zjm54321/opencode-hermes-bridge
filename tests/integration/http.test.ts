import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobRequest } from '../../src/core.js'
import type { Result as ToolResult } from '@opencode/plugin/promise/tool'
import { MemoryStorage, withFixture } from './harness.js'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const filesOf = (result: ToolResult) => (typeof result.content === 'string' ? [] : result.content ?? []).filter(item => item.type === 'file')

test('fixture inline echo over HTTP (no model): snapshots, idempotency, private files and session isolation', async () => {
  await withFixture(async h => {
    const [png, txt, pdf, zip] = await h.files()
    if (!png || !txt || !pdf || !zip) throw new Error('Missing generated fixtures')
    const pathImage = { ...png, name: 'path-image.png' }
    const base64Image = { ...png, name: 'base64-image.png' }
    const files = [png, pathImage, base64Image]
    const original = await h.bridge()
    for (const file of [txt, pdf, zip]) {
      await expect(original.ask('integration-session-a', { text: 'Unsupported ordinary file', attachments: [file] })).rejects.toThrow('ordinary file attachments are not supported')
    }
    const job = await original.ask('integration-session-a', {
      text: 'Echo these exact fixture bytes; this is not a model-understanding test.',
      attachments: [
        { name: png.name, data: `data:${png.mime};base64,${png.base64}` },
        { name: pathImage.name, mime: pathImage.mime, path: join(h.uploads, png.name) },
        { name: base64Image.name, mime: base64Image.mime, base64: base64Image.base64 },
      ],
    })
    // No consumer has run: inspect the actual server DB, not a mocked fetch counter.
    expect(job.status).toBe('accepted')
    expect(h.storage.job(job.id).submitted).toBe(false)
    expect((await h.evidence(job.id, job.threadId)).rows).toHaveLength(0)
    expect((await original.result('integration-session-a', job.id)).metadata?.final).toBe(false)
    expect(h.storage.value).not.toContain(h.token)
    for (const file of files) {
      expect(h.storage.job(job.id).attachments.find(a => a.name === file.name)?.base64).toBe(file.base64)
    }
    // Mutating the allowed source after local acceptance must not change durable bytes.
    await writeFile(join(h.uploads, png.name), 'Changed AFTER the accepted snapshot.')
    await original.dispose()
    const { id, threadId, text, attachments } = h.storage.job(job.id)
    const request: JobRequest = { id, threadId, text, attachments }

    // Simulate a companion accepting a submission whose ACK the old client did not persist.
    // The client must have persisted its irreversible attempt marker before that HTTP send.
    const pending = JSON.parse(h.storage.value!) as { jobs: Record<string, { postAttempted: boolean }> }
    pending.jobs[id]!.postAttempted = true
    await h.storage.save(JSON.stringify(pending))
    const firstPost = await h.http('/v1/jobs', request)
    expect(firstPost.status).toBe(202)
    expect(await firstPost.json()).toEqual({ id })
    const remote = await h.terminal(id)
    expect(remote.status).toBe('completed')
    // EchoRunner returns inline attachments for this fixture only. This does not prove
    // the native Hermes API Gateway returns attachments or creates server-side files.
    expect(remote.attachments).toHaveLength(3)
    const initialEvidence = await h.evidence(id, threadId)
    expect(initialEvidence.rows).toHaveLength(1)
    const persistedInput = JSON.parse(initialEvidence.rows[0]!.input) as JobRequest
    expect(persistedInput).toEqual(request)
    for (const file of files) {
      const inputAttachment = persistedInput.attachments.find(a => a.name === file.name)!
      const outputAttachment = remote.attachments.find(a => a.name === file.name)!
      expect(sha256(Buffer.from(inputAttachment.base64, 'base64'))).toBe(file.sha256)
      expect(sha256(Buffer.from(outputAttachment.base64, 'base64'))).toBe(file.sha256)
      expect(outputAttachment.base64).toBe(file.base64)
    }
    const duplicate = await h.http('/v1/jobs', request)
    expect(duplicate.status).toBe(202)
    expect(await duplicate.json()).toEqual({ id })
    const conflict = await h.http('/v1/jobs', { ...request, text: 'Different content under the same ID' })
    expect(conflict.status).toBe(409)
    expect(await conflict.text()).not.toContain(h.token)
    // Neither an identical replay nor a conflicting body may overwrite the stored job/result.
    expect((await h.evidence(id, threadId)).rows).toEqual(initialEvidence.rows)
    expect(await h.terminal(id)).toEqual(remote)

    // New Bridge instance: local ACK is missing, but the durable attempt marker permits only GET.
    expect(h.storage.job(id).submitted).toBe(false)
    const restarted = await h.bridge()
    const other = await restarted.ask('integration-session-b', { text: 'Independent second session' })
    expect(other.threadId).not.toBe(threadId)
    expect((await restarted.status('integration-session-a', id))[0]?.threadId).toBe(threadId)
    const a = await h.result(restarted, 'integration-session-a', id)
    const b = await h.result(restarted, 'integration-session-b', other.id)
    expect(a.metadata?.final).toBe(true)
    expect(h.storage.job(id).attachments).toEqual(request.attachments)
    const evidence = await h.evidence(id, threadId)
    expect(evidence.rows).toHaveLength(1)
    expect(evidence.rows[0]?.status).toBe('completed')
    // The bridge must not generate or reinject its former independent conversation history.
    expect(evidence.messages).toEqual([])
    expect((JSON.parse(evidence.rows[0]!.input) as JobRequest).attachments).toEqual(attachments)
    const originalTimes = new Map<string, bigint>()
    for (const file of files) {
      const clientOutput = join(h.outputs, id, file.name)
      expect(sha256(await readFile(clientOutput))).toBe(file.sha256)
      expect((await stat(clientOutput)).mode & 0o777).toBe(0o600)
      originalTimes.set(file.name, (await stat(clientOutput, { bigint: true })).mtimeNs)
    }
    expect((await stat(join(h.outputs, id))).mode & 0o777).toBe(0o700)
    expect(JSON.stringify(a.content)).toContain(id)
    expect(JSON.stringify(a.content)).not.toContain(other.id)
    expect(JSON.stringify(b.content)).toContain(other.id)
    expect(JSON.stringify(b.content)).not.toContain(id)
    expect(filesOf(a).map(f => f.name).sort()).toEqual(files.map(f => f.name).sort())
    for (const file of files) {
      expect(filesOf(a).find(f => f.name === file.name)?.uri).toBe(`data:${file.mime};base64,${file.base64}`)
      expect(JSON.stringify(a)).toContain(join(h.outputs, id, file.name))
    }
    expect(JSON.stringify(a.content)).toContain('binary contents have NOT been read')
    await expect(restarted.status('integration-session-b', id)).rejects.toThrow('current session')
    await expect(restarted.resume('integration-session-b', id)).rejects.toThrow('current session')
    await expect(restarted.result('integration-session-b', id)).rejects.toThrow('current session')
    await restarted.tick()
    await restarted.dispose()
    const resultRestart = await h.bridge()
    await resultRestart.tick()
    expect(await resultRestart.result('integration-session-a', id)).toEqual(a)
    for (const file of files) {
      const clientOutput = join(h.outputs, id, file.name)
      expect((await stat(clientOutput, { bigint: true })).mtimeNs).toBe(originalTimes.get(file.name)!)
      expect(sha256(await readFile(clientOutput))).toBe(file.sha256)
    }
  })
}, 30_000)

test('real HTTP authentication: 401 is a sanitized tool result and never creates a server job', async () => {
  await withFixture(async h => {
    const wrongToken = `wrong-${h.token}`
    const storage = new MemoryStorage()
    const bridge = await h.bridge(storage, wrongToken)
    const job = await bridge.ask('integration-auth-session', { text: 'Must never reach the executor' })
    const result = await h.result(bridge, 'integration-auth-session', job.id)
    expect((await bridge.status('integration-auth-session', job.id))[0]).toMatchObject({ status: 'failed', submitted: false })
    expect((await h.evidence(job.id, job.threadId)).rows).toHaveLength(0)
    for (const token of [null, wrongToken]) {
      const denied = await h.http(`/v1/jobs/${job.id}`, undefined, token)
      expect(denied.status).toBe(401)
      const body = await denied.text()
      expect(body).not.toContain(h.token)
      expect(body).not.toContain(wrongToken)
    }
    expect(JSON.stringify(result.content)).toContain('HTTP 401')
    expect(JSON.stringify(result)).not.toContain(wrongToken)
    expect(storage.value).not.toContain(h.token)
    await Bun.sleep(30)
    await bridge.tick()
    expect(await bridge.result('integration-auth-session', job.id)).toEqual(result)
    expect((await h.evidence(job.id, job.threadId)).rows).toHaveLength(0)
  })
}, 20_000)

test('real HTTP worker: execution failure is sanitized tool output; a later same-thread job succeeds', async () => {
  await withFixture(async h => {
    const bridge = await h.bridge()
    const failed = await bridge.ask('integration-failure-session', { text: '__fixture_fail__' })
    const failedResult = await h.result(bridge, 'integration-failure-session', failed.id)
    expect(h.storage.job(failed.id).status).toBe('failed')
    const response = await h.terminal(failed.id)
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('execution_failed')
    expect(JSON.stringify(response)).not.toContain('test-provider-secret-must-not-escape')
    expect(JSON.stringify(response)).not.toContain(h.token)
    expect(JSON.stringify(failedResult)).toContain(failed.id)
    expect(JSON.stringify(failedResult)).not.toContain('test-provider-secret-must-not-escape')
    expect(filesOf(failedResult)).toEqual([])
    const succeeding = await bridge.ask('integration-failure-session', { text: 'Worker survives earlier executor failure' })
    expect(succeeding.threadId).toBe(failed.threadId)
    const succeeded = await h.result(bridge, 'integration-failure-session', succeeding.id)
    expect(h.storage.job(succeeding.id).status).toBe('completed')
    expect(JSON.stringify(succeeded.content)).toContain('Worker survives earlier executor failure')
    expect(JSON.stringify(succeeded.content)).toContain(succeeding.id)
    const evidence = await h.evidence(succeeding.id, succeeding.threadId)
    expect(evidence.rows).toHaveLength(1)
    expect(evidence.rows[0]?.status).toBe('completed')
    expect(evidence.messages).toEqual([]) // No legacy bridge-managed conversation history.
    await bridge.tick()
    expect(await bridge.result('integration-failure-session', succeeding.id)).toEqual(succeeded)
    expect(h.storage.value).not.toContain(h.token)
  })
}, 20_000)

test('raw HTTP asset roundtrip: opaque PDF/ZIP bytes, same-name outputs, durable manifest and explicit tool result', async () => {
  await withFixture(async h => {
    const [, , pdf, zip] = await h.files()
    if (!pdf || !zip) throw new Error('Missing binary fixtures')
    const bridge = await h.bridge()
    const job = await bridge.ask('binary-session', {
      text: 'Fixture-only raw binary echo, not a model-understanding test.', requireFiles: true,
      files: [
        { name: 'same-name.bin', path: join(h.uploads, pdf.name), mime: pdf.mime },
        { name: 'same-name.bin', mime: zip.mime, base64: zip.base64 },
      ],
    })
    expect(h.storage.job(job.id).files).toHaveLength(2)
    expect((await h.evidence(job.id, job.threadId)).rows).toEqual([])
    await writeFile(join(h.uploads, pdf.name), 'mutated after snapshot')
    const result = await h.result(bridge, 'binary-session', job.id)
    const durable = h.storage.job(job.id)
    expect(durable.postAttempted).toBe(true)
    expect(durable.uploadedAssets).toEqual(durable.input_assets!)
    expect(durable.input_assets).toHaveLength(2)
    const remote = await h.terminal(job.id)
    expect(remote.output_assets).toHaveLength(2)
    expect(durable.result).toEqual(remote)
    expect(filesOf(result)).toEqual([]) // No assertion that the model read PDF/ZIP bytes.
    const paths: string[] = []
    for (const a of remote.output_assets!) {
      const source = a.mime === pdf.mime ? pdf : zip
      expect(a.name).toBe('same-name.bin')
      expect(a.sha256).toBe(source.sha256)
      const path = join(h.outputs, job.id, a.asset_id, a.name)
      paths.push(path)
      expect(sha256(await readFile(path))).toBe(source.sha256)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(h.outputs, job.id, a.asset_id))).mode & 0o777).toBe(0o700)
      expect(result.metadata?.artifacts).toContainEqual({ ...a, path })
    }
    expect(new Set(paths).size).toBe(2)
    const evidence = await h.evidence(job.id, job.threadId)
    expect(evidence.rows).toHaveLength(1)
    const input = JSON.parse(evidence.rows[0]!.input) as JobRequest
    expect(input.input_assets).toEqual(durable.input_assets!)
    expect(input.attachments).toEqual([])
    expect(evidence.messages).toEqual([])
    await expect(bridge.result('another-session', job.id)).rejects.toThrow('current session')
    const times = await Promise.all(paths.map(path => stat(path, { bigint: true }).then(info => info.mtimeNs)))
    await bridge.dispose()
    const restarted = await h.bridge()
    expect(await restarted.result('binary-session', job.id)).toEqual(result)
    expect(await Promise.all(paths.map(path => stat(path, { bigint: true }).then(info => info.mtimeNs)))).toEqual(times)
    expect((await h.evidence(job.id, job.threadId)).rows).toEqual(evidence.rows)
    expect(h.storage.value).not.toContain(h.token)
  }, { files: true })
}, 30_000)
