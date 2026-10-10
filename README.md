<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# OpenCode Hermes Bridge

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

OpenCode Hermes Bridge 为 OpenCode V2 宿主与本地 [Hermes Agent](https://github.com/NousResearch/Hermes-Agent) 提供基于 HTTP 轮询与真实字节流传输的单向桥接通道。

本项目**不是标准 A2A（Agent-to-Agent）协议实现**。由于上游 Hermes 默认的 A2A 协议对附件通常只提取纯文本描述而丢弃原始二进制字节，本项目通过伴随 Python 服务（Companion）与 OpenCode V2 插件协同，实现真实文件字节（PNG/JPEG/GIF/WebP、PDF、ZIP 等）的双向流转与会话异步回投。

- 开源协议：GPL-3.0-or-later
- 代码仓库：[https://github.com/zjm54321/opencode-hermes-bridge](https://github.com/zjm54321/opencode-hermes-bridge)

---

## 1. 架构与交互时序

```text
+-----------------------+                    +---------------------------+
|    OpenCode V2 宿主    |                    | Hermes Companion (Python) |
| (TypeScript 插件/客户端)|                    | (SQLite + Worker 线程调度) |
+-----------+-----------+                    +-------------+-------------+
            |                                              |
     [用户输入指令/文件]                                      |
            |                                              |
     1. hermes_ask                                         |
     2. 本地持久化 Outbox 快照                               |
     3. 立即返回 accepted (不等网络)                         |
            |                                              |
            |--- 4. POST /v1/jobs (带 ID / 附件 Base64) --->|
            |                                              | 先写 SQLite 入库
            |<-- 5. 202 Accepted --------------------------|
            |                                              | 单 Worker FIFO 调度
            |                                              | 调用 Hermes Runner
            |--- 6. 定期 GET /v1/jobs/:id 轮询 ------------->|
            |<-- 7. 200 OK (status: queued/running) -------|
            |                                              | 执行完成，固化文件
            |--- 8. GET /v1/jobs/:id 轮询 ------------------>|
            |<-- 9. 200 OK (status: completed / 附件) ------|
            |                                              |
    10. 附件落盘 (仅图片/文本转模型上下文，                  |
        PDF/ZIP 等二进制仅保存并回显路径)                  |
    11. ctx.session.prompt 队列回投原会话                   |
    12. 标记 Outbox 为 delivered                           |
```

### 核心设计原则

1. **单向触发与异步回投**：仅允许 OpenCode 主动向 Hermes 发起请求。OpenCode 插件无反向入站监听，Hermes 不能主动连接 OpenCode；Companion 仅提供本地 HTTP 入站服务被动接收请求。
2. **本地快速确认（Accepted）**：调用 `hermes_ask` 时，插件先将指令及完整附件数据持久化到本地 Outbox，随即向用户返回接收确认，不等待 HTTP 往返耗时。
3. **真实字节保真**：输入输出均通过规范 Base64 编码在 HTTP 上传输，并在隔离工作目录内以物理文件形式落地；集成测试用 SHA-256 比对往返字节以验证保真。

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

# 4. 执行单元测试
nix develop --command bun run test

# 5. 执行跨语言集成测试
nix develop --command bun run test:integration
```

### 2.2 Python Companion 运行环境约定

- **外部依赖要求**：Companion 的服务端与调度核心仅使用 Python 3.11+ 标准库（`http.server`、`sqlite3`、`fcntl` 等），**本项目不安装也不打包 Hermes 及其大模型推理依赖**。
- **虚拟环境启动**：必须在已完整安装 Hermes Agent 依赖的外部 Python 虚拟环境（venv）中启动 Companion。
- **环境隔离要求**：必须在进程启动前设置 `HERMES_HOME` 环境变量，以便 Hermes 内部加载对应 profile 的 `.env`；Companion 不复刻 Hermes CLI 动态 provider 路由逻辑，对话上下文由 Companion 自带的 SQLite 管理，`threadId` 与 Hermes CLI 原有聊天会话数据库完全隔离。

---

## 3. 快速启动与服务端配置

### 3.1 启动 Companion 服务

采用不侵入修改外部虚拟环境的规范方式，在同一 Shell 中指定项目仓库与 Hermes 代码仓库的绝对路径并启动（请使用绝对路径，因为 `server.py` 会将进程工作目录切换至 workspace，相对路径在切换后会失效）：

```bash
# 设置项目与 Hermes 仓库的绝对路径
export BRIDGE_REPO="/absolute/path/to/opencode-hermes-bridge"
export HERMES_REPO="/absolute/path/to/hermes-agent"

# 设置 Hermes 配置目录、鉴权 Token 与显式模型标识
export HERMES_HOME="/absolute/path/to/hermes-home"
export HERMES_BRIDGE_TOKEN="your-secure-bridge-token-without-spaces"
export HERMES_MODEL="your-model-id"

# 可选：显式模型路由配置（若连接自建或特定模型网关）
# export HERMES_BRIDGE_PROVIDER="custom"
# export HERMES_BRIDGE_BASE_URL="http://model-gateway.internal:8084/v1"
# export HERMES_BRIDGE_API_MODE="chat_completions"
# export HERMES_BRIDGE_MODEL_API_KEY="your-model-api-key"
# export HERMES_BRIDGE_API_KEY_ENV="HERMES_BRIDGE_MODEL_API_KEY"  # 选填，默认即为 HERMES_BRIDGE_MODEL_API_KEY

# 启动服务 (通过 PYTHONPATH 挂载源码，Hermes venv 路径以部署实际为准)
PYTHONPATH="$BRIDGE_REPO/companion:$HERMES_REPO${PYTHONPATH:+:$PYTHONPATH}" \
  "$HERMES_REPO/.venv/bin/python" -m hermes_bridge \
  --host 127.0.0.1 \
  --port 8787 \
  --model "$HERMES_MODEL" \
  --workspace "$HOME/.local/share/opencode-hermes-bridge"
```

> **注意**：
> - `--model` / `HERMES_MODEL` 为**必填项**，必须显式指定具体的模型标识（如示例占位符 `your-model-id`）。Hermes 的底层 `AIAgent` 仅接收模型名称并不等同于 Hermes CLI 已自动选择或判定 provider。
> - **可选显式路由环境变量**：若需要将请求路由至自定义模型网关，可设置显式路由环境变量组：
>   - `HERMES_BRIDGE_PROVIDER`：模型服务提供商标识（如 `custom`）。
>   - `HERMES_BRIDGE_BASE_URL`：模型网关基地址（如 `http://model-gateway.internal:8084/v1`），必须为带主机名的 HTTP(S) URL，严禁包含用户名/密码凭据、查询参数（`?`）或 Hash 片段（`#`），允许 `/v1` 等路径。
>   - `HERMES_BRIDGE_API_MODE`：接口模式，本版本仅支持 `chat_completions`。
>   - `HERMES_BRIDGE_API_KEY_ENV`：承载模型 API Key 的环境变量名称，缺省为 `HERMES_BRIDGE_MODEL_API_KEY`。它仅用于选择变量名，所指向的目标环境变量必须包含非空 Key。
>   - **完整性与快速失败（Fail-Fast）**：当上述任意一个路由环境变量（包括 `HERMES_BRIDGE_API_KEY_ENV`）出现时，要求 `HERMES_BRIDGE_PROVIDER`、`HERMES_BRIDGE_BASE_URL` 和 `HERMES_BRIDGE_API_MODE` 三项完整具备且非空，并在服务端初始化早期完成校验（早于工作区初始化与 Worker 启动）。配置错误采用固定脱敏提示，不回显密钥并立即退出。
>   - **凭据生命周期与处理边界**：模型 API Key 在导入 Hermes 模块前从环境捕获，作为进程私有属性保存，并透传给 `AIAgent(api_key=...)`。Bridge 自身处理流程不会主动将该密钥写入任务请求、SQLite 数据库、本地 Outbox 或自身的运行日志。启动前请确保已载入正确 profile。需要注意：Python 私有属性并非操作系统级隔离；当密钥传入 `AIAgent` 后，底层 Hermes、上游 Provider SDK、工具以及模型本身的行为是否记录或返回密钥，不属于 Bridge 可控制的保证范围。Hermes 并非执行沙箱，外部运行时与工具的日志、环境及文件系统访问权限须由部署者另行限制。
>   - **两类凭据职责区分**：用于 OpenCode 插件调用 Companion 的桥接鉴权 `HERMES_BRIDGE_TOKEN`（Bearer Token），与访问上游网关的模型 `HERMES_BRIDGE_MODEL_API_KEY`（网关密钥）属于两类不同用途的凭据，建议分别配置专用的 Bridge Token 与模型网关密钥。
>   - **旧模式兼容性**：若未设置显式路由组，Companion 保持原有行为（仅向 `AIAgent` 传递 `session_id`、`model` 与 `quiet_mode`），依赖 Hermes 自身内部的环境处理（如 `HERMES_HOME` 下配置），不能声称对 Hermes CLI 的完整动态路由自动兼容。提供模型示例不证明任何第三方模型路由一定兼容。

#### Companion CLI 选项列表

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--host` | `127.0.0.1` | 监听地址。默认仅绑定本地回环。远程 HTTP 需要受信网络访问控制（如局域网源地址限制、禁止暴露公网）；不可信网络或公网传输建议前置 TLS 反向代理或加密隧道（如 WireGuard/SSH）。 |
| `--port` | `8787` | 监听端口。 |
| `--model` | 环境变量 `HERMES_MODEL` | 必填。显式指定 Hermes 调用的模型名称标识（CLI 模型路由不在此处加载）。 |
| `--workspace` | `~/.local/share/opencode-hermes-bridge` | 工作区目录，包含 SQLite 数据库、任务锁文件及临时文件。自动设为 `0700` 私有权限。 |
| `--request-timeout` | `10.0` | 单次 HTTP 请求处理超时秒数。 |

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
| `uploadRoots` | `HERMES_BRIDGE_UPLOAD_ROOTS` | `[]`（空列表） | 允许以 `path` 形式读取本地文件的路径白名单。环境变量须为合法 JSON 数组（如 `export HERMES_BRIDGE_UPLOAD_ROOTS='["/absolute/project"]'`）。**空列表仅禁用 `path` 方式读取，`base64` 与 `data` 形式不受白名单限制**。 |
| `outputDir` | `HERMES_BRIDGE_OUTPUT_DIR` | 优先读取 `$XDG_STATE_HOME/opencode-hermes-bridge/outputs`，缺省为 `~/.local/state/opencode-hermes-bridge/outputs` | Companion 产物接收后的本地安全保存目录（设为 `0700` 私有权限）。 |

> **关键运维提示**：
> `HERMES_BRIDGE_TOKEN` **必须注入到 OpenCode 后台服务环境**中。仅为 Companion 单独设置 export 不会自动同步至已启动的 OpenCode 宿主进程。需要特别注意：**插件配置可热重载，但后台进程环境变量更新需要重启后台服务**（已运行 daemon 不会自动更新 `process.env`，仅重启 TUI 亦不足以生效；需通过 `opencode service restart` 等方式重启后台服务以使环境生效）。OpenCode 宿主仅需读取 Bridge 端的 URL 与 Bearer Token；显式模型路由相关的环境变量（`HERMES_BRIDGE_PROVIDER`、`HERMES_BRIDGE_BASE_URL` 及模型网关 API Key）仅属于 Companion 进程环境，无需也不应注入 OpenCode 宿主。

---

## 5. 插件提供的工具（Tools）

插件加载后会注册以下三个工具：

### 5.1 `hermes_ask`

向 Hermes 发起指令与文件任务。

- **参数格式**：
  - `text`（必填，string）：发送给 Hermes 的指令，最大 64 KiB UTF-8。
  - `attachments`（选填，array，最大 8 项）：文件附件列表。每个附件必须且仅能从以下三种形状选一种：
    - `{ path, mime, name? }`：从本地文件读取，路径解析后必须落在 `uploadRoots` 白名单内且禁止符号链接。`path` 与 `mime` 必填，`name` 选填（缺省时自动取 `basename(path)`）。
    - `{ data, name, mime? }`：标准 Base64 Data URI（如 `data:image/png;base64,...`）。`data` 与 `name` 必填，`mime` 选填（缺省时从 Data URI 解析提取，若提供则必须与 Data URI 中的 MIME 一致）。
    - `{ base64, name, mime }`：标准规范 Base64 字节串。`base64`、`name` 与 `mime` 均必填。
- **执行行为**：
  - 校验参数配额并做本地快照；
  - 写入本地 Outbox 后**立即返回本地接收确认文本**，附带 Job UUID 与 Thread UUID；
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
  - 沿用原持久化 UUID 与附件快照继续轮询或重试；
  - 若此前未获知服务端接收状态（202），可能使用原 ID 重提；
  - **绝不**新建 Job ID，不重新执行已完成的任务；若由于鉴权或服务端错误失败，需修复配置后再恢复。

---

## 6. 文件安全、配额与模型格式处理

### 6.1 传输安全配额

- **单任务附件总数**：最多 8 个。
- **单附件体积上限**：解码后最大 10 MiB。
- **附件总体积上限**：解码后最大 20 MiB。
- **指令文本上限**：最大 64 KiB UTF-8。
- **HTTP 传输报文上限**：最大 32 MiB。超出配额请求将返回 HTTP 413。

### 6.2 本地文件读取安全限制（Linux `/proc/self/fd`）

在读取 `uploadRoots` 内的文件时，客户端先解析绝对路径并逐级校验禁止符号链接；在打开文件描述符后，通过 `/proc/self/fd/<fd>` 获取真实路径并做设备号/Inode 校验，严防并发符号链接替换（TOCTOU）与路径越界。

### 6.3 多媒体回传与模型上下文分流

任务执行完成后，Companion 将产物文件回传至客户端：
1. **可入模型上下文格式**：`image/png`、`image/jpeg`、`image/gif`、`image/webp` 及 `text/*`。这些文件由插件封装为 Data URI 注入 `ctx.session.prompt` 的 `files` 数组，直接供模型解析。
2. **其余二进制格式**（PDF、ZIP 等）：原子写入客户端本地私有目录（`outputDir/<jobId>/<name>`），**仅在回投文本中展示本地绝对路径**，不作为模型附件传入，文档与插件均不声称模型能直接解析此类二进制。

---

## 7. 任务生命周期、幂等与故障语义

- **幂等性保障**：
  - 服务端使用 `Job ID + 内容 SHA-256 指纹` 校验。
  - 相同 ID 且内容一致：幂等复用，返回 `202 Accepted`。
  - 相同 ID 但内容变异：返回 `409 Conflict`。
  - 服务端 SQLite 丢失时无法去重，客户端重提会被视作新任务。
- **服务重启恢复**：
  - Companion 重启时，SQLite 中处于 `running` 状态的任务直接置为 `failed`（错误码 `restart`），防止重复重放产生副作用；处于 `queued` 状态的任务恢复排队调度。
- **轮询超时与暂停**：
  - 轮询间隔 2 秒，单次 HTTP 超时 10 秒；
  - 任务在 30 分钟未完成后自动转入 `paused` 状态并通知原会话；用户可通过 `hermes_resume` 继续轮询。
- **Outbox 生命周期与交付语义**：
  - Outbox 暂无自动过期清理机制，记录保留在 OpenCode 存储中。
  - 结果成功投递至原会话后标记为 `delivered`；若投递阶段崩溃重启，可能存在重复投递通知（弱交付语义，非严格 exactly-once），通知内附带 Job ID 用于识别。

---

## 8. 安全与沙箱责任边界声明

1. **Companion 并非执行沙箱**：Companion 的路径检查（限制在 `uploads/` 与 `output/` 目录）仅用于 HTTP 文件交换的边界防护，**不构成 Hermes Agent 的系统权限沙箱**。Hermes 运行时依然拥有宿主所赋予的环境与工具权限。
2. **凭据脱敏与处理边界**：Companion 对自身模型与工具执行的异常信息进行了脱敏处理，防止底层提供商的 API Key 或敏感环境变量随错误报文泄露至网络。Bridge 本身不主动持久化或记录显式路由的模型 API Key，但当 Key 透传给 `AIAgent` 后，Hermes、工具或第三方 SDK 的内部行为不受 Bridge 约束，相关执行环境安全须由部署者配置限制。
3. **网络暴露与访问控制**：服务默认绑定 `127.0.0.1`，鉴权仅通过 Bearer Token 进行。若需在受信任的局域网（LAN）内使用 HTTP 访问，必须实施受信网络访问控制（如内网防火墙源地址白名单、严禁直接暴露于公网）。需要注意：局域网明文 HTTP 传输并不等同于 TLS，亦非绝对安全（Bearer Token 与通信内容在网络链路上仍以明文传输）；在跨公网或不可信网络链路中，强烈建议前置 TLS 反向代理或使用 VPN / 加密隧道。本项目不提供公网开放端点配置指南。

---

## 9. 验证现状简述

项目已完成单元测试、跨语言集成测试及最小化实体联调（完整证据与分层矩阵详见 [docs/VERIFICATION.md](docs/VERIFICATION.md)）：
- **已证实**：TypeScript 产物构建与类型检查（未变更）、TypeScript 单元测试（21 项 / 145 断言）；Python 服务端测试（25 项，覆盖服务接口、调度队列、错误脱敏，以及新增的显式路由参数捕获、合法性校验、Fail-Fast 拦截与指定测试场景下的凭据扫描）；跨语言 HTTP 集成测试（3 场景 / 105 断言，依托 EchoRunner 回显桩验证字节流通）；真实 OpenCode 宿主（`2.0.24+de2cacd`）成功加载 `dist/` 并注册可用工具；在隔离环境中通过真实 Hermes（`0.21.5`）完成 1 次真实模型文本调用（返回 200 与固定回复），且测试夹具文件字节双向传输 SHA-256 完全匹配。
- **未证实 / 未运行**：测试文件输出由夹具生成而非模型创建；图像请求在发送前被 Hermes 移除，因此模型视觉理解能力未验证；真实宿主内的模型自主工具选择、权限确认弹窗及后台自动回投全链路 UI 尚未运行测试；新增的显式模型路由能力仅完成 Python 单元测试覆盖，尚未在真实自定义模型网关或新生产环境中进行实机部署验证，不代表任意模型路由一定兼容。测试已清理全部自建资源，未改动现有生产服务。
