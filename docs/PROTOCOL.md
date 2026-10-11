<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# OpenCode Hermes Bridge 交互与通信协议规范

本规范定义 OpenCode V2 客户端插件与本地 Hermes Companion 之间的 HTTP 桥接接口、数据格式、状态机与安全边界。

- 协议版本：v1
- 适用项目：[OpenCode Hermes Bridge](https://github.com/zjm54321/opencode-hermes-bridge)
- 许可协议：GPL-3.0-or-later

---

## 1. 架构拓扑与交互原则

1. **单向驱动与异步投递**：OpenCode 插件单向主动向 Companion 发起任务；Hermes 仅被动响应，不主动发起连接，无反向入站监听机制。
2. **两阶段应答（Local Accepted -> Background Delivered）**：
   - 阶段一：插件将用户指令及附件字节完整写入本地 Outbox，随即向用户返回 `accepted` 状态，不阻塞等待网络传输。
   - 阶段二：后台异步执行 HTTP 提交与轮询；待任务完成后，插件将结果投递回原 OpenCode 会话的排队队列中。
3. **真实字节保真**：附件直接传输二进制字节流（通过标准 Base64 编码在 HTTP 上流通），而非截断为纯文本描述。

---

## 2. HTTP 接口规范

- **默认监听地址**：`http://127.0.0.1:8787`。远程 HTTP 需要受信网络访问控制；若桥接服务限制仅在局域网（LAN）授权网段内暴露，建议在容器 NetworkPolicy 与宿主机 ACL 两层实施双重源地址控制；上游 SNAT 可能掩盖真实来源，须核实服务器实际观察到的源地址（通用示例网段可参考 `192.168.1.0/24` 与 `192.168.10.0/24`），严禁直接暴露于公网；不可信网络建议前置 TLS 反向代理或加密隧道。
- **传输层鉴权**：请求必须携带 `Authorization: Bearer <TOKEN>` 头部。Token 必须为非空 ASCII 字符串，且不得包含空白字符或控制字符。服务端使用常量时间比对（`hmac.compare_digest`）校验。
- **传输报文限制**：单次 HTTP 请求与响应体上限均为 32 MiB（`Content-Length` 超过 32 MiB 拒绝）。

### 2.1 任务提交：`POST /v1/jobs`

客户端向 Companion 提交异步任务。服务端在返回响应前**必须先将规范化的数据写入 SQLite**。

- **请求头**：
  - `Content-Type: application/json; charset=utf-8`
  - `Content-Length: <bytes>`
  - `Authorization: Bearer <TOKEN>`

- **请求体 JSON 格式**：
```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "threadId": "7d2b45e1-8930-4e3a-96c2-402f01f0a28e",
  "text": "指令文本",
  "attachments": [
    {
      "name": "image.png",
      "mime": "image/png",
      "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg=="
    }
  ]
}
```

- **响应状态码**：
  - `202 Accepted`：任务入库成功，返回 `{"id": "<uuid>"}`。
  - `409 Conflict`：请求的 Job ID 已存在，但内容哈希与既有任务不一致。
  - `413 Payload Too Large`：请求体整体、指令文本或附件体积超出配额。
  - `401 Unauthorized`：Bearer Token 缺失、错误或格式非法。
  - `415 Unsupported Media Type`：`Content-Type` 不是 `application/json`。

- **幂等性判定**：
  - 服务端提取除去 `id` 以外的规范字段（`threadId`、`text`、`attachments`）并计算 SHA-256 指纹。
  - 若 `id` 相同且指纹一致，服务端幂等复用，一律返回 `202 {"id": "<id>"}`；
  - 若 `id` 相同但指纹不一致，服务端返回 `409 Conflict`。

### 2.2 任务状态轮询：`GET /v1/jobs/:id`

- **请求格式**：`GET /v1/jobs/<uuid>`（严禁带查询参数）。

- **响应状态码**：
  - `200 OK`：返回任务最新快照。
  - `404 Not Found`：未找到对应 Job ID。
  - `401 Unauthorized`：Bearer Token 校验失败。

- **响应体 JSON 格式**：
```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "queued | running | completed | failed",
  "text": "执行输出结果文本",
  "attachments": [
    {
      "name": "result.pdf",
      "mime": "application/pdf",
      "base64": "..."
    }
  ],
  "error": null
}
```

- **字段约束与状态转移**：
  - 未就绪状态（`status` 为 `queued` 或 `running`）：`text` 为 `""`，`attachments` 为 `[]`，`error` 为 `null`。
  - 执行成功（`status` 为 `completed`）：`text` 包含模型生成的回复文本，`attachments` 包含提取到的产物文件，`error` 为 `null`。
  - 执行失败（`status` 为 `failed`）：`text` 为 `""`，`attachments` 为 `[]`，`error` 为 `{"code": "ERR_CODE", "message": "脱敏错误描述"}`。若产物体积超限或执行抛错，必须置为 `failed`，严禁静默丢弃文件。

---

## 3. 存储、隔离与执行规范

### 3.1 目录组织与隔离

在服务端工作区中，目录严格限定为私有权限（目录 `0700`，文件 `0600`；在 Kubernetes 等容器环境中挂载持久卷时，初始化逻辑需通过固定目录 fd 校验并确保卷根目录安全收紧为 `0700`，各子目录沿用既有私有权限初始化逻辑，避免被挂载环境权限如 `02770` 放宽）：

```text
<workspace>/
├── bridge.sqlite3          # 任务及会话历史存储
├── worker.lock             # 单实例排他文件锁 (fcntl.flock)
└── jobs/
    └── <job_id>/
        ├── uploads/        # 接收并落盘的输入附件
        └── output/         # 供 Hermes Agent 输出文件的目标目录
```

- **输出路径提取规则**：
  - Hermes 执行完成后，仅在 `final_response` 中以 `MEDIA:/absolute/path` 声明输出文件；
  - 该绝对路径必须严格落在当前任务专有的 `<workspace>/jobs/<job_id>/output/` 目录内；
  - 路径校验必须通过 `dir_fd` 逐级解析，严格拒绝路径逃逸、非常规文件（Non-regular file）以及符号链接（Symlink）；
  - 校验通过后读取物理文件并生成规范 Base64 编码，任务完成后字节固化并存入 SQLite。

### 3.2 单 Worker 串行、崩溃恢复与容器 PID 1 契约

- **单 Worker FIFO**：Companion 采用单一后台工作线程，按任务提交顺序从 SQLite 读取 `queued` 状态的任务串行执行。
- **服务重启恢复逻辑**：
  - 重启时检查 SQLite：原处于 `running` 状态的任务一律更新为 `status='failed'`，错误码为 `restart`（“Companion restarted during execution; job was not replayed.”），严防模型自动重放带来的副作用与外部开销；
  - 原处于 `queued` 状态的任务保持排队，等待启动后由 Worker 继续调度。
- **容器 PID 1 专用守护进程契约（`hermes_bridge.init`）**：
  - **运行限制**：仅在进程 PID 为 1 且具备独立 PID 命名空间的环境下启动，非 PID 1 启动直接退出（状态码 1）。
  - **架构与孤儿回收**：Supervisor 作为独立父进程，独占 `waitpid(-1)` 回收子进程与被收养的孤儿进程，不劫持主服务子解释器内部的 `subprocess.wait`；通过 `fork` + `setsid` 隔离派生子进程执行 Companion 主服务。
  - **信号转换与阶梯超时**：
    - 首次接收到 `SIGTERM` 或 `SIGINT` 时，转换为向主子进程 PID 发送单次 `SIGINT`（仅转发至主子进程，不向整个进程组广播），触发 HTTP 服务的优雅关闭逻辑；后续重复接收到的 TERM/INT 信号被忽略，不重复转发；
    - 超时阶梯为绝对时间线：T+20s 向主子进程组发送 `SIGTERM`（`killpg`）、T+25s 发送 `SIGKILL`、T+27s 父进程强行退出（退出码 137）。重复接收到信号不重置亦不延长上述时限；
    - 主子进程若正常或提前退出，父进程立即向剩余进程组发送 `SIGTERM`，至多等待 5 秒升级为 `SIGKILL` 并进行至多 2 秒孤儿回收清理（若子进程与孤儿已全部退出则在 `waitpid` 报 `ECHILD` 时提早结束，不强制等满 7 秒；清理阶段收到的外部信号同样不会延长既定清理时限）。
  - **状态机与部署要求**：
    - Job Worker 当前模型不支持通过信号实时撤销模型推理，因此限时终止不构成任务完全 drain；超时强杀导致的未决 `running` 任务在下次服务启动时依原有状态机置为 `failed`（`restart` 错误码）并不自动重放；
    - 派生独立会话（`setsid`）的孤儿进程无法被 `killpg` 覆盖，依赖容器 PID 1 退出时由 Linux 内核销毁 PID 命名空间进行彻底清理。容器部署必须保证 `hostPID: false` 与 `shareProcessNamespace: false`，并配置不小于 30 秒的终止宽限期（如 `terminationGracePeriodSeconds: 30`）。

### 3.3 会话历史、模型路由与凭据处理边界

- **对话历史持久化**：以 `threadId` 为主键保存在 Companion 的 SQLite `threads` 表中。
- **与 Hermes CLI 隔离**：Companion 中的 `threadId` 不会连接或恢复 Hermes CLI 原有的会话记录或数据库。
- **模型参数要求**：Companion 启动时通过命令行参数 `--model` 或环境变量 `HERMES_MODEL` 显式指定模型标识。Hermes 底层 `AIAgent` 仅接收 `model` 参数并不等同于 Hermes CLI 已在多模型/多 Provider 间完成路由解析。
- **显式模型路由组规范（可选）**：
  若需要将 Hermes 推理请求显式导向自定义网关，支持通过以下环境变量定义路由契约：
  - `HERMES_BRIDGE_PROVIDER`：Provider 名称（例如 `custom`）。
  - `HERMES_BRIDGE_BASE_URL`：模型网关基地址（例如 `http://model-gateway.internal:8084/v1`）。必须为 HTTP(S) URL 并包含主机名，严禁包含用户信息凭证（userinfo）、查询参数（`?`）或片段标识（`#`），允许路径如 `/v1`。
  - `HERMES_BRIDGE_API_MODE`：接口模式，当前版本固定且仅允许 `chat_completions`。
  - `HERMES_BRIDGE_API_KEY_ENV`：承载模型 API Key 的环境变量名称，缺省为 `HERMES_BRIDGE_MODEL_API_KEY`。必须为合法环境变量名标识符（`^[A-Za-z_][A-Za-z0-9_]*$`），其所指代的环境变量值在启动环境中必须非空。
- **完整性约束与快速失败（Fail-Fast）**：
  - 当上述 4 个变量中有任意一个存在时，要求 `HERMES_BRIDGE_PROVIDER`、`HERMES_BRIDGE_BASE_URL` 与 `HERMES_BRIDGE_API_MODE` 必须全部非空具备，否则直接抛出异常拒绝启动。
  - 路由校验在 Companion 启动初期执行，先于工作区目录准备、排他锁获取及后台 Worker 线程初始化。
  - 启动失败输出固定的脱敏错误提示，不回显密钥内容，不打印 Traceback。
- **凭据生命周期与存储边界**：
  - 模型 API Key 在 `HermesRunner` 构造阶段从环境捕获至进程私有属性中（在导入 Hermes 库前捕获，防止被 Hermes 自身加载 profile 的 `.env` 覆盖）。
  - Bridge 自身处理流程不会主动将该密钥写入任务请求对象、SQLite 数据库（`bridge.sqlite3`）、Outbox 存储、HTTP 响应报文或自身日志；该密钥仅作为 `api_key` 参数透传给 `AIAgent(**options)`。
  - Python 进程私有属性并非机密隔离机制；密钥传入 `AIAgent` 后的记录行为、异常捕获或网络调用受外部库实现约束，外部运行时与工具的日志、环境及文件系统访问权限须由部署者另行配置限制。
- **两类凭据职责边界**：
  - `HERMES_BRIDGE_TOKEN`：OpenCode 插件访问 Companion 服务的 Bearer Token。
  - 模型 API Key（`HERMES_BRIDGE_MODEL_API_KEY` 或自定义变量）：Hermes 访问底层模型网关的鉴权密钥。
  - 两类凭据服务于不同链路与安全域，建议分别配置专用密钥，避免混用。
- **未启用显式路由时的旧模式兼容**：
  - 若未设置上述显式路由变量，Companion 维持原有行为，仅向 `AIAgent` 传递 `session_id`、`model` 与 `quiet_mode`，依赖 Hermes 自身加载的环境变量（如 `HERMES_HOME` 下对应 profile 的配置），不支持亦不声称自动兼容 Hermes CLI 的动态 Provider 路由。示例模型仅作配置参考，不保证任意模型路由一定兼容。

---

## 4. 传输安全限额

| 配额项 | 约束阈值 | 超限处理机制 |
| :--- | :--- | :--- |
| 指令文本 (`text`) | 最大 64 KiB UTF-8 | 客户端阻止 / 服务端 HTTP 413 |
| 附件数量 (`attachments`) | 最多 8 个 | 客户端阻止 / 服务端 HTTP 413 |
| 单附件体积 | 解码后最大 10 MiB | 客户端阻止 / 服务端 HTTP 413 |
| 附件总体积 | 解码后最大 20 MiB | 客户端阻止 / 服务端 HTTP 413 |
| 附件名称 (`name`) | 纯单文件名，最大 255 字节，禁止路径分隔符及控制字符 | HTTP 400 拒绝 |
| HTTP 报文体积 | 最大 32 MiB | HTTP 413 拒绝 |

---

## 5. 客户端（TypeScript 插件）行为准则

1. **Outbox 存储模型**：
   - 调用 `hermes_ask` 时，先将完整的指令、原始附件数据以及元数据快照写入本地持久化存储（`outbox-v1`）；
   - 在未发起 HTTP 请求或请求尚在等待阶段，即刻返回本地接收信息。
2. **本地文件上传防护**：
   - 仅允许读取 `uploadRoots` 白名单内的文件；
   - 通过 Linux `/proc/self/fd` 验证真实路径、设备号与 Inode 属性一致性，并全程禁止符号链接，防护符号链接替换与并发篡改风险。
3. **轮询、重试与超时控制**：
   - 默认轮询间隔为 2000 ms，单次 HTTP 请求超时为 10 秒；
   - 指数退避：遇网络暂时故障按退避策略重试；若遭遇 404 且任务曾被标记为 `submitted`，说明服务端状态丢失，重置为 `accepted` 状态重新提交原 ID；
   - 超时暂停：若任务在 30 分钟内未完成，状态转为 `paused`，不再自动消耗网络；
   - 恢复操作：调用 `hermes_resume` 时沿用原 Job ID 继续轮询或恢复提交，严禁为同一任务分配新 ID。
4. **会话回投与多媒体分流**：
   - 任务完成时，通过 `ctx.session.prompt({ sessionID, text, files, delivery: 'queue' })` 将结果回投至原会话；
   - 仅限定格式的图片（`image/png`、`image/jpeg`、`image/gif`、`image/webp`）及 `text/*` 附件转换为 Data URI 注入 `files`；其他二进制格式（PDF、ZIP 等）仅写入本地私有目录（`outputDir/<jobId>/<name>`）并在文本中列出路径；
   - 会话回投成功后将本地 Outbox 标记为 `delivered`。因崩溃重启窗口可能导致重复投递通知，通知中均包含 Job ID 用于去重，协议不承诺严格 exactly-once 或 at-least-once 等强交付保证。
