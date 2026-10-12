<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# OpenCode Hermes Bridge 交互与通信协议规范

本规范定义 OpenCode V2 客户端插件与本地 Hermes Companion 之间的 HTTP 桥接接口、数据格式、状态机与安全边界。

- 协议版本：v1
- 适用项目：[OpenCode Hermes Bridge](https://github.com/zjm54321/opencode-hermes-bridge)
- 许可协议：GPL-3.0-or-later

---

## 1. 架构拓扑与交互原则

1. **单向驱动与异步投递**：OpenCode 插件单向主动向 Companion 发起任务，Companion 向原生 Hermes Gateway 发起 Run 请求；Hermes 仅被动响应，不主动发起连接，无反向入站监听机制。
2. **两阶段应答（Local Accepted -> Background Delivered）**：
   - 阶段一：插件将用户指令及图片附件完整写入本地 Outbox 并记录 outbound scope 哈希，随即向用户返回 `accepted` 状态，不阻塞等待网络传输。
   - 阶段二：后台异步执行 HTTP 提交与轮询；待任务完成后，插件将结果投递回原 OpenCode 会话的排队队列中。
3. **真实图片保真与原生会话复用**：本阶段附件限定为图片格式（`image/png`、`image/jpeg`、`image/gif`、`image/webp`，通过标准 Base64 编码流通），普通非图片文件在提交前拦截。后端对接原生 Gateway `/v1/runs`，会话持久化由 Gateway 管理（`session_id="opencode-<threadId>"`），不向网关注入旧 bridge 私有历史。

---

## 2. HTTP 接口规范

- **默认监听地址**：`http://127.0.0.1:8787`。远程 HTTP 需要受信网络访问控制；若桥接服务限制仅在局域网（LAN）授权网段内暴露，建议在容器 NetworkPolicy 与宿主机 ACL 两层实施双重源地址控制；上游 SNAT 可能掩盖真实来源，须核实服务器实际观察到的源地址（通用示例网段可参考 `192.168.1.0/24` 与 `192.168.10.0/24`），严禁直接暴露于公网；不可信网络建议前置 TLS 反向代理或加密隧道。
- **传输层鉴权**：请求必须携带 `Authorization: Bearer <TOKEN>` 头部。Token 必须为非空 ASCII 字符串，且不得包含空白字符或控制字符。服务端使用常量时间比对（`hmac.compare_digest`）校验。
- **传输报文限制**：单次 HTTP 请求与响应体上限均为 32 MiB（`Content-Length` 超过 32 MiB 拒绝）。

### 2.1 任务提交：`POST /v1/jobs`

客户端向 Companion 提交异步任务。服务端在返回响应前**必须先将规范化的数据写入 SQLite 并绑定网关 scope**。

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
  - `415 Unsupported Media Type`：`Content-Type` 不是 `application/json`，或附件包含非图片格式（返回 `unsupported_attachment`，仅支持 PNG/JPEG/GIF/WebP）。

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
  "attachments": [],
  "error": null
}
```

- **字段约束与状态转移**：
  - 未就绪状态（`status` 为 `queued` 或 `running`）：`text` 为 `""`，`attachments` 为 `[]`，`error` 为 `null`。
  - 执行成功（`status` 为 `completed`）：`text` 包含网关生成的回复文本，`attachments` 为 `[]`（当前原生网关不包含输出附件传输契约，此为生产 Gateway 任务正常结果示例；v1 wire 协议保留输出附件数组结构以兼容历史产物与本地回显适配器，但系统不开放普通文件新输入），`error` 为 `null`。
  - 执行失败（`status` 为 `failed`）：`text` 为 `""`，`attachments` 为 `[]`，`error` 为 `{"code": "ERR_CODE", "message": "脱敏错误描述"}`。若模型输出中出现 `MEDIA:...` 格式，置为 `failed` 且错误码为 `unsupported_output`（客户端 GET 接口恒返回 HTTP 200）。

---

## 3. 存储、隔离与执行规范

### 3.1 目录组织与隔离

在服务端工作区中，目录严格限定为私有权限（目录 `0700`，文件 `0600`；在 Kubernetes 等容器环境中挂载持久卷时，初始化逻辑需通过固定目录 fd 校验并确保卷根目录安全收紧为 `0700`，各子目录沿用既有私有权限初始化逻辑，避免被挂载环境权限如 `02770` 放宽）：

```text
<workspace>/
├── bridge.sqlite3          # 任务、网关运行及会话存储（threads 表为历史遗留结构，当前不生成/注入历史）
└── worker.lock             # 单实例排他文件锁 (fcntl.flock)
```

- **网关输出约束**：Companion 不读取外部 Gateway 内部文件系统；若模型输出声明 `MEDIA:/absolute/path`，Companion 统一在轮询响应中置为 `unsupported_output` 失败，不进行任何路径提权或读取。

### 3.2 单 Worker 调度、Gateway Runs 状态机与崩溃恢复

- **单 Worker FIFO**：Companion 采用单一后台工作线程，按任务提交顺序从 SQLite 读取 `queued` 与 `running` 状态的任务串行执行。
- **网关运行账本（`gateway_runs`）与单次 POST 原则**：
  - 任务执行前在事务中向 `gateway_runs` 登记 `(job_id, body, scope, session_id, first_sent, run_id)` 并绑定当前 `gateway_scope`；
  - 每个任务对 Gateway 的原生 POST**至多执行 1 次**；
  - 若 POST 遇到断连、超时或非 202 响应，状态保守置为 `failed`（错误码 `gateway_outcome_unknown`，客户端轮询恒返回 HTTP 200）并不自动重放（不承诺严格 exactly-once）；
  - 已获取有效 `run_id` 的任务，在轮询阶段遭遇暂时性网络故障或 429/5xx 响应时，保持 `running` 状态并按指数退避继续重试 GET，退避上限默认 10 秒；
  - 本地调用 `stop()` 仅中断本地等待事件，不向 Gateway 发送 `/stop` 请求，不主动取消远端任务；
  - 服务重启时：已具备 `run_id` 的任务继续通过 GET 轮询恢复；尚未登记发送意图且 scope 相符的新 `queued` 任务在重启后仍可正常执行首次 POST；仅当已在 `gateway_runs` 登记发送意图但缺失 `run_id`（或 scope 不符/缺失）时，才保守置为 `failed`（错误码 `gateway_outcome_unknown`）；
  - 旧架构遗留任务（属于旧版 backend_version 的未决任务）在启动时直接标记为 `failed`（错误码 `backend_changed`）；若属于当前版本但缺少有效 scope 绑定，则标记为 `gateway_outcome_unknown`；历史数据均保留但不予执行。
- **容器 PID 1 专用守护进程契约（`hermes_bridge.init`）**：
  - **运行限制**：仅在进程 PID 为 1 且具备独立 PID 命名空间的环境下启动，非 PID 1 启动直接退出（状态码 1）。
  - **架构与孤儿回收**：Supervisor 作为独立父进程，独占 `waitpid(-1)` 回收子进程与被收养的孤儿进程，不劫持主服务子解释器内部的 `subprocess.wait`；通过 `fork` + `setsid` 隔离派生子进程执行 Companion 主服务。
  - **信号转换与阶梯超时**：
    - 首次接收到 `SIGTERM` 或 `SIGINT` 时向主子进程 PID 发送单次 `SIGINT` 触发优雅关闭，后续按 T+20s（`killpg` SIGTERM）、T+25s（SIGKILL）、T+27s 绝对时限退出；
    - 主子进程提前退出则在最多 7 秒内完成孤儿进程清理退出；
  - **状态机与部署要求**：
    - 超时强杀导致未完成的任务在下次启动时按既有机制处理，不自动重放；
    - 容器部署必须保证 `hostPID: false` 与 `shareProcessNamespace: false`，并配置不小于 30 秒的终止宽限期。

### 3.3 原生 Gateway 路由与凭据规范

- **原生 Gateway 接口标准**：
  - Companion 仅对接原生 Hermes Gateway 的 `/v1/runs` 接口（参考 NousResearch/hermes-agent [v2026.9.24 api_server_runs.py](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/gateway/platforms/api_server_runs.py)）；
  - 请求报文仅包含 `{"input": native_input, "session_id": session_id}`；
  - `session_id` 固定生成为 `opencode-<threadId>`，用于串联 Gateway 原生会话上下文；长期记忆使用的用户身份须另行核对。Bridge 不向 Gateway 注入私有历史或自建 prompt 模板。
- **环境变量配置契约**：
  - `HERMES_GATEWAY_URL`：Gateway 基础 URL（例如 `http://127.0.0.1:8642`），必须为合法的 HTTP(S) URL，严禁包含用户信息凭证、查询参数（`?`）或片段标识（`#`），末尾不包含 `/v1/runs`。
  - `HERMES_GATEWAY_TOKEN`：访问 Gateway 的 Bearer Token（对应 Gateway 的 `API_SERVER_KEY`），必须为非空 ASCII 字符串。
- **网关 Scope 绑定与校验**：
  - 服务端计算目标网关与其凭据哈希的 `scope`（`sha256([url, sha256(token)])`）；入队与恢复严格校验 scope 一致性，防止跨目标误发。
- **两类凭据职责边界**：
  - `HERMES_BRIDGE_TOKEN`：OpenCode 插件访问 Companion 服务的 Bearer Token。
  - `HERMES_GATEWAY_TOKEN`：Companion 访问 Gateway 原生 API 的鉴权密钥。
  - 两类凭据服务于不同链路与安全域，分别配置管理。
- **旧版模型路由废弃说明**：
  - 早期版本中的 `--model`、`HERMES_MODEL`、`HERMES_BRIDGE_PROVIDER`、`HERMES_BRIDGE_BASE_URL` 等显式进程内 AIAgent 路由变量均已废弃；`runner.HermesRunner` 仅作为导入兼容别名存在。

---

## 4. 传输安全限额

| 配额项 | 约束阈值 | 超限处理机制 |
| :--- | :--- | :--- |
| 指令文本 (`text`) | 最大 64 KiB UTF-8 | 客户端阻止 / 服务端 HTTP 413 |
| 附件数量 (`attachments`) | 最多 8 个（仅限 PNG/JPEG/GIF/WebP 图片） | 客户端阻止 / 服务端 HTTP 415（非法类型）或 413 |
| 单附件体积 | 解码后最大 10 MiB | 客户端阻止 / 服务端 HTTP 413 |
| 附件总体积 | 解码后最大 20 MiB | 客户端阻止 / 服务端 HTTP 413 |
| 附件名称 (`name`) | 纯单文件名，最大 255 字节，禁止路径分隔符及控制字符 | HTTP 400 拒绝 |
| HTTP 报文体积 | 最大 32 MiB | HTTP 413 拒绝 |
| 原生 Gateway 报文 (`MAX_NATIVE_BODY`) | 最大 10,000,000 字节 | 超出硬上限在提交网关前置为 `failed`（错误码 `payload_too_large`） |

> **载荷分层约束说明**：
> 外部 HTTP 接口（`POST /v1/jobs`）遵循 32 MiB 请求体及单文件 10 MiB / 总计 20 MiB 配额。然而，Companion 组装发往 Gateway 原生接口的规范 JSON 报文设有 10,000,000 字节（`MAX_NATIVE_BODY`）硬上限；由于 Base64 膨胀（~33%）及 JSON 封装开销，实际允许传输的图片总容量显著受限；入队 202 成功不保证原生报文体一定通过检查，超出硬上限将在发送前失败。

---

## 5. 客户端（TypeScript 插件）行为准则

1. **Outbox 存储模型与写前持久化**：
   - 调用 `hermes_ask` 时，先校验图片 MIME，并将指令、图片数据、`postAttempted: false` 及当前 `scopeHash` 写入本地持久化存储（`outbox-v1`）；
   - 在未发起 HTTP 请求或请求尚在等待阶段，即刻返回本地接收信息；
   - 在发起 POST 请求前，必须先在事务中将 `postAttempted` 标记为 `true` 固化落盘。
2. **本地文件上传防护**：
   - 仅允许读取 `uploadRoots` 白名单内的图片文件；
   - 通过 Linux `/proc/self/fd` 验证真实路径、设备号与 Inode 属性一致性，全程禁止符号链接；非图片格式直接抛错拦截。
3. **轮询、重试与超时控制**：
   - 默认轮询间隔为 2000 ms，单次 HTTP 请求超时为 10 秒；
   - 若在初次 POST 收到 202 之前网络异常，后续轮询仅以 GET 查询原任务，绝不重放 POST；
   - 若遭遇 404，任务自动转为 `paused` 并设置状态未知提示；
   - 超时暂停：若任务超出时限未完成，状态转为 `paused`；
   - 恢复操作：调用 `hermes_resume` 时仅以 GET 查询原记录，绝不重新提交模型任务；若任务缺少 scopeHash 或配置 scope 变动，保持暂停且不发起 HTTP 连接。
4. **会话回投与多媒体分流**：
   - 任务完成时，通过 `ctx.session.prompt({ sessionID, text, files: output.files, delivery: 'queue' })` 将结果回投至原会话；客户端核心保留 `saveOutputs` 产物落地与 `output.files` 组装逻辑以兼容历史遗留结果；由于生产 `GatewayRunner` 正常 `RunResult` 仅包含文本而无输出附件，故新网关任务的 `files` 恒为 `[]`，不代表客户端删除了产物处理逻辑；
   - 当前原生网关无输出附件契约，正常回投仅包含文本；
   - 会话回投成功后将本地 Outbox 标记为 `delivered`。因崩溃重启窗口可能导致重复投递通知，通知中均包含 Job ID 用于去重，协议不承诺严格 exactly-once 保证。
