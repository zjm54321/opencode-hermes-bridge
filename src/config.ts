import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { record } from './protocol.js'

export interface Config {
  url: string; token: string; uploadRoots: string[]; directory: string; outputDir: string
  pollMs: number; httpTimeoutMs: number; jobTimeoutMs: number
}
export function config(options: unknown = {}, env: Record<string, string | undefined> = process.env, directory = process.cwd()): Config {
  const o = record(options)
  if ('token' in o) throw new Error('Token must come from an environment variable, never plugin options')
  const rawURL = o.url ?? env.HERMES_BRIDGE_URL ?? 'http://127.0.0.1:8787'
  if (typeof rawURL !== 'string') throw new Error('Invalid bridge URL')
  const url = new URL(rawURL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Bridge URL must be an HTTP(S) origin without credentials, query, fragment or path')
  const tokenEnv = o.tokenEnv ?? 'HERMES_BRIDGE_TOKEN'
  if (typeof tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('Invalid tokenEnv')
  const token = env[tokenEnv] ?? ''
  if (!token || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error(`Configure a nonempty Bearer token in environment variable ${tokenEnv}`)
  let roots: unknown = o.uploadRoots ?? []
  if (!('uploadRoots' in o) && env.HERMES_BRIDGE_UPLOAD_ROOTS) roots = JSON.parse(env.HERMES_BRIDGE_UPLOAD_ROOTS)
  if (!Array.isArray(roots) || !roots.every((r): r is string => typeof r === 'string' && r.length > 0)) throw new Error('uploadRoots must be an array of paths (environment value is JSON)')
  const outputDir = o.outputDir ?? env.HERMES_BRIDGE_OUTPUT_DIR ?? resolve(env.XDG_STATE_HOME ?? resolve(homedir(), '.local/state'), 'opencode-hermes-bridge/outputs')
  if (typeof outputDir !== 'string' || !outputDir) throw new Error('Invalid outputDir')
  return { url: url.origin, token, uploadRoots: roots.map(r => resolve(directory, r)), directory, outputDir: resolve(directory, outputDir), pollMs: 2000, httpTimeoutMs: 10_000, jobTimeoutMs: 30 * 60_000 }
}
