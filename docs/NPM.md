<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# OpenCode Hermes Bridge NPM 接入与发布指南

本文档说明 `opencode-hermes-bridge` 的 npm 运行配置、本地打包验证、首次发布与 GitHub Actions OIDC 自动化发布流程。

> **当前状态**：0.1.0 已在 npm 公开发布，GitHub Trusted Publisher 已配置发布权限；0.1.1 的 GitHub CI 因测试临时目录缺失而失败，未执行发布；0.1.2 修复 CI 目录准备，**首次 OIDC 发布仍待下轮 CI 验证**。

## 1. 架构定位与 OpenCode 配置

- 本包为 OpenCode 原生插件（Native Plugin），**不是 MCP Server**。
- 安装该 npm 包仅加载客户端集成工具，**不等于启动 Hermes Gateway 或 Companion 后端**，亦不会新建独立的 Agent 或 profile。
- 包导出编译后的 Node 目标，默认导出 `Plugin.define`（插件 ID 保持为 `hermes-bridge`），外部依赖 `@opencode/plugin 2.0.24`。

在 OpenCode 配置文件中配置：

```json
{
  "plugins": [
    {
      "package": "opencode-hermes-bridge@latest",
      "options": {
        "tokenEnv": "HERMES_BRIDGE_TOKEN"
      }
    }
  ]
}
```

- **切换规则**：从本地 `dist` 路径切换至 npm 包时，必须**直接替换原有条目而非追加**，避免 Duplicate plugin ID 报错。
- **状态说明**：当前生产仍使用本地部署，并未切换至 npm 包；切换前不搬迁或删除旧记录，切换时核验 Outbox 账本仍可读取。上例沿用服务环境中的 `HERMES_BRIDGE_URL`。
- **生命周期机制**（依据 [OpenCode Plugins 规范](https://opencode.ai/v2/docs/plugins/)）：
  - 启动阶段仅检查（check）未固定版本的更新，**不自动执行安装**。
  - 使用 `opencode plugin check` 检查更新，使用 `opencode plugin update <package>` 执行更新；配置固定版本号时将跳过检查。
  - 配置热重载依宿主实现而定，必要时需执行 `opencode service restart`，不保证全量热更。

## 2. 本地打包验证机制

仓库提供了自动化打包检查脚本 `scripts/package-native.mjs`，在 Node >= 22.14.0（当前环境为 Node 24 / Bun 1.4.2）下运行：

```bash
nix develop --command node scripts/package-native.mjs /tmp/opencode/hermes-npm-release-0.1.2
```

- **执行约束**：指定的目标输出目录必须预先不存在，避免污染已有数据。
- **校验流程**：脚本会在干净隔离目录中执行构建、生成真实 `.tgz` 压缩包、解包校验结构，并在临时 consumer 环境中通过独立 cache 与空 `.npmrc` 安装并验证 `import` 加载。
- **产物位置**：产物输出于 `<outdir>/opencode-hermes-bridge-0.1.2.tgz` 与 `package-report.json`。该脚本不执行 `npm publish`，不覆盖仓库 `dist/`，无需 npm 登录态。

## 3. 首次手动发布（v0.1.0，已完成）

0.1.0 的首次发布与后续 Trusted Publisher 配置均已完成；以下仅保留首次发布流程说明，**不要重复发布 0.1.0**：

1. 在终端交互登录 npm（**严禁在对话或公共渠道发送 Token 凭据**）：
   ```bash
   nix develop --command npm login --registry=https://registry.npmjs.org/
   ```
2. 发布打包验证产物（首次发布不具备 OIDC 环境，不带 `--provenance`）：
   ```bash
   nix develop --command npm publish /path/to/stage-dir/opencode-hermes-bridge-0.1.0.tgz --access public --ignore-scripts
   ```
3. **版本注意事项**：首次发布 0.1.0 成功后，**切勿在 GitHub 上创建名为 `v0.1.0` 的 Release**，否则触发的 GitHub Actions 会因 npm 拒绝重复版本而失败。首期请保留手动发布的 0.1.0，待下一个正常迭代（如 0.1.1）再启用自动化发布。

## 4. 后续 OIDC 自动化发布配置（Trusted Publisher）

首次发布成功后，通过 npm 原生 Trusted Publisher 使用短期 OIDC 身份自动发布，无需保存长期 Token：

1. **npm 设置**：
   - 官方 CLI（npm >= 11.15.0，需要 2FA，可按提示在浏览器确认）：`npm trust github opencode-hermes-bridge --repository zjm54321/opencode-hermes-bridge --file publish-npm.yml --allow-publish`。此包已配置，无需重复创建。
   - 网页备选：访问 npmjs 对应包页面的 `Settings` → `Trusted Publisher` → `GitHub Actions`。
   - 填写信息：Owner/User `zjm54321`，Repository `opencode-hermes-bridge`，Workflow filename `publish-npm.yml`，Environment 留空。
   - **重要权限**：新添加的 Trusted Publisher 默认处于 "stage only" 状态，必须在 Allowed actions 中显式勾选允许 `npm publish`。
   - **时间窗口**：新建的 Publisher 必须在 2 天内完成首次成功发布，否则配置将自动过期失效。建议在准备发布下一个版本前再行创建。
2. **安全策略**：建议为 npm 账号开启 2FA；确认 OIDC 发布成功后，可选择 "Require two-factor authentication and disallow tokens" 限制传统 Token 发布。该设置不禁止交互式 2FA 发布，也不影响 Trusted Publisher。
3. **工作流触发规则**：
   - 工作流由 GitHub 正式 Release 的 `published` 事件触发，排除 draft 与 prerelease；发布前校验 Tag 与 `package.json` 版本一致（如 `v0.1.1`），且对应提交已包含在 `main` 中。普通 `git push` 不会发布。
   - 工作流内单 job 串联构建、7 项单元测试、类型检查、打包及临时 consumer 加载验证，确保测试与发布的为同一 `.tgz` 产物。工作流自动为公开包附加 provenance 签名，无需配置 `NPM_TOKEN`。目前尚未在 CI 中实际运行。

## 5. 参考链接

- [npm Trusted Publishers 官方文档](https://docs.npmjs.com/trusted-publishers)
- [npm trust 官方 CLI 文档](https://docs.npmjs.com/cli/v11/commands/npm-trust)
- [OpenCode Plugins 官方规范](https://opencode.ai/v2/docs/plugins/)
