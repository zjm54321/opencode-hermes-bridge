import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { isIP, type AddressInfo, type Socket } from 'node:net'
import ipaddr from 'ipaddr.js'
import type { OAuthConfig, PrivateTunnelConfig } from './config.js'
import type { Principal } from './contracts.js'

export type { Principal } from './contracts.js'
export class AuthenticationError extends Error {
  constructor(readonly status: 401 | 403) { super(status === 401 ? 'Authentication required' : 'Access denied') }
}

export class JwtAuthenticator {
  private readonly key: JWTVerifyGetKey
  constructor(private readonly config: OAuthConfig, key?: JWTVerifyGetKey) {
    this.key = key ?? createRemoteJWKSet(new URL(config.jwksURL), {
      timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
      [customFetch]: (url, options) => fetch(url, { ...options, redirect: 'error' }),
    })
  }
  async authenticate(authorization: string | undefined): Promise<Principal> {
    if (!authorization || authorization.length > 16_384 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)) throw new AuthenticationError(401)
    let payload
    try {
      const result = await jwtVerify(authorization.slice(7), this.key, {
        algorithms: ['RS256', 'ES256'], issuer: this.config.issuer, audience: this.config.resource,
        requiredClaims: ['iss', 'sub', 'aud', 'exp'], clockTolerance: 0,
      })
      payload = result.payload
    } catch { throw new AuthenticationError(401) }
    if (payload.sub !== this.config.allowedSubject || typeof payload.scope !== 'string' || !payload.scope.split(/\s+/).includes('hermes:use')) throw new AuthenticationError(403)
    return { issuer: this.config.issuer, subject: this.config.allowedSubject }
  }
}

export function protectedResourceMetadata(config: OAuthConfig) {
  return { resource: config.resource, authorization_servers: [config.issuer], scopes_supported: ['hermes:use'], bearer_methods_supported: ['header'] }
}
export function authChallenge(config: OAuthConfig): string {
  return `Bearer resource_metadata="${config.publicOrigin}/.well-known/oauth-protected-resource", scope="hermes:use"`
}

function loopbackAddress(address: string | undefined): string | undefined {
  if (!address || !isIP(address) || address.includes('%')) return undefined
  const parsed = ipaddr.process(address) // Normalize IPv4-mapped socket addresses before classification.
  return parsed.range() === 'loopback' ? parsed.toString() : undefined
}

/** The caller must supply server.address() and the actual socket, never forwarded headers. */
export function privateTunnelAuthority(config: PrivateTunnelConfig, bound: AddressInfo | string | null,
  socket: Pick<Socket, 'localAddress' | 'remoteAddress'>): string | undefined {
  if (!bound || typeof bound === 'string') return undefined
  const address = loopbackAddress(bound.address)
  if (address !== config.host || !loopbackAddress(socket.localAddress) || !loopbackAddress(socket.remoteAddress)) return undefined
  if (bound.port < 1 || bound.port > 65535 || !Number.isInteger(bound.port)) return undefined
  return `${address === '::1' ? '[::1]' : address}:${bound.port}`
}
