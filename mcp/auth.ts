import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { McpConfig } from './config.js'
import type { Principal } from './contracts.js'

export type { Principal } from './contracts.js'
export class AuthenticationError extends Error {
  constructor(readonly status: 401 | 403) { super(status === 401 ? 'Authentication required' : 'Access denied') }
}

export class JwtAuthenticator {
  private readonly key: JWTVerifyGetKey
  constructor(private readonly config: McpConfig, key?: JWTVerifyGetKey) {
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

export function protectedResourceMetadata(config: McpConfig) {
  return { resource: config.resource, authorization_servers: [config.issuer], scopes_supported: ['hermes:use'], bearer_methods_supported: ['header'] }
}
export function authChallenge(config: McpConfig): string {
  return `Bearer resource_metadata="${config.publicOrigin}/.well-known/oauth-protected-resource", scope="hermes:use"`
}
