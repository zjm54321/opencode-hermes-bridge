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
| (TypeScript 插件/客户端)|                    | (SQLite + Worker 调度队列) |                    | (现有公共实例 /v1/runs)  |
+-----------+-----------+                    +-------------+-------------+                    +-----------+------------+
            |                                              |                                              |
     [用户输入指令/图片]                                      |                                              |
            |                                              |                                              |
     1. hermes_ask                                         |                                              |
     2. 持久化 Outbox 快照与 scopeHash                       |                                              |
     3. 立即返回 accepted (不等网络)                         |                                              |
            |                                              |                                              |
            |--- 4. POST /v1/jobs (带 ID / 图片 Base64) --->|                                              |
            |                                              | 先写 SQLite 入库绑定 scope                    |
            |<-- 5. 202 Accepted --------------------------|                                              |
            |                                              | 单 Worker FIFO 调度                          |
            |                                              | 写 gateway_runs (至多 1 次 native POST)       |
            |                                              |--- 6. POST /v1/runs (input, session_id) ---->|
            |                                              |<-- 7. 202 Accepted (返回 run_id) ------------|
            |--- 8. 定期 GET /v1/jobs/:id 轮询 ------------->|                                              |
            |                                              |--- 9. GET /v1/runs/:run_id 轮询 ------------->|
            |                                              |<-- 10. 200 OK (status: queued/running) ------|
            |<-- 11. 200 OK (status: running) -------------|                                              |
            |                                              |--- 12. GET /v1/runs/:run_id 轮询 ------------>|
            |                                              |<-- 13. 200 OK (status: completed / output) --|
            |--- 14. GET /v1/jobs/:id 轮询 ---------------->|                                              |
            |<-- 15. 200 OK (status: completed / text) ----|                                              |
            |                                              |                                              |
    16. 校验产物并组织回复                                   |                                              |
    17. ctx.session.prompt 队列回投原会话                   |                                              |
    18. 标记 Outbox 为 delivered                           |                                              |
```

### 核心设计原则

1. **单向触发与异步回投**：仅允许 OpenCode 主动向 Companion 发起请求，Companion 向 Gateway 发起原生 Run 请求。无反向入站监听，不暴露 OpenCode 内部端口。
2. **本地快速确认（Accepted）**：调用 `hermes_ask` 时，插件先将指令及图片附件数据持久化到本地 Outbox 并记录 outbound scope 哈希，随即向用户返回接收确认，不等待 HTTP 往返耗时。
3. **原生 Gateway 复用与单次提交**：后端对接现有原生 Gateway，对话持久化由 Gateway 原生 session 机制维护（`session_id="opencode-<threadId>"`），不注入旧 bridge 私有历史。每个任务向 Gateway 的原生 POST 至多发起 1 次，丢失 202 响应时保守标记 unknown 不盲目重放。

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

插件加载后会注册以下三个工具：

### 5.1 `hermes_ask`

向 Hermes 发起指令与图片任务。

- **参数格式**：
  - `text`（必填，string）：发送给 Hermes 的指令，最大 64 KiB UTF-8。
  - `attachments`（选填，array，最大 8 项）：图片附件列表（本阶段仅支持 `image/png`、`image/jpeg`、`image/gif`、`image/webp`，普通非图片文件在提交前直接拒绝）。每个附件必须且仅能从以下三种形状选一种：
    - `{ path, mime, name? }`：从本地文件读取，路径解析后必须落在 `uploadRoots` 白名单内且禁止符号链接。`path` 与 `mime` 必填，`name` 选填（缺省时自动取 `basename(path)`）。
    - `{ data, name, mime? }`：标准 Base64 Data URI（如 `data:image/png;base64,...`）。`data` 与 `name` 必填，`mime` 选填（缺省时从 Data URI 解析提取，若提供则必须与 Data URI 中的 MIME 一致）。
    - `{ base64, name, mime }`：标准规范 Base64 字节串。`base64`、`name` 与 `mime` 均必填。
- **执行行为**：
  - 校验图片 MIME 格式与配额并做本地快照；
  - 写入本地 Outbox 并记录 `postAttempted: false` 与当前 outbound scope 哈希；
  - **立即返回本地接收确认文本**，附带 Job UUID 与 Thread UUID；
  - 后台异步提交至 Companion 并启动状态轮询。

### 5.2 `hermes_status`

查询当前 OpenCode 会话中关联的 Hermes 任务状态。

- **参数格式**：
  - `id`（选填，string）：指定查询的任务 UUID；若不提供则列出当前会话下的所有任务。
- **执行行为**：仅读取本地 Outbox 快照数据，不发起外部 HTTP 请求，不跨会话读取。

### 5.3 `hermes_resume`

恢复当前会话中处于暂停（`paused`）或失败（`failed`）状态的任务。

- **参数格式**：
  - `id`（必填，string）：目标任务 UUID。
- **执行行为**：
  - 沿用原持久化 UUID 与快照，仅通过 GET 轮询原任务状态；
  - **绝不**重新提交 POST 模型请求，即便此前因网络中断导致结果状态未知；
  - 缺少 scope 绑定或检测到当前 URL/Token 配置发生变化的旧任务将被保持暂停（blocked），不发起任何 HTTP 请求。

---

## 6. 文件安全、配额与模型格式处理

### 6.1 传输安全配额与网关报文硬上限

- **Bridge 外部传输配额**：
  - 单任务附件总数：最多 8 个（仅限 PNG/JPEG/GIF/WebP 图片，普通文件直接拦截）。
  - 单附件体积上限：解码后最大 10 MiB。
  - 附件总体积上限：解码后最大 20 MiB。
  - 指令文本上限：最大 64 KiB UTF-8。
  - HTTP 传输报文上限：最大 32 MiB。超出配额请求将返回 HTTP 413；普通非图片文件在客户端前置拒绝，服务端校验遇非法格式返回 HTTP 415。
- **原生 Gateway 载荷上限（关键约束）**：
  - Companion 发往 Gateway 的规范 native JSON 报文（含 Base64 编码图片与 session_id 封装）受到 `MAX_NATIVE_BODY = 10,000,000 字节` 的硬性约束；
  - 由于 Base64 存在约 33% 的体积膨胀与 JSON 字段开销，实际允许传输的物理图片总容量显著小于外层 10 MiB / 20 MiB 配额；
  - 若序列化后的原生报文超出 10,000,000 字节，即使任务已通过外层校验获得 202 入库，在提交原生网关前也将转为 `failed`（错误码 `payload_too_large`）。

### 6.2 本地文件读取安全限制（Linux `/proc/self/fd`）

在读取 `uploadRoots` 内的文件时，客户端先解析绝对路径并逐级校验禁止符号链接；在打开文件描述符后，通过 `/proc/self/fd/<fd>` 获取真实路径并做设备号/Inode 校验，严防并发符号链接替换（TOCTOU）与路径越界。

### 6.3 多媒体回传与模型上下文分流

- **输入流转**：图片附件经 Base64 转换为标准 `image_url` Data URI，作为 `input` 内容提交至 Gateway 原生接口。
- **输出限制**：原生 Gateway `/v1/runs` 当前暂无输出附件传输契约；若模型输出文本中出现 `MEDIA:...` 格式输出行，Companion 轮询时返回任务 `status: "failed"` 且错误码为 `unsupported_output`（GET 接口本身恒返回 HTTP 200）。Companion 不读取原生 Gateway 内部文件系统，系统不假装已具备普通文件理解或模型自主输出附件能力。

---

## 7. 任务生命周期、幂等与故障语义

- **客户端写前持久化与 At-most-once POST**：
  - 插件在发起 HTTP POST 前必须先持久化 `postAttempted: true` 及当前 `scopeHash`（`sha256([url, sha256(token)])`）；
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
- **限制边界与清理完成状态**：
  - 仅支持文字及 PNG/JPEG/GIF/WebP 图片；当前插件配置未设置 `uploadRoots`，本地 path 图片调用在入队前直接被拦截，本次图片实测走既有内嵌 base64 分支（内嵌图片无需目录白名单；本地路径上传方式未做验证）；普通非图片文件在当前阶段仍不受支持；
  - 仅验证了原 Gateway 链路与配置保持；追加既有资料询问获得有效回应，未逐条核验全部记忆或证明所有 Honcho peer 完全一致（不计入验收 fixtures，文档不包含个人具体资料）；
  - 原会话后台消息回传已验证（收到真实文本与图片通知，delivered 置为 true）；真实前端页面呈现、权限确认弹窗及模型自主工具调用未做专门 UI 测试；
  - **清理与收尾完成（C1/C2）**：旧独立 Deployment 已删除（旧 Pod 为 0），旧 home 与 hermes-profile 孤立目录已清理完毕（移除 556 文件与 27 目录），jobs/DB 完整保留，原 hermes-agent Pod、Deployment 与 Services 均保持不变，未访问原 /opt/data；GitOps 已完成废弃模型凭据字段（`HERMES_BRIDGE_MODEL_API_KEY`）清理（commit `a93555a`），生产 Secret 仅保留有效的 Bridge 与 Gateway 双令牌，验证与鉴权探测全数通过。阶段验收结论以正式文档为准。
