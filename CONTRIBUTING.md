# Contributing

[中文](CONTRIBUTING.zh.md) · [Architecture](ARCHITECTURE.md) · [First run](FIRST_RUN.md)

Sprite consists of a Node kernel (`core/`), a native SwiftUI shell (`shell/`), shared contracts (`contracts/`), and pi extensions (`pi-extension/`). The kernel owns the event journal and dedicated memory writes. The shell uses local JSON-RPC rather than reading memory files.

## Design rules

1. **Keep durable facts and authored content.** The journal is append-only. Conversation and thought projections can be rebuilt; original diaries, notes and recordings cannot all be reconstructed from it. Context compaction must not delete originals or replace them with summaries.
2. **Respect the write boundary.** Application code writes journal events through the kernel. Dedicated memory tools use version checks and durable receipts. Full mode deliberately allows shell access with OS-user permissions: this is autonomy, not a sandbox. Do not mistake prompt text, a proposal or old conversation for new authorization.
3. **Keep private data out of Git.** Do not commit real identities, conversations, API keys, machine-specific home paths or build output. Use synthetic test fixtures.

Identity is authored by the companion. Dedicated constraints changes require approval of an exact proposal; user memory-management operations are not exposed as agent approval tools. Preserve these distinctions when adding features.

## Development

Requirements: macOS 14+, Swift 6/Xcode command line tools, Node 24 LTS (or 22.18+ on the 22.x line), and pi 0.70.2.

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

`pi:typecheck` checks against the installed engine's real API. Kernel tests use isolated homes and offline providers; some require the real pi binary. Report skips separately. `Scripts/verify-all.sh` also exercises live, voice, reconnect, soak and scale paths: inspect each stage's output rather than treating a final summary as evidence for every check.

Use `./install.sh --dev` when you want the installed service to run this checkout. This changes your local installation and uses your real memory. After kernel edits, restart with `launchctl kickstart -k gui/$(id -u)/com.sprite.core`; rebuild shell changes with the installer. Normal `./install.sh` copies the kernel into Application Support. Uninstall preserves memory.

Match the existing architecture and add regression coverage for behavioral fixes. Report what failed before, what passes now, and what remains unverified. UI strings use `L(...)`/`Lf(...)` in `Localization.swift`; original diary and conversation content is not translated. Keep both READMEs and changelogs aligned.

## Preparing a public update

The author's local development history contains private notes. **Do not push that development branch directly.** Public snapshots retain only the publishable tree and have the current public branch as their parent. The publication script excludes `docs/`, old prototypes and build output; root documentation is public.

```bash
# Committed source is the default. To include pending tracked and new files:
Scripts/publish-code.sh --source worktree --branch publish/code-only
# Inspect and validate the resulting local commit before any push:
git diff origin/main..publish/code-only --stat
# After review, publish that exact snapshot (not newer working-tree changes):
Scripts/publish-code.sh --source publish/code-only --push
```

Without `--push`, the script only creates a local candidate and runs the privacy scan. It never changes the working tree or the normal index. Updates use normal fast-forward pushes, without rewriting remote history. If the remote changes after review, review the rebuilt candidate before publishing.

The privacy scanner compares a Git tree against local real-memory probes. It is a useful gate, not proof that arbitrary secrets or private history are absent. Without local memory it cannot perform those comparisons. Inspect the diff as well. A local pre-push hook is supplied in `Scripts/hooks/pre-push`; Git does not install hooks on clone. Its current checks target the configured public Sprite remote and the pushed tips, not every historical commit.

```bash
python3 Scripts/privacy-scan.py . publish/code-only
```

Redact private hits. Add a narrowly documented allowlist entry only for confirmed product wording. Never resolve a hit by disabling the check. Keep scanner logs private because they may quote matching text.

## macOS releases

CI checks types, kernel/installer/publication tests and Swift tests with pinned pi. A `v*` tag triggers `.github/workflows/release-macos.yml`. Apple Silicon and Intel runners each build and smoke-test a self-contained app; only after both succeed is a **draft** GitHub Release created with DMG, ZIP and checksum assets. Tag only a reviewed public snapshot after CI passes. Review the draft before publishing it.

Use `npm run package:macos` to build for your current Mac's architecture. The runtime has its own locked dependencies under `Scripts/runtime/`; update that lock deliberately when changing pi. Packaging includes licenses and excludes user data and test fixtures. First launch uses `Scripts/bootstrap-runtime.mjs` to prepare the per-user service; tests must use isolated homes and mocked launchctl, never the developer's live service. See [INSTALL.md](INSTALL.md) for the complete flow and signing limits.

## Reports and license

Report reproduction steps, expected and actual behavior, and redacted evidence. Do not paste raw personal journal entries or keys. See [LICENSE](LICENSE).
