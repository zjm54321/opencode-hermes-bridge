<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# OpenCode Hermes Bridge 验证与测试现状

本文档记录 OpenCode Hermes Bridge 各模块的测试覆盖证据、自动化验证结果、跨语言集成验证边界以及尚未完成的真实环境联调项。

- 适用项目：[OpenCode Hermes Bridge](https://github.com/zjm54321/opencode-hermes-bridge)
- 许可协议：GPL-3.0-or-later

---

## 1. 验证体系与分层边界

为了确保系统在网络不稳定、进程重启、恶意载荷及大文件传输下的健壮性，验证体系划分为以下层次：

1. **TypeScript 插件与客户端单元测试**：验证本地 Outbox 即时写入、配额前置校验、图片 MIME 过滤（普通文件前置拒绝）、`postAttempted` 写前持久化、`scopeHash` 绑定、404 pause 且 resume 仅 GET 轮询、会话隔离及资源释放。
2. **Python Companion 服务端单元测试**：验证 HTTP 鉴权、单 Worker 串行执行、网关 scope 绑定、`gateway_runs` 账本、至多 1 次 native POST、丢失 202 标记未知、已知 run_id 指数退避恢复、旧队列隔离（`backend_changed`）、快速 stop（不发远端 cancel）与图片 MIME 校验。
3. **跨语言端到端集成测试**：在本地真实 HTTP 协议栈下运行 TypeScript 核心客户端与 Python Companion 服务端，基于回显执行器（EchoRunner）验证多格式字节传输与生命周期完整性（注：回显 inline images 仅为测试夹具，不代表原生 Gateway 输出附件能力）。
4. **历史架构验证基线（旧版独立 AIAgent 架构保留证据）**：保留同镜像容器 PID 1 验收、生产环境 GitOps 修补部署（commit `6a3d295`）及旧版显式路由单任务实测作为历史归属参考。
5. **生产 Hermes Gateway 现场只读探测与身份验证**：现场实测既有 Hermes Gateway（`v2026.9.24`）、`HERMES_HOME=/opt/data`、`memory.provider=honcho`，`127.0.0.1:8642` capabilities 鉴权探测（200），Honcho 记忆只读查询，核验各入口身份映射隔离约束。

> **重要边界声明**：
> - 自动化跨语言集成测试基于 `EchoRunner` 回显桩验证协议管道，回显的内联图片仅为测试夹具，**绝不等于原生 Hermes Gateway 具备输出附件回传能力**。
> - 真实宿主加载验证证明了插件在宿主内的**加载激活、工具注册及底层闭包调用**，**不等于模型自主选择工具、权限确认 UI 弹窗交互、后台自动回投至真实聊天窗口**。
> - 生产 Gateway 现场探测证明了原网关接口与鉴权可用，**不等于新版 Gateway 桥接服务已在生产部署或联通**；Sidecar 部署方案仅为架构建议，未在生产环境部署生效。
> - 连接至同一 Gateway **不自动保证跨渠道共享同一 Honcho 用户记忆**，不同入口（Web PTY、微信、OpenCode）存在身份标识差异，须通过身份 Gate 正确识别，严禁擅自合并其他用户身份。

---

## 2. 测试执行与证据汇总

在 Nix Flake 声明的环境下（Bun 1.4.2 / Node 24.21.0 / Python 3.14.7 stdlib）及真实 OpenCode 宿主（`2.0.24+de2cacd`）中，验证结果如下：

| 测试层级 | 执行方式 / 环境 | 断言 / 观察依据 | 状态与关键结论 |
| :--- | :--- | :--- | :--- |
| **TS 类型检查** | `bunx tsc --noEmit` | 静态类型校验 | **PASS**（类型定义与 SDK 契约一致，0 错误） |
| **TS 产物构建** | `bun run build` | 2 模块打包（`dist/`） | **历史 PASS**（输出 Node 目标 ES 模块，本轮离线套件未重复编译） |
| **TS 单元与集成测试** | `bun test tests/unit tests/integration` | 27 测试项 / 330 断言 | **PASS**（覆盖核心调度、图片 MIME 过滤、`postAttempted` 预写、scopeHash 绑定及 3 场景 HTTP 集成测试） |
| **Python 服务与网关单测** | `python -m unittest discover -s companion/tests` | 29 测试项（耗时 8.430s 无 skip） | **PASS**（全本机 fake，`test_gateway.py` 严格覆盖 Gateway 契约、断 202 标记未知、known ID 恢复、旧 queue 隔离、4 次暂时故障退避及快速 stop） |
| **代码规范与格式检查** | `git diff --check` | 差异与空白换行规范检查 | **PASS**（无多余空白字符或换行格式异常，注：仅检查空白规范，不替代语法检查） |
| **生产 Gateway 现场只读探测** | 生产 Pod 环回 `127.0.0.1:8642` | capabilities 探测（401/200）与 Honcho 只读查询 | **PASS**（原生 Gateway v2026.9.24 运行中，capabilities 接口响应 200，只读 Honcho 查询正常，无模型调用） |
| **[历史架构] 容器 PID 1 验收** | 隔离 Pod + 真实镜像 Hermes 0.21.5 | UID 10000 / CapEff 0 / 6 项守护契约 / SIGTERM / Pod Delete | **历史 PASS**（2026-10-10 证据，归属旧版独立 AIAgent 架构，不计入当前 Gateway 计数） |
| **[历史架构] 生产 GitOps 修补部署** | 生产环境集群（commit `6a3d295b0514a6d2124cd15ed3807440f12cd768`） | 34 ACL + 25 runtime + 10 附加检查 / 卷根目录 0700 收紧 / 3 项鉴权探测 | **历史 PASS**（2026-10-11 证据，归属旧版独立 AIAgent 架构，不计入当前 Gateway 计数） |
| **[历史架构] 显式路由短文本实测** | 生产环境 + Aether 网关 + `z-ai/glm-5.3-flash` | 1 任务（1 POST + 16 GET，30.741s）返回固定标记 | **历史 PASS**（2026-10-11 证据，归属旧版独立 AIAgent 架构，不计入当前 Gateway 计数） |
| **真实宿主加载验证** | 独立隔离 OpenCode 宿主进程 | 插件状态与工具枚举 | **历史 PASS**（2026-10-10 独立宿主证据：`dist/` 激活，枚举 3 工具，本轮未重跑） |

> **版本增量与验证范围说明**：
> - **当前 Gateway 方案离线测试**：TypeScript 27 项测试（330 断言）与 Python 29 项单测全数通过，测试套件依托全本机 fake 环境和 `test_gateway.py` 精确模拟 Gateway API 契约（包括断 202 标记未知、已知 run_id 恢复、旧队列隔离、4 次暂时性故障指数退避以及快速 stop），证实了单任务至多 1 次 native POST 及网关 scope 绑定的状态机鲁棒性。
> - **测试夹具说明**：跨语言集成测试中 `EchoRunner` 回显 inline images 仅为端到端通信测试夹具，绝不代表原生 Gateway 输出附件能力。
> - **历史证据归属区分**：此前 2026-10-10 与 2026-10-11 的测试记录（TS 21 项 / 145 断言、Python 37 项单测、GitOps commit `6a3d295` 容器部署及 `z-ai/glm-5.3-flash` 显式路由实机调用）均属于旧版独立进程内 AIAgent 架构，保留作为历史归属参考，不作为当前 Gateway 架构的测试计数。
> - **生产环境网关现场事实**：生产现场已确认既有 Hermes 镜像 `nousresearch/hermes-agent:v2026.9.24`、`HERMES_HOME=/opt/data`、`memory.provider=honcho`；`.env` 中包含有效 `API_SERVER_KEY`，`127.0.0.1:8642` 端口监听且 capabilities 鉴权探测（匿名 401，正确 auth 200 返回 capabilities 对象）全数通过。只读 Honcho 查询已完成（所选目标无条目，仅代表该目标无记录，不证明无其他记忆），身份元数据核对正在进行。
> - **身份映射与记忆共享隔离**：Web PTY internal credential 经排除，普通新会话可 fallback peerName，微信通常基于 senderID；连接至同一 Gateway 不自动保证 Honcho 同一 user，部署指南须以有效身份 gate 提醒，严禁擅自合并用户身份。
> - **未执行阶段与技术边界（NOT RUN / NOT PROVEN / UNSUPPORTED）**：
>   - 新版 Gateway 桥接服务及 Sidecar 部署方案仅为建议方案，**尚未在生产环境部署、重启或提交**；
>   - 生产网关真实模型调用尚未在新方案下执行；
>   - 宿主交互式会话中的模型自主工具调用、权限弹窗及自动回投全链路 UI 未运行测试（插件端到端连接及宿主交互验证尚未完成）；
>   - 普通非图片文件输入及原生 Gateway 产物输出附件暂不受支持。

---

## 3. 各分层详细验证矩阵

### 3.1 TypeScript 客户端模块 (`tests/unit/`)

TypeScript 测试套件包含 27 个测试项与 330 个断言（含 `tests/unit/` 与 `tests/integration/`），全数通过：

| 验证项 | 验证内容与断言条件 | 测试文件依据 | 验证结论 |
| :--- | :--- | :--- | :--- |
| **本地即时响应与写前持久化** | 调用 `bridge.ask` 时，本地 Outbox 成功持久化且预写 `postAttempted: false` 与当前 `scopeHash`，在发起实际 HTTP 请求前立即返回 `accepted`；Token 不写入持久化层。 | `core.test.ts` | **已通过** (自动化测试) |
| **会话严格隔离** | 多个会话并发请求分配独立的 `threadId`，状态查询和任务恢复严格禁止跨会话访问。 | `core.test.ts` | **已通过** (自动化测试) |
| **Scope 隔离与配置变更拦截** | 计算 `sha256([url, sha256(token)])` 并持久化；遇配置变更或缺少 scope 保持 `paused` 状态并不发起网络请求。 | `core.test.ts` | **已通过** (自动化测试) |
| **404 状态未知处理** | 收到 Companion 404 自动转入 `paused` 并设置状态未知提示；调用 `resume` 仅以 GET 查验原记录，不再重新提交 POST。 | `core.test.ts` | **已通过** (自动化测试) |
| **固定 ID 与退避重试** | 模拟网络离线、HTTP 429（带 Retry-After）及 503 异常，断言沿原 Job ID 执行指数退避重试，不生成重复 ID。 | `core.test.ts` | **已通过** (自动化测试) |
| **不可恢复错误停机** | 收到 HTTP 401 停止自动重试，向会话队列发送一次操作失败通知；不发起二次请求。 | `core.test.ts` | **已通过** (自动化测试) |
| **超时暂停与恢复** | 模拟超过时限自动转入 `paused`；调用 `resume` 恢复任务且保持原 ID 与快照不变。 | `core.test.ts` | **已通过** (自动化测试) |
| **上传图片前置过滤** | 严格限定仅放行 PNG、JPEG、GIF 与 WebP 图片；传入 PDF、ZIP、TXT 等非图片文件在快照阶段直接抛错拦截。 | `files.test.ts` | **已通过** (自动化测试) |
| **上传路径安全防护** | 逐级解析路径并断言拒绝符号链接与越界路径；Linux `/proc/self/fd/<fd>` 比对真实 Inode 与设备号。 | `files.test.ts` | **已通过** (自动化测试) |
| **静态参数配额** | 超出 8 个附件、单文件超过 10 MiB、总附件超过 20 MiB、文本超过 64 KiB 均在前置阶段抛错拦截。 | `protocol.test.ts` | **已通过** (自动化测试) |
| **资源清理与释放** | 调用 `bridge.dispose` 时显式取消轮询定时器并中断未决 Fetch，无未捕获异常。 | `core.test.ts` | **已通过** (自动化测试) |

### 3.2 Python Companion 服务端 (`companion/tests/`)

Python 服务端测试套件包含 29 个测试项（耗时 8.430s 无 skip，全本机 fake 测试，由 `test_companion.py`、`test_gateway.py` 与 `test_init.py` 组成）：

| 验证项 | 验证内容与断言条件 | 测试文件依据 | 验证结论 |
| :--- | :--- | :--- | :--- |
| **Bearer 鉴权拦截** | 缺少头部、非法 Bearer 格式或非 ASCII Token 均拒绝并返回 HTTP 401，校验使用 `hmac.compare_digest`。 | `test_companion.py` | **已通过** (自动化测试) |
| **网关 Scope 绑定** | 任务入队与持久化严格绑定 `gateway_scope`，跨网关目标或凭据不一致的任务直接拒绝调度。 | `test_gateway.py` | **已通过** (自动化测试) |
| **幂等复用与冲突检测** | 相同 ID 且内容规范指纹一致返回 `202 {"id": ...}`；相同 ID 变异内容返回 `409 Conflict`。 | `test_companion.py` | **已通过** (自动化测试) |
| **单次 Native POST 契约** | 在事务中登记 `gateway_runs`，每任务向 Gateway 至多发起 1 次 POST；若初次 POST 遇到网络断连或非 202 响应，保守置为 `failed`（错误码 `gateway_outcome_unknown`，客户端查询恒返回 HTTP 200）并不自动重放。 | `test_gateway.py` | **已通过** (自动化测试) |
| **已知 run_id 故障恢复** | 已获得 `run_id` 的任务遇 429 或 5xx 故障时保持 `running` 并按指数退避轮询（上限 10s），不中断远端执行。 | `test_gateway.py` | **已通过** (自动化测试) |
| **快速 Stop 信号隔离** | 调用 `stop()` 仅中断本地等待事件，不向网关发起 `/stop` 请求，不取消远端任务。 | `test_gateway.py` | **已通过** (自动化测试) |
| **服务重启恢复状态机** | 重启时仅对已有 `run_id` 的任务通过 GET 恢复轮询；尚未登记发送意图且 scope 相符的新 `queued` 任务仍可正常执行首次 POST；仅在已登记发送意图但缺失 `run_id`（或 scope 不符/缺失）时置为 `failed`（错误码 `gateway_outcome_unknown`）；属于旧版 backend_version 的遗留任务标记为 `backend_changed`。 | `test_gateway.py` | **已通过** (自动化测试) |
| **图片 MIME 格式校验** | 校验输入附件 MIME，非图片格式（PNG/JPEG/GIF/WebP 以外）返回 HTTP 415 `unsupported_attachment`。 | `test_companion.py` | **已通过** (自动化测试) |
| **媒体输出格式拦截** | 检测到网关输出文本中出现 `MEDIA:...` 格式时置为 `failed`（错误码 `unsupported_output`，客户端查询恒返回 HTTP 200），不假装支持输出附件。 | `test_gateway.py` | **已通过** (自动化测试) |
| **单 Worker 串行调度** | 多个请求并发入队，同一时刻仅存在一个活动执行 Worker，`running` 状态期间文本与附件返回空字段。 | `test_companion.py` | **已通过** (自动化测试) |
| **PID 1 守卫拦截** | 非 PID 1 环境启动直接拒绝退出并返回状态码 1，输出标准错误提示。 | `test_init.py` | **已通过** (离线仿真单测) |
| **退出状态码透传** | 主子进程正常退出（0）或异常退出（7）的状态码原样由 Supervisor 透传。 | `test_init.py` | **已通过** (离线仿真单测) |
| **信号平滑转换** | 接收到外部 SIGTERM 或 SIGINT 时转换为向主子进程 PID 发送单次 SIGINT 触发优雅关闭（不发向进程组），后续重复信号忽略。 | `test_init.py` | **已通过** (离线仿真单测) |
| **阶梯超时与 KILL** | 阻塞子进程按阶梯升级强杀（单测使用内部缩时参数模拟 20s/25s/27s 阶梯逻辑），多次重复信号不重置或延长退出期限。 | `test_init.py` | **已通过** (离线仿真单测) |
| **孤儿进程回收** | double-fork 且脱离会话的后代孤儿进程由 Supervisor 在独立 waitpid 循环中正常回收。 | `test_init.py` | **已通过** (离线仿真单测) |
| **Waitpid 隔离** | Supervisor 的 waitpid(-1) 仅回收自身子进程与被收养孤儿，不抢占主服务内部的 subprocess.wait 结果。 | `test_init.py` | **已通过** (离线仿真单测) |
| **Exec 失败防护** | 子进程 exec 失败时以状态码 127 安全退出，不泄漏参数、异常或环境。 | `test_init.py` | **已通过** (离线仿真单测) |
| **清理保留主状态** | 主子进程提前退出后立即向剩余组发 TERM，至多等待 5s 升级为 KILL 并进行至多 2s 回收（ECHILD 提早结束），最终保留主进程原始退出码。 | `test_init.py` | **已通过** (离线仿真单测) |
| **清理期信号截止期保持** | 清理阶段接收到首个外部 SIGTERM 或 SIGINT 时，保持既定清理截止期不被刷新延长（回归测试）。 | `test_init.py` | **已通过** (离线仿真单测) |

### 3.3 跨语言端到端集成测试 (`tests/integration/`)

采用真实 Python HTTP 服务与 TypeScript 客户端在随机本地端口通信，依托 `EchoRunner` 模拟 Agent 回显（见 `tests/integration/README.md`；注：测试中 `EchoRunner` 回显 inline images 仅作为回显桩测试夹具，绝不代表原生 Gateway 输出附件能力）：

- **场景一（图片多形状流转与边界防护）**：输入阶段前置拒绝非图片文件（TXT/PDF/ZIP 夹具在前置快照阶段被直接拦截）；测试同 PNG 图片在三种输入形态（Data URI、uploadRoots 本地路径、直接 Base64）下的保真传输与私有文件落地（0600 文件 / 0700 目录）；验证客户端 `postAttempted: true` 写前持久化标记；通过人为直接重复 POST 验证服务端幂等复用（返回 202 且不重新触发执行器，证明非客户端自动重投），冲突报文返回 409；验证跨会话隔离，并确认 SQLite 中对话历史（`messages`）明确为空。
- **场景二（HTTP 401 鉴权拒绝）**：携带错误 Token 发起请求，确认 401 被正确脱敏拦截、不创建服务端任务、停止客户端自动重试并向原会话发送一次常规失败通知。
- **场景三（执行器故障隔离与会话延续）**：模拟 Companion 抛错后 Job 失败标记、错误信息脱敏及后续任务队列不受阻断；同 thread 后续任务仍能正常提交并成功执行，历史记录保持为空。

### 3.4 [历史架构] 真实 OpenCode 宿主加载与工具注册验证

在真实隔离的 OpenCode 宿主进程（版本 `2.0.24+de2cacd`）中执行专项冒烟验证，记录如下事实（属于旧版独立 AIAgent 架构证据）：

1. **插件入口解析与激活**：
   - **负控制**：配置指向仓库根目录时，宿主未加载该插件且枚举到的工具数为 0（由于宿主本地目录解析探测 `index.js`/`server.js`，而仓库根目录不含入口文件且会跳过单文件路径）；
   - **正控制**：配置指向编译输出目录 `/.../opencode-hermes-bridge/dist` 时，插件状态确认为 `active`，入口源为 `dist/index.js`，`features.server = true`。
2. **工具列表枚举**：
   - 宿主 `ctx.tool.list()` 正确枚举出 `hermes_ask`、`hermes_status`、`hermes_resume` 三个工具及其完整 Schema 与权限配置。
3. **闭包执行与安全降级**：
   - **无 Token 情况**：直接调用三个工具执行器，均正确触发安全降级响应（提示配置 Bearer Token，且确认未向配置的测试端点发起 HTTP 请求）；
   - **提供测试 Token 情况**：调用 `hermes_status` 成功返回 `[]`，证实 Bridge 实例与底层 storage 初始化正常运作。
4. **测试端点连接观察**：
   - 本地端口监听在激活运行超过 2 个轮询周期（5 秒以上）内观测到针对测试端点的 **0 次连接**，且未向真实 Hermes 发送请求；
   - 验证所启动的 6 个隔离宿主进程在测试结束后均已通过 SIGTERM 正常退出，未对用户持久服务造成任何影响。

### 3.5 [历史架构] 同镜像实际容器 PID 1 守护与生命周期验收 (`hermes-pid1-container-test`)

在与生产一致的固定镜像（Hermes 0.21.5 / Python 3.13.5）及独立隔离 Pod 中，使用未经修改的旧版生产源码（commit `ce8cb6445d9f64d9d2af1d6419f46de6ad97495d`，`init.py` SHA-256 校验一致）执行实机验收（属于旧版独立 AIAgent 架构证据）：

1. **运行环境与安全基线确认**：
   - 进程 UID/GID/fsGroup 均为 10000，`readOnlyRootFilesystem`，drop ALL capabilities（`CapEff: 0000000000000000`），`NoNewPrivs: 1`，`Seccomp: 2` (RuntimeDefault)。
   - 工作区、HOME 与临时目录均为 `0700` 私有权限。
   - 仅限独立 PID 命名空间，`hostPID: false`，`shareProcessNamespace: false`。
2. **真实 PID 1 与独立子进程**：
   - 容器内 PID 1 为 `hermes_bridge.init`，实际主服务为独立子进程（PID 7，PPID 1 `hermes_bridge`）。生产 `init.py` 的 PID 1 守卫在真实环境中成功放行（非 PID 1 启动直接退出并返回 1）。
3. **接口探测与模型零调用**：
   - 环回匿名 `GET /v1/jobs/...` 返回 401；带夹具 Bearer Token 返回 404（路径有效）。全程 0 POST，配置 `HERMES_MODEL=fixture-no-call`；HermesRunner 已构造，但未导入 `run_agent`/`AIAgent`，未调用模型接口。
4. **信号与删除生命周期**：
   - **SIGTERM 退出**：向 PID 1 发送 SIGTERM，容器状态 `Completed`，`exitCode: 0`，restartCount 0（信号发出至观测到终止耗时 2.007s，含 SSH/API 轮询开销）。
   - **Pod 优雅删除**：在 30 秒 TerminationGracePeriod 下执行 `kubectl delete pod`，平滑退出 `exitCode: 0`，确认 `DELETED` tombstone（命令执行至确认 Gone 耗时 1.428s）。
5. **真实 PID 1 下 6 项 Supervisor 核心行为验收**（全部通过，容器 exitCode 0，每项测试结束时 `waitpid(-1, WNOHANG)` 均返回 `ECHILD`）：
   - *Case 1（正常退出码保留）*：主子进程退出码 7 正确保留并透传（实测 0.203s）。
   - *Case 2（子进程 wait 隔离）*：子解释器内部 `subprocess.wait()` 正确捕获退出码 23，supervisor 退出 0，无抢占 wait（实测 0.283s）。
   - *Case 3（Double-fork 孤儿回收）*：孤儿进程脱离会话后被真实 PID 1 收养，自然退出被成功回收，主退出码 7 保留（实测 0.530s）。
   - *Case 4（清理期信号截止期保持）*：主退出后清理阶段接收外部 SIGTERM，保持既定清理截止期不被刷新延长，主退出码 7 保留（内部缩时夹具实测 0.365s；注：该缩时参数仅用于测试加速，非生产默认值）。
   - *Case 5（重复信号平滑转换）*：向 PID 1 发送重复 TERM/INT，仅向主子进程 PID 发送单次 SIGINT（不转发给进程组），正常退出 0（实测 0.731s）。
   - *Case 6（阻塞超时强杀阶梯）*：生产 20s/25s/27s 阶梯下，首个信号后 20.020s 发送组 SIGTERM，25.053s 发送 SIGKILL，强杀退出码 137（提供生产级阶梯时效实测证据）。
6. **资源销毁闭环**：
   - 测试专用隔离命名空间及所有自建对象在测试完成后已彻底清理（`--ignore-not-found` 确认 Gone）。注：上述实测耗时均为单次观测值，不作为性能基准或固定 SLA 承诺。

### 3.6 [历史架构] 生产环境 GitOps 部署与运行时安全验收 (`production-runtime-acceptance`)

生产环境通过 GitOps 完成修补发布与自动化部署，实测确认各项运行时门禁与安全契约（属于旧版独立 AIAgent 架构证据）：

1. **版本发布与源码一致性**：
   - 生产环境通过 GitOps 完成修补上线（commit `6a3d295b0514a6d2124cd15ed3807440f12cd768`），源码标注保持 `ce8cb6445d9f64d9d2af1d6419f46de6ad97495d` 未变；
   - ConfigMap `hermes-bridge-code-48g42k6tc6` 中 6 个源文件哈希与冻结基线完全匹配；
   - 部署镜像严格锁定 digest `nousresearch/hermes-agent:v2026.9.24@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7`。
2. **多层网络与运行时门禁**：
   - 34 项 ACL 规则检查、25 项核心运行时门禁及 10 项附加门禁全数通过；
   - 新 Pod 正常拉起并进入 Ready 1/1，init 容器与主容器 restartCount 均为 0。
3. **工作区目录私有权限加固（0700）**：
   - 保留 Kubernetes `fsGroup: 10000` 设置；
   - 此前卷根目录实测为 `02770`（`fsGroup` 上游存在放宽权限可能），修补后通过 init 容器使用固定目录文件描述符（fd）校验卷根目录属性与所有权并执行 `fchmod(0700)` 安全收紧，三个子目录沿用各自初始化安全检查；
   - 实测确认：`/bridge/state` 卷根目录及 `/bridge/state/jobs`、`/bridge/state/home`、`/bridge/state/hermes-profile` 三个子目录权限均严格为 `10000:10000` / `0700`。
4. **鉴权探测与外部访问边界**：
   - 执行三项固定鉴权探测，结果完全符合协议预期：
     - 匿名 GET 请求响应 `401`；
     - 错误 Bearer Token GET 请求响应 `401`；
     - 正确 Bearer Token 查询固定未知 Job GET 请求响应 `404`；
   - **真实客户端源地址身份未证实（NOTPROVEN）**：鉴权证据中仅记录本地 socket 地址，未关联外部网络五元组证据，HTTP 鉴权成功不推导源地址已被证实；
   - **第二局域网段未运行（NOTRUN）**：第二授权网段（示例 `192.168.10.0/24`）实机互联流量未运行测试，规则配置检查不可替代实际双网段实测。

### 3.7 生产 Hermes Gateway 现场只读探测与身份隔离核验

针对生产运行中的原生 Hermes Gateway 实例，执行受限的只读状态与身份元数据核验：

1. **运行镜像与配置基准**：
   - 原生 Hermes 运行镜像为 `nousresearch/hermes-agent:v2026.9.24`；
   - 环境变量确认：`HERMES_HOME=/opt/data`，记忆提供商配置为 `memory.provider=honcho`；
   - 凭据隔离：`.env` 文件包含有效 `API_SERVER_KEY`，网关本地监听端口 `127.0.0.1:8642`。
2. **Capabilities 接口只读探测**：
   - 匿名访问 `GET http://127.0.0.1:8642/v1/capabilities` 返回 `401 Unauthorized`；
   - 携带合法 Bearer Token（`API_SERVER_KEY`）访问，返回 `200 OK` 且响应体为 `{"object": "hermes.api_server.capabilities", ...}`；
   - 全程仅进行只读能力探测，**未调用任何大模型推理接口**。
3. **Honcho 记忆只读查询与身份边界**：
   - 对既有 root peer 执行精确只读查询响应 `200 OK`，结果为 `items: [], total: 0`（仅证明针对该特定 peer 当前无条目，不代表用户无历史记忆）；
   - **公共源码规则分析**：依据公共代码逻辑，Web PTY internal credential 经 `_methods_browser_control._is_authenticated_identity` 排除，常规新会话可 fallback `peerName`，而微信通道通常基于 `senderID`；上述规则属于源码规范分析，现场实际会话的身份元数据核验仍在推进中，并未完成真实用户 session 证明；
   - **身份与会话边界**：`session_id`（`opencode-<threadId>`）仅用于串联 Gateway 会话上下文。跨入口是否使用同一 Honcho 用户，取决于实际身份解析结果，不能仅凭实例、工作区或客户端名称判断；当前仍待核对。目标是共用同一既有身份，不擅自合并其他用户数据。
4. **上游 SDK 契约参考**：
   - 原生 Gateway 任务运行生命周期遵循 NousResearch/hermes-agent 官方稳定契约（参见 tag `v2026.9.24` [api_server_runs.py](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/gateway/platforms/api_server_runs.py)）。

---

## 4. 真实外部实体与模型联调现状

在受控隔离环境下，此前针对旧版独立 AIAgent 架构执行了最小化联调与显式路由实测。本节保留上述历史证据归属，并总结原生 Gateway 架构下的状态分层与边界：

### 4.1 [历史架构] 最小文本调用与基础交互 (text: PASS)

- **历史调用链路**：在完全隔离的临时环境（独立 HOME、独立测试线程）中，经项目核心链路 `JobService -> HermesRunner -> run_agent.AIAgent` 执行（属于此前版本默认配置的保留证据，不归属当前原生 Gateway 桥接方案）；
- **执行结果**：向真实模型发起 1 次 HTTP 调用并成功返回 200，Hermes 报告 `completed=true`，返回预期的固定回复文本 `HERMES_BRIDGE_SMOKE_OK`；
- **副作用隔离**：单次调用中工具调用数为 0，fallback 激活数为 0；显式跳过了长期记忆持久化、用户 Profile 加载、会话数据库及后台审阅流程，未对已有生产部署或业务状态造成任何修改。

### 4.2 [历史架构] 夹具文件字节双向运输 (fixture file transport: PASS)

- **落盘与运输比对**：输入的测试 TXT 文件与 1×1 像素有效 PNG 文件经 Companion 输入正确写入工作区；测试生成的远端输出文件经序列化传输并在本地回收后，双向 SHA-256 哈希值完全一致（验证了文件描述符读取、规范 Base64 编码、物理文件写入及哈希保真）；
- **特别说明**：
  1. 输出文件的字节内容由测试夹具生成，**不是由 Hermes 模型自主创建**；
  2. TXT 文件的内部内容未交由大模型读取；
  3. 本项测试仅覆盖真实 Hermes Runner / JobService 链与文件运输机制，不包含完整的浏览器/前端 UI 链路。

### 4.3 [历史架构] 模型图片视觉理解 (model image understanding: INCONCLUSIVE)

- **测试现象**：Companion 在构建输入时正确包含了 `image_url`，但 Hermes 0.21.5 在准备底层模型请求时移除了图像片段（image parts）。安全校验 Guard 在请求发送前拦截阻断，因此**没有任何图像数据被送达上游模型**；
- **结论定性**：因图像未送达上游，**无法判定上游模型是否具备视觉理解能力**。隔离的临时 HOME 未配置视觉能力覆盖项且模型元数据探测被禁用，此结果反映的是特定测试环境配置约束而非模型不支持；
- **资源清理**：图像任务在 120 秒未取得终止状态后，监管进程终止了自建进程组，并完整清理了所有自建目录与相关进程，未追加额外模型调用。

### 4.4 真实宿主 UI 与权限交互 (full UI: NOT RUN)

- **当前 Gateway 链路状态**：未运行宿主 UI 与权限交互全链路测试。旧架构已验证宿主加载、工具枚举及简单真实工具回传；这些历史证据不替代新 Gateway 链路的验收，也不证明权限弹窗与前端渲染等全部交互均已验证。

### 4.5 [历史架构] 显式模型路由短文本实测 (explicit routing smoke: PASS)

- **测试环境与路由配置**：2026-10-11 在旧版生产部署环境中执行单次短文本实机调用；显式配置 `provider: custom`、`api_mode: chat_completions`、网关 Aether、模型标识 `z-ai/glm-5.3-flash`（属于旧版独立 AIAgent 架构保留证据，不代表当前原生 Gateway 桥接方案）；
- **执行过程与关键数据**：
  - 单任务提交：1 次 POST 请求返回 Accepted，随后进行 16 次同 ID GET 轮询探测，最终状态确认为 `completed`；
  - 任务耗时：总耗时 30.741s（单次 HTTP <= 10s，轮询间隔 >= 2s，在 180s 任务预算内）；
  - 标记比对：验证模型返回文本去除首尾空白后等于固定标记 `HERMES_BRIDGE_OK`；
  - 产物与错误：`attachments` 为空，`error` 为空，安全错误码为 `NONE`；
  - 测试期间未做任何配置、环境、代码或 Pod 变更，服务 0 重启；
- **技术约束与未证实边界**：
  - 单任务不保证底层 SDK 内部仅调用了一次 HTTP 推理请求；
  - 单任务仅验证了特定网关与模型通道通畅，不声称对任意第三方模型网关或未测试模型具备通用兼容性；
  - 真实入站源地址仍为 **NOTPROVEN**，第二网段 `192.168.10.0/24` 实机流转仍为 **NOTRUN**；
  - 不包含真实 OpenCode 宿主界面的自动回投或模型自主工具选择。

### 4.6 状态分层汇总

| 验证维度 | 测试状态 | 说明 |
| :--- | :--- | :--- |
| **Gateway 方案离线测试** | **PASS** | TS 27 项 / 330 断言全过，Python 29 项单测全过（全本机 fake，覆盖 API 契约与断 202 恢复） |
| **原生 Gateway 现场探测** | **PASS** | 生产 Pod 环回 8642 端口，capabilities 探测响应 200，无模型调用 |
| **[历史架构] 文字指令回复** | **历史 PASS** | 2026-10-10 历史独立 AIAgent 架构联调证据：1 次真实模型 HTTP 200 调用 |
| **[历史架构] 夹具文件传输** | **历史 PASS** | 2026-10-10 历史证据：TXT / PNG 落地与传输 SHA-256 匹配（夹具生成） |
| **[历史架构] 容器 PID 1 验收** | **历史 PASS** | 2026-10-10 历史证据：真实容器 PID 1 守护契约与删除全通过（0 POST，未调模型） |
| **[历史架构] 生产 GitOps 部署** | **历史 PASS** | 2026-10-11 历史证据：commit `6a3d295` 部署生效，34 ACL + 25 runtime + 10 附加全过，目录 0700 收紧 |
| **[历史架构] 显式路由单任务** | **历史 PASS** | 2026-10-11 历史证据：Aether + `z-ai/glm-5.3-flash` 返回 `HERMES_BRIDGE_OK` |
| **原生 Gateway 模型真实调用** | **NOT RUN** | 当前新架构尚未在生产环境通过 Gateway 桥接执行真实模型推理任务 |
| **生产 Gateway 桥接部署 (Sidecar)** | **NOT RUN / NOT DEPLOYED** | Sidecar 方案仅为建议方案，尚未在生产环境部署、重启或提交 |
| **模型图片视觉理解** | **INCONCLUSIVE** | 图像在发送前被 Hermes 移除，未送达上游模型，不可得出结论 |
| **普通文件与输出附件能力** | **UNSUPPORTED** | 普通非图片文件提交前直接拦截；原生 Gateway 暂无输出附件传输契约（MEDIA 报 `unsupported_output` 失败） |
| **跨入口既有身份/记忆一致性** | **NOT PROVEN** | 长远目标是共用同一既有身份而非自动合并记忆；需身份映射匹配，连接同一 Gateway 不自动保证记忆共享 |
| **第二局域网段实机数据流转** | **NOT RUN** | 规则检查不可替代双 LAN 实测，第二授权网段（示例 `192.168.10.0/24`）实机互联流量未运行 |
| **入站客户端外部源地址证实** | **NOT PROVEN** | 证据仅含本地 socket 地址，未关联外部网络五元组，客户端外部真实源地址身份未证实 |
| **宿主全链路 UI 回投与自主工具** | **NOT RUN** | 尚未在真实聊天 UI 与自主模型决策场景中联调（旧架构曾验证简单工具回传，新 Gateway 链路尚未运行测试） |

---

## 5. 已知工程限制与技术边界

1. **单次 Native POST 与弱交付语义**：Companion 对 Gateway 的原生 POST 每任务至多执行 1 次。若 POST 遇到网络断连或未获得合法 202 响应，状态保守置为 `failed`（错误码 `gateway_outcome_unknown`，客户端轮询恒返回 HTTP 200）并不自动重放（不承诺严格 exactly-once）。任务在写入会话队列与本地 Outbox 标记为 `delivered` 之间若宿主异常退出，可能导致重复投递通知，消费方需基于 Job ID 识别幂等性。
2. **身份隔离与 Honcho 记忆边界**：本次既有 Gateway 配置使用 Honcho，目标是**共用同一既有用户身份**。需区分用户 peer 与客户端/助手 peer，并核对入口身份、别名及默认值的实际解析结果；客户端名称不同不代表用户不同。当前跨入口映射仍待确认，不据此修改或合并身份数据。
3. **格式与附件能力边界**：当前输入附件严格限定为图片格式（PNG/JPEG/GIF/WebP），普通文件（PDF/ZIP/TXT 等）在提交前直接拦截；原生 Gateway `/v1/runs` 暂无输出附件传输契约，模型输出若含 `MEDIA:...` 则置为 `failed`（错误码 `unsupported_output`，客户端查询恒返回 HTTP 200）。此外，原生 Gateway 规范报文受 `MAX_NATIVE_BODY = 10,000,000 字节` 硬上限约束，超限直接失败。系统不读取原生 Gateway 容器内部文件系统，不假装已有普通文件理解或模型自主输出附件能力。
4. **Outbox 存储膨胀**：当前 Outbox 数据持久化保留于宿主存储中，未内置定时自动清理策略，需注意会话长期使用的存储容量。
5. **网关路由与当前代码边界**：当前代码实现已切换为 `GatewayRunner` 对接原生 Gateway `/v1/runs`（注意生产环境尚未部署/重启生效），旧版显式模型路由环境变量组与 `--model` 选项均已废弃；Sidecar 部署方案仅为建议方案，尚未在生产环境执行部署、重启或提交；宿主交互式会话中的模型自主工具调用、权限弹窗及自动回投全链路 UI 未运行测试（插件端到端连接及宿主交互验证尚未完成）。
6. **容器 PID 1 守护入口实机验收与生产边界**：`hermes_bridge.init` 在同镜像真实容器 PID 1 环境下的进程形态、6 项 supervisor 契约、优雅终止及 Pod 删除已完成实机验收并全部 PASS。在生产 Kubernetes 部署中，此前卷根目录实测为 `02770`（`fsGroup` 上游存在放宽权限可能），修补后通过 init 容器使用固定目录文件描述符校验卷根目录并安全收紧为 `0700`（`10000:10000`），三个子目录沿用各自初始化检查，保证工作区全路径严格私有；编排层仍须保持 `hostPID: false`、`shareProcessNamespace: false` 并配置充足的终止宽限期（建议 30s）。当前测试覆盖了孤儿自然退出的回收，对脱离会话逃逸的后代仍依赖容器退出时内核清理 PID 命名空间；单次实测耗时受网络与 API 轮询影响，不作为固定性能 SLA 承诺。
