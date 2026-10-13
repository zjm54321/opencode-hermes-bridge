<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# ChatGPT Secure MCP Tunnel 私有隧道接入指南

本文档介绍针对个人使用场景下，将 Hermes MCP 服务通过 OpenAI 官方 Secure MCP Tunnel 接入 ChatGPT 网页端（Business / Enterprise 工作区）的架构规范、环境契约与部署边界。

> **方案定位与区别说明**：
> - **官方原生隧道**：采用 OpenAI 官方 [tunnel-client](https://github.com/openai/tunnel-client) 建立出站隧道，**而非 Cloudflare Tunnel、Cloudflare Access 或 Turnstile 方案**；
> - **免独立 IdP**：在 ChatGPT 网页端添加应用时选择 **Tunnel** 配合 **No authentication**；无需搭建 Auth0、Keycloak 等独立 OAuth 授权服务器，亦无需处理验证码；
> - **状态说明**：本文档描述的是源码已审定的契约规范与离线配置模板；当前生产环境尚未部署上线，尚未连接真实 ChatGPT 账户实测。

---

## 1. 架构拓扑与信任模型

`tunnel-client` 作为出站客户端主动连接 OpenAI 控制面，MCP 边缘服务仅监听在本地回环地址（`127.0.0.1`），不向公网暴露任何 HTTP(S) 端口。

```text
+----------------------------+
| ChatGPT 网页端 (Client)     |
| (应用连接选 Tunnel / No Auth)|
+-------------+--------------+
              │ (OpenAI 平台受控出站隧道)
              ▼
+--------------------------------------------------------------------------------+
| 新建私有 MCP Pod (共享 Localhost 回环，无 Service / Ingress / hostPort)           |
|                                                                                |
|  [openai/tunnel-client:v0.0.16] (只读挂载 API Key 文件，主动连接 OpenAI 控制面)       |
|              │                                                                 |
|              │ HTTP POST 127.0.0.1:8790/mcp (仅限本地环回，无外部网络暴露)          |
|              ▼                                                                 |
|  [hermes-mcp (HERMES_MCP_AUTH_MODE=private-tunnel)]                            |
|  (固定单 Owner 身份: urn:hermes-mcp:private-tunnel:v1 + sha256(JSON([owner,id])))|
+--------------------------------------------------------------------------------+
              │
              │ 集群内部 DNS HTTP (http://hermes-bridge.ai-services.svc.cluster.local:8787)
              ▼
+--------------------------------------------------------------------------------+
| 既有生产 hermes-agent Pod (已部署的 Sidecar 架构，保持原实例、配置与记忆)           |
|                                                                                |
|  [hermes-bridge (Companion 8787)] <--- loopback ---> [Hermes Gateway (8642)]    |
+--------------------------------------------------------------------------------+
```

### 访问控制与安全边界

1. **单 Owner 信任域**：
   - 在 `private-tunnel` 模式下，MCP 服务不对每个外部请求进行单独的用户鉴权；凡通过该安全隧道到达本地回环端口的调用，均等价于同一个预配置的固定 Owner（`HERMES_MCP_PRIVATE_OWNER`）；
   - 单 Owner 身份仅用于 MCP 任务账本归属，不直接证明原 Hermes 用户身份，亦不直接改变或隔离其既有记忆与 profile；
   - 若在 ChatGPT 企业工作区中将该 App 共享给其他成员，其他成员调用该应用时也将访问同一个固定 Owner 的上下文。因此该应用必须严格限制为个人使用。
2. **凭证分层与保护**：
   - **OpenAI 控制面 API Key**：仅用于 `tunnel-client` 向 OpenAI 证明客户端身份；该密钥通过只读 Secret 文件注入容器，**严禁**直接暴露在命令行参数（argv）、聊天窗口或 Git 仓库中；
   - **Bridge 令牌**：MCP 容器仅持有访问既有 Bridge 服务的 `HERMES_BRIDGE_TOKEN`，两类凭据仅在各自对应容器中挂载或注入，不交叉提供；
   - 密钥轮换时，更新密钥文件并重启 `tunnel-client` 即可，不会改变既有的任务账本归属。

---

## 2. 服务端配置契约 (`HERMES_MCP_AUTH_MODE=private-tunnel`)

当设置 `HERMES_MCP_AUTH_MODE=private-tunnel` 时，服务切换为私有隧道认证模式（缺省仍为 `oauth` 公网模式）。

### 2.1 环境变量配置列表

| 变量名 | 必填 | 默认值 | 说明与约束 |
| :--- | :--- | :--- | :--- |
| `HERMES_MCP_AUTH_MODE` | 是 | `oauth` | 设为 `private-tunnel` 启用私有隧道模式 |
| `HERMES_MCP_PRIVATE_OWNER` | 是 | - | 固定个人所有者标识（非空字符串，<= 256 UTF-8 字节，无控制字符，非 Honcho peer 配置） |
| `HERMES_MCP_TUNNEL_ID` | 是 | - | OpenAI 控制面分配的 Tunnel ID（格式必须严格为 `^tunnel_[a-z0-9]{32}$`） |
| `HERMES_MCP_HOST` | 否 | `127.0.0.1` | 监听地址，**只能设为 `127.0.0.1` 或 `::1`**（拒绝任何通配绑定） |
| `HERMES_MCP_PORT` | 否 | `8790` | 监听端口 |
| `HERMES_MCP_STATE_DIR` | 是 | - | 状态持久化目录（权限必须为 `0700`，内含 `state.json` 与 `writer.lock`） |
| `HERMES_MCP_FILE_ORIGINS` | 否 | `[]` | 输入文件 HTTPS Origin 白名单（JSON 数组，缺省 `[]` 禁用文件下载） |
| `HERMES_MCP_HTTP_DOWNLOADS`| 否 | `0` | **必须为 `0`**（私有隧道模式下禁用独立 HTTP 下载能力链接） |
| `HERMES_BRIDGE_URL` | 否 | `http://127.0.0.1:8787` | 后端 Bridge 服务地址（在 K8s 内部指向既有集群服务 DNS） |
| `HERMES_BRIDGE_TOKEN` | 是 | - | 访问既有 Bridge 服务的 Bearer Token |

### 2.2 运行特性与协议行为

1. **元数据发现行为**：
   - 私有隧道模式下，服务**不构造 JWT 校验器、不拉取远程 JWKS、不返回 401 质询头**；
   - 访问 `GET /.well-known/oauth-protected-resource` 预期返回 `HTTP 404 Not Found`（符合官方 `sample_mcp_remote_no_auth` 规范）。
2. **主体身份与账本保护防篡改**：
   - 内部主体固定为 `issuer: "urn:hermes-mcp:private-tunnel:v1"`, `subject: sha256(JSON.stringify([privateOwner, tunnelID]))`；
   - 若状态目录内已有历史账本，当启动时检测到认证模式、所有者或 Tunnel ID 发生变更时，**服务拒绝启动**以防账本跨主体污染；严禁直接删除数据库或指向空目录来绕过校验，必须由人工审计或迁移历史任务；
   - 该固定身份仅用于 MCP 内部任务账本归属，不改变既有 Hermes 容器的原生 profile 与 Honcho 记忆。
3. **输出格式**：
   - 产物默认通过 MCP 原生 `resources/read` 交付原始字节；服务不保证 ChatGPT 网页端会自动呈现原生附件卡片，复杂文件交付与模型阅读理解属于不同层级。

---

## 3. 官方 Tunnel-Client 容器规范

客户端采用 OpenAI 官方发布的容器镜像，镜像版本与内容已经公共镜像库校验。

### 3.1 镜像基准

- **镜像标识**：`ghcr.io/openai/tunnel-client:v0.0.16@sha256:4605ea909701668d3bdcbe6152558e068e24006aa96ca5518ca67f786a1bce13`
- **提交哈希**：commit `5f99daabd4aa4a77049e6d81d54a0d8c18335397`
- **官方入口**：容器 `ENTRYPOINT` 已固化为 `/usr/bin/tunnel-client run`

### 3.2 运行参数与环境变量

```yaml
# 容器命令行参数 (优先以文件方式挂载 API Key，避免进程参数泄漏)
args:
  - "--control-plane.api-key=file:/run/secrets/tunnel_api_key"

# 容器环境变量
env:
  - name: CONTROL_PLANE_TUNNEL_ID
    valueFrom:
      configMapKeyRef:
        name: hermes-mcp
        key: tunnel-id
  - name: MCP_SERVER_URL
    value: "http://127.0.0.1:8790/mcp"
  - name: HEALTH_LISTEN_ADDR
    value: "127.0.0.1:8080"
  - name: ALLOW_REMOTE_UI
    value: "false"
  - name: OPEN_WEB_UI
    value: "false"
```

---

## 4. Kubernetes 协同编排模式规划 (模板设计)

部署规划由 `deploy/private-tunnel/` 目录提供离线验证模板，采用单个受控 Pod，由 MCP 服务与 `tunnel-client` 作为两个协同容器共享网络命名空间（Localhost 环回）：

### 4.1 模板文件结构与六大资源

- **文件清单**：
  - `Dockerfile`：多阶段构建，强制要求 `BUN_IMAGE` 与 `SOURCE_REVISION` build args，从干净源码编译 `/image-app`，绝不拷贝旧 `dist/`；
  - `base/kustomization.yaml` 与 `base/resources.yaml`：采用 YAML 1.2 的 JSON 子集格式，包含 Kustomize 渲染所需的 6 个核心资源：
    1. `ServiceAccount`（`hermes-mcp`，禁用 token 自动挂载）；
    2. `ConfigMap`（`hermes-mcp`，包含 `auth-mode`、`private-owner`、`tunnel-id` 及 `file-origins`）；
    3. `PersistentVolumeClaim`（`hermes-mcp-private`，专用 PVC 存储状态与产物）；
    4. `Deployment`（`hermes-mcp`，Recreate 策略，双 initContainers 与双应用容器）；
    5. `NetworkPolicy`（默认拒绝所有入站，严格限制出站至 DNS、公网 443 及同命名空间 `hermes-agent:8787`）；
    6. `NetworkPolicy`（增量后端规则，仅允许同命名空间 `hermes-mcp` 访问 `hermes-agent:8787`，现有 LAN 规则完全保持不动）；
  - `volume-init.mjs` 与 `probe.mjs`：卷安全初始化脚本与就绪探测脚本；
  - `check.py`、`check.test.py`、`volume-init.test.mjs`：离线静态检查与仿真测试脚本；
  - `secrets.yaml.example` 与 `release-inputs.json.example`：仅含空 schema 的示例占位文件，`base` 清单绝不包含 Secret。

### 4.2 存储安全与权限分层

- **根初始化阶段 (`volume-roots`)**：Root UID 0 执行，仅赋予 `CHOWN` 与 `FOWNER` 权限并丢弃所有其他 capability，通过 `O_NOFOLLOW` 安全文件描述符校验空目录，设置 `chmod 0700` 与 `fchown 10000:10000`；
- **非 Root 初始化阶段 (`volume-private`)**：以 UID/GID 10000 运行，在卷内创建 `state` 与 `outputs` 目录（运行容器挂载路径为 `/private/state`、`/private/outputs`，权限 `0700`），并最后写入绑定标记文件（`0600`，持久化 `sha256(JSON.stringify([owner, tunnelID]))`）；
- **严禁越界与复用**：状态与产物必须使用独立的专用 PVC，绝对禁止复用、挂载或克隆原 Hermes profile 目录。

### 4.3 离线验证命令与发布门禁

本模板目前处于离线验证准备阶段。除实际 Tunnel ID 与生产密钥外，`StorageClass`、所有者标识 `owner`、经独立核实的 Bun 1.4.2 镜像 digest、构建后的 MCP 镜像 digest 及最终源码版本 `SOURCE_REVISION` 也尚待填入验证（具体填值流程详见 `deploy/private-tunnel/handoff.json` 步骤）。**请勿在生产环境执行发布操作**。可执行以下离线命令校验模板结构：

```bash
# 执行本地静态合规检查
python3 deploy/private-tunnel/check.py

# 渲染 Kustomize 本地清单 (6 个资源)
kustomize build deploy/private-tunnel/base
```

> **全量文件发布硬门禁说明**：
> 1. 当前生产环境仍运行文本+图片 Sidecar 基线；
> 2. 双向完整原文件流转依赖在保留原 profile 与身份前提下，另行部署新版 Companion 文件资产层和 `hermes_file_plugin`、`GET /v1/capabilities` 明确返回 `assets: true`（仅代表 Bridge 资产传输通道可用，不代表模型已成功调用文件插件）、以及 ChatGPT 真实原文件往返验收；
> 3. 本部署模板仅用于 MCP + Tunnel 协同，不包含后端升级 overlay，不暗示全栈生产已就绪。文字任务可独立验收。

---

## 官方参考来源

- [OpenAI Tunnel Client Docker 部署文档](https://github.com/openai/tunnel-client/blob/5f99daabd4aa4a77049e6d81d54a0d8c18335397/docs/deployment/docker.md)
- [OpenAI Tunnel Client 配置与 Profile 源码](https://github.com/openai/tunnel-client/blob/5f99daabd4aa4a77049e6d81d54a0d8c18335397/cmd/client/profile_samples.go)
- [ChatGPT 自定义 MCP 连接选项](https://developers.openai.com/api/docs/guides/custom-mcp-server#how-to-use)
- [OpenAI 官方 Secure MCP Tunnels 文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
