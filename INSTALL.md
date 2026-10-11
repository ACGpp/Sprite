# Installing Sprite

[中文](INSTALL.zh.md) · [README](README_EN.md) · [Releases](https://github.com/ACGpp/Sprite/releases)

## Download

Choose `arm64.dmg` for Apple Silicon or `x64.dmg` for Intel. Apple menu → About This Mac shows which processor you have. Both require macOS 14 or later. Open the DMG, drag Sprite into Applications, then launch it from there. ZIP downloads contain the same app.

The app includes Node 24.14.0, pi 0.70.2 and the Sprite kernel. No development tools or separate runtime installation are required. You supply your model-provider credentials in the app; provider charges are separate.

No installer available on the Releases page means a binary release has not yet been published; use the source instructions in the README meanwhile. The repository's build workflow alone is not a published download.

## First launch

The menu-bar app appears while its background service is prepared. On a new account this can take a little longer. The service is installed for your account without an administrator password. It keeps running when you close the conversation or quit the menu-bar app; pause the companion before quitting if you want it to rest.

- App: `/Applications/Sprite.app` (or your user Applications folder).
- Runtime versions: `~/Library/Application Support/Sprite/releases/`.
- Background service: `~/Library/LaunchAgents/com.sprite.core.plist`.
- Memory home (legacy compatibility path): `~/.claude-memory/`; see the [README memory section](README_EN.md#memory-and-privacy) for its contents.
- Diagnostics: `~/Library/Logs/sprite-core.log` and `sprite-core.err.log`.

Once connected, choose a provider and model in Settings, save your key, and send a first message. Ejecting the DMG does not stop the installed service.

## macOS security prompt

Current builds are ad-hoc signed, without Apple Developer ID signing or notarization. macOS may block a downloaded app. After checking that the file came from this project's Releases page, attempt to open it, then allow it under System Settings → Privacy & Security → Open Anyway. Follow Apple's confirmation dialog. Managed Macs may disallow this; do not disable system security globally.

To check a download, place the matching `SHA256SUMS-arm64.txt` or `SHA256SUMS-x64.txt` next to the downloaded assets and run `shasum -a 256 -c SHA256SUMS-arm64.txt` (or the x64 equivalent). It lists both DMG and ZIP: download both for that command, or compare the one file's `shasum -a 256 <file>` result to its listed value. Checksums detect corrupted downloads; they do not replace developer signing.

## Upgrade and recovery

Back up the whole memory directory, quit the app, replace it with the new download, and reopen. A new runtime is staged before the previous service stops. The old writer must exit before switching, and the new kernel must answer RPC. Startup failure restores the previous service definition when possible. Previous runtime directories are retained for recovery; these are not backups of your memory.

A manually launched kernel using the same memory can block an upgrade. Stop that process and reopen Sprite. For other startup errors, the app shows a dialog and the logs above contain diagnostics. Reopening a healthy installation does not restart the kernel.

## Uninstall

Quit Sprite. Open the DMG and double-click `Uninstall Sprite.command`; confirm removal in the dialog. This stops the background service and removes its runtime files, while keeping your memory. Move Sprite.app to the Trash afterwards. An uninstaller is also included inside the app at `Contents/Resources/Uninstall Sprite.command`.

For a source installation, `./install.sh --uninstall` remains available. Deleting Sprite.app by itself leaves the independently installed service in place.

## Build and release (maintainers)

```bash
npm ci
npm run package:macos
```

Build on a Mac matching the target CPU. The script builds Swift, downloads the pinned official Node archive and checks its SHA-256, installs pi from `Scripts/runtime/package-lock.json`, copies product source, and signs the bundle locally. It smoke-tests the actual bundled Node, pi, kernel RPC and extension tools against an isolated offline provider, then creates DMG, ZIP and checksums in `release/`. No real user memory or configuration is packaged. Dependency licenses remain in the bundle, alongside Node's and Sprite's licenses.

`.github/workflows/release-macos.yml` builds on Apple Silicon and Intel runners. Push a `v<package.json version>` tag only for the reviewed public snapshot. Both builds and checks must succeed before a draft GitHub Release is created. Review the assets and notes, then publish the draft. A normal source push does not publish a release or update anyone's installed app.

A Developer ID certificate and notarization credentials are not configured. The workflow does not claim notarized output. An automatic updater is separate future work.
