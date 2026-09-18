# Contributing

> 中文版见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。

First, what this project is — three pieces:

- **`core/`** — the kernel. Memory, personality, the breathing schedule, and the agent runtime.
  It is the **only writer**: every fact goes into an append-only JSONL journal, and the markdown
  files (diary, conversation log) are just projections of it.
- **`shell/`** — a native macOS menu-bar app (SwiftUI). It **never reads memory files**; it talks to
  the kernel over a local Unix socket using JSON-RPC. The contract lives in `contracts/`.
- **`pi-extension/`** — the policy layer for the agent's "hands and feet": which paths it may read or
  write, which commands it may run.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture. If you want to try the app as a user
first, [FIRST_RUN.md](FIRST_RUN.md) is a checklist for the first day — that is genuinely the most
useful thing you can do early on.

## Two invariants

These matter more than performance, and review will hold you to them:

1. **Single writer.** Any path that writes memory must go through the kernel. The shell, the scripts,
   and the extension must never write the journal or its projections directly.
2. **Memory is never destroyed.** The journal is append-only and the projections (`diary/`,
   `mailbox.md`, `stream.jsonl`, `voice/`) are outputs, not cache: never delete them, never replace
   them with a summary. The only evictable layer is the working view (`context/`), and eviction means
   "out of view", not "gone" — see ARCHITECTURE.md → "Memory: truth, projections, and what
   'compression' may do".
3. **No personal data in the repo.** This project ships no preset personality and no sample
   character. A commit must never contain a real instance's identity, real memory content, an API
   key, or an absolute home-directory path.

## Development setup

```bash
git clone https://github.com/ACGpp/Sprite.git
cd Sprite
npm ci                 # dev-only deps (TypeScript, for typechecking); the kernel itself has zero deps
./install.sh --dev     # build + install the app; the kernel runs straight from this checkout
```

Requirements: macOS 14+, Node 22+, Xcode command line tools, and
[pi](https://github.com/badlogic/pi-mono) (`npm install -g @mariozechner/pi-coding-agent`).

With `--dev` the kernel runs `core/main.ts` from this checkout, so after changing kernel code:

```bash
launchctl kickstart -k gui/$(id -u)/com.sprite.core   # restart the kernel
tail -f ~/Library/Logs/sprite-core.log                # watch it come up
```

Shell changes need a rebuild: `./install.sh --dev` again. The app is ad-hoc signed, so macOS may ask
for microphone permission again afterwards — expected, not a bug.

Other flags: `./install.sh --no-service` (skip the launchd service), `./install.sh --uninstall`
(removes app + service, **keeps your memory**).

## Tests

```bash
node --test "core/**/*.test.ts"   # kernel: journal, importer, projections, RPC, scheduler, breath,
                                  # gateway policy, settings, scale, end-to-end
cd shell && swift test            # shell: RPC contract + pure logic (conversation merge, settings,
                                  # speaking-card policy)
Scripts/verify-all.sh             # the full acceptance run (10 stages, ~3 minutes)
```

`Scripts/verify-all.sh` is the source of truth: typecheck, kernel tests, Swift contract tests, a
zero-warnings Swift concurrency check, self-checks, a live kernel + real `pi` round trip, the voice
path, reconnect, a soak run, and a 200k-event scale measurement. **Do not quote numbers from these
docs — quote what the script prints.** Some stages skip honestly when the environment cannot support
them (no microphone, no speech recogniser, no `pi` binary); a skip is never reported as a pass.

## How changes get accepted

- **Reproduce first, then fix.** Nearly every real bug in this codebase was found by a test rather
  than by reasoning — including races that only appeared under load. Add a regression test that fails
  before your fix and passes after it, and say in the PR what the failing state looked like.
- **Honest degradation over silent failure.** When something cannot work, the product says so (a
  `system.problem` event, a visible note in the UI, a skipped test) instead of pretending.
- **Durable facts come from the journal files, not from caches.** The in-memory read model is a
  bounded window; anything promised to the user ("it will hand these back in the morning") must be
  read from disk.
- Commit messages: Chinese or English, both fine. Explain *why* the change is needed; the *what* is
  in the diff.
- **Code comments are currently Chinese**, and so is `install.sh` output. The app itself now has an
  English UI: all user-facing strings go through `L(...)`/`Lf(...)` in
  `shell/Sources/sprite-shell/Localization.swift`, where the **Chinese original is the dictionary
  key** and anything untranslated falls back to it — so translating is incremental and never leaves a
  blank. To add a language, copy the dictionary and extend `UILanguage`. Write your own comments in
  whichever language you are comfortable with; translating existing ones is welcome but not required.

## Before you push

A privacy gate runs as a local `pre-push` hook (source: `Scripts/hooks/pre-push`). It scans what you
are about to publish against **your own real memory** and refuses the push if it finds an identity, a
verbatim memory fragment, an API key, or an absolute home path:

```bash
python3 Scripts/privacy-scan.py . HEAD   # exactly what the hook runs
```

If it flags something, either redact it, or — only when you are certain it is product wording rather
than private content — add the phrase to `Scripts/privacy-allowlist.txt` with a comment saying why.

Two more local guards worth knowing: `core/settings.test.ts` fails if any tracked file hardcodes an
absolute home directory, and the same file fails if build artifacts are tracked (`shell/.build*`,
`.core-test/`, `.demo/`).

## Releases

`origin/main` is a **code-only snapshot**: the author publishes it with
`Scripts/publish-code.sh --push`, which builds a single commit containing the code and never the
author's development notes. That is why the public history looks compressed — it is intentional, not
lost history. If a design decision is not written down publicly, just ask.

## If the app hangs

The shell is SwiftUI inside AppKit windows, so a hang is almost always a **layout loop** rather than
blocked I/O. Two commands pin it down in under a minute:

```bash
pgrep -x Sprite                      # the app's pid
sample "$(pgrep -x Sprite)" 3 -file /tmp/sprite-sample.txt
log show --predicate 'process == "Sprite"' --last 10m --style compact \
  | grep -iE "layout|state during|SwiftUI"
```

What to look for: every sample sitting in `NSHostingView.layout()` means the window keeps re-laying
out, and AppKit will say so explicitly — `-layoutSubtreeIfNeeded ... has continued for 300 iterations
because -updateConstraints and/or -layout has kept the layout dirty`. The usual cause is feedback
between a window and its content: an `NSHostingController` whose content size the window chases while
the content re-measures to fit the window. The records window disables that feedback
(`controller.sizingOptions = []`, see `AppDelegate.openRecords`), and layout-sensitive additions
should keep a stable size (`lineLimit`, `frame(maxWidth:)`, `fixedSize`) instead of leaving a `Spacer`
to renegotiate width on every pass.

## Where to ask

Open an issue with what you tried, what you expected, and the raw evidence (the relevant
`~/.claude-memory/journal/YYYY-MM-DD.jsonl` slice, a screenshot, or the `verify-all` output).
Never paste your API key or your real conversations.

## License

See [LICENSE](LICENSE).
