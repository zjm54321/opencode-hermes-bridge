<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# OpenCode Hermes Bridge

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

OpenCode Hermes Bridge 为 OpenCode V2 宿主与原生 [Hermes Gateway](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/gateway/platforms/api_server_runs.py)（`/v1/runs`）提供基于 HTTP 轮询与真实图片传输的桥接通道。

本项目致力于将 OpenCode 任务统一接入网页与微信等入口共用的既有 Hermes Gateway 服务，消除重复的独立 AIAgent 实例与 profile 分裂，促成同一用户身份与记忆上下文共享。本阶段输入支持文本与图片（`image/png`、`image/jpeg`、`image/gif`、`image/webp`），普通非图片文件在提交前直接拦截；原生 Gateway 暂无输出附件传输契约，若模型输出包含 `MEDIA:` 则作为 `unsupported_output` 拦截，不假装已有普通文件理解或输出附件能力。

- 开源协议：GPL-3.0-or-later
- 代码仓库：[https://github.com/zjm54321/opencode-hermes-bridge](https://github.com/zjm54321/opencode-hermes-bridge)

---

## 1. 架构与交互时序

```text
+-----------------------+                    +---------------------------+                    +------------------------+
|    OpenCode V2 宿主    |                    | Hermes Companion (Python) |                    | 原生 Hermes Gateway    |
| (TypeScript 插件/客户端)|                    | (SQLite + 资产层 + 调度队列)|                    | (现有公共实例 /v1/runs)  |
+-----------+-----------+                    +-------------+-------------+                    +-----------+------------+
            |                                              |                                              |
     [用户输入指令/文件]                                      |                                              |
            |                                              |                                              |
     1. hermes_ask (带 waitSeconds，默认 30s)               |                                              |
     2. 校验配额，持久化 Outbox 与 scopeHash                 |                                              |
     3. 若有输入文件，PUT /v1/jobs/{job}/assets/{asset} ---->| (校验 SHA-256 / 写入资产库)                  |
     4. POST /v1/jobs (提交任务与 input_assets) ----------->|                                              |
            |                                              |--- 5. POST /v1/runs 提交原生任务 ------------>|
            |                                              |<-- 6. 202 Accepted (返回 run_id) ------------|
            |--- 7. 轮询 GET /v1/jobs/:id ------------------>|                                              |
            |                                              |--- 8. GET /v1/runs/:run_id 轮询 ------------->|
            |                                              |<-- 9. 200 OK (status: completed) ------------|
            |<-- 10. 200 OK (JobResponse 含 output_assets) -|                                              |
            |                                              |                                              |
    11. 客户端下载 output_assets 并校验 SHA-256             |                                              |
    12. 原子落盘 outputDir/<jobId>/<assetId>/<name>        |                                              |
    13. 向宿主返回标准 Tool.Result (超期返回状态+Job ID)    |                                              |
```

### 核心设计原则

1. **单向驱动与原生工具返回**：仅允许 OpenCode 插件主动向 Companion 发起请求，彻底废除向聊天界面注入伪提示的做法（移除 `ctx.session.prompt`），执行完成直接向宿主返回标准的 `Tool.Result`。
2. **多模式等待与显式取回（`waitSeconds`）**：调用 `hermes_ask` 时默认等待 30 秒（可在 0..120 秒间调整；0 秒立即返回）。在等待期限内完成的任务直接返回最终工具结果；长任务返回当前状态与 Job ID，后续通过 `hermes_result` 显式取回，不会在后台自动开启新一轮推理。
3. **原生 Gateway 复用与单次提交**：后端对接现有原生 Gateway，对话上下文由 Gateway 原生 session 机制维护（`session_id="opencode-<threadId>"`），不注入旧 bridge 私有历史。每个任务向 Gateway 的原生 POST 至多发起 1 次，丢失 202 响应时保守标记 unknown 不盲目重放。

---

## 2. 运行环境与安装构建

项目基于 Nix Flake 声明基础运行环境（Node.js 24 / Bun 1.4 / Python 3.14 stdlib）。

### 2.1 依赖安装与构建（TypeScript 插件）

在项目根目录下执行：

```bash
# 1. 锁定依赖安装
nix develop --command bun install --frozen-lockfile

# 2. 类型检查
nix develop --command bun run typecheck

# 3. 产物构建 (编译至 dist/)
nix develop --command bun run build

# 4. 执行单元测试与集成测试
nix develop --command bun run test
nix develop --command bun run test:integration
```

### 2.2 Python Companion 运行环境约定

- **标准库无第三方推理依赖**：Companion 服务端与调度核心仅使用 Python 3.11+ 标准库（`http.client`、`sqlite3`、`fcntl` 等），不导入 Hermes Agent 推理包，亦不读取本地 profile。
- **网关连接配置**：通过环境变量 `HERMES_GATEWAY_URL`（Gateway 基础 URL，不含 `/v1/runs`）与 `HERMES_GATEWAY_TOKEN` 与 Gateway 建立连接，与 OpenCode 客户端使用的 `HERMES_BRIDGE_URL` / `HERMES_BRIDGE_TOKEN` 完全分离。
- **配置隔离与网络环境**：无需拷贝 Gateway 的完整 profile 或 HOME 目录；在受信局域网（LAN）中可直接使用标准 HTTP 通信，不可信网络中建议前置 TLS 反向代理。

---

## 3. 快速启动与服务端配置

### 3.1 启动 Companion 服务

```bash
# 设置项目仓库路径
export BRIDGE_REPO="/absolute/path/to/opencode-hermes-bridge"

# 设置 Hermes Gateway 基础地址与 API Server Token（来自 Gateway 环境的 API_SERVER_KEY）
export HERMES_GATEWAY_URL="http://127.0.0.1:8642"
export HERMES_GATEWAY_TOKEN="your-gateway-api-server-token"

# 设置 OpenCode 客户端访问 Companion 所需的 Bridge Token
export HERMES_BRIDGE_TOKEN="your-secure-bridge-token-without-spaces"

# 启动服务
PYTHONPATH="$BRIDGE_REPO/companion${PYTHONPATH:+:$PYTHONPATH}" \
  python3 -m hermes_bridge \
  --host 127.0.0.1 \
  --port 8787 \
  --workspace "$HOME/.local/share/opencode-hermes-bridge"
```

> **架构演进说明**：
> - 早期版本中通过 `--model` / `HERMES_MODEL` 及 `HERMES_BRIDGE_PROVIDER` 在进程内加载 `AIAgent` 的独立执行模式已作为**旧架构**废弃；当前代码实现（`GatewayRunner`）直接转发原生 Gateway，不再接收 `--model` 参数或显式模型路由环境变量组（注意生产环境尚未部署新代码，不可视为生产已生效）。
> - `hermes_bridge.runner.HermesRunner` 仅作为导入兼容别名保留，实际行为与 `GatewayRunner` 一致。

#### Companion CLI 选项列表

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--host` | `127.0.0.1` | 监听地址。默认仅绑定本地回环。远程 HTTP 需要受信网络访问控制（如局域网源地址限制、禁止暴露公网）；不可信网络建议前置 TLS 反向代理或加密隧道。 |
| `--port` | `8787` | 监听端口。 |
| `--workspace` | `~/.local/share/opencode-hermes-bridge` | 工作区目录，包含 SQLite 数据库及任务锁文件。自动设为 `0700` 私有权限。 |
| `--request-timeout` | `10.0` | 客户端访问 Companion 的单次 HTTP 请求处理超时秒数（Companion 发往 Gateway 原生接口的单次请求超时固定为 5 秒，轮询间隔 1 秒，最大退避 10 秒）。 |
| `--asset-ttl` | `86400` | 文件资产在服务端的保留时长秒数（默认 24 小时）。过期资产访问返回 HTTP 410；服务在启动及显式调用 `expire` 时回收磁盘字节并保留 tombstone 记录；服务未运行常驻后台定时 GC 守护线程。 |

### 3.2 容器化部署专用入口（hermes_bridge.init）

在容器或 Kubernetes Pod 中部署 Companion 时，可使用轻量级 PID 1 专用入口：

```bash
# 容器 Entrypoint 示例（仅限容器内作为真实 PID 1 运行）
python -m hermes_bridge.init \
  --host 0.0.0.0 \
  --port 8787 \
  --workspace "/data/workspace"
```

> **运行约束与部署建议说明**：
> - **仅限容器 PID 1**：`hermes_bridge.init` 在启动时校验 `os.getpid() == 1`，非 PID 1 运行将直接拒绝退出。普通本地运行与开发调试仍请使用 `python -m hermes_bridge`。
> - **优雅终止与阶梯超时**：首次收到 `SIGTERM` 或 `SIGINT` 时向主子进程发送 `SIGINT` 触发优雅关闭，后续按 20s/25s/27s 阶梯超时推进；主进程提前退出则在最多 7 秒内完成孤儿进程清理退出。
> - **网关协同部署（Sidecar 方案）**：在 Kubernetes 环境中，Companion 作为薄 Sidecar 编排在既有 Hermes Gateway Pod 内，通过 `127.0.0.1:8642` 环回访问 Gateway API，避免将 Gateway 管理端口对外暴露（生产已通过 GitOps commit `2d639d1` 部署上线，直连 `127.0.0.1:8642/v1/runs`，未新建独立 AI Agent 或 profile，保留原 `/opt/data` 及配置，未迁移或替换资料）。

---

## 4. OpenCode V2 插件注册与配置

插件使用 `@opencode/plugin 2.0.24` SDK。在 OpenCode 配置文件中通过 `plugins` 数组显式加载：

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-hermes-bridge/dist",
      "options": {
        "url": "http://127.0.0.1:8787",
        "tokenEnv": "HERMES_BRIDGE_TOKEN",
        "uploadRoots": [
          "/home/user/workspace/project"
        ]
      }
    }
  ]
}
```

> **重要路径说明**：
> 在 OpenCode 2.0.24+de2cacd 真实宿主实测中，本地目录形式的插件加载器会探测目录内的 `index.js` 或 `server.js`。因此，`package` **必须直接指向构建产物目录 `dist`**（如 `/absolute/path/to/opencode-hermes-bridge/dist`），指向仓库根目录或具体的单个 `.js` 文件均不会被宿主正确加载。
> 严禁在 `options` 中直接填写 `token` 字段（配置解析器会直接抛错阻断），Token 必须通过环境变量注入。

### 插件配置项（`src/config.ts`）

所有配置项均遵循**插件 `options` 字段优先于环境变量**的原则。`src/config.ts` 允许相对路径并相对于 `ctx.location.directory`（当前工作区）进行解析，但推荐配置绝对路径以避免多工作区切换产生歧义。

| 配置项 | 对应环境变量 | 默认值 | 说明与约束 |
| :--- | :--- | :--- | :--- |
| `url` | `HERMES_BRIDGE_URL` | `http://127.0.0.1:8787` | 仅允许 HTTP(S) Origin，禁止包含用户名、密码、查询串、Hash 或子路径。 |
| `tokenEnv` | - | `HERMES_BRIDGE_TOKEN` | 承载 Bearer Token 的环境变量名称（必须为合法标识符）。 |
| `uploadRoots` | `HERMES_BRIDGE_UPLOAD_ROOTS` | `[]`（空列表） | 允许以 `path` 形式读取本地文件的路径白名单。环境变量须为合法 JSON 数组（如 `export HERMES_BRIDGE_UPLOAD_ROOTS='["/absolute/project"]'`）。**空列表禁用 `path` 方式读取，`base64` 与 `data` 形式不受白名单限制**。当前生产默认未设置 `uploadRoots`，本地 path 图片在入队前直接被拦截。 |
| `outputDir` | `HERMES_BRIDGE_OUTPUT_DIR` | 优先读取 `$XDG_STATE_HOME/opencode-hermes-bridge/outputs`，缺省为 `~/.local/state/opencode-hermes-bridge/outputs` | Companion 产物接收后的本地安全保存目录（设为 `0700` 私有权限）。 |

> **关键运维提示**：
> `HERMES_BRIDGE_TOKEN` **必须注入到 OpenCode 后台服务环境**中。仅为 Companion 单独设置 export 不会自动同步至已启动的 OpenCode 宿主进程。需要特别注意：**插件配置可热重载，但后台进程环境变量更新需要重启后台服务**（已运行 daemon 不会自动更新 `process.env`，仅重启 TUI 亦不足以生效；需通过 `opencode service restart` 等方式重启后台服务以使环境生效）。OpenCode 宿主仅需读取 Bridge 端的 URL 与 Bearer Token；Hermes Gateway 相关的环境变量（`HERMES_GATEWAY_URL` 与 `HERMES_GATEWAY_TOKEN`）仅属于 Companion 进程环境，无需也不应注入 OpenCode 宿主。

---

## 5. 插件提供的工具（Tools）

插件加载后会注册以下四个工具，执行结果均直接返回宿主标准 `Tool.Result`，不向聊天流注入伪提示（详细教程与代码示例详见 [docs/FILE_TRANSFER.md](docs/FILE_TRANSFER.md)）：

### 5.1 `hermes_ask`

向 Hermes 发起指令、原生图片及普通文件任务。

- **参数格式**：
  - `text`（必填，string）：发送给 Hermes 的指令，最大 64 KiB UTF-8。
  - `attachments`（选填，array，最大 8 项）：原生内嵌图片列表（仅支持 PNG/JPEG/GIF/WebP）。
  - `files`（选填，array，最大 8 项）：普通文件列表（支持 PDF、ZIP、XLSX、DOCX 等所有二进制格式）。每个文件可采用 `{ path, mime, name? }`、`{ data, name, mime? }` 或 `{ base64, name, mime }`。以 `path` 形式提交时必须落在 `uploadRoots` 白名单内。
  - `requireFiles`（选填，boolean）：要求启用文件支持（例如期望 Hermes 生成产物输出文件而无需输入文件时）。若 Bridge 服务未开启文件能力，直接在提交前拦截报错，不静默降级。
  - `waitSeconds`（选填，number，0..120，默认 30）：客户端等待秒数。0 秒立即返回非终态确认信息。
- **执行行为**：
  - 自动完成输入文件资产上传与任务登记；
  - 等待期内若任务完成，直接返回正式 `Tool.Result`；若超时则返回当前状态及 Job ID 供后续取回。

### 5.2 `hermes_result`

显式取回当前会话中已持久化的任务结果。

- **参数格式**：
  - `id`（必填，string）：目标任务 UUID。
  - `waitSeconds`（选填，number，0..120，默认 0）：等待秒数。
- **执行行为**：
  - 若任务仍在排队或运行，返回明确的当前状态；
  - 若任务已完成，自动下载输出文件资产至本地私有目录并返回标准 `Tool.Result`；绝不向远端重复发起 POST。

### 5.3 `hermes_status`

查询当前 OpenCode 会话中关联的 Hermes 任务本地 Outbox 状态。

- **参数格式**：
  - `id`（选填，string）：指定查询的任务 UUID；若不提供则列出当前会话下的所有任务。
- **执行行为**：仅读取本地 Outbox 快照数据，不发起外部 HTTP 请求，不跨会话读取。

### 5.4 `hermes_resume`

恢复当前会话中处于暂停（`paused`）或失败（`failed`）状态的任务。

- **参数格式**：
  - `id`（必填，string）：目标任务 UUID。
- **执行行为**：
  - 沿用原持久化 UUID 与快照，仅通过 GET 轮询原任务状态，绝不重新提交 POST 模型请求；
  - 缺少 scope 绑定或检测到当前 URL/Token 配置发生变化的旧任务将被保持暂停（blocked），不发起任何 HTTP 请求。

---

## 6. 文件安全、配额与模型格式处理

双向原文件流转详尽技术契约与配置说明请参考专门教程 [docs/FILE_TRANSFER.md](docs/FILE_TRANSFER.md)。

### 6.1 传输安全配额与网关报文硬上限

- **Bridge 外部传输配额**：
  - 单任务原生图片 (`attachments`)：最多 8 个（仅限 PNG/JPEG/GIF/WebP 图片）。
  - 单任务文件资产 (`files` / `assets`)：最多 8 个（包含输入与输出）。
  - 单文件资产体积上限：最大 10 MiB（10,485,760 字节）。
  - 任务资产总体积上限：每方向最大 20 MiB（20,971,520 字节）。
  - 指令文本上限：最大 64 KiB UTF-8。
  - HTTP 任务报文上限：最大 32 MiB。超出配额请求将返回 HTTP 413。
- **原生 Gateway 载荷上限（关键约束）**：
  - Companion 发往 Gateway 的规范 native JSON 报文（含 Base64 编码图片与 session_id 封装）受到 `MAX_NATIVE_BODY = 10,000,000 字节` 的硬性约束；
  - 普通文件通过受控资产层流转，不进入原生 Gateway JSON 报文；若图片或文本原生报文超出 10,000,000 字节，在提交原生网关前将被置为 `failed`（错误码 `payload_too_large`）。

### 6.2 本地文件读取安全限制（Linux `/proc/self/fd`）

在读取 `uploadRoots` 内的文件时，客户端先解析绝对路径并逐级校验禁止符号链接；在打开文件描述符后，通过 `/proc/self/fd/<fd>` 获取真实路径并做设备号/Inode 校验，严防并发符号链接替换（TOCTOU）与路径越界。默认 `uploadRoots: []` 禁用本地路径读取。

### 6.3 多媒体回传与模型上下文分流

- **输入流转**：原生图片转换为 `image_url` Data URI 送入 Gateway；普通文件上传至 Companion 资产库后，由 Hermes 插件 `hermes_file_plugin` 在当前 Run 私有工作区内读取原件。
- **输出与交付**：Hermes 生成的常规产物通过 `bridge_publish_file` 登记发布；客户端下载落盘至本地私有目录（`outputDir/<jobId>/<assetId>/<name>`，0600 文件 / 0700 目录）。图片与纯文本由插件转换为 `Tool.FileContent` 供模型理解，ZIP、PDF、XLSX 等复合二进制文件仅在工具结果中回显本地绝对路径、文件大小与 SHA-256 哈希，绝不将二进制原始内容拼装进模型上下文。系统不假装模型能直接理解任意未知二进制。

---

## 7. 任务生命周期、幂等与故障语义

- **客户端写前持久化与 At-most-once POST**：
  - 插件在发起 HTTP POST 前必须先持久化 `postAttempted: true` 及当前 `scopeHash`（`sha256([url, sha256(token)])`）；
  - 任务内容 SHA-256 指纹在包含 `input_assets` 时自动将其纳入计算；
  - 输入资产允许在任务提交前上传；一旦 `POST /v1/jobs` 提交成功，输入资产名单即被密封冻结，后续仅允许对已密封的资产 ID 按相同字节与哈希原样幂等重传（PUT），不允许追加新资产；文件 PUT 幂等不等于模型 POST 可重放（模型 POST 严格至多 1 次）；
  - 若在收到 202 前网络中断，后续轮询仅以 GET 查询原任务，绝不重放 POST；
  - 若 Companion 返回 404，任务自动转入 `paused` 并提示结果未知；后续调用 `hermes_resume` 仅以 GET 查询原记录，不会重新发起 POST 请求；
  - 缺少 scopeHash 或目标配置变动的任务保持暂停，禁止发起网络连接。
- **Companion 网关任务状态机与 gateway_runs**：
  - 入队任务严格绑定 `gateway_scope`，在唯一 SQLite 中通过 `gateway_runs` 表持久化标准请求体、session_id、发起时间戳及原生 run_id；
  - 对 Gateway 的原生 POST 每任务**至多执行 1 次**；若 POST 遭遇断连或未获得合法 202 响应，状态保守置为 `failed`（错误码 `gateway_outcome_unknown`，客户端轮询恒返回 HTTP 200）并不自动重试（不承诺严格 exactly-once）；
  - 已获取有效 `run_id` 的任务遇暂时性 GET 故障（429、5xx、临时网络波动）保持 `running` 状态并执行指数退避重试（上限默认 10 秒）；
  - 服务调用 `stop()` 时仅中断本地等待线程，不向 Gateway 发送 `stop` 请求，不取消远端任务；
  - 服务重启时：已具备 `run_id` 的任务继续通过 GET 轮询恢复；尚未登记发送意图且 scope 相符的新 `queued` 任务仍可正常执行首次 POST；仅当已在 `gateway_runs` 登记发送意图但缺失 `run_id`（或 scope 不符/缺失）时，才保守置为 `failed`（错误码 `gateway_outcome_unknown`）；
  - 协议异常（重复 JSON 键、格式错误）或无效响应均置为未知；原生返回 404 时标记未知；
  - 输出若在无已登记资产时出现 `MEDIA:...` 文本行，仍置为 `unsupported_output` 失败；在已有密封登记的输出资产时，回复文本严格仅作文本处理，绝不解析文本内的 `MEDIA:` 路径；
  - 旧架构遗留任务（属于旧版 backend_version 的未决任务）在启动时更新为 `failed`（错误码 `backend_changed`）；若属于当前版本但缺少有效 scope 绑定，则标记为 `gateway_outcome_unknown`；历史数据均保留但不予执行。

---

## 8. 安全与沙箱责任边界声明

1. **Companion 并非执行沙箱**：Companion 作为协议转换与状态管理中间层，**不构成 Hermes Agent 的系统权限沙箱**。Hermes 运行时依然拥有宿主所赋予的环境与工具权限。
2. **两类凭据独立管理**：用于 OpenCode 访问 Companion 的 `HERMES_BRIDGE_TOKEN`，与 Companion 访问 Gateway 的 `HERMES_GATEWAY_TOKEN`（API_SERVER_KEY）属于不同安全域，完全分离配置。
3. **身份隔离与既有记忆一致性边界**：既有 Hermes Gateway 采用 Honcho 记忆提供商。长远跨入口目标是**共用同一既有身份与记忆上下文**，而非在不同用户间自动合并记忆。依据公开源码规则，Web PTY 使用 internal credentials，常规会话依赖 `peerName`，而微信通常基于 `senderID`；若无明确别名或绑定映射，不同入口可能被识别为独立用户。部署时必须通过有效身份 Gate 进行核验，严禁擅自合并其他用户的身份数据。
4. **网络暴露与访问控制**：服务支持在受信任局域网（LAN）内使用 HTTP 访问；若需跨不可信网络或公网传输，强烈建议前置 TLS 反向代理或加密隧道。严禁将管理端口直接暴露于公网。

---

## 9. 验证现状简述

项目已完成当前 Gateway 桥接方案的源码构建、离线测试、生产 Sidecar 部署及真实插件端到端模型实测；此前旧版独立架构的测试证据已作为历史基准完整归档（完整证据与分层矩阵详见 [docs/VERIFICATION.md](docs/VERIFICATION.md)）：
- **当前源码与离线自动化测试**：源码 commit `8a4e47cf1f15233988053ce7bdbe6cd29576354e`，实际 `dist/` 构建一致；TypeScript 27 项测试全数通过（330 断言，含 3 场景 HTTP 集成测试）；Python 29 项测试全数通过（耗时 8.430s 无 skip，`test_gateway.py` 严格覆盖 Gateway API 契约、202 断连、已知 run_id 恢复、旧队列隔离、暂时故障退避及快速 stop）；TypeScript 类型检查与 `git diff --check` 通过。HTTP 集成测试中 `EchoRunner` 回显 inline images 仅为测试夹具，不代表原生 Gateway 输出附件能力。
- **生产 Sidecar 部署与只读验收（GitOps B）**：通过 GitOps commit `2d639d199bac5eb011efa5ac41cd705c08346c2f` 上线，桥接作为原 `hermes-agent` Pod 的薄 Sidecar 运行，直连本地 `127.0.0.1:8642/v1/runs`；未新建独立 AI Agent 或 profile，保留原 `/opt/data` 及配置，未迁移或替换资料；Flux、网络安全及只读鉴权验收 PASS（非双 LAN 来源实包验证）。
- **真实插件端到端模型实测（PASS）**：真实 OpenCode 插件向部署上线的桥接服务发起实际调用并成功完成：
  - 纯文本任务：成功返回预期标记 `HERMES_GATEWAY_OK`；
  - 图片任务：32×32 纯蓝 PNG（99 字节，以内嵌 Base64 形式提交）成功经 Gateway 识别并回复包含“蓝色”；
  - 两个任务在 Bridge SQLite DB 中均对应原 Gateway 的原生 `run_<32hex>`，会话同属 `opencode-<threadUUID>`，原生 GET 200 确认 `completed=true, partial=false, interrupted=false`，输出完全匹配；
  - 初始鉴权注意：初次请求曾因客户端进程使用的令牌与配置不一致出现 401，用户手动重启后环境变量与配置对齐并成功执行，启动代码未做修改；旧 401 任务未重放，采用用户批准的新任务 UUID 成功验收。
- **历史架构验证归属（旧架构保留证据）**：此前 2026-10-10/10-11 的 TypeScript 21 项 / 145 断言、Python 37 项单测、同镜像真实容器 PID 1 验收、GitOps commit `6a3d295` 独立部署验收及 `z-ai/glm-5.3-flash` 显式路由实测属于旧版独立进程内 AIAgent 架构，保留作为历史证据归属，不计入当前 Gateway 方案计数。旧版历史测试曾包含简单工具回传验证；当前 Gateway 链路仍未专门进行自主工具选择与前端 UI 交互验证。
- **新版本源码实现与本地离线验证（未部署）**：新版本已在源码层完成正式 `Tool.Result` 结果重构、移除聊天流伪输入，并建立双向文件资产流转契约（四工具：`hermes_ask`、`hermes_result`、`hermes_status`、`hermes_resume` 及配套 Hermes 插件 `hermes_file_plugin`）。本地离线完整验证通过（TypeScript 31 项单元测试 / 414 断言、5 场景本地集成测试 / 180 断言；Python 43 项测试 / 26.955s，含插件 11 项、资产层 3 项；类型检查与隔离构建均通过）；当前生产环境仍运行此前已验收的 Sidecar 基线，新客户端与文件功能尚未部署上线。
- **限制边界与清理完成状态**：
  - 既有生产调用仅支持文字及 PNG/JPEG/GIF/WebP 图片；当前生产插件配置未设置 `uploadRoots`，本地 path 图片调用在入队前直接被拦截，此前图片实测走既有内嵌 base64 分支（内嵌图片无需目录白名单；本地路径上传方式未做验证）；普通非图片文件的端到端流转待新版本部署；
  - 仅验证了原 Gateway 链路与配置保持；追加既有资料询问获得有效回应，未逐条核验全部记忆或证明所有 Honcho peer 完全一致（不计入验收 fixtures，文档不包含个人具体资料）；
  - 原会话后台消息回传已验证（收到真实文本与图片通知，delivered 置为 true）；真实前端页面呈现、权限确认弹窗及模型自主工具调用未做专门 UI 测试；
  - **清理与收尾完成（C1/C2）**：旧独立 Deployment 已删除（旧 Pod 为 0），旧 home 与 hermes-profile 孤立目录已清理完毕（移除 556 文件与 27 目录），jobs/DB 完整保留，原 hermes-agent Pod、Deployment 与 Services 均保持不变，未访问原 /opt/data；GitOps 已完成废弃模型凭据字段（`HERMES_BRIDGE_MODEL_API_KEY`）清理（commit `a93555a`），生产 Secret 仅保留有效的 Bridge 与 Gateway 双令牌，验证与鉴权探测全数通过。阶段验收结论以正式文档为准。

---

## 10. ChatGPT Remote MCP 服务（本地实现与宿主验证完成，未部署）

项目在 `mcp/` 目录提供了面向 ChatGPT 网页端（Business / Enterprise）的标准 Streamable HTTP `/mcp` 服务（启动脚本 `bun run mcp:start`），基于官方 MCP SDK 构建，支持 `hermes_submit`、`hermes_status`、`hermes_result` 三项工具与原生 Resources 原字节文件交付。本轮已完成本地全套离线验证（`bun run test:mcp` 20 项测试 / 667 断言及 MCP 类型检查全部通过），并在真实隔离 OpenCode 2.0.27 宿主中（OAuth 基线）实际调用 MCP 三工具与 Code Mode `read_mcp_resource` 验证了 318 字节 ZIP 原件完整闭环（哈希一致，向仿真原生网关 POST 1 次，无自动落盘）。针对私有隧道的离线部署模板（`deploy/private-tunnel/`）已完成结构与静态检查。

针对接入网络与认证方式，项目支持两种模式：
- **公网 OAuth 模式**：通过外部标准 OAuth 授权服务器与公网 HTTPS 反向代理保护，详见 [docs/CHATGPT_MCP.md](docs/CHATGPT_MCP.md)；
- **官方私有隧道模式（推荐个人免 IdP 使用）**：通过 OpenAI 官方 Secure MCP Tunnel（`openai/tunnel-client`）建立私有出站直连（选 Tunnel + No authentication），无需外部 IdP 或开放公网端口，详见 [docs/PRIVATE_TUNNEL.md](docs/PRIVATE_TUNNEL.md)。

> **说明**：该服务目前已完成源码实现与真实宿主离线闭环，尚未在真实 ChatGPT 账户或生产环境连接部署；实际接入使用需工作区管理权限及对应凭据准备。
