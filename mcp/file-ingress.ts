import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { checkServerIdentity } from 'node:tls'
import ipaddr from 'ipaddr.js'
import { LIMITS, mime, name, record } from '../src/protocol.js'
import type { FileRef, NormalizedFile } from './contracts.js'

interface Address { address: string; family: number }
export interface IngressIO {
  resolve(hostname: string): Promise<readonly Address[]>
  request(options: RequestOptions, response: (res: IncomingMessage) => void): ClientRequest
}
const nativeIO: IngressIO = {
  resolve: hostname => lookup(hostname, { all: true, verbatim: true }),
  request: (options, response) => httpsRequest(options, response),
}

export function publicAddress(address: string): boolean {
  if (!isIP(address) || address.includes('%')) return false
  const ip = ipaddr.parse(address)
  if (ip.range() !== 'unicast') return false
  if (ip.kind() === 'ipv6') return ip.match(ipaddr.IPv6.parse('2000::'), 3)
  // Azure's virtual platform/metadata endpoint is public-looking but not a file origin.
  return ip.toString() !== '168.63.129.16'
}

/** IO injection is for deterministic tests; configuration never enables private addresses or insecure TLS. */
export function createFileIngress(origins: readonly string[], io: IngressIO = nativeIO): (ref: FileRef) => Promise<NormalizedFile> {
  const allowed = new Set(origins)
  return async raw => {
    if (!allowed.size) throw new Error('File import is disabled')
    const ref = record(raw)
    if (Object.keys(ref).some(key => !['file_id', 'download_url', 'file_name', 'mime_type'].includes(key))) throw new Error('Invalid file reference')
    const file_id = name(ref.file_id)
    const filename = name(ref.file_name ?? file_id)
    const type = mime(ref.mime_type ?? 'application/octet-stream')
    if (typeof ref.download_url !== 'string' || ref.download_url.length > 8192 || /[\x00-\x20\x7f\\#]/.test(ref.download_url) || /:\/\/[^/?#]*@/.test(ref.download_url)) throw new Error('Invalid file download URL')
    let url: URL
    try { url = new URL(ref.download_url) } catch { throw new Error('Invalid file download URL') }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !allowed.has(url.origin)) throw new Error('File origin is not allowed')
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    return new Promise<NormalizedFile>((resolve, reject) => {
      let done = false
      let request: ClientRequest | undefined
      let response: IncomingMessage | undefined
      const fail = () => {
        if (done) return
        done = true; clearTimeout(timer)
        response?.destroy(); request?.destroy()
        reject(new Error('File import failed safely'))
      }
      const timer = setTimeout(fail, 10_000)
      void (async () => {
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await io.resolve(hostname)
        if (done) return
        if (!addresses.length || addresses.length > 32 || addresses.some(a => isIP(a.address) !== a.family || !publicAddress(a.address))) { fail(); return }
        const pinned = addresses[0]!
        request = io.request({
          protocol: 'https:', hostname: pinned.address, family: pinned.family, port: Number(url.port || 443),
          servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true,
          checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate),
          method: 'GET', path: `${url.pathname}${url.search}`, agent: false,
          headers: { Host: url.host, Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
        }, res => {
          response = res
          res.on('error', fail); res.on('aborted', fail)
          if (done) { res.destroy(); return }
          const length = res.headers['content-length']
          const encoding = res.headers['content-encoding']
          if (res.statusCode !== 200 || typeof length !== 'string' || !/^(0|[1-9][0-9]*)$/.test(length)
              || Number(length) > LIMITS.file || (encoding !== undefined && encoding !== 'identity') || res.headers['transfer-encoding']) { fail(); return }
          const expected = Number(length)
          let size = 0
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > expected || size > LIMITS.file) { fail(); return }
            chunks.push(chunk)
          })
          res.on('end', () => {
            if (done) return
            if (size !== expected) { fail(); return }
            done = true; clearTimeout(timer)
            resolve({ file_id, name: filename, mime: type, bytes: Buffer.concat(chunks, size) })
          })
        })
        request.on('error', fail)
        if (done) request.destroy()
        else request.end()
      })().catch(fail)
    })
  }
}
