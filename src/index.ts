import { Plugin } from '@opencode/plugin'
import { Bridge, config, waitSeconds } from './core.js'
import { record, uuid } from './protocol.js'
import { agentContext } from './agent-context.js'

const attachmentSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Safe unique basename. Required for base64/data inputs.' },
    mime: { type: 'string', description: 'image/png, image/jpeg, image/gif or image/webp; required for path/base64.' },
    path: { type: 'string', description: 'Local image in explicitly configured uploadRoots; symlinks forbidden.' },
    data: { type: 'string', description: 'data:<mime>;base64,<canonical base64>' },
    base64: { type: 'string', description: 'Canonical base64 bytes, not a URL.' },
  },
} as const
const fileSchema = {
  ...attachmentSchema,
  properties: {
    ...attachmentSchema.properties,
    mime: { type: 'string', description: 'Lowercase MIME type without parameters, including application/pdf, application/zip or application/octet-stream. Required for path/base64.' },
    path: { type: 'string', description: 'Local file in explicitly configured uploadRoots. Symlinks and remote URLs are forbidden; opaque bytes are snapshotted without parsing.' },
  },
} as const
const waitSchema = { type: 'number', minimum: 0, maximum: 120, description: 'Bounded wait in seconds (0 returns immediately). Cancellation stops waiting, not the persisted job.' } as const

export default Plugin.define({
  id: 'hermes-bridge',
  async setup(ctx) {
    let bridge: Bridge | undefined
    let configurationError = ''
    try {
      const cfg = config(ctx.options, process.env, ctx.location.directory)
      bridge = await Bridge.create(cfg, {
        storage: {
          async load() {
            const value = await ctx.storage.get('outbox-v1')
            if (value !== undefined && typeof value !== 'string') throw new Error('Invalid persisted Hermes outbox')
            return value
          },
          save: value => ctx.storage.set('outbox-v1', value),
        },
      })
    } catch (error) {
      configurationError = error instanceof Error ? error.message : 'Hermes bridge setup failed'
    }
    const unavailable = () => ({ content: `Hermes bridge unavailable: ${configurationError}. No HTTP request was made. Configure plugin options/environment explicitly; no host configuration is modified.` })
    const registration = await ctx.tool.transform(editor => {
      editor.add({
        name: 'hermes_ask',
        description: 'Send text, optional native image attachments, and opaque files to Hermes. File transfer requires companion capabilities; files are never silently dropped or converted to text. Set requireFiles for output files even without input files. Up to 8 inputs total, 10 MiB each/20 MiB combined. Persist the job and wait up to 30 seconds by default (waitSeconds 0..120); return formal output or non-final status/job ID for hermes_result. No chat injection. Data leaves this machine if the endpoint is remote.',
        options: { permission: 'hermes_ask' },
        input: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', description: 'Request to Hermes, at most 64 KiB UTF-8.' }, attachments: { type: 'array', maxItems: 8, items: attachmentSchema, description: 'Native PNG/JPEG/GIF/WebP images only. Use files for ordinary binary files.' }, files: { type: 'array', maxItems: 8, items: fileSchema }, requireFiles: { type: 'boolean', description: 'Require file-capable execution, including when requesting output files with no input file. Unsupported companions fail before model submission.' }, waitSeconds: waitSchema } },
        async execute(input, context) {
          if (!bridge) return unavailable()
          const r = record(input)
          const seconds = waitSeconds(r.waitSeconds, 30)
          const job = await bridge.ask(context.sessionID, { ...r, text: agentContext('opencode', r.text) }, context.signal)
          return bridge.result(context.sessionID, job.id, { waitSeconds: seconds, signal: context.signal })
        },
      })
      editor.add({
        name: 'hermes_result',
        description: 'Read this session’s durable Hermes result as a formal tool result, optionally waiting up to 120 seconds (default 0). Pending/paused jobs return explicit non-final status. Images/text may be attached; other files are saved locally, not claimed as model-read. No chat injection or resubmission.',
        options: { permission: 'hermes_result' },
        input: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', description: 'Existing job UUID in this session.' }, waitSeconds: waitSchema } },
        async execute(input, context) {
          if (!bridge) return unavailable()
          const r = record(input)
          return bridge.result(context.sessionID, uuid(r.id), { waitSeconds: waitSeconds(r.waitSeconds), signal: context.signal })
        },
      })
      editor.add({
        name: 'hermes_status',
        description: 'Inspect only the current OpenCode session’s local Hermes outbox. Does not call Hermes or inspect any other session.',
        options: { permission: 'hermes_status' },
        input: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', description: 'Optional job UUID; omit to list this session’s jobs.' } } },
        async execute(input, context) {
          if (!bridge) return unavailable()
          context.signal.throwIfAborted()
          const r = record(input)
          return { content: JSON.stringify(await bridge.status(context.sessionID, r.id === undefined ? undefined : uuid(r.id))) }
        },
      })
      editor.add({
        name: 'hermes_resume',
        description: 'Resume querying the original record for this session’s paused or failed job using its persisted UUID. Never resubmits a model request, even when the outcome is unknown. Jobs with missing or changed endpoint/credential scope stay blocked without HTTP.',
        options: { permission: 'hermes_resume' },
        input: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', description: 'Existing job UUID in the current session.' } } },
        async execute(input, context) {
          if (!bridge) return unavailable()
          const r = record(input)
          const job = await bridge.resume(context.sessionID, uuid(r.id), context.signal)
          return { content: `${JSON.stringify(job)}\nUse hermes_result with this job ID to retrieve output. Resume never submits another POST.` }
        },
      })
    })
    bridge?.start()
    return async () => { await bridge?.dispose(); await registration.dispose() }
  },
})
