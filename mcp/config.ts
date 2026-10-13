import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'

export interface McpConfig {
  publicOrigin: string; resource: string; issuer: string; jwksURL: string; allowedSubject: string
  stateDirectory: string; fileOrigins: readonly string[]; host: string; port: number; httpDownloads: boolean
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
  const required = (name: string): string => {
    const value = env[`HERMES_MCP_${name}`]
    if (!value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Configure HERMES_MCP_${name}`)
    return value
  }
  const publicOrigin = httpsURL(required('PUBLIC_ORIGIN'), true).origin
  const issuer = required('ISSUER')
  const jwksURL = required('JWKS_URL')
  httpsURL(issuer); httpsURL(jwksURL)
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
  return Object.freeze({ publicOrigin, resource: `${publicOrigin}/mcp`, issuer, jwksURL, allowedSubject: required('SUBJECT'), stateDirectory, fileOrigins: Object.freeze([...new Set(fileOrigins)]), host, port, httpDownloads: httpDownloads === '1' })
}
