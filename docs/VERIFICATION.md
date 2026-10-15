<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# OpenCode Hermes Bridge 验证与测试现状

本文档区分既有验证事实与尚未验证的部署边界；历史详细报告保留于 Git 提交历史中。

## 核心检查命令

在项目根目录的 `nix develop --offline --no-update-lock-file` 环境中运行：

```bash
bun run typecheck
bun run typecheck:mcp
bun test tests/unit
bun run test:integration
bun run test:mcp
PYTHONPATH=companion PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s companion/tests -v
python3 -B deploy/private-tunnel/check.py
bun test deploy/private-tunnel/volume-init.test.mjs
```

历史统一验证记录包含 28 项基线测试。本轮针对来源说明功能，主工程/MCP 类型检查、7 项单元测试、7 项 MCP 测试与 2 项集成测试（共 16 项）及双隔离构建均通过，Python/deploy 复用既有验证证据；测试与构建阶段未修改 live dist，验收后另行更新了运行版本。

## 已有事实

- 原生产 Gateway 保留原 profile，文本/图片链路与 `hermes_file_plugin` 均已上线。
- 真实隔离 OpenCode 2.0.27 曾通过 MCP 工具与 `read_mcp_resource` 收到 318 字节 ZIP；该次 Gateway/model 为 fixture，未自动保存文件。后续生产链路中 OpenCode 已成功完成 162 字节原 ZIP 往返并保存原件（SHA-256 为 `759dab247ae6e26389fea5716a439beaa128485bfc8c0c37c77b61881922e0e4`）。
- 来源说明上线后，OpenCode 仅重启一次，95 个插件恢复正常、服务配置未变；真实请求中 Hermes 正确识别了 OpenCode、编程用途及代理转交身份。
- 私有 Tunnel 具备上一轮真实的 ChatGPT 文字链路验证；本轮部署（source `6395de7`、GitOps `f23a344a`、MCP 镜像 `c08e3794e88604225339bbf2fff3818b423c4792b33993b89e71a1ff864e76af`）经 runtime bundle 与健康检查均通过，本轮未再次发起 ChatGPT 调用。
- 专属 PV Bound、private 700、uid 10000 运行与 root init 容器曾通过真实 CI 与线上环境验证（但不代表覆盖所有第三方 CSI/CNI 组合与文件类型）。

## 未验事项与发布前提

- 真实 ChatGPT 侧的附件自动绑定、原件读取与自动保存行为仍未实测；传输成功不等于模型能正确理解内容。
- 生产特化配置（如专属 owner、Tunnel ID 与外部 Secret）不作为通用部署模板的默认保证，使用模板前仍须核对填写。

配置见 [私有隧道指南](PRIVATE_TUNNEL.md)；原件传输与插件前提见 [文件指南](FILE_TRANSFER.md)；未知提交不重投、凭据 scope 与旧 jobs 保护见 [通信协议](PROTOCOL.md)。
