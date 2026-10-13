import { isIP, type AddressInfo, type Socket } from 'node:net'
import ipaddr from 'ipaddr.js'
import type { McpConfig } from './config.js'

export type { Principal } from './contracts.js'

function loopbackAddress(address: string | undefined): string | undefined {
  if (!address || !isIP(address) || address.includes('%')) return undefined
  const parsed = ipaddr.process(address) // Normalize IPv4-mapped socket addresses before classification.
  return parsed.range() === 'loopback' ? parsed.toString() : undefined
}

/** The caller must supply server.address() and the actual socket, never forwarded headers. */
export function privateTunnelAuthority(config: McpConfig, bound: AddressInfo | string | null,
  socket: Pick<Socket, 'localAddress' | 'remoteAddress'>): string | undefined {
  if (!bound || typeof bound === 'string') return undefined
  const address = loopbackAddress(bound.address)
  if (address !== config.host || !loopbackAddress(socket.localAddress) || !loopbackAddress(socket.remoteAddress)) return undefined
  if (bound.port < 1 || bound.port > 65535 || !Number.isInteger(bound.port)) return undefined
  return `${address === '::1' ? '[::1]' : address}:${bound.port}`
}
