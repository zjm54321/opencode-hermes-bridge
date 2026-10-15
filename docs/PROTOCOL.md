<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# OpenCode Hermes Bridge 交互与通信协议规范

本规范定义 OpenCode V2 客户端插件与本地 Hermes Companion 之间的 HTTP 桥接接口、数据格式、状态机与安全边界。

- 协议版本：v1

## 1. HTTP 接口规范

- **默认监听地址**：`http://127.0.0.1:8787`。远程 HTTP 需要受信网络访问控制；若桥接服务限制仅在局域网（LAN）授权网段内暴露，建议在容器 NetworkPolicy 与宿主机 ACL 两层实施双重源地址控制；上游 SNAT 可能掩盖真实来源，须核实服务器实际观察到的源地址（通用示例网段可参考 `192.168.1.0/24` 与 `192.168.10.0/24`），严禁直接暴露于公网；不可信网络建议前置 TLS 反向代理或加密隧道。
- **传输层鉴权**：
  - 公开接口：请求必须携带 `Authorization: Bearer <HERMES_BRIDGE_TOKEN>` 头部；
  - 内部文件接口（`/internal/...`）：仅限环回地址访问，必须携带 `Authorization: Bearer <HERMES_BRIDGE_FILE_TOKEN>` 头部，且两类 Token 完全独立。
- **传输报文限制**：单次 HTTP 任务报文上限为 32 MiB（`Content-Length` 超过 32 MiB 拒绝）；单文件资产上限 10 MiB，单任务单向资产总上限 20 MiB。

### 1.1 能力探测：`GET /v1/capabilities`

客户端在首次准备提交任务时惰性调用此接口探测 Companion 服务端具备的特性与配额，并进行实例级缓存：

- **请求头**：`Authorization: Bearer <HERMES_BRIDGE_TOKEN>`
- **响应状态码**：`200 OK`
- **响应体 JSON 格式**：
```json
{
  "object": "hermes.bridge.capabilities",
  "version": 1,
  "assets": true,
  "max_asset_bytes": 10485760,
  "max_total_asset_bytes": 20971520,
  "max_assets": 8
}
```
> **注意**：`assets: true` 仅代表 Bridge 服务端已配置并启用了文件资产接口，并不代表 Hermes 实例已安装或激活了对应的文件插件。

### 1.2 任务提交：`POST /v1/jobs`

客户端向 Companion 提交异步任务。服务端在返回响应前**必须先将规范化的数据写入 SQLite 并绑定网关 scope**。

本轮源码仅在新任务入队前按固定入口将 `[协作代理说明]` 加入 `text`，原正文在 `[任务正文]` 后逐字保留，64 KiB UTF-8 限额包含说明且超限直接拒绝。该说明不用于身份认证、授权或记忆身份映射，不新增协议字段；已有任务及恢复查询不补写说明。

- **请求头**：
  - `Content-Type: application/json; charset=utf-8`
  - `Content-Length: <bytes>`
  - `Authorization: Bearer <HERMES_BRIDGE_TOKEN>`

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
  ],
  "input_assets": [
    "9f8b2c14-5717-4562-b3fc-2c963f66afa6"
  ]
}
```

- **字段说明**：
  - `attachments`：仅支持原生内联图片（PNG/JPEG/GIF/WebP）；
  - `input_assets`（可选，`[UUID]`）：已提前上传至资产库的文件资产 ID 列表。存在该字段（包括空列表 `[]`）即代表任务显式启用文件流转模式，并参与任务内容 SHA-256 指纹计算。
- **响应状态码**：
  - `202 Accepted`：任务入库成功，返回 `{"id": "<uuid>"}`。
  - `409 Conflict`：请求的 Job ID 已存在，但内容哈希与既有任务不一致。
  - `413 Payload Too Large`：请求体整体、指令文本或附件体积超出配额。
  - `401 Unauthorized`：Bearer Token 缺失、错误或格式非法。
  - `415 Unsupported Media Type`：`Content-Type` 非 JSON，或传入非图片 attachment，或在服务端未启用文件能力时提交了 `input_assets`。

### 1.3 任务状态轮询：`GET /v1/jobs/:id`

- **请求格式**：`GET /v1/jobs/<uuid>`（严禁带查询参数）。
- **响应体 JSON 格式**：
```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "queued | running | completed | failed",
  "text": "执行输出结果文本",
  "attachments": [],
  "output_assets": [
    {
      "asset_id": "8a7c1b2d-5717-4562-b3fc-2c963f66afa6",
      "name": "result.zip",
      "mime": "application/zip",
      "size": 1048576,
      "sha256": "<64hex_sha256_hash>"
    }
  ],
  "error": null
}
```

- **字段约束与状态转移**：
  - 未就绪状态（`queued` / `running`）：`text` 为 `""`，`attachments` 为 `[]`，`output_assets` 为 `[]`，`error` 为 `null`。
  - 执行成功（`completed`）：`text` 包含模型生成的回复文本，`attachments` 兼容既有内联图片，`output_assets`（可选扩展字段，旧格式可省略）包含 Hermes 发布的常规产物文件元数据，`error` 为 `null`。
  - 执行失败（`failed`）：`text` 为 `""`，`attachments` 与 `output_assets` 为 `[]`，`error` 为 `{"code": "ERR_CODE", "message": "脱敏描述"}`。若模型输出中出现未受支持的 `MEDIA:...` 格式文本且无已登记输出资产，置为 `failed` 且错误码为 `unsupported_output`；若已有登记发布的输出资产，文本严格作为普通文本，绝不额外解析文本内的 `MEDIA:` 路径。

### 1.4 对外文件资产接口：`PUT / GET /v1/jobs/:job_id/assets/:asset_id`

- **传输层鉴权**：携带 `Authorization: Bearer <HERMES_BRIDGE_TOKEN>`。
- **上传资产：`PUT /v1/jobs/:job_id/assets/:asset_id`**：
  - 允许在 `POST /v1/jobs` 提交任务之前上传输入资产；一旦任务提交成功，输入资产名单即被密封冻结（sealed），后续仅允许对已密封的资产 ID 按相同字节与哈希原样幂等重传（PUT 返回 `200 OK`），提交后严禁追加新资产；
  - 请求头必须包含：
    - `Content-Type: <mime>`
    - `Content-Length: <bytes>`
    - `Content-Disposition: attachment; filename*=UTF-8''<url_encoded_basename>`
    - `X-Content-SHA256: <64hex>`
  - 响应：新资产写入返回 `201 Created`；相同 ID 且内容哈希一致幂等返回 `200 OK`；相同 ID 但字节内容不一致返回 `409 Conflict`。
  - 文件 PUT 幂等重传不等于模型任务 POST 可重放（模型任务 POST 严格遵循至多 1 次提交）。
- **下载资产：`GET /v1/jobs/:job_id/assets/:asset_id`**：
   - 以二进制流返回资产内容；客户端核验流式 SHA-256 与元数据一致后，再原子写入本地目标路径，绝不覆盖内容相异的既有文件。
- **资产过期**：Companion `--asset-ttl` 默认 86400 秒；过期访问返回 HTTP 410，启动或显式 `expire` 时回收字节并保留 tombstone，无常驻定时 GC。该 Bridge 资产接口与 TTL 不因 MCP 只提供资源 URI 而移除。

### 1.5 内部文件资产接口（环回专属）：`/internal/runs/:run_id/assets[/:asset_id]`

供本地 Hermes 插件（`hermes_file_plugin`）调用的专用接口：
- **运行约束**：仅允许本地环回请求（Loopback），必须携带 `Authorization: Bearer <HERMES_BRIDGE_FILE_TOKEN>`。
- **Run 授权**：`run_id` 必须来自 Hermes 私有执行上下文并对应已登记任务；不能相信模型参数或环境变量提供的 Run ID。插件安装与本地共享目录前提见 [文件指南](FILE_TRANSFER.md)。
- **获取输入列表：`GET /internal/runs/:run_id/assets`**：返回 `{"job_id": "<uuid>", "input_assets": [<Asset>, ...]}`。
- **读取输入资产原字节：`GET /internal/runs/:run_id/assets/:asset_id`**：流式返回输入资产二进制。
- **发布输出资产：`PUT /internal/runs/:run_id/assets/:asset_id`**：将当前 run 工作区内的生成文件登记发布为任务资产，返回元数据。返回 `201 Created` 或幂等 `200 OK`。

---

## 2. 存储、隔离与执行规范

### 2.1 目录组织与隔离

在服务端工作区中，目录严格限定为私有权限（目录 `0700`，文件 `0600`；在 Kubernetes 等容器环境中挂载持久卷时，初始化逻辑需通过固定目录 fd 校验并确保卷根目录安全收紧为 `0700`，各子目录沿用既有私有权限初始化逻辑，避免被挂载环境权限如 `02770` 放宽）：

```text
<workspace>/
├── bridge.sqlite3          # 任务、网关运行及会话存储（threads 表为历史遗留结构，当前不生成/注入历史）
├── artifacts/              # 原字节文件资产
└── worker.lock             # 单实例排他文件锁 (fcntl.flock)
```

- **网关输出约束**：Companion 不读取模型声称的 `MEDIA:/absolute/path`；无登记输出资产时该类输出失败，已有输出资产时仍不解析文本路径，以登记资产为准。

### 2.2 单 Worker 调度、Gateway Runs 状态机与崩溃恢复

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

### 2.3 原生 Gateway 路由与凭据规范

- **原生 Gateway 接口标准**：
  - Companion 仅对接原生 Hermes Gateway 的 `/v1/runs` 接口（参考 NousResearch/hermes-agent [v2026.9.24 api_server_runs.py](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/gateway/platforms/api_server_runs.py)）；
  - 请求报文仅包含 `{"input": native_input, "session_id": session_id}`；
   - `session_id` 固定生成为 `opencode-<threadId>`，用于串联 Gateway 原生会话上下文；长期记忆使用的用户身份须另行核对。Bridge 不注入旧私有历史或另设 persona；文件任务仅附加文件工具交接提示。
- **环境变量配置契约**：
  - `HERMES_GATEWAY_URL`：Gateway 基础 URL（例如 `http://127.0.0.1:8642`），必须为合法的 HTTP(S) URL，严禁包含用户信息凭证、查询参数（`?`）或片段标识（`#`），末尾不包含 `/v1/runs`。
  - `HERMES_GATEWAY_TOKEN`：访问 Gateway 的 Bearer Token（对应 Gateway 的 `API_SERVER_KEY`），必须为非空 ASCII 字符串。
- **网关 Scope 绑定与校验**：
  - 服务端计算目标网关与其凭据哈希的 `scope`（`sha256([url, sha256(token)])`）；入队与恢复严格校验 scope 一致性，防止跨目标误发。
- **两类凭据职责边界**：
  - `HERMES_BRIDGE_TOKEN`：OpenCode 插件访问 Companion 服务的 Bearer Token。
  - `HERMES_GATEWAY_TOKEN`：Companion 访问 Gateway 原生 API 的鉴权密钥。
  - 两类凭据服务于不同链路与安全域，分别配置管理。

---

## 3. 传输安全限额

| 配额项 | 约束阈值 | 超限处理机制 |
| :--- | :--- | :--- |
| 指令文本 (`text`) | 最大 64 KiB UTF-8 | 客户端阻止 / 服务端 HTTP 413 |
| 单文件资产体积 (`max_asset_bytes`) | 最大 10 MiB (10,485,760 字节) | 服务端 HTTP 413 拒绝 |
| 输入项合计 (`attachments` + `files` / `input_assets`) | 最多 8 项，单向总体积最大 20 MiB | 客户端阻止 / 服务端 HTTP 413 或 415 |
| 输出项合计 (内联图片 + `output_assets`) | 最多 8 项，单向总体积最大 20 MiB | 超限拒绝并置为 `failed`，不截断原文件 |
| 附件与资产名称 (`name`) | 纯单文件名，最大 255 字节，禁止路径分隔符及控制字符 | HTTP 400 拒绝 |
| HTTP 任务报文体积 | 最大 32 MiB | HTTP 413 拒绝 |
| 原生 Gateway 报文 (`MAX_NATIVE_BODY`) | 最大 10,000,000 字节 | 超出硬上限在提交网关前置为 `failed`（错误码 `payload_too_large`） |

普通文件通过资产层直传，不计入 Gateway JSON 报文；若图片或文本原生报文超出硬上限，将在发送前失败。

---

## 4. 客户端（TypeScript 插件）行为准则

1. **Tool.Result 原生工具结果模型**：
   - 工具执行直接向 OpenCode 宿主返回标准的 `Tool.Result` 对象，彻底保持聊天对话流的整洁。
2. **多模式等待与超时分流（`waitSeconds`）**：
   - `hermes_ask` 支持 `waitSeconds`（范围 0..120，默认 30 秒；0 秒立即返回）；
   - 在等待期内完成的任务直接返回最终输出结果；
   - 超过等待期限的任务返回明确的未终态状态（如 `queued` / `running`）与 Job ID；长任务在后台完成后不会擅自唤醒启动新一轮推理，必须由后续显式调用取回。
3. **显式结果取回规范（`hermes_result`）**：
   - 客户端通过 `hermes_result` 查询持久化任务结果，同样支持 `waitSeconds`（默认 0，范围 0..120）；
   - 终态任务返回完整回复文本与已下载的文件资产列表；未终态返回当前状态，绝不向远端发起重复 POST。
4. **能力探测与 Fail-Fast 阻断机制**：
   - 客户端在准备首次提交任务时惰性调用 `GET /v1/capabilities` 并实例级缓存服务端特性；
   - 当任务设置了 `requireFiles: true` 或包含了 `files` 输入时，若服务端未开启文件能力，客户端在前置阶段立即抛错拦截，绝不发生静默降级或提交缺失文件的无效任务。
5. **本地文件上传防护（`uploadRoots`）**：
   - 仅允许以 `path` 形式读取 `uploadRoots` 白名单内的文件；通过 Linux `/proc/self/fd` 验证真实路径、设备号与 Inode 属性一致性，全程禁止符号链接；
   - 默认 `uploadRoots` 为空列表 `[]`（关闭本地路径读取）；通过 `base64` 或 `data` 形式传入的数据由插件统一快照处理，不受路径白名单约束。
6. **产物落盘与多媒体格式分流**：
   - 输出文件资产自动安全下载至本地私有目录（`outputDir/<jobId>/<assetId>/<name>`，0600 文件 / 0700 目录）；
   - 格式分流原则：图片与纯文本由插件转换为 `Tool.FileContent`，能否被模型解析取决于宿主与模型能力；ZIP、PDF、XLSX 等复合二进制文件仅返回本地绝对路径、文件大小与 SHA-256 哈希，绝不将二进制原始内容拼装进模型上下文。
7. **轮询、重试与中止操作**：
   - 发起 POST 前持久化 `postAttempted: true` 与 `scopeHash`（`sha256([url, sha256(token)])`）；202 响应丢失时仅 GET 查询原任务，不重放 POST，也不自动创建新 UUID；
   - 遇到暂时性网络波动或 429 时按退避策略重试 GET；遇 404 任务转为 `paused`；
   - `hermes_resume` 仅以 GET 恢复轮询，绝不重新提交模型任务；缺少 scopeHash 或配置变动的任务保持暂停；
   - 客户端超时取消或用户中止（AbortSignal）仅停止本地等待流程，**绝不向远端发起取消请求**，任务在服务端保持安全排队与执行。
