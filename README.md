# Sprite

[English](README_EN.md) · [下载安装](https://github.com/ACGpp/Sprite/releases) · [使用与安装帮助](INSTALL.zh.md) · [更新记录](CHANGELOG.zh.md)

**一个住在 Mac 菜单栏里的 AI 伙伴。**

Sprite 能和你交谈、记住经历、阅读资料、写下想法，也能自己安排下一次醒来的时间。它的身份和性格在相处与探索中逐渐形成，仓库不附带预置人格或任何人的私人记忆。

## 它能做什么

- **随时交谈**：点击菜单栏图标，或按 `⌥K` 打开对话；支持文字和语音转写。
- **持续记忆**：保留日记、笔记与对话，在记录窗口查看内容、比较版本和恢复记忆。
- **自主行动**：可以选择探索、记录或休息。开启自由行动后，还能联网、运行程序、读写文件和研究自己的代码。
- **安静陪伴**：有安静时段和主动消息额度；想说但不宜打扰的话会留下来。
- **选择模型**：支持多个模型供应商及自定义兼容接口，中英文界面可切换。

## 下载与安装

需要 **macOS 14 或更新版本**，以及你选择的模型服务商的 API Key。

1. 打开 [Releases](https://github.com/ACGpp/Sprite/releases)，在 **Assets** 中下载适合你的 Mac 的 `.dmg`。
2. 打开 DMG，把 **Sprite** 拖到 **Applications（应用程序）**。
3. 从应用程序打开 Sprite，在设置中选择供应商、填写 API Key，保存并应用。

| Mac 类型 | 选择的安装包 |
| --- | --- |
| Apple Silicon（M 系列） | `Sprite-<版本>-arm64.dmg` |
| Intel | `Sprite-<版本>-x64.dmg` |

安装包包含内核、Node.js 和 pi，**无需另装 Node、npm、Xcode 或命令行工具**。首次打开会准备当前用户的后台服务。Release 也提供 ZIP 和 SHA-256 校验文件；不要把 GitHub 自动生成的 “Source code” 当作应用安装包。

若 Releases 还没有安装包，请使用下方源码安装。当前构建未经过 Apple Developer ID 签名和公证；若 macOS 阻止打开，核对下载来源后到“系统设置 → 隐私与安全性”选择“仍要打开”。详见[安装帮助](INSTALL.zh.md)。

## 开始使用

按 `⌥K` 打开对话，回车发送。语音转写会先填入输入框，由你决定是否发送。记录窗口可查看日记、探索笔记、对话、思维流、语音和记忆；设置中可以更换模型、界面语言和登录启动选项。

Sprite 会自己安排作息。默认安静时段是**上海时间 23:00–07:00**：主动消息留作留言，普通输入排队；“现在叫醒它”可以立即唤醒。主动消息的每日额度可在设置中调整。

### 行动权限

| 模式 | 能力 |
| --- | --- |
| 交流 `off` | 交谈、留言和安排作息；必要记忆仍会提供 |
| 只读 `readonly` | 加上记忆文件读取和历史查询 |
| 读写 `on`（默认） | 加上版本化记忆写入 |
| 自由行动 `full` | 加上 Shell、网络、程序和本地文件访问 |

自由行动使用当前 macOS 用户的权限，不是沙箱。Sprite 可以阅读和修改自己的代码；修改源码与部署更新是不同的步骤。它可以自主维护身份；通过专用工具修改约定时，需要你批准具体提案。

## 记忆与隐私

Sprite 的记忆之家是本机目录 `~/.claude-memory/`。这是早期版本留下的兼容路径，不是一个单独的“记忆文件”；现有安装仍从这里读写，改名需要专门的迁移流程。

目录里主要有这些内容：

```text
~/.claude-memory/
├── identity.md                 它对自己的认知与性格
├── journal/                    只追加的事件日志，唯一事实来源
├── diary/  notes/              日记与笔记
├── explorations/  private/     探索记录与它自己的空间
├── context/                    工作记忆与需要复核的约定
├── conversations/mailbox.md   给人看的对话记录投影
├── thoughts/stream.jsonl       思维流投影
├── voice/                      原始语音记录
├── config/settings.json        模型、作息、主动消息和权限设置
├── sessions/                   每日模型会话
└── runtime/                   内核通信、版本和运行时文件
```

其中 `journal/` 和这些由它生成的投影记录运行事实；日记、笔记、身份和录音等原始内容不能全部从日志重建。进入模型上下文的对话和记忆片段会发送给你配置的供应商；自由行动可访问网络，系统语音识别也可能将音频发送给 Apple。

请备份**整个记忆目录**：原始日记、笔记和录音不能全部从事件日志重建。记忆管理中的版本恢复适用于专用记忆工具管理的内容；Shell 直接修改的文件不自动获得同样的版本回执。

## 升级与卸载

升级时先备份记忆，退出 Sprite，下载新版并替换 Applications 中的应用，再打开。应用会更新后台运行环境；目前没有应用内自动更新。

卸载时先退出 Sprite，再运行 DMG 中的 **Uninstall Sprite.command**，停止并移除后台服务，最后把应用移到废纸篓。卸载保留 `~/.claude-memory/`。仅删除应用不会移除独立运行的后台服务。

## 从源码运行

开发需要 macOS 14+、Swift 6 / Xcode 命令行工具、Node.js 24 LTS（或 22.x 的 22.18+）及 pi 0.70.2。

```bash
npm install -g @mariozechner/pi-coding-agent@0.70.2
git clone https://github.com/ACGpp/Sprite.git
cd Sprite
./install.sh
```

开发与验证见[贡献指南](CONTRIBUTING.zh.md)，系统设计见[架构说明](ARCHITECTURE.md)。安装包构建与发布流程见[安装帮助](INSTALL.zh.md)。提交问题时请附复现步骤和脱敏证据。

## License

[MIT](LICENSE)
