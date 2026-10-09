import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobRequest } from '../../src/core.js'
import { MemoryStorage, withFixture } from './harness.js'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test('real HTTP: durable byte snapshots, restart/repeated-ID idempotency, private artifact hashes and session isolation', async () => {
  await withFixture(async h => {
    const files = await h.files()
    const [png, txt, pdf, zip] = files
    if (!png || !txt || !pdf || !zip) throw new Error('Missing generated fixtures')
    const original = await h.bridge()
    const job = await original.ask('integration-session-a', {
      text: 'Echo these exact fixture bytes; this is not a model-understanding test.',
      attachments: [
        { name: png.name, data: `data:${png.mime};base64,${png.base64}` },
        { name: txt.name, mime: txt.mime, path: join(h.uploads, txt.name) },
        { name: pdf.name, mime: pdf.mime, base64: pdf.base64 },
        { name: zip.name, data: `data:${zip.mime};base64,${zip.base64}` },
      ],
    })
    // No consumer has run: inspect the actual server DB, not a mocked fetch counter.
    expect(job.status).toBe('accepted')
    expect(h.storage.job(job.id).submitted).toBe(false)
    expect((await h.evidence(job.id, job.threadId)).rows).toHaveLength(0)
    expect(h.prompts).toHaveLength(0)
    expect(h.storage.value).not.toContain(h.token)
    for (const file of files) {
      expect(h.storage.job(job.id).attachments.find(a => a.name === file.name)?.base64).toBe(file.base64)
    }
    // Mutating the allowed source after local acceptance must not change durable bytes.
    await writeFile(join(h.uploads, txt.name), 'Changed AFTER the accepted snapshot.')
    await original.dispose()
    const { id, threadId, text, attachments } = h.storage.job(job.id)
    const request: JobRequest = { id, threadId, text, attachments }

    // Simulate a companion accepting a submission whose ACK the old client did not persist.
    const firstPost = await h.http('/v1/jobs', request)
    expect(firstPost.status).toBe(202)
    expect(await firstPost.json()).toEqual({ id })
    const remote = await h.terminal(id)
    expect(remote.status).toBe('completed')
    expect(remote.attachments).toHaveLength(4)
    const originalTimes = new Map<string, bigint>()
    for (const file of files) {
      const uploaded = join(h.workspace, 'jobs', id, 'uploads', file.name)
      const output = join(h.workspace, 'jobs', id, 'output', file.name)
      expect(sha256(await readFile(uploaded))).toBe(file.sha256)
      expect(sha256(await readFile(output))).toBe(file.sha256)
      expect(remote.attachments.find(a => a.name === file.name)?.base64).toBe(file.base64)
      originalTimes.set(file.name, (await stat(output, { bigint: true })).mtimeNs)
    }
    const duplicate = await h.http('/v1/jobs', request)
    expect(duplicate.status).toBe(202)
    expect(await duplicate.json()).toEqual({ id })
    const conflict = await h.http('/v1/jobs', { ...request, text: 'Different content under the same ID' })
    expect(conflict.status).toBe(409)
    expect(await conflict.text()).not.toContain(h.token)

    // New Bridge instance, same durable local outbox still says "accepted".
    expect(h.storage.job(id).submitted).toBe(false)
    const restarted = await h.bridge()
    const other = await restarted.ask('integration-session-b', { text: 'Independent second session' })
    expect(other.threadId).not.toBe(threadId)
    expect((await restarted.status('integration-session-a', id))[0]?.threadId).toBe(threadId)
    await h.delivered(restarted, 'integration-session-a', id)
    await h.delivered(restarted, 'integration-session-b', other.id)
    expect(h.storage.job(id).delivered).toBe(true)
    expect(h.storage.job(id).attachments).toEqual(request.attachments)
    const evidence = await h.evidence(id, threadId)
    expect(evidence.rows).toHaveLength(1)
    expect(evidence.rows[0]?.status).toBe('completed')
    expect(evidence.messages).toHaveLength(2) // One user/assistant pair, not replayed twice.
    expect(evidence.messages[0]?.content).toBe(text)
    expect((JSON.parse(evidence.rows[0]!.input) as JobRequest).attachments).toEqual(attachments)
    for (const file of files) {
      const serverOutput = join(h.workspace, 'jobs', id, 'output', file.name)
      const clientOutput = join(h.outputs, id, file.name)
      expect((await stat(serverOutput, { bigint: true })).mtimeNs).toBe(originalTimes.get(file.name)!)
      expect(sha256(await readFile(clientOutput))).toBe(file.sha256)
      expect((await stat(clientOutput)).mode & 0o777).toBe(0o600)
    }
    expect((await stat(join(h.outputs, id))).mode & 0o777).toBe(0o700)
    const a = h.prompts.filter(p => p.sessionID === 'integration-session-a')
    const b = h.prompts.filter(p => p.sessionID === 'integration-session-b')
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0]?.delivery).toBe('queue')
    expect(a[0]?.text).toContain(id)
    expect(a[0]?.text).not.toContain(other.id)
    expect(b[0]?.text).toContain(other.id)
    expect(b[0]?.text).not.toContain(id)
    expect(a[0]?.files.map(f => f.name).sort()).toEqual([png.name, txt.name].sort())
    expect(a[0]?.files.find(f => f.name === png.name)?.uri).toBe(`data:${png.mime};base64,${png.base64}`)
    expect(a[0]?.files.find(f => f.name === txt.name)?.uri).toBe(`data:${txt.mime};base64,${txt.base64}`)
    for (const file of [pdf, zip]) {
      expect(a[0]?.files.some(f => f.name === file.name)).toBe(false)
      expect(a[0]?.text).toContain(join(h.outputs, id, file.name))
    }
    expect(a[0]?.text).toContain('binary contents have NOT been read')
    await expect(restarted.status('integration-session-b', id)).rejects.toThrow('current session')
    await expect(restarted.resume('integration-session-b', id)).rejects.toThrow('current session')
    await restarted.tick()
    expect(h.prompts).toHaveLength(2)
  })
}, 30_000)

test('real HTTP authentication: 401 is sanitized, creates no server job, stops automatic retry and notifies once', async () => {
  await withFixture(async h => {
    const wrongToken = `wrong-${h.token}`
    const storage = new MemoryStorage()
    const bridge = await h.bridge(storage, wrongToken)
    const job = await bridge.ask('integration-auth-session', { text: 'Must never reach the executor' })
    await h.delivered(bridge, 'integration-auth-session', job.id)
    expect((await bridge.status('integration-auth-session', job.id))[0]).toMatchObject({ status: 'failed', delivered: true, submitted: false })
    expect((await h.evidence(job.id, job.threadId)).rows).toHaveLength(0)
    for (const token of [null, wrongToken]) {
      const denied = await h.http(`/v1/jobs/${job.id}`, undefined, token)
      expect(denied.status).toBe(401)
      const body = await denied.text()
      expect(body).not.toContain(h.token)
      expect(body).not.toContain(wrongToken)
    }
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.sessionID).toBe('integration-auth-session')
    expect(h.prompts[0]?.text).toContain('HTTP 401')
    expect(h.prompts[0]?.text).not.toContain(wrongToken)
    expect(storage.value).not.toContain(h.token)
    await Bun.sleep(30)
    await bridge.tick()
    expect(h.prompts).toHaveLength(1)
    expect((await h.evidence(job.id, job.threadId)).rows).toHaveLength(0)
  })
}, 20_000)

test('real HTTP worker: execution failure is sanitized and delivered; a later same-thread job still succeeds', async () => {
  await withFixture(async h => {
    const bridge = await h.bridge()
    const failed = await bridge.ask('integration-failure-session', { text: '__fixture_fail__' })
    await h.delivered(bridge, 'integration-failure-session', failed.id)
    expect(h.storage.job(failed.id).status).toBe('failed')
    const response = await h.terminal(failed.id)
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('execution_failed')
    expect(JSON.stringify(response)).not.toContain('test-provider-secret-must-not-escape')
    expect(JSON.stringify(response)).not.toContain(h.token)
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.text).toContain(failed.id)
    expect(h.prompts[0]?.text).not.toContain('test-provider-secret-must-not-escape')
    expect(h.prompts[0]?.files).toEqual([])
    const succeeding = await bridge.ask('integration-failure-session', { text: 'Worker survives earlier executor failure' })
    expect(succeeding.threadId).toBe(failed.threadId)
    await h.delivered(bridge, 'integration-failure-session', succeeding.id)
    expect(h.storage.job(succeeding.id).status).toBe('completed')
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1]?.text).toContain('Worker survives earlier executor failure')
    expect(h.prompts[1]?.text).toContain(succeeding.id)
    expect(h.prompts.every(p => p.sessionID === 'integration-failure-session' && p.delivery === 'queue')).toBe(true)
    const evidence = await h.evidence(succeeding.id, succeeding.threadId)
    expect(evidence.rows).toHaveLength(1)
    expect(evidence.rows[0]?.status).toBe('completed')
    expect(evidence.messages).toHaveLength(2)
    await bridge.tick()
    expect(h.prompts).toHaveLength(2)
    expect(h.storage.value).not.toContain(h.token)
  })
}, 20_000)
