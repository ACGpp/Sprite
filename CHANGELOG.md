# Changelog

[中文](CHANGELOG.zh.md) · [README](README_EN.md)

## 0.3.4 — 2026-10-10

This update collects the changes since the last public code snapshot. It includes the memory and runtime work developed across several local iterations.

### Memory and autonomy

- Add versioned memory writes, conflict detection, durable write receipts and recovery of interrupted writes. Preserve original content and previous versions.
- Add a Memory page to Records: inspect versions and differences, restore a selected version, review proposals, and manage sourced agreements. Restores check that the current version has not changed underneath the preview.
- Let the companion maintain its own identity. Dedicated tools still require user approval for a specific proposed constraints version; user memory management is separate from the agent gateway.
- Add an explicit `full` permission mode for shell commands, network access, programs and local files. Default `on` remains controlled memory read/write. Full mode uses the current OS user's permissions and is not a sandbox.
- Refresh complete identity, effective agreements and runtime context before model calls. Optional background yields first when space is tight; failure to fit required memory is reported explicitly. Session compaction does not delete original memories.

### Runtime and recovery

- Improve message delivery and retry handling, interrupted-command recovery, cancellation, model/mode changes and daily session rollover. Avoid silently replaying operations with unknown outcomes.
- Add archive-backed history queries with bounded indexes and cache validation. Recover conversation projections from durable events instead of relying on a short in-memory window.
- Record `tool.finished` separately from tool invocation, correlated by run and call ID. Count dedicated writes only after verified success; ignore duplicate or unmatched completion results. Older attempts without receipts remain unverified.
- Exclude scheduling-only activity from substantive work when calculating idle streaks. A proactive “just wrote” cue now uses the immediately preceding run's verified writes.
- Check diary modification dates in Shanghai time. Put a fresh memory snapshot before the latest user input without separating tool results from their assistant calls; distinguish an ongoing tool continuation from the next scheduled wake.

### macOS app and installation

- Update memory-management views, conversation merging, records navigation, failure presentation and window lifecycle handling; extend Chinese/English interface strings.
- Build before stopping the installed kernel, wait for the old writer to exit before replacing files, and confirm the new service through RPC. Retain the user's memory on uninstall.
- Align source and app version at 0.3.4 (app build 7). Recommend Node 24 LTS; require Node 22.18+ on the 22.x line. Validate extensions against pi 0.70.2.

### Documentation and publication

- Align Chinese and English READMEs, contribution guidance and release notes with the current permission, privacy, memory and upgrade behavior.
- Prepare public snapshots from either a commit or the working tree, including new source files, without changing the developer's index. Preserve public history with a normal fast-forward update; exclude private development notes and build output.
- Pin pi in CI and check the real extension API. Replace the disabled Electron template with a tag-triggered macOS workflow: build and smoke-test Apple Silicon and Intel DMG/ZIP packages, attach SHA-256 checksums, then create a draft release.
- Bundle Node, pi and the kernel. First launch installs the per-user runtime; upgrades retain previous runtimes and restore the old service on startup failure. Include an uninstaller that preserves memory.

### Upgrade and limits

Back up the entire `~/.claude-memory/` directory. For a downloaded app, quit Sprite, replace it and reopen. For source installations, update the public checkout and run `./install.sh`. A source push does not update an installed app. There is no in-app updater, notarized app distribution or validated autonomous code-deployment pipeline.

Tool receipts improve evidence; they do not guarantee correct reasoning or prevent repeated behavior. Arbitrary shell writes are outside dedicated memory version receipts. Hardware, real-provider behavior and long-running autonomy need separate verification beyond deterministic tests.
