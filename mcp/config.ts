import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import type { Principal } from './contracts.js'

export interface McpConfig {
  privateOwner: string; tunnelID: string; stateDirectory: string
  fileOrigins: readonly string[]; host: '127.0.0.1' | '::1'; port: number
}

/** Private tunnel transport is a single-owner trust domain, NOT per-request user authentication. */
export function configuredPrincipal(config: McpConfig): Principal {
  return {
    issuer: 'urn:hermes-mcp:private-tunnel:v1',
    subject: createHash('sha256').update(JSON.stringify([config.privateOwner, config.tunnelID])).digest('hex'),
  }
}

export function mcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
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
  const privateOwner = privateIdentifier('PRIVATE_OWNER'), tunnelID = privateIdentifier('TUNNEL_ID')
  if (!/^tunnel_[a-z0-9]{32}$/.test(tunnelID)) throw new Error('Invalid HERMES_MCP_TUNNEL_ID (expected tunnel_ followed by 32 lowercase letters or digits)')
  const stateDirectory = required('STATE_DIR')
  if (!isAbsolute(stateDirectory)) throw new Error('HERMES_MCP_STATE_DIR must be absolute')
  let origins: unknown
  try { origins = JSON.parse(env.HERMES_MCP_FILE_ORIGINS ?? '[]') } catch { throw new Error('Invalid HERMES_MCP_FILE_ORIGINS') }
  if (!Array.isArray(origins) || origins.length > 32 || !origins.every(v => typeof v === 'string')) throw new Error('Invalid HERMES_MCP_FILE_ORIGINS')
  const fileOrigins = origins.map(value => {
    let url: URL
    try { url = new URL(value) } catch { throw new Error('Invalid HERMES_MCP_FILE_ORIGINS') }
    if (url.protocol !== 'https:' || value !== url.origin) throw new Error('HERMES_MCP_FILE_ORIGINS must contain exact HTTPS origins')
    return url.origin
  })
  const host = env.HERMES_MCP_HOST ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('HERMES_MCP_HOST must be 127.0.0.1 or ::1')
  const portValue = env.HERMES_MCP_PORT ?? '8790'
  const port = Number(portValue)
  if (!/^[0-9]+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HERMES_MCP_PORT')
  return Object.freeze({ privateOwner, tunnelID, stateDirectory, fileOrigins: Object.freeze([...new Set(fileOrigins)]), host, port })
}
