# 安装 Sprite

[English](INSTALL.md) · [README](README.md) · [Releases](https://github.com/ACGpp/Sprite/releases)

## 下载

Apple Silicon 选择 `arm64.dmg`，Intel 选择 `x64.dmg`；点击苹果菜单 → 关于本机可查看芯片类型。两者均要求 macOS 14 或更新版本。打开 DMG，将 Sprite 拖到 Applications，再从应用程序启动。ZIP 文件包含同一份应用。

应用内置 Node 24.14.0、pi 0.70.2 和 Sprite 内核，不需要开发工具或额外安装运行环境。模型服务商的凭据在应用中填写，模型费用由服务商收取。

如果 Releases 页还没有安装包，表示二进制版本尚未发布，可先按 README 从源码安装。仓库里有构建流程，不等于下载文件已经上线。

## 首次打开

菜单栏应用会在后台服务准备期间显示；新账户的首次准备可能稍长。服务安装在当前账户下，无需管理员密码。关闭对话或退出菜单栏应用后，后台仍会运行；希望它休息时，请先暂停。

- 应用：`/Applications/Sprite.app`，也可放在用户的 Applications 文件夹。
- 运行环境版本：`~/Library/Application Support/Sprite/releases/`。
- 后台服务：`~/Library/LaunchAgents/com.sprite.core.plist`。
- 记忆之家（早期兼容路径）：`~/.claude-memory/`；目录内容见 [README 的记忆说明](README.md#记忆与隐私)。
- 诊断日志：`~/Library/Logs/sprite-core.log` 和 `sprite-core.err.log`。

连接后，在设置中选择供应商与模型，保存密钥，发送第一句话。弹出 DMG 不影响已安装的后台服务。

## macOS 安全提示

当前构建只有 ad-hoc 签名，没有 Apple Developer ID 签名和公证，因此 macOS 可能拦截下载的应用。核对文件来自本项目 Releases 后，先尝试打开，再到“系统设置 → 隐私与安全性”选择“仍要打开”，按系统提示确认。受管理的 Mac 可能不允许此操作，不要全局关闭系统安全功能。

如需检查下载完整性，把对应的 `SHA256SUMS-arm64.txt` 或 `SHA256SUMS-x64.txt` 放到下载文件旁，运行 `shasum -a 256 -c SHA256SUMS-arm64.txt`（Intel 使用 x64 文件）。列表同时包含 DMG 和 ZIP，此命令需要两份文件；只下载了一份时，可用 `shasum -a 256 <文件>` 与列表中的对应值比较。校验和用于检测文件损坏，不能代替开发者签名。

## 升级与恢复

先备份整个记忆目录，退出应用，用新下载替换旧应用后重新打开。新运行环境会先准备好，再停止旧服务；确认旧写入进程退出才切换，并等待新内核响应 RPC。启动失败时会尽可能恢复旧服务定义。旧运行环境目录保留用于恢复，但不是记忆备份。

如果另有手动启动的内核使用同一份记忆，它可能阻止升级；停止该进程后重新打开 Sprite。其他启动错误会显示提示，细节见上述日志。再次打开健康的安装不会重启内核。

## 卸载

先退出 Sprite，打开 DMG，双击 `Uninstall Sprite.command` 并在弹窗中确认。它会停止后台服务并移除运行环境，保留记忆；然后把 Sprite.app 移到废纸篓。应用包内的 `Contents/Resources/Uninstall Sprite.command` 也提供同一入口。

源码安装仍可用 `./install.sh --uninstall`。只删除 Sprite.app 不会移除独立安装的后台服务。

## 构建与发布（维护者）

```bash
npm ci
npm run package:macos
```

在与目标芯片架构相同的 Mac 上构建。脚本编译 Swift，下载固定版本的官方 Node 压缩包并检查 SHA-256，按 `Scripts/runtime/package-lock.json` 安装 pi，复制产品源码并本地签名。随后使用实际打包的 Node、pi、内核 RPC 和扩展工具，在隔离的离线 provider 下做冒烟测试，最后在 `release/` 生成 DMG、ZIP 和校验文件。不打包真实用户记忆或配置；依赖许可证及 Node、Sprite 许可证随包保留。

`.github/workflows/release-macos.yml` 分别使用 Apple Silicon 和 Intel runner。只给已审阅的公开快照打与 `package.json` 版本一致的 `v<版本>` 标签。两种构建与检查都成功后才创建 GitHub Release 草稿；检查安装包和说明，再发布草稿。普通源码 push 不会发布 Release，也不会更新用户已经安装的应用。

目前未配置 Developer ID 证书和公证凭据，不把构建结果称为公证安装包。自动更新需另行实现。
