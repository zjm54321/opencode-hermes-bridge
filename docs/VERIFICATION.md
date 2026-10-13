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

本轮统一验证的 28 项测试、主/MCP 类型检查、静态检查、plugin/MCP 隔离构建及 MCP bundle 启动 smoke 均通过，live dist 两项 SHA 保持不变；这些结果不代表真实 Tunnel/ChatGPT、root/CSI/PV 或生产部署验收。静态检查允许模板占位值并提醒填写，不执行部署；初始化 fixture 不替代真实 root/CSI/PV 验证。

## 已有事实

- 原生产 Sidecar 文本/图片链路此前已通，直连原 Gateway，保留原 profile。
- 真实隔离 OpenCode 2.0.27 曾通过 MCP 工具与 `read_mcp_resource` 收到 318 字节 ZIP，解码后原件 SHA-256 一致。**该 ZIP 验收的 Gateway/model 是 fixture**，不代表真实模型生成文件或真实 ChatGPT 验收；宿主 `automaticFileSave=false`。
- 当前完整文件 Companion / `hermes_file_plugin` 与 MCP 仍为未部署源码，生产仍是此前文本/图片 Sidecar。

## 未验事项与发布前提

- 真实 ChatGPT Tunnel、账户权限、附件自动绑定与原件读取/保存行为尚未验收；传输成功不等于模型理解内容或客户端自动落盘。
- root→10000 权限处理、真实 CSI/PV、目标 CNI 与 DNS/后端/出站规则尚未实测。
- 完整文件功能需另行在保留原 profile/身份前提下升级后端并安装启用文件插件。`GET /v1/capabilities` 的 `assets: true` 只证明资产接口开启，不证明插件启用或模型成功调用。
- 模板的 owner、Tunnel ID、独立存储、可信镜像 digest 与外部 Secret 须在实际使用前填写并核对；文字-only 验收不能宣称完整文件就绪。

配置见 [私有隧道指南](PRIVATE_TUNNEL.md)；原件传输与插件前提见 [文件指南](FILE_TRANSFER.md)；未知提交不重投、凭据 scope 与旧 jobs 保护见 [通信协议](PROTOCOL.md)。
