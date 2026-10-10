# 参与开发

[English](CONTRIBUTING.md) · [架构](ARCHITECTURE.md) · [首次使用（英文）](FIRST_RUN.md)

Sprite 包含 Node 内核（`core/`）、SwiftUI 原生外壳（`shell/`）、共享契约（`contracts/`）和 pi 扩展（`pi-extension/`）。内核负责事件日志及专用记忆写入；外壳通过本机 JSON-RPC 访问，不直接读取记忆文件。

## 设计原则

1. **保留事实和原文。** 日志只追加；对话与思维流投影可以重建，但原始日记、笔记和录音不能全靠日志恢复。上下文压缩不得删除原文或用摘要替换原文。
2. **遵守写入边界。** 应用代码通过内核写日志；专用记忆工具使用版本检查和持久回执。自由行动有意开放当前系统用户权限下的 Shell，这体现自主性，不是沙箱。提示词、提案和旧对话不能自行成为新的授权。
3. **私人数据不入库。** 不提交真实身份、对话、密钥、本机家目录路径或构建产物；测试使用合成样例。

伙伴自主维护身份；专用工具修改约定须批准具体提案，用户记忆管理操作不作为 Agent 的批准工具。新增功能时保留这些区别。

## 开发

需要 macOS 14+、Swift 6 / Xcode 命令行工具、Node 24 LTS（或 22.x 的 22.18+）和 pi 0.70.2。

```bash
npm install -g @mariozechner/pi-coding-agent@0.70.2
npm ci
npm run core:typecheck
npm run policy:typecheck
npm run pi:typecheck
npm run typecheck
npm run core:test
npm run release:test
npm run shell:test
npm run app:build
```

`pi:typecheck` 对照实际安装引擎的 API。内核测试使用隔离目录和离线 provider，其中部分需要真实 pi 可执行文件；跳过需单独报告。`Scripts/verify-all.sh` 还覆盖活体链路、语音、重连、soak 和规模检查，应逐阶段检查输出，不把最后一句总结当成所有检查都通过的证据。

希望已安装服务运行当前源码时，使用 `./install.sh --dev`；这会改变本机安装并使用真实记忆。修改内核后可用 `launchctl kickstart -k gui/$(id -u)/com.sprite.core` 重启；外壳修改需重新运行安装器。普通安装把内核复制到 Application Support；卸载保留记忆。

遵循现有架构，为行为修复补充回归验证。说明修复前的问题、当前通过的检查和未验证项。界面文案走 `Localization.swift` 的 `L(...)` / `Lf(...)`，日记和对话原文不翻译；同步维护两份 README 和更新记录。

## 准备公开更新

作者本地开发历史含私人笔记，**不要直接推送这条开发分支**。公开快照仅包含可发布文件，以当前公开分支为父提交。发布脚本排除 `docs/`、旧原型和构建产物；根目录文档会公开。

```bash
# 默认使用已提交源码；包含当前已修改及新增文件时：
Scripts/publish-code.sh --source worktree --branch publish/code-only
# 先检查、验证生成的本地提交：
git diff origin/main..publish/code-only --stat
# 审阅后推送这份确切快照，不重新读取后续工作目录改动：
Scripts/publish-code.sh --source publish/code-only --push
```

不带 `--push` 只生成本地候选并扫描隐私，不修改工作目录或正常暂存区。普通快进推送保留远端历史，不强推。若审阅后远端又有更新，应重新审阅重建的候选再发布。

扫描器用本机真实记忆作为探针比对 Git 文件树，有帮助但不能证明任意密钥或私人历史都已排除；没有本机记忆时无法做这些比对，还需审阅 diff。仓库提供 `Scripts/hooks/pre-push`，但 Git 克隆不会自动安装钩子。目前钩子针对指定公开 Sprite 远端和推送的顶端提交，不逐个扫描所有历史提交。

```bash
python3 Scripts/privacy-scan.py . publish/code-only
```

私人命中应脱敏；只有确认属于产品文案的短语才能逐条加白名单并说明理由，不能关闭检查来绕过命中。扫描日志可能引用匹配原文，请留在本地。

## macOS Release

CI 使用固定 pi 检查类型、内核/安装/发布测试和 Swift 测试。`v*` 标签触发 `.github/workflows/release-macos.yml`，Apple Silicon 和 Intel runner 分别构建并验证内置运行环境的应用；两者都成功后才创建带 DMG、ZIP 和校验文件的 GitHub Release **草稿**。应在 CI 通过后给已审阅的公开快照打标签，检查草稿后再发布。

本机用 `npm run package:macos` 构建当前架构的安装包。运行环境独立锁定在 `Scripts/runtime/`，更换 pi 时需明确更新锁文件。打包保留许可证，排除用户数据和测试夹具。首次启动由 `Scripts/bootstrap-runtime.mjs` 准备用户服务，测试必须使用隔离目录和模拟 launchctl，不操作开发者的真实服务。完整流程及签名限制见[安装帮助](INSTALL.zh.md)。

## 报告与许可

报告复现步骤、预期和实际行为，附脱敏证据；不要直接粘贴私人日志或密钥。许可见 [LICENSE](LICENSE)。
