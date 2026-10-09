import { Plugin } from '@opencode/plugin'
import { Bridge, config } from './core.js'
import { record, uuid } from './protocol.js'

const attachmentSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Safe unique basename. Required for base64/data inputs.' },
    mime: { type: 'string', description: 'Lowercase MIME type without parameters; required for path/base64.' },
    path: { type: 'string', description: 'Local file in explicitly configured uploadRoots; symlinks forbidden.' },
    data: { type: 'string', description: 'data:<mime>;base64,<canonical base64>' },
    base64: { type: 'string', description: 'Canonical base64 bytes, not a URL.' },
  },
} as const

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
        // Session IDs originate exclusively in tool context and are preserved in the private outbox.
        prompt: input => ctx.session.prompt({ ...input, sessionID: input.sessionID as Parameters<typeof ctx.session.prompt>[0]['sessionID'] }),
      })
    } catch (error) {
      configurationError = error instanceof Error ? error.message : 'Hermes bridge setup failed'
    }
    const unavailable = () => ({ content: `Hermes bridge unavailable: ${configurationError}. No HTTP request was made. Configure plugin options/environment explicitly; no host configuration is modified.` })
    const registration = await ctx.tool.transform(editor => {
      editor.add({
        name: 'hermes_ask',
        description: 'Send a request and optional attachment bytes to the configured Hermes companion. Snapshots only explicitly allowed local uploads, persists an outbox and immediately returns LOCAL acceptance, not a Hermes/model result. Background replies go only to this OpenCode session. External data leaves this machine if the configured endpoint is remote.',
        options: { permission: 'hermes_ask' },
        input: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', description: 'Request to Hermes, at most 64 KiB UTF-8.' }, attachments: { type: 'array', maxItems: 8, items: attachmentSchema } } },
        async execute(input, context) {
          if (!bridge) return unavailable()
          const job = await bridge.ask(context.sessionID, input, context.signal)
          return { content: `Locally accepted and durably queued; not yet acknowledged by Hermes. Job ${job.id}; thread ${job.threadId}. Background result will be queued to this session. Use hermes_status with this job ID.` }
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
        description: 'Locally resume waiting/retry for this session’s paused or failed job, using the SAME persisted UUID and attachment snapshot. May resubmit that idempotency key; never deliberately creates a new Hermes task. Fix authorization/configuration before retrying a permanent error.',
        options: { permission: 'hermes_resume' },
        input: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', description: 'Existing job UUID in the current session.' } } },
        async execute(input, context) {
          if (!bridge) return unavailable()
          const r = record(input)
          return { content: JSON.stringify(await bridge.resume(context.sessionID, uuid(r.id), context.signal)) }
        },
      })
    })
    bridge?.start()
    return async () => { await bridge?.dispose(); await registration.dispose() }
  },
})
