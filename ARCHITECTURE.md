# Architecture

A short tour for someone about to change code. Nothing here is a specification — the code and
`contracts/` are. But these are the load-bearing ideas, and most bugs in this project's history were
a violation of one of them.

## The shape

```
        ┌─────────────────────────── your Mac ───────────────────────────┐
        │                                                                │
        │   Sprite.app (menu bar, SwiftUI)                               │
        │        │  JSON-RPC over ~/.claude-memory/runtime/core.sock      │
        │        ▼                                                       │
        │   kernel  (core/, Node, launchd service com.sprite.core)       │
        │        │                                                       │
        │        │  JSON-RPC over ~/.claude-memory/runtime/gateway.sock  │
        │        ▼                                                       │
        │   pi  (resident child: `pi --mode rpc`)  +  pi-extension/       │
        │                                                                │
        │   truth:  ~/.claude-memory/journal/YYYY-MM-DD.jsonl             │
        │   projections: conversations/mailbox.md, thoughts/             │
        └────────────────────────────────────────────────────────────────┘
```

The shell, kernel and pi are separate processes, with one journal owner. The kernel is the **single writer**; the shell is a viewer that can send
commands; pi is the agent runtime that the kernel drives. The native shell and the dedicated pi memory tools do not write the
journal.

## Why a journal instead of a database

- **Append-only JSONL, one file per Shanghai day.** Facts are events (`message.in`, `run.started`,
  `message.out`, `diary.written`, `breath.scheduled`, …); the read model is derived by folding them.
- The event log is the source of runtime and conversation facts. Conversation and thought
  projections can be regenerated from it. Authored diaries, notes and original voice recordings
  are separate durable content; back up the entire memory home, not just the journal.
- **The day boundary is Asia/Shanghai**, deliberately, everywhere (journal file names, quiet hours,
  the proactive quota, the "today" readout). `hourInShanghai`/`dayInShanghai` in `core/text.ts` are
  the only allowed way to ask "what time is it" — `new Date().getHours()` is a bug in this codebase.
  A machine in another timezone must still behave the same way.
- **The in-memory read model is a cache with a window** (200 entries per list, 2000 events). Anything
  the product promised the user must be re-read from the journal files on disk. Three separate
  incidents came from forgetting this, so tests now read the files, not the window.
- **Checkpoints** (`journal/checkpoint.json`) make startup O(1) instead of O(events): the read-model
  snapshot plus the last sequence number. If it fails validation the kernel falls back to a full
  rescan, so a stale checkpoint is never fatal.

## The breath cycle

The kernel's main loop is a schedule, not an event handler:

1. `scheduler.next()` decides when to wake (quiet hours ⇒ slower cadence; consecutive failures ⇒
   exponential backoff; an explicit pause ⇒ no timer breaths at all).
2. On wake, the kernel builds an **observation** (`core/breath.ts` `buildObservation`) — recent
   messages, quiet-window state, whether there is a reason to speak, and a block of **facts** about
   itself (its capabilities, what its memory looks like, what it did last time, what it has done
   today). Facts, not instructions: whether to act is the model's choice.
3. The observation goes to `pi` as a prompt. The run ends when pi reports `agent_end` or the timeout
   fires. Tool calls are logged as `run.activity` (with the audit summary) and `tool.decided`.
4. The kernel writes `run.finished`/`run.failed`, updates presence, and reschedules. If a prompt was
   rejected, the messages it had seen go **back** into the pending queue — a user's sentence must
   never be silently consumed.

Presence (`thinking` / `breathing` / `quiet` / `paused` / `degraded`) is reported by the kernel and
rendered by the shell; the shell never invents a state.

## The capability gateway

pi's tools are how the instance touches the world, so the kernel owns the door: a second Unix socket
(`gateway.sock`) served by the kernel, exposed to pi as an extension (`pi-extension/sprite.ts`), whose
policy half lives in `pi-extension/policy.ts` (pure functions, unit tested):

- **One policy source**: `contracts/memory-policy.ts` defines the tool set and the capability text for each mode. The gateway checks the current mode and agent generation again at execution time.
- **Ordinary memory**: `diary/`, `explorations/`, `notes/`, `private/` and the single file `context/working-memory.md` are writable through kernel-owned `read/write/edit`. Writes require a matching version, retain prior content, and return a verified result.
- **Self-authored identity**: The agent creates and edits `identity.md` through versioned ordinary writes, without per-edit approval. Initial guidance supports discovery and revision of its own personality rather than prescribing one.
- **Reviewed memory**: Only `context/constraints.md` requires a concrete proposal. Only the user command endpoint accepts approval or rejection of that version; the Agent memory gateway has no approval method. In full mode this is a tool contract, not protection against shell access to local sockets or metadata.
- **History**: `memory_history` returns an allowlisted projection with actual journal paths and sequence numbers. Raw `config/`, `journal/`, `runtime/`, `sessions/` and `legacy-v2/` are not exposed to file tools.
- **Speaking**: the kernel still chooses bubble versus digest and enforces quiet hours and proactive quotas.
- **Runtime configuration**: only the explicitly selected `full` mode exposes pi’s built-in `bash` tool for shell commands, network access, programs and local files. Existing `on`/`readonly`/`off` modes exclude general shell. Production pi uses a kernel-owned cwd and agent directory, explicit tools/extensions/system prompt, and disables discovered context files, skills and prompt templates. This also prevents inherited pi authentication commands from running.

The versioned store is the write path for dedicated memory tools. In `full`, shell commands run with the current OS user’s permissions and can access files outside that store; its path restrictions and version receipts are not a sandbox for shell commands. Kernel ownership of journal/projections remains an application convention, not OS-enforced isolation. `on` retains its settings value for compatibility but now means controlled memory read/write, not unrestricted shell. Full mode is opt-in, persists across restarts, and changing modes retires the previous pi instance before exposing the new tool set. Capability snapshots are refreshed before each model call so historical statements about having no shell cannot override current capabilities. See [the changelog](CHANGELOG.md) for the public release scope.

## The shell

`shell/` is a normal SwiftPM package (`SpriteRPC` library + `sprite-shell` executable + tests). Rules
that came out of real bugs:

- **No blocking RPC on the main thread.** Requests run on a background queue and results are boxed as
  immutable snapshots before hopping back; the UI must not freeze when the kernel is busy.
- **Compare response ids.** A reply whose id does not match the request means desync: close the
  connection and resync rather than decoding a defaulted state.
- **Tolerant decoding.** `KernelState` decodes field by field with safe defaults, so a new shell can
  talk to an old kernel and vice versa. Extra fields are ignored, missing fields fall back.
- **The shell never reads the memory directory.** Audio playback, records, and settings all go through
  RPC; that is what makes the "single writer" rule enforceable.
- **Verify with the real view.** `sprite-shell --shot <dir>` renders the actual UI to PNG and OCRs it
  back, so layout and copy can be asserted without a human looking at the screen.

## Where things live (memory home)

```
~/.claude-memory/
  identity.md                 evolving identity and personality, authored directly by the agent
  journal/                    append-only truth, one JSONL per Shanghai day + checkpoint.json
  conversations/mailbox.md    the human-readable conversation log (projection)
  diary/  notes/  explorations/  private/  context/    its content dirs (its memory, its space)
  thoughts/stream.jsonl       its thinking stream (projection, human-readable)
  voice/*.m4a                 the original audio of voice notes (the least replaceable thing)
  runtime/core.sock  runtime/gateway.sock              the two sockets (0600)
  config/settings.json        model, quiet hours, proactive cap, hands setting (0600)
  sessions/memory-v1/         current daily pi sessions; old sessions remain intact
  runtime/memory/             versioned contents, proposals and write receipts
  runtime/pi-agent/           isolated pi configuration
  runtime/pi-workspace/       isolated pi working directory
```

`private/` is documented as "its space, the owner may look but is not expected to". Relevant memory excerpts and conversations enter model requests to the configured provider. The full directory is not uploaded as a separate archive.

## Memory: truth, projections, and what "compression" may do

The event journal records facts, authored files preserve interpretations, and the model context is a temporary view. These responsibilities must not be conflated:

1. **`journal/`** records messages and runtime events. It can rebuild conversation and thought projections, but cannot reconstruct arbitrary original notes or audio from tool summaries alone.
2. **Authored originals** include identity, diaries, notes, explorations and private writing. `core/memory-store.ts` preserves full prior versions and uses durable write intents; neither pi compaction nor the kernel's context builder rewrites them.
3. **Current context** is assembled by `core/memory-context.ts` through pi's transient `context` hook before each model call. Identity, constraints and unresolved state remain complete; only optional recent history and the working note are reduced to fit. If the mandatory core cannot fit or cannot be read safely, the pi process stops before requesting the provider.

Existing constraints are preserved as legacy text with unverified provenance. A user-approved exact version receives proposal/command provenance. File text never expands tool permission. New sessions use `sessions/memory-v1/` so old persisted memory snapshots are not silently reactivated; old files remain available for deliberate inspection.

The rules below exist because the obvious alternative — "summarize the memory, keep the gist" — was
tried, measured, and is a quiet disaster. Summaries keep the topic and lose the constraint; the rare
high-stakes event (a reversal, a self-correction, a boundary collision) is exactly what a summarizer
drops; and deleting a source does not delete its descendants.

- **Compression is additive.** The only legitimate form is *index + backlink*: a waypoint file, or a
  paragraph in the working view, that points at exact locations (journal `seq`, file path + line) in
  the truth layer. pi may compact its session view, but that is separate from editing original memory files.
- **Constraints are their own layer and are never summarized.** Lines with operational force
  (calibrations, alarms, prohibitions, boundaries) live in `context/constraints.md`, are always in
  view without truncation. The recommended authoring format carries four fields: *prerequisite / authority / fallback / execution
  consequence*. For a companion this matters more than for a task agent: what gets flattened is not a
  ticket, it is the thing that shaped it.
- **Select by risk, not by frequency.** Keep the events that happened once and mattered.
- **Forgetting must chase derivatives.** If something is ever revoked, deleting the source is not
  enough — index entries, digests, held-back messages and the working view all have to be handled
  too.
- **No destructive scripts.** `tools/compress-memory.sh` is a v2 leftover: it reads the old
  `thoughts/stream.jsonl` pipeline and would delete every file in `diary/`, overwrite `identity.md`,
  and truncate the stream. It now refuses to run before touching anything (guard at the top of the
  file, test in `core/legacy-scripts.test.ts`), and nothing in this repo calls it. Keep it that way.

## Testing and the acceptance run

- Kernel: `npm run core:test` — no build step, Node runs the TypeScript directly.
- Shell: `cd shell && swift test`.
- Everything: `Scripts/verify-all.sh` (typecheck, kernel, contract, a zero-warnings concurrency check,
  self-checks, a live kernel with real `pi`, the voice path, reconnect, soak, scale). Inspect individual stage logs and exit status; record skipped hardware/provider checks separately.
- Regression tests for real incidents live in `core/review-regressions.test.ts`,
  `core/pause-regressions.test.ts`, and `core/observation-facts.test.ts`; each one names the failure
  it reproduces.
- Honest skips: stages that need a microphone, a speech recogniser, or `pi` skip with a printed reason
  when the environment lacks them. A skip is never a pass.

## Reading order for a newcomer

1. `contracts/events.ts` — the event vocabulary and the command surface.
2. `core/main.ts` — the composition root: settings, sockets, breath loop, gateway handlers.
3. `core/breath.ts` — the observation and the run lifecycle.
4. `core/journal.ts` — the single writer, recovery, checkpoints, day rotation.
5. `shell/Sources/SpriteRPC/CoreClient.swift` — how the shell talks, and how it resyncs.
6. `shell/Sources/sprite-shell/ShellModel.swift` — the shell's state and the background-request
   pattern.

## Memory management and release verification (2026-09-21)

The local user RPC `memory.manage` provides path-bound version previews, compare-and-swap restores, and sourced agreement lifecycles; these actions are not exposed to the Agent gateway. `core/memory-management.ts` assembles effective agreements without rewriting the legacy constraints file. Identity writes publish `identity.changed`, and outgoing journal events retain the name used at that time.

The pi extension preflights each new prompt, attempts official compaction once when old history consumes the budget, then rechecks complete core memory before submitting the unchanged prompt. Tool-loop failures stop without replaying side effects. The journal archive uses bounded per-file indexes and signature-validated caches, with disk as the source of truth.

The transient snapshot is inserted before the latest user message, preserving assistant/tool-result adjacency. It includes the current run ID, Shanghai time and requested next wake, so tool continuation is not presented as a new scheduled wake.

Tool attempts (`tool.decided`) and outcomes (`tool.finished`) are separate facts. Successful dedicated writes require a matched completion receipt; arbitrary shell writes and old attempts without receipts are not inferred as verified writes. Scheduling-only runs contribute to idle streaks, while a “just wrote” cue uses only the preceding run.

Public release scope and limitations: [CHANGELOG.md](CHANGELOG.md).

## Downloadable app runtime

`Scripts/package-macos.sh` builds a self-contained DMG/ZIP for the build machine's architecture. The app contains the native shell, a pinned Node binary, locked pi dependencies, product kernel code, licenses and a runtime manifest. `BundledRuntime.swift` starts `bootstrap-runtime.mjs` asynchronously while the shell connects. Source/dev bundles without a manifest use their existing service.

The bootstrap stages a version in Application Support, stops the old launch agent, waits for its memory writer to exit, switches the per-user service definition, and checks RPC readiness. Failure attempts to restore the previous service. Memory remains separate from executable releases. Reopening a healthy installation is a no-op; uninstall stops the writer before removing runtime files and retains memory. This installs the runtime when the app opens; it does not download updates.
