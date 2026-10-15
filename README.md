<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# OpenCode Hermes Bridge

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

OpenCode 原生工具和 ChatGPT 私有 MCP 隧道连接同一个 Hermes Gateway。长任务通过状态查询与结果工具取回，不新建 Agent 或 profile。OpenCode 的原字节文件通道与 ChatGPT 私有 MCP 已部署；ChatGPT 自动文件交接仍待实测。

新任务入队前按 OpenCode / ChatGPT 入口自动添加固定代理与能力说明，并在 `[任务正文]` 后逐字保留原文；64 KiB UTF-8 文字限额包含说明。说明只供理解任务来源，不属于身份认证或权限授予，不改变记忆身份（Honcho 映射），也不补写旧任务。该功能已在两端上线：实测 Hermes 正确识别了 OpenCode 来源与用途；ChatGPT 侧本轮仅验证运行中构建产物与健康状态，未新发请求。

- 开源协议：GPL-3.0-or-later
- 代码仓库：[https://github.com/zjm54321/opencode-hermes-bridge](https://github.com/zjm54321/opencode-hermes-bridge)

## 1. 运行环境与安装构建

项目基于 Nix Flake 声明基础运行环境（Node.js 24 / Bun 1.4 / Python 3.14 stdlib）。Companion 仅使用 Python 3.11+ 标准库，不导入 Hermes Agent 推理包，亦不读取本地 profile。

在项目根目录下执行开发检查与隔离构建：

```bash
nix develop --command bun install --frozen-lockfile
nix develop --command bun run typecheck
# 仅改变输出目录，保留插件的 Node 目标与外部 SDK
nix develop --command bun build src/index.ts src/core.ts --target=node --external @opencode/plugin --outdir=/tmp/opencode/hermes-plugin-build
```

测试命令见 [验证现状](docs/VERIFICATION.md)。隔离构建不覆盖现有 `dist/`，不自动注册测试产物；替换实际插件目录属于另行部署。

## 2. Companion 启动配置

```bash
export BRIDGE_REPO="/absolute/path/to/opencode-hermes-bridge"

# Gateway 基础地址与 API Server Token（来自 Gateway 的 API_SERVER_KEY）
export HERMES_GATEWAY_URL="http://127.0.0.1:8642"
export HERMES_GATEWAY_TOKEN="your-gateway-api-server-token"

# 客户端访问 Companion 所需的独立 Bridge Token
export HERMES_BRIDGE_TOKEN="your-secure-bridge-token-without-spaces"

PYTHONPATH="$BRIDGE_REPO/companion${PYTHONPATH:+:$PYTHONPATH}" \
  python3 -m hermes_bridge \
  --host 127.0.0.1 \
  --port 8787 \
  --workspace "$HOME/.local/share/opencode-hermes-bridge"
```

以上令牌为占位值，实际凭据通过安全环境注入。文件功能还需配置并安装 [Hermes 文件插件](docs/FILE_TRANSFER.md)，仅启动 Companion 不等于文件后端已就绪。

容器作为真实 PID 1 时可使用 `python -m hermes_bridge.init`；普通本地运行仍使用 `python -m hermes_bridge`。工作区与任务账本应持久保留，详细接口及恢复约束见 [通信协议](docs/PROTOCOL.md)。

## 3. OpenCode V2 插件注册与配置

插件使用 `@opencode/plugin 2.0.24` SDK。在 OpenCode 配置文件中通过原生 `plugins` 数组显式加载（不是 MCP server 配置）。支持在线 npm 包加载（发布后）或指向本地开发构建目录：

```json
{
  "plugins": [
    {
      "package": "opencode-hermes-bridge@latest",
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

- `package`：在线加载时填写 npm 包名（如 `opencode-hermes-bridge@latest` 或固定版本号）；本地开发调试可沿用构建产物目录的绝对路径，例如 `/absolute/path/to/opencode-hermes-bridge/dist`。从本地切换至 npm 时请**替换原有条目而非追加**，避免 Duplicate plugin ID。打包与发布流程见 [NPM 接入与发布指南](docs/NPM.md)。
- 严禁在 `options` 中填写 `token`；`tokenEnv` 是承载 Bearer Token 的环境变量名称，默认 `HERMES_BRIDGE_TOKEN`。
- `options` 优先于环境变量。`url` 对应 `HERMES_BRIDGE_URL`，仅允许无凭据、查询串或子路径的 HTTP(S) Origin；`uploadRoots` 对应 JSON 数组 `HERMES_BRIDGE_UPLOAD_ROOTS`，默认 `[]` 禁用本地路径读取，`base64` / `data` 不受路径白名单限制。
- `outputDir` 对应 `HERMES_BRIDGE_OUTPUT_DIR`，默认 `$XDG_STATE_HOME/opencode-hermes-bridge/outputs`，缺省为 `~/.local/state/opencode-hermes-bridge/outputs`。路径相对当前工作区解析，推荐绝对路径。

> `HERMES_BRIDGE_TOKEN` 必须注入 **OpenCode 后台服务环境**。仅为 Companion 设置 export 不会同步至已启动的宿主；更新环境变量需要重启后台服务（如 `opencode service restart`），仅重启 TUI 不足以生效。`HERMES_GATEWAY_URL` 与 `HERMES_GATEWAY_TOKEN` 只属于 Companion 环境，不应注入 OpenCode 宿主。

## 4. 插件工具

执行结果直接返回标准 `Tool.Result`，不向聊天流注入伪提示。

| 工具 | 参数与行为 |
| :--- | :--- |
| `hermes_ask` | `text` 必填；`attachments` 为图片，`files` 为普通文件；`requireFiles` 要求文件能力；`waitSeconds` 为 0..120，默认 30。超时返回状态与 Job ID。 |
| `hermes_result` | `id` 必填；`waitSeconds` 默认 0。取回已持久化结果，下载输出资产，不重复 POST。 |
| `hermes_status` | `id` 可选；仅读当前会话本地 Outbox，不发起 HTTP，不跨会话读取。 |
| `hermes_resume` | `id` 必填；对暂停或失败任务沿用原 UUID 恢复 GET 轮询，不重新提交。缺少 scope 或 URL/Token 变化的旧任务保持暂停。 |

双向原文件用法、配额、`files` / `attachments` 示例与 `requireFiles` 前提见 [文件传输指南](docs/FILE_TRANSFER.md)。未知提交结果不能靠更换 UUID 自动重投；原任务与历史 jobs 必须保留，恢复合同见 [通信协议](docs/PROTOCOL.md)。

## 5. ChatGPT 私有 MCP 隧道

`mcp/` 提供标准 Streamable HTTP `/mcp` 服务（`bun run mcp:start`），支持 `hermes_submit`、`hermes_status`、`hermes_result` 三项工具与原生 Resources 原字节交付。

在 ChatGPT 网页端选择 **Tunnel + No authentication**，通过官方出站 `tunnel-client` 连接本地回环 MCP，不开放公网服务。配置与离线模板见 [私有隧道指南](docs/PRIVATE_TUNNEL.md)。这是个人单 Owner 信任域，不构成多租户隔离。

## 6. 安全与验证边界

- Companion 与 MCP 不是 Hermes 系统权限沙箱；Hermes 仍拥有宿主赋予的工具权限。
- 复用原 Gateway 与 profile 不保证不同渠道共享同一聊天 session 或 Honcho peer；长期身份与账户权限须另行核对，不自动合并其他用户记忆。
- Bridge HTTP 仅用于受信网络并配置访问控制；不可信网络需要 TLS 或加密隧道，严禁直接暴露管理端口。
- 已完成 OpenCode 原字节 ZIP 往返及 ChatGPT 私有 Tunnel 文字调用；两端来源说明已上线（OpenCode 端已实测，ChatGPT 侧本轮已过健康检查未新发请求）；ChatGPT 自动文件交接仍待实测。详细边界与检查命令见 [验证现状](docs/VERIFICATION.md)。
