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

- **默认监听地址**：`http://127.0.0.1:8787`。生产环境若需远程调用，必须自行搭建 TLS 反向代理或加密隧道。
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

在服务端工作区中，目录严格限定为私有权限（目录 `0700`，文件 `0600`）：

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

### 3.2 单 Worker 串行与崩溃恢复

- **单 Worker FIFO**：Companion 采用单一后台工作线程，按任务提交顺序从 SQLite 读取 `queued` 状态的任务串行执行。
- **服务重启恢复逻辑**：
  - 重启时检查 SQLite：原处于 `running` 状态的任务一律更新为 `status='failed'`，错误码为 `restart`（“Companion restarted during execution; job was not replayed.”），严防模型自动重放带来的副作用与外部开销；
  - 原处于 `queued` 状态的任务保持排队，等待启动后由 Worker 继续调度。

### 3.3 会话历史与 Hermes 上下文

- **对话历史持久化**：以 `threadId` 为主键保存在 Companion 的 SQLite `threads` 表中。
- **与 Hermes CLI 隔离**：Companion 中的 `threadId` 不会连接或恢复 Hermes CLI 原有的会话记录或数据库。
- **首版模型配置约定**：Companion 启动时通过命令行参数 `--model` 或环境变量 `HERMES_MODEL` 显式指定模型；启动前必须确立 `HERMES_HOME` 环境变量以载入环境；Companion 并不包含 Hermes CLI 的动态 Provider 路由。若需特定 Provider，须由部署者在 Hermes 环境内部完成配置。

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
