import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import type { Principal } from './contracts.js'

interface CommonConfig {
  stateDirectory: string; fileOrigins: readonly string[]; host: string; port: number; httpDownloads: boolean
}
export interface OAuthConfig extends CommonConfig {
  authMode: 'oauth'; publicOrigin: string; resource: string; issuer: string; jwksURL: string; allowedSubject: string
}
export interface PrivateTunnelConfig extends CommonConfig {
  authMode: 'private-tunnel'; publicOrigin: 'https://private-tunnel.invalid'
  privateOwner: string; tunnelID: string; host: '127.0.0.1' | '::1'; httpDownloads: false
}
export type McpConfig = OAuthConfig | PrivateTunnelConfig

/** Private tunnel transport is a single-owner trust domain, NOT per-request user authentication. */
export function configuredPrincipal(config: McpConfig): Principal {
  if (config.authMode === 'oauth') return { issuer: config.issuer, subject: config.allowedSubject }
  return {
    issuer: 'urn:hermes-mcp:private-tunnel:v1',
    subject: createHash('sha256').update(JSON.stringify([config.privateOwner, config.tunnelID])).digest('hex'),
  }
}

export function httpsURL(value: string, originOnly = false): URL {
  if (!value || value.trim() !== value || /[\x00-\x20\x7f\\#]/.test(value) || /:\/\/[^/?#]*@/.test(value)) throw new Error('Invalid HTTPS configuration URL')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Invalid HTTPS configuration URL') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.search
      || (originOnly && url.pathname !== '/')) throw new Error('Invalid HTTPS configuration URL')
  return url
}

export function mcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const authMode = env.HERMES_MCP_AUTH_MODE ?? 'oauth'
  if (authMode !== 'oauth' && authMode !== 'private-tunnel') throw new Error('Invalid HERMES_MCP_AUTH_MODE (use oauth or private-tunnel)')
  const required = (name: string): string => {
    const value = env[`HERMES_MCP_${name}`]
    if (!value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Configure HERMES_MCP_${name}`)
    return value
  }
  const privateIdentifier = (name: string): string => {
    const value = required(name)
    if (Buffer.byteLength(value) > 256 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error(`Invalid HERMES_MCP_${name}`)
    return value
  }
  const identity = authMode === 'oauth' ? {
    authMode, publicOrigin: httpsURL(required('PUBLIC_ORIGIN'), true).origin,
    issuer: required('ISSUER'), jwksURL: required('JWKS_URL'), allowedSubject: required('SUBJECT'),
  } as const : {
    authMode, publicOrigin: 'https://private-tunnel.invalid',
    privateOwner: privateIdentifier('PRIVATE_OWNER'), tunnelID: privateIdentifier('TUNNEL_ID'),
  } as const
  if (identity.authMode === 'oauth') { httpsURL(identity.issuer); httpsURL(identity.jwksURL) }
  const stateDirectory = required('STATE_DIR')
  if (!isAbsolute(stateDirectory)) throw new Error('HERMES_MCP_STATE_DIR must be absolute')
  let origins: unknown
  try { origins = JSON.parse(env.HERMES_MCP_FILE_ORIGINS ?? '[]') } catch { throw new Error('Invalid HERMES_MCP_FILE_ORIGINS') }
  if (!Array.isArray(origins) || origins.length > 32 || !origins.every(v => typeof v === 'string')) throw new Error('Invalid HERMES_MCP_FILE_ORIGINS')
  const fileOrigins = origins.map(value => {
    const url = httpsURL(value, true)
    if (value !== url.origin) throw new Error('HERMES_MCP_FILE_ORIGINS must contain exact HTTPS origins')
    return url.origin
  })
  const host = env.HERMES_MCP_HOST ?? '127.0.0.1'
  if (!isIP(host)) throw new Error('HERMES_MCP_HOST must be a listener IP address')
  const portValue = env.HERMES_MCP_PORT ?? '8790'
  const port = Number(portValue)
  if (!/^[0-9]+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HERMES_MCP_PORT')
  const httpDownloads = env.HERMES_MCP_HTTP_DOWNLOADS ?? '0'
  if (httpDownloads !== '0' && httpDownloads !== '1') throw new Error('Invalid HERMES_MCP_HTTP_DOWNLOADS (use 0 or 1)')
  const common = { stateDirectory, fileOrigins: Object.freeze([...new Set(fileOrigins)]), port }
  if (identity.authMode === 'private-tunnel') {
    if (!/^tunnel_[a-z0-9]{32}$/.test(identity.tunnelID)) throw new Error('Invalid HERMES_MCP_TUNNEL_ID (expected tunnel_ followed by 32 lowercase letters or digits)')
    if (host !== '127.0.0.1' && host !== '::1') throw new Error('Private tunnel requires HERMES_MCP_HOST=127.0.0.1 or ::1')
    if (httpDownloads !== '0') throw new Error('Private tunnel requires HERMES_MCP_HTTP_DOWNLOADS=0')
    // This sentinel is only for the existing private service's HTTPS-origin invariant.
    // Private mode neither contacts it nor advertises it as a public endpoint.
    return Object.freeze({ ...identity, ...common, host, httpDownloads: false })
  }
  return Object.freeze({ ...identity, ...common, host, resource: `${identity.publicOrigin}/mcp`, httpDownloads: httpDownloads === '1' })
}
