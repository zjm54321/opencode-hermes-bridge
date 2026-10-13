import { config as bridgeConfig } from '../src/config.js'
import { configuredPrincipal, mcpConfig } from './config.js'
import { createFileIngress } from './file-ingress.js'
import { createMcpHttpServer } from './http.js'
import { McpBridgeService } from './service.js'

export async function startMcp(env: Record<string, string | undefined> = process.env) {
  const config = mcpConfig(env)
  const service = await McpBridgeService.open({
    bridgeConfig: bridgeConfig({}, env), stateDirectory: config.stateDirectory,
    allowedPrincipal: configuredPrincipal(config), downloadFile: createFileIngress(config.fileOrigins),
  })
  const server = createMcpHttpServer(config, service)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => { server.off('error', reject); resolve() })
    })
  } catch (error) { await service.close(); throw error }
  const close = async () => {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
    await service.close()
  }
  return { server, close }
}

if (import.meta.main) {
  try {
    const running = await startMcp()
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      void running.close().catch(() => { process.exitCode = 1 })
    }
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
  } catch {
    console.error('Hermes MCP startup failed; check the explicit configuration and private state permissions.')
    process.exitCode = 1
  }
}
