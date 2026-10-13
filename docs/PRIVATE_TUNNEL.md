<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# ChatGPT Secure MCP Tunnel 接入指南

本文档介绍通过 OpenAI 官方 [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)（`tunnel-client`）将 Hermes 接入 ChatGPT 网页端（Business / Enterprise 工作区）的架构、工具协议、环境变量与部署模板。

在 ChatGPT 网页端添加应用时选择 **Tunnel + No authentication**，无需外部身份服务或开放公网端口。与 OpenCode 插件复用原 Gateway 与 profile，不保证不同渠道共享同一聊天 session。本文描述源码与离线模板，生产尚未部署。

## 1. 架构拓扑与信任模型

`tunnel-client` 作为出站客户端主动连接 OpenAI 平台控制面，MCP 服务仅在本地回环（`127.0.0.1`）监听，无公网暴露端口。

ChatGPT → 官方 Tunnel → 同 Pod 的 `127.0.0.1:8790/mcp` → `http://hermes-bridge.ai-services.svc.cluster.local:8787` → 原 Gateway。

1. **单 Owner 信任域**：
   - 隧道直连本地回环，MCP 服务将所有通过该隧道的调用统一归属为预设的固定 Owner（`HERMES_MCP_PRIVATE_OWNER`）；
   - 该机制旨在保护个人 Hermes profile 与长期记忆，**不构成多租户隔离**；应用仅供个人使用，不得随意共享给包含其他成员的工作区。
2. **凭据分层管理**：
   - **OpenAI 隧道 API Key**：由 `tunnel-client` 容器通过只读 Secret 文件挂载（`--control-plane.api-key=file:/run/secrets/tunnel_api_key`）；参数仅含路径，严禁把密钥值放进参数、代码或报告；
   - **Bridge 令牌**：MCP 容器仅持有访问既有 Bridge 服务的 `HERMES_BRIDGE_TOKEN`，两类凭据在对应容器内分别管理。
   - 控制面账户须有对应 Tunnel 的权限；API Key 启动时读取，轮换需重启客户端。同 Pod 共享网络不是容器级隔离。

## 2. MCP 工具契约（3 个工具）

服务基于官方 MCP SDK（`@modelcontextprotocol/server` + `@modelcontextprotocol/node`）提供标准 Stateless Streamable HTTP `/mcp` 端点。

### 2.1 `hermes_submit`

提交新任务至 Hermes，支持单文件输入与幂等去重。

- **输入参数 (`SubmitInput`)**：
  - `request_id`（必填，UUID）：客户端生成的幂等标识。相同 ID 且内容指纹一致时复用已有任务；内容变异时作为冲突拒绝（返回 `isError` 工具错误）；
  - `text`（必填，string）：指令文本（最大 64 KiB UTF-8）；
  - `thread_id`（选填，UUID）：会话标识。缺省时自动分配新会话句柄；传入已有 ID 时延续上下文；
  - `file`（选填，单对象）：输入文件引用，声明 `_meta: { 'openai/fileParams': ['file'] }`；
    - 结构：`{ file_id, download_url, file_name?, mime_type? }`；
   - 安全拉取：服务端从 `download_url` 拉取原始字节，仅限 `HERMES_MCP_FILE_ORIGINS` 白名单中的精确 HTTPS Origin，仅允许公网单播 IP、禁止重定向，上限 10 MiB / 10 秒；
  - `require_files`（选填，boolean）：要求启用文件支持；
  - `wait_seconds`（选填，number，0..120，默认 0）：等待秒数。
- **工具注解**：声明 `destructiveHint: true`（Hermes 拥有系统工具与执行权限，MCP 不充当沙箱）。
- **输出返回**：完成并取回文件时，工具 `content` 包含标准 MCP `resource_link`，URI 指向原生资源（`hermes://jobs/{job_id}/assets/{asset_id}`）。

> **说明**：ChatGPT 网页端是否自动将已有对话附件绑定至 `file` 参数尚未经真实账户实测。

### 2.2 `hermes_status`

- **输入参数**：`{ job_id: UUID }`
- **执行行为**：声明 `readOnlyHint: true`，只读返回任务进度元数据。

### 2.3 `hermes_result`

- **输入参数**：`{ job_id: UUID, wait_seconds?: number }`（0..120）
- **执行行为**：
  - 任务暂停时以 GET 恢复轮询，绝不重新提交 POST；
  - 终态返回输出文件的 MCP 资源 URI（`hermes://...`）；响应元数据不暴露宿主机内部路径，模型输出正文作为外部不可信内容原样返回。

### 2.4 原生 Resources 资源读取契约

- **模板发现**：声明 `resources` capability，注册 `ResourceTemplate` 为 `hermes://jobs/{job_id}/assets/{asset_id}`，可通过 `resources/templates/list` 发现；
- **资源读取 (`resources/read`)**：
  - 请求参数：`{ uri: "hermes://jobs/{job_id}/assets/{asset_id}" }`；
  - 响应：返回 `contents: [{ uri, mimeType, blob }]`；
   - 原字节流转：`blob` 由本服务程序编码为 Base64，经 SDK 传输，客户端按需解码、展示或落盘（绝非大模型文本转写）；服务不保证客户端自动保存文件或模型已解析内容。
   - 输出描述只提供资源 URI，不提供 HTTP 下载 URL、过期时间或 MCP 下载 TTL；输入 `file.download_url` 与 Bridge 底层资产 API 仍保留。

## 3. 环境变量与配置契约

| 变量名 | 必填 | 默认值 | 说明与约束 |
| :--- | :--- | :--- | :--- |
| `HERMES_MCP_PRIVATE_OWNER` | 是 | - | 固定个人所有者标识（非空字符串，<= 256 UTF-8 字节，无控制字符，非 Honcho peer 配置） |
| `HERMES_MCP_TUNNEL_ID` | 是 | - | OpenAI 控制面分配的 Tunnel ID（格式严格为 `^tunnel_[a-z0-9]{32}$`） |
| `HERMES_MCP_STATE_DIR` | 是 | - | 绝对路径的状态持久化目录（权限必须为 `0700`，内含 `state.json` 与 `writer.lock`） |
| `HERMES_MCP_FILE_ORIGINS` | 否 | `[]` | 允许拉取输入文件的 HTTPS Origin 白名单（JSON 数组，缺省禁用输入文件拉取） |
| `HERMES_MCP_HOST` | 否 | `127.0.0.1` | 监听地址，**只能设为 `127.0.0.1` 或 `::1`**（拒绝通配绑定） |
| `HERMES_MCP_PORT` | 否 | `8790` | 监听端口 |
| `HERMES_BRIDGE_URL` | 否 | `http://127.0.0.1:8787` | 后端 Bridge 服务地址（在 K8s 内部指向既有集群服务 DNS） |
| `HERMES_BRIDGE_TOKEN` | 是 | - | 访问既有 Bridge 服务的 Bearer Token |
| `HERMES_BRIDGE_OUTPUT_DIR` | 否 | `$XDG_STATE_HOME/opencode-hermes-bridge/outputs`，缺省为 `~/.local/state/opencode-hermes-bridge/outputs` | Bridge 输出根目录（MCP 在其下按 owner 创建隔离目录） |

### 运行约束

- 官方 Tunnel 的 No authentication 流程中，PRMD 探测路径 `GET /.well-known/oauth-protected-resource` 返回 `404`；不是本服务提供的认证发现接口。
- **状态保护与锁**：固定主体 issuer 为 `urn:hermes-mcp:private-tunnel:v1`，subject 为 `sha256(JSON.stringify([privateOwner, tunnelID]))`；`McpState.owner` 是唯一账本主体绑定。owner 或 Tunnel ID 改变会拒绝旧 state；不得新建空账本绕过。`writer.lock` 不自动抢占，仅在确认原进程已结束后人工处理锁，严禁删除 `state.json`。
- Bridge URL/Token 的 scope 变化时，旧任务保持阻断；未知提交结果只查询原 job，不重投。

## 4. Kubernetes 部署模板规划 (`deploy/private-tunnel/`)

项目在 `deploy/private-tunnel/` 提供了离线验证模板：

- **核心清单**：`base/resources.yaml` 声明 6 个资源（`ServiceAccount`、`ConfigMap hermes-mcp`、`PVC hermes-mcp-private`、`Deployment hermes-mcp`、以及 2 个限制入站与同命名空间后端通信的 `NetworkPolicy`）；
- **存储与初始化**：专用 PVC 内 `state` 与 `outputs` 目录为 `0700`、owner 10000；未知非空根目录、错误 owner/mode/符号链接、缺账本但有旧输出均拒绝，不认领、清空或修复旧数据，不复用原 profile。私有临时目录独立；单副本 `Recreate`，非 root、只读根、drop ALL、RuntimeDefault；root init 仅 CHOWN/FOWNER，无递归 chown 或 fsGroup；
- **双容器协同**：官方镜像固定 `ghcr.io/openai/tunnel-client:v0.0.16@sha256:4605ea909701668d3bdcbe6152558e068e24006aa96ca5518ca67f786a1bce13`。MCP 与客户端引用同一个 ConfigMap `tunnel-id` key；无 Service/Ingress/hostPort/hostNetwork，NP 拒绝入站，仅放 DNS、同 namespace 后端 8787 与公网 443，不修改旧 LAN 规则。loopback exec readiness 不证明 ChatGPT 可用；
- **本地验证命令**：
  ```bash
  # 运行静态合规检查
   python3 -B deploy/private-tunnel/check.py

  # 渲染 Kustomize 本地清单
  kustomize build deploy/private-tunnel/base
  ```
- **使用前填值**：填写 `REPLACE_ME_*`（owner、Tunnel ID、StorageClass、MCP 镜像 digest），安全提供空 Secret 示例所需的两类凭据；Dockerfile 的 `BUN_IMAGE` 必须填写可信 `oven/bun:1.4.2@sha256:<64hex>`，冻结依赖并独立打包，不使用现有 dist。检查器输出 `STATIC PASS` 并提醒占位值，只做静态检查，不部署、不代表验收通过。
- 完整文件发布仍需另行 profile-safe 后端插件升级、`assets: true` 能力确认与真实账户原件验收；详见 [文件指南](FILE_TRANSFER.md) 与 [验证现状](VERIFICATION.md)。

## 官方参考来源

- [OpenAI Tunnel Client 部署文档](https://github.com/openai/tunnel-client/blob/5f99daabd4aa4a77049e6d81d54a0d8c18335397/docs/deployment/docker.md)
- [ChatGPT 自定义 MCP 连接选项](https://developers.openai.com/api/docs/guides/custom-mcp-server#how-to-use)
- [OpenAI 官方 Secure MCP Tunnels 文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
