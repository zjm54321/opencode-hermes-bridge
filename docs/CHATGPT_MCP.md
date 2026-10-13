<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# ChatGPT Remote MCP 服务接入指南

本文档介绍针对 ChatGPT 网页端（Business / Enterprise 工作区）接入的 Remote MCP 服务架构、工具契约、OAuth 保护与安全边界。

> **重要前提与状态声明**：
> 1. **本地与真实 Host 验证现状**：当前已完成 MCP 标准服务实现并通过全套离线测试（17 项测试 / 478 断言）；在隔离环境中经真实 OpenCode 2.0.27 宿主实际调用 MCP 三工具并通过 `read_mcp_resource` 验证了 318 字节 ZIP 原件完整闭环（哈希一致，无自动落盘）；真实 ChatGPT 网页端附件自动绑定与商业 OAuth 账户接入仍待实测，生产环境未部署上线。
> 2. **真实接入前置条件**：需所属 ChatGPT 工作区管理员允许添加自定义 MCP App、外部配置独立的真实 OAuth 2.0 授权服务器、以及具备公网 HTTPS 域名与反向代理。

---

## 1. 架构拓扑与交互原则

服务基于官方 MCP SDK（`@modelcontextprotocol/server 2.3.1` + `@modelcontextprotocol/node 2.1.1`），对外提供标准无状态 Streamable HTTP `/mcp` 端点。

```text
+----------------------------+                    +-----------------------------+                    +---------------------------+
| ChatGPT / MCP Client       |                    | Hermes MCP Server (8790)    |                    | Hermes Companion (8787)   |
| (Business/Enterprise 应用) |                    | (OAuth 资源服务 + 原生 Resources) |              | (任务账本 + 受控文件资产层) |
+-------------+--------------+                    +--------------+--------------+                    +-------------+-------------+
              |                                                  |                                                  |
       [发起任务 / 引用输入文件]                                    |                                                  |
              |                                                  |                                                  |
       1. POST /mcp (hermes_submit, Bearer JWT) ---------------->| (验证 JWT / 安全拉取输入文件)                       |
              |                                                  | 2. 登记资产并提交任务 ----------------------------->|
              |<-- 3. 返回 ToolResult (含 hermes:// 资源 URI) ----|                                                  |
              |                                                  |                                                  |
       [客户端按需读取原件]                                        |                                                  |
       4. POST /mcp (resources/read, Bearer JWT) --------------->| (校验 JWT / 从本地资产库读取原字节)                  |
              |<-- 5. contents: [{ uri, mimeType, blob }] --------|                                                  |
              | (MCP blob 使用 Base64 表示原始字节，由客户端按需解码、展示或保存；不经模型转录)                      |
```

### 核心设计原则

- **原生 Resources 协议优先**：服务默认通过 MCP 标准 Resources 规范交付产物文件（声明 `resources` capability，提供 `hermes://jobs/{job_id}/assets/{asset_id}` 模板）。工具结果返回该资源 URI，客户端通过认证的 `resources/read` 获取 `blob`（MCP blob 使用 Base64 表示原始字节，由客户端按需解码、展示或保存；不经模型转录；不默认承诺客户端自动落盘或已读入模型上下文）。
- **单 Owner 访问**：服务绑定个人原 Hermes profile，单 Owner 约束旨在保护个人既有长期记忆，**不构成多租户记忆隔离**。所有 MCP 请求（包括 `resources/read`）均需经 OAuth JWT 严格鉴权。
- **可选 HTTP 兼容下载**：仅在显式配置 `HERMES_MCP_HTTP_DOWNLOADS=1`（默认 0 禁用）时，才额外生成包含 256 位随机能力 Token 的短时 HTTPS 下载链接（`/files/<token>`，默认 10 分钟）。默认模式下不生成 capability Token，不返回 `url` 与 `expires_at`。

---

## 2. MCP 工具契约（3 个工具）

### 2.1 `hermes_submit`

提交新任务至 Hermes。支持幂等去重与单文件输入。

- **输入参数 (`SubmitInput`)**：
  - `request_id`（必填，string/UUID）：客户端生成的幂等请求标识。相同 ID 且内容指纹一致时复用已有任务；相同 ID 但内容指纹变异时作为冲突拒绝（在 MCP `tools/call` 中返回 `isError` 工具错误，不新建任务）。
  - `text`（必填，string）：发给 Hermes 的指令文本（最大 64 KiB UTF-8）。
  - `thread_id`（选填，string/UUID）：会话标识。缺省时自动分配新会话句柄；传入已有合规 ID 时延续上下文。
  - `file`（选填，单对象）：输入文件引用，声明 `_meta: { 'openai/fileParams': ['file'] }`。
    - 结构：`{ file_id, download_url, file_name?, mime_type? }`
    - 单文件限制：当前仅支持单个文件输入（Bridge 内部的 8 文件配额属于更底层能力）。
  - `require_files`（选填，boolean）：要求文件流转能力支持。
  - `wait_seconds`（选填，number，0..120，默认 0）：等待秒数。
- **输入文件拉取安全防护**：
  - 服务端根据 `download_url` 自动下载原始字节；
  - 严格限制：仅允许 `HERMES_MCP_FILE_ORIGINS` 白名单中的精确 HTTPS Origin、公网公共 DNS 解析并锁定单播 IP、禁止任何 HTTP 重定向、单个文件上限 10 MiB、超时 10 秒。
- **工具注解与执行边界**：
  - 工具注解声明 `destructiveHint: true`（因底层 Hermes 拥有系统工具与执行权限，MCP 适配层不充当执行权限沙箱，任务按原 Hermes 权限执行）。
- **输出返回**：
  - 标准 MCP `resource_link` 数组及结构化 metadata；其中 `resource_link.uri` 统一指向原生资源 URI（`hermes://jobs/{job_id}/assets/{asset_id}`）。
  - 默认返回 `PublicFile` 对象包含 `{ asset_id, name, mime, size, sha256, uri }`；仅当显式配置 `HERMES_MCP_HTTP_DOWNLOADS=1` 时，才额外生成并附加短时 HTTP 下载链接 `url` 与 `expires_at`。
  - 不承诺 ChatGPT 网页端会自动呈现原生附件卡片，亦不保证模型已自动阅读或理解二进制文件内容。

> **特别声明**：ChatGPT 网页端是否会自动将对话已有附件或生成文件绑定至 `file` 参数**尚未经真实账户实测**。`fileParams` 的支持依据来自 OpenAI Codex 官方实现与 Apps SDK 规范，不可作为网页已实际支持的绝对保证。

### 2.2 `hermes_status`

查询指定任务的当前状态。

- **输入参数**：`{ job_id: string/UUID }`。
- **执行行为**：工具注解声明 `readOnlyHint: true`（指查询行为本身只读，不代表模型底层执行无副作用）；只读检查当前 Owner 拥有的任务状态，返回当前任务进度元数据。

### 2.3 `hermes_result`

取回任务结果，支持等待。

- **输入参数**：`{ job_id: string/UUID, wait_seconds?: number }`（0..120）。
- **执行行为**：
  - 工具注解声明 `readOnlyHint: true`；
  - 若任务处于暂停状态，仅发起 GET 轮询恢复，绝不重新提交模型 POST；
  - 任务完成时，返回包含输出文件 MCP 资源 URI（`hermes://...`）的列表；若启用了 HTTP 兼容下载则附加短时下载链接；
  - 服务生成的响应元数据绝不包含宿主机内部物理路径或内部通信 Token；Hermes 业务输出正文作为外部不可信内容原样返回（不进行自动文本过滤或篡改）。

### 2.4 原生 Resources 资源读取契约

服务通过 MCP 原生资源规范交付产物文件：

- **能力声明与模板发现**：服务端声明 `resources` capability，注册 `ResourceTemplate` 为 `hermes://jobs/{job_id}/assets/{asset_id}`。客户端可通过 `resources/templates/list` 发现该模板；服务未实现动态完整 `resources/list` 实体枚举，请求的资源 URI 须源自工具返回。
- **读取资源：`resources/read`**：
  - 请求参数：`{ uri: "hermes://jobs/{job_id}/assets/{asset_id}" }`；
  - 鉴权：每个请求均须携带合规的 OAuth JWT 严格校验，非公开 Bearer URL；
  - 响应：返回 `contents: [{ uri, mimeType, blob }]`；MCP blob 使用 Base64 表示原始字节，由客户端按需解码、展示或保存；不经模型转录；客户端不自动承诺落盘或模型已解析二进制；
  - 错误处理：若资源不存在或非当前授权 Owner 拥有，返回标准 MCP 错误（客户端捕获标准 MCP error 即可，无需硬绑定特定错误码）。

---

## 3. OAuth 2.0 受保护资源规范与认证

本项目在此架构中**仅充当 OAuth 2.0 受保护资源服务器（Resource Server）**，不自建用户登录系统，亦不负责签发凭据；外部必须配置合规的独立授权服务器（如 Auth0、Keycloak 或自建 IdP）。

### 3.1 资源发现与元数据

服务暴露 `/.well-known/oauth-protected-resource` 元数据端点供 ChatGPT 发现：

```json
{
  "resource": "https://mcp.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": ["hermes:use"],
  "bearer_methods_supported": ["header"]
}
```

未携带有效 Token 访问 `/mcp` 时，服务返回 `HTTP 401 Unauthorized` 并附带规范的认证质询头：
`WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="hermes:use"`

### 3.2 JWT 校验规则

- **签名算法**：仅允许 `RS256` 或 `ES256`；
- **公钥获取**：通过 `HERMES_MCP_JWKS_URL` 动态拉取 JWKS，缓存 10 分钟；
- **声明项核验**：严格校验 `iss === HERMES_MCP_ISSUER`、`aud` 必须匹配（等于或包含在数组中）`HERMES_MCP_PUBLIC_ORIGIN + '/mcp'`、必须具备有效期限 `exp`；若出现 `nbf` 则校验生效期；校验 `scope` 包含 `hermes:use`；无需额外自定义 claim；
- **唯一主体绑定**：`sub` 必须严格等于 `HERMES_MCP_SUBJECT`，非授权主体的合法 Token 拒绝访问（HTTP 403），严防越权读取个人 Hermes 记忆。

### 3.3 域名与网络安全

- **Host 与 Origin 校验**：服务校验 HTTP 请求的 `Host` 头必须与 `HERMES_MCP_PUBLIC_ORIGIN` 域名一致；若存在 `Origin` 头，仅允许 `chatgpt.com` 或自身公开源。
- **TLS 反向代理**：服务自身默认监听在本地回环 `127.0.0.1:8790`，对外必须前置具备合法证书的 TLS 反向代理（如 Nginx、Caddy 或安全隧道）。对外公开地址必须为标准 HTTPS。

---

## 4. MCP 状态存储、排他锁与文件生命周期

### 4.1 私有状态与产物目录规范

- **状态目录**：保存在 `HERMES_MCP_STATE_DIR` 目录下，权限必须为 `0700`，`state.json` 文件权限为 `0600`，最大体积限制为 128 MiB，最多记录 256 个任务。
- **产物隔离目录**：任务产物文件落盘保存在 `HERMES_BRIDGE_OUTPUT_DIR` 路径下以 `owner` 哈希命名的隔离子目录中，不与 OpenCode 的已有任务混淆。
- **单写者排他文件锁 (`writer.lock`)**：服务启动时获取排他锁。若进程异常退出遗留文件锁，**服务绝不自动抢占/偷锁**；必须由操作者在确认旧进程完全终止后，手动删除 `writer.lock`。
- **严禁删除 state.json**：清理锁时绝对不可删除 `state.json` 或历史请求去重记录，否则将破坏 `request_id` 幂等去重索引并丢失历史任务映射。原 OpenCode 任务账本保持独立未动。

### 4.2 文件与凭据生命周期

- **产物交付模式与生命周期**：默认模式下产物通过 MCP 原生 `resources/read` 交付，不生成 HTTP capability 下载链接。若显式设置 `HERMES_MCP_HTTP_DOWNLOADS=1` 启用兼容下载模式，服务额外签发包含 256 位高熵随机能力 Token 的下载链接（默认 10 分钟有效，`expires_at` 记录为 Unix 毫秒）；该 URL 本身为 Bearer 凭据，在有效期内持有该 URL 的客户端均可直接发起标准 HTTP GET 下载原件（无需携带 OAuth JWT）；过期后访问返回 HTTP 410 Gone，若旧元数据后续被覆盖或清除则返回 404 Not Found；已认证客户端可调用 `hermes_result` 重新签发有效链接。
- **存储规划**：服务不自动清理历史账本与产物文件；输入文件的临时签名 URL 不持久化落盘。工作区存储与账本生命周期应由操作者另行制定备份与归档策略。

---

## 5. 环境变量与启动运行

### 5.1 环境变量配置列表

| 变量名 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `HERMES_MCP_PUBLIC_ORIGIN` | 是 | - | 服务对外公开的 HTTPS 域名（例如 `https://mcp.example.com`，末尾无斜杠） |
| `HERMES_MCP_ISSUER` | 是 | - | 独立 OAuth 授权服务器 Issuer URL（例如 `https://auth.example.com`） |
| `HERMES_MCP_JWKS_URL` | 是 | - | 独立 OAuth 授权服务器 JWKS 密钥地址（例如 `https://auth.example.com/.well-known/jwks.json`） |
| `HERMES_MCP_SUBJECT` | 是 | - | 唯一允许访问的受信任用户主体标识符（JWT `sub`） |
| `HERMES_MCP_STATE_DIR` | 是 | - | 存放 `state.json` 与 `writer.lock` 的绝对私有目录（权限必须为 `0700`） |
| `HERMES_MCP_FILE_ORIGINS` | 否 | `[]` | 允许拉取输入文件的 HTTPS Origin 白名单（JSON 数组格式，为空时禁用文件输入） |
| `HERMES_MCP_HTTP_DOWNLOADS` | 否 | `0` | 是否启用基于独立 HTTP 短时链接的兼容下载模式（默认 0 禁用，仅通过 MCP 原生 resources/read 交付） |
| `HERMES_MCP_HOST` | 否 | `127.0.0.1` | 服务本地监听地址 |
| `HERMES_MCP_PORT` | 否 | `8790` | 服务本地监听端口 |
| `HERMES_BRIDGE_URL` | 否 | `http://127.0.0.1:8787` | 后端 Hermes Bridge 服务地址 |
| `HERMES_BRIDGE_TOKEN` | 是 | - | 访问 Hermes Bridge 服务的鉴权 Token |
| `HERMES_BRIDGE_OUTPUT_DIR` | 否 | `~/.local/state/opencode-hermes-bridge/outputs` | Bridge 输出根目录（MCP 在其下按 owner 创建隔离输出目录） |

### 5.2 启动与测试命令

```bash
# 启动 MCP 边缘服务
bun run mcp:start

# 执行 MCP 单元测试
bun run test:mcp

# 执行 MCP 独立类型检查
bun run typecheck:mcp
```

> **本地验证与真实宿主验收**：
> - **离线统一测试**：MCP 服务已完成当前标准资源版本的代码实现与全套离线测试（`bun run test:mcp` 17 项测试 / 478 断言全过，耗时 13.69s；`bun run typecheck:mcp` 与 `bun run typecheck` 通过；隔离打包 168 模块 `mcp.js` 0.97 MB 通过）。整合测试验证了从 OAuth JWT 签名校验、MCP Streamable HTTP 协议、Bridge 任务调度、文件插件直到 ZIP 原件哈希比对的端到端闭包。
> - **真实 OpenCode 宿主验收**：在隔离环境中通过真实 OpenCode 2.0.27 宿主二进制完成实测。宿主成功连接 MCP 服务，实际调用 `hermes_submit`（触发原生网关 POST 1 次、外部文件导入 1 次）、`hermes_status`、`hermes_result` 与重复 submit 幂等复用；随后在 Code Mode 下检索发现并调用 `tools.opencode.read_mcp_resource` 读取资源，返回的 Base64 blob 解码后 318 字节 ZIP 与源原件 SHA-256 哈希（`75e419f42626b40231569f6bbc57b05fa106815ce0e73dbe1c6587b8bc0468af`）完全一致。整个过程未生成 HTTP 能力链接，无自动本地落盘（`automaticFileSave: false`）。
> - **资源读取与清理**：服务端实际处理 `readResource` 1 次，隔离宿主与运行夹具已关闭清理，生产服务及 `dist/` 未改动。
> - **真实边界**：测试中上游 Gateway/model 与外部文件源采用本地仿真，宿主调用由脚本化 provider 驱动；真实 ChatGPT 网页端附件自动绑定与商业 OAuth 账户接入仍待实测。本轮 MCP 代码在本地验证完成，尚未在生产环境部署上线。
