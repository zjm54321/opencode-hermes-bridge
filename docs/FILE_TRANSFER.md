<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# OpenCode Hermes Bridge 双向文件传输指南

本文档介绍 OpenCode 与 Hermes 之间的双向原文件流转机制（包含大模型端专用插件 `hermes_file_plugin`、受控资产层与 OpenCode 客户端工具）。

> **状态说明**：本文档描述的是当前源码实现的完整客户端与文件资产契约，属于开发中的源码能力；线上生产环境当前仍运行此前已验证的 Sidecar 基线，尚未部署本功能。

---

## 1. 架构与文件流向

文件流转采用**受控文件资产层（Asset Store）**，在 OpenCode 客户端与原 Hermes 实例之间直接传递不可变原始字节，彻底解耦大模型文本上下文与底层二进制传输。

```text
+-----------------------+                    +---------------------------+                    +-------------------------+
|    OpenCode 宿主       |                    | Hermes Companion (8787)   |                    | 既有 Hermes 实例 (Gateway) |
| (V2 插件 / 原生 Tool)  |                    | (任务账本 + 受控文件资产层) |                    | (Hermes v2026.9.24)     |
+-----------+-----------+                    +-------------+-------------+                    +------------+------------+
            |                                              |                                               |
     [用户选择文件/指令]                                      |                                               |
            |                                              |                                               |
     1. hermes_ask (带 files 或 requireFiles)               |                                               |
     2. PUT /v1/jobs/{job}/assets/{asset} (原字节写入) ---->| (校验 SHA-256 / 0600 资产)                    |
     3. POST /v1/jobs (提交任务与 input_assets) ----------->|                                               |
            |                                              |--- 4. POST /v1/runs 提交原生任务 ------------>|
            |                                              |                                               |
            |                                              |    5. bridge_files({}) 探测输入 ------------->|
            |                                              |<-- 6. GET /internal/runs/{run}/assets --------|
            |                                              |    (读取 workspace/inputs 原件)               |
            |                                              |                                               |
            |                                              |    7. 执行任务并生成产物 ---------------------|
            |                                              |    8. bridge_publish_file({path}) ----------->|
            |                                              |<-- 9. PUT /internal/runs/{run}/assets/{id} ---|
            |                                              |    (原子登记输出资产)                          |
            |                                              |                                               |
            |--- 10. 轮询 GET /v1/jobs/{id} -------------->|                                               |
            |<-- 11. 200 OK (JobResponse 含 output_assets)-|                                               |
            |                                              |                                               |
    12. 客户端 GET /v1/jobs/{job}/assets/{id} 下载原字节 -->|                                               |
    13. 客户端核验 SHA-256 并原子写入本地                  |                                               |
        outputDir/<jobId>/<assetId>/<name>                 |                                               |
    14. 客户端向 OpenCode 宿主返回标准 Tool.Result          |                                               |
```

### 核心设计原则

1. **原字节无损传输**：ZIP、PDF、XLSX、DOCX 等文件均以原始二进制流传输，服务端与网关不重写、不解压、不执行，保留原始文件名与 SHA-256 哈希。
2. **传输成功 ≠ 模型自动解析**：对于图片与文本文件，插件可转换为 `Tool.FileContent` 送入大模型上下文；对于 ZIP、二进制等复合文件，插件返回已安全落盘的绝对路径、大小与哈希，由模型根据需要调用本地工具处理，不将大段二进制盲目塞入模型上下文。
3. **无聊天流注入**：彻底移除 `ctx.session.prompt`。短任务在预设等待期（默认 30 秒）内直接返回标准 `Tool.Result`；长任务返回排队/运行状态及 Job ID，后续通过 `hermes_result` 取回，不打断正常对话。
4. **配额分层与聚合计算**：单文件资产最大 10 MiB（10,485,760 字节）。输入方向（`attachments` 图片与 `files` 资产合计）最多 8 项、总计最大 20 MiB；输出方向（既有图片附件与 `output_assets` 资产合计）最多 8 项、总计最大 20 MiB。当声明 `requireFiles: true` 或提交了 `files` 时，若 Bridge 服务未开启文件功能，直接在提交前拦截抛错，严禁静默降级。

---

## 2. Hermes 端插件配置 (`hermes_file_plugin`)

为了使原 Hermes 实例能够感知并发布文件，项目在 `integrations/hermes_file_plugin/` 中提供了本项目按 Hermes 接口实现的配套插件。

### 2.1 插件特性与安全边界

- **单一原实例**：插件运行在既有 Hermes v2026.9.24 内部，使用原有的 profile 与长期记忆，不新建任何独立 Agent。
- **本地专属（Local-Only）**：仅适用于 Hermes 与 Bridge 运行在同一宿主机/Pod 的环境，不适配远程非共享文件系统的 Sandbox。
- **可信执行上下文**：通过 Hermes 内部私有 `ContextVar` 获取当前 `run_<32hex>` 权威标识，绝不信任大模型传入的参数或环境变量作为权威 Run ID。
- **工作区隔离**：Hermes 仅能发布位于当前 Run 私有工作区目录下的常规文件（Regular file），严禁读取符号链接或工作区外的宿主文件。

### 2.2 部署目录结构

```text
integrations/hermes_file_plugin/
├── __init__.py         # 插件入口与工具注册 (bridge_files, bridge_publish_file)
├── client.py           # 原生标准库 HTTP 文件客户端与安全文件描述符 I/O
└── plugin.yaml         # Hermes 官方插件清单声明
```

### 2.3 必须配置的环境变量

在启动 Hermes 实例前，必须在环境中注入以下变量：

```bash
# 1. 显式启用本地文件插件功能
export HERMES_BRIDGE_FILES_LOCAL=1

# 2. 已存在的绝对私有目录，必须归当前运行用户所有且权限为 0700
export HERMES_BRIDGE_FILE_ROOT="/data/hermes-files"

# 3. 独立的文件传输专属 Bearer Token（严禁与对外暴露的 HERMES_BRIDGE_TOKEN 混用，通过安全环境注入）
export HERMES_BRIDGE_FILE_TOKEN="<secure-file-only-token>"

# 4. 可选：Bridge 内部服务地址（仅限环回地址，缺省为 http://127.0.0.1:8787）
export HERMES_BRIDGE_FILES_URL="http://127.0.0.1:8787"
```

> **运维与配套提醒**：
> - **插件启用提醒**：仅配置上述环境变量并不等于 Hermes 实例已经安装或启用了 `bridge_files` 与 `bridge_publish_file` 工具；必须按照 Hermes 官方机制将 `integrations/hermes_file_plugin` 放置在其插件目录中或在配置中显式加载，确保 Hermes 启动时能正常发现并注册该配套插件。
> - `HERMES_BRIDGE_FILE_ROOT` 目录下的任务工作区仅在两项文件工具授权通过并被调用时建立，并非在每个任务开始时建立。操作者须自行制定工作区保留与清理策略，**严禁在任务运行中途删除活动工作区**。
> - Companion 服务端必须配置相同的 `HERMES_BRIDGE_FILE_TOKEN`，以便在 `/internal/runs/...` 端点验证请求来源。
> - Companion 服务端支持 `--asset-ttl` 选项（默认 86400 秒 / 24 小时）。过期资产访问返回 HTTP 410 Gone，磁盘文件在服务启动时或显式调用 `expire` 时回收并保留 tombstone 记录；服务未运行常驻后台定时 GC 守护线程。

---

## 3. OpenCode 客户端工具使用与场景示例

OpenCode 插件在首次准备提交任务时惰性调用 Companion 的 `GET /v1/capabilities` 并缓存探测结果。若支持文件功能，则开启原生文件传输通道。

### 3.1 客户端配置 (`opencode.json`)

```json
{
  "plugins": [
    {
      "package": "/path/to/opencode-hermes-bridge/dist",
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

> **安全白名单说明**：
> `uploadRoots` 默认为空列表 `[]`（此时禁用以本地 `path` 形式读取文件）。只有在显式配置白名单后，插件才允许读取白名单目录下的本地文件作为输入；通过 `base64` 或 `data` 传入的数据不受此白名单限制。

### 3.2 工具清单

| 工具名称 | 作用说明 |
| :--- | :--- |
| `hermes_ask` | 提交请求与附件。支持传入 `files`（普通文件）、`attachments`（仅原生图片）、`requireFiles`（要求文件能力）及 `waitSeconds`（等待秒数，默认 30，范围 0..120）。 |
| `hermes_result` | 取回已持久化的任务结果。支持 `waitSeconds`（默认 0，范围 0..120）。非终态返回明确的未完成状态与 Job ID，终态返回正式工具结果。 |
| `hermes_status` | 轻量查询当前会话本地 Outbox 中的任务列表或指定任务状态，不发起网络请求。 |
| `hermes_resume` | 对暂停或网络中断的任务恢复轮询。仅发起 GET 查询，绝不重复 POST。 |

---

## 4. 典型场景代码与输入示例

### 场景一：上传本地 ZIP/PDF 供 Hermes 分析

通过 `files` 传入本地路径（须在 `uploadRoots` 内）或规范 Base64 字节，并指定 `requireFiles: true`：

```json
{
  "text": "请分析上传的工程压缩包，统计模块架构并给出改进建议。",
  "files": [
    {
      "name": "project-source.zip",
      "mime": "application/zip",
      "path": "/home/user/workspace/project/project-source.zip"
    }
  ],
  "requireFiles": true,
  "waitSeconds": 45
}
```

**执行流程**：
1. 客户端校验文件存在性与大小，上传至 Companion 文件资产库；
2. 提交任务至 Hermes，Hermes 在私有工作区内获取校验后的真实 ZIP 原字节文件（传输层不自动解压，Hermes 是否解压按提示词由其本地工具执行）；
3. Hermes 自行调用解压与分析工具；若在 45 秒内完成，直接返回正式 Tool.Result。

### 场景二：无输入文件，要求 Hermes 生成产物（如编译产物或报表）

即使不提交输入文件，只要期望 Hermes 输出交付文件，即应设置 `requireFiles: true`：

```json
{
  "text": "请对本模块执行基准测试，并将生成的测试结果打包为 benchmark-report.zip 交付给我。",
  "requireFiles": true,
  "waitSeconds": 30
}
```

**执行流程**：
1. 客户端确认 Bridge 具备文件能力；
2. Hermes 启动并在私有工作区生成 `benchmark-report.zip`；
3. Hermes 调用 `bridge_publish_file({"path": "benchmark-report.zip"})` 登记产物；
4. 任务完成后，客户端自动将原文件下载至 `$XDG_STATE_HOME/opencode-hermes-bridge/outputs/<job_id>/<asset_id>/benchmark-report.zip`；
5. 工具结果中回显完整本地绝对路径、文件大小与 SHA-256，供用户或下游模型使用。

### 场景三：耗时较长的异步任务与显式取回

若任务执行预计超过 30 秒，可在 `hermes_ask` 中设置 `waitSeconds: 0` 实现即时返回，后续轮询：

```json
// 1. 发起任务，设置 waitSeconds 为 0 立即返回
// hermes_ask:
{
  "text": "执行全量端到端测试并生成报告",
  "requireFiles": true,
  "waitSeconds": 0
}
// 返回结果：{"status": "queued", "id": "3fa85f64-..."}
```

```json
// 2. 后续轮次中，通过 hermes_result 阻塞等待取回结果
// hermes_result:
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "waitSeconds": 60
}
// 若已完成，返回包含模型回复文本与落地文件路径的标准 Tool.Result
```

---

## 5. 故障排查与边界说明

1. **报 `Hermes file capability is disabled`**：表明 Companion 服务端未配置 `HERMES_BRIDGE_FILE_TOKEN` 或未开启文件接口。检查 Companion 启动环境并确认环境变量。
2. **报 `ordinary file attachments are not supported`**：表明将普通二进制文件传入了只接受图片的 `attachments` 字段。普通文件必须通过 `files` 字段提交。
3. **报 `Upload path is not within uploadRoots`**：表明传入的本地文件路径未在 OpenCode 插件的 `uploadRoots` 配置白名单中。需修改插件配置添加白名单路径。
4. **中止操作（Abort/Cancel）**：客户端超时取消或用户打断仅中断本地等待事件，**不会向远端发起中断请求**；任务仍在服务端排队或执行，后续可通过原 Job ID 用 `hermes_result` 重新取回。
