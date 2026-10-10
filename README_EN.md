# Sprite

[中文](README.md) · [Download](https://github.com/ACGpp/Sprite/releases) · [Installation help](INSTALL.md) · [Changelog](CHANGELOG.md)

**An AI companion living in your Mac's menu bar.**

Sprite can talk with you, remember experiences, read, write down its thoughts, and decide when to wake again. Its identity and personality develop through conversations and exploration. This repository ships no preset personality or anyone's private memories.

## What it does

- **Conversation within reach:** click the menu bar icon or press `⌥K`; use text or voice transcription.
- **Persistent memory:** keep diaries, notes and conversations; browse records, compare versions and restore memories.
- **Independent action:** choose to explore, write or rest. Free action also enables networking, programs, file access and studying its own code.
- **Quiet companionship:** quiet hours and a proactive-message quota help it avoid interrupting you; messages can wait for later.
- **Your choice of model:** connect multiple model providers or a custom compatible endpoint, with Chinese and English interfaces.

## Download and install

Requires **macOS 14 or later** and an API key for your chosen model provider.

1. Open [Releases](https://github.com/ACGpp/Sprite/releases) and download the `.dmg` for your Mac under **Assets**.
2. Open the DMG and drag **Sprite** into **Applications**.
3. Open Sprite from Applications, choose a provider in Settings, enter your API key, and save.

| Mac | Download |
| --- | --- |
| Apple Silicon (M series) | `Sprite-<version>-arm64.dmg` |
| Intel | `Sprite-<version>-x64.dmg` |

The app includes the kernel, Node.js and pi. **You do not need to install Node, npm, Xcode or command line tools.** First launch prepares a background service for your account. Releases also provide ZIP archives and SHA-256 checksums; GitHub's automatic “Source code” downloads are not application installers.

If no installer has been published yet, use the source installation below. Current builds lack Apple Developer ID signing and notarization. If macOS blocks the app, verify the download source, then use **System Settings → Privacy & Security → Open Anyway**. See [installation help](INSTALL.md).

## Getting started

Press `⌥K` to open the conversation and Return to send. Voice transcription fills the input field first; you choose whether to send it. Records contains diaries, exploration notes, conversations, thoughts, voice and memory. Settings lets you change models, interface language and launch-at-login preferences.

Sprite chooses its own rhythm. Quiet hours default to **23:00–07:00 Shanghai time**: proactive speech becomes a stored message and ordinary incoming messages wait. “Wake now” can override that window. Adjust the daily proactive-message quota in Settings.

### Action permissions

| Mode | Capabilities |
| --- | --- |
| Conversation `off` | Talk, leave messages and schedule wakes; essential memory is still supplied |
| Read only `readonly` | Adds memory-file reading and history queries |
| Read/write `on` (default) | Adds versioned memory writes |
| Free action `full` | Adds Shell, networking, programs and local file access |

Free action uses your macOS account's permissions and is not a sandbox. Sprite can read and modify its own code; editing source and deploying an update are separate steps. It can maintain its own identity. Changes to agreements through dedicated tools require your approval of a specific proposal.

## Memory and privacy

Memory lives in `~/.claude-memory/`. Conversations and memory excerpts included in context are sent to your configured model provider. Free action can access the network, and system speech recognition may send audio to Apple.

Back up the **entire memory directory**: not all original diaries, notes or recordings can be reconstructed from the event journal. Version restores cover content managed by dedicated memory tools; direct Shell edits do not automatically receive the same version receipts.

## Upgrade and uninstall

To upgrade, back up your memory, quit Sprite, download the new version, replace the app in Applications, and reopen it. The app updates its background runtime. There is no in-app automatic updater yet.

To uninstall, quit Sprite, run **Uninstall Sprite.command** from the DMG to remove the background service, then move the app to the Trash. Your `~/.claude-memory/` directory is retained. Removing the app alone does not remove its independent background service.

## Run from source

Development requires macOS 14+, Swift 6 / Xcode command line tools, Node.js 24 LTS (or 22.18+ on the 22.x line), and pi 0.70.2.

```bash
npm install -g @mariozechner/pi-coding-agent@0.70.2
git clone https://github.com/ACGpp/Sprite.git
cd Sprite
./install.sh
```

See [Contributing](CONTRIBUTING.md) for development and checks, [Architecture](ARCHITECTURE.md) for system design, and [installation help](INSTALL.md) for packaging and releases. Include reproduction steps and redacted evidence in issue reports.

## License

[MIT](LICENSE)
