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
        │   projections: conversations/mailbox.md, diary/, thoughts/, …   │
        └────────────────────────────────────────────────────────────────┘
```

Two processes, one owner. The kernel is the **single writer**; the shell is a viewer that can send
commands; pi is the agent runtime that the kernel drives. Neither the shell nor pi ever writes the
journal.

## Why a journal instead of a database

- **Append-only JSONL, one file per Shanghai day.** Facts are events (`message.in`, `run.started`,
  `message.out`, `diary.written`, `breath.scheduled`, …); the read model is derived by folding them.
- The event log is the **truth**. Markdown files (`conversations/mailbox.md`, `diary/*.md`,
  `thoughts/stream.jsonl`, `voice/`) are projections written by the kernel for humans and for the
  agent to read back. If a projection is lost, it can be regenerated; if the journal is lost, the
  instance's life is lost.
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

- **Allowed roots**: writes are limited to content directories inside the memory home
  (`diary/ explorations/ notes/ private/ context/`). `~`, `..`, and symlinks are resolved and
  rejected.
- **Secret paths**: `config/`, `journal/`, `runtime/`, `sessions/` are refused even for reading, so
  the agent cannot hand out its own API key.
- **Speaking**: `capability.say` goes through the kernel, which decides bubble vs. held-back digest
  (quiet hours) and enforces the daily proactive quota. The model does not get to bypass the limit.
- **Hands setting**: `security.agentShell` = `on` / `readonly` / `off` maps onto pi's `--tools`.

Honest limitation, stated in the README too: this is a collaborative policy layer, not a sandbox. pi
runs as the same user as the kernel, so a determined prompt injection with `bash` enabled is not
contained by path checks alone.

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
  identity.md                 who it is (its own file, written by it)
  journal/                    append-only truth, one JSONL per Shanghai day + checkpoint.json
  conversations/mailbox.md    the human-readable conversation log (projection)
  diary/  notes/  explorations/  private/  context/    its content dirs (its memory, its space)
  thoughts/stream.jsonl       its thinking stream (projection, human-readable)
  voice/*.m4a                 the original audio of voice notes (the least replaceable thing)
  runtime/core.sock  runtime/gateway.sock              the two sockets (0600)
  config/settings.json        model, quiet hours, proactive cap, hands setting (0600)
  sessions/                   pi session state
```

`private/` is documented as "its space, the owner may look but is not expected to". Nothing in the
memory home is ever uploaded; the only outbound traffic is the model API call to the provider the
owner configured.

## Memory: truth, projections, and what "compression" may do

Three layers, in order of authority:

1. **`journal/` — the truth.** Append-only events, one file per Shanghai day. Never rewritten, never
   trimmed, never summarized. Everything else can be rebuilt from it.
2. **Projections — `conversations/mailbox.md`, `thoughts/stream.jsonl`, `diary/`, `voice/`.** Written
   by the kernel for humans, and (diary, notes, explorations) by the instance itself. These are
   *outputs*, not cache: they are never deleted or replaced by a summary.
3. **The working view — `context/working-memory.md`, `context/constraints.md`.** The only layer that
   may be *evicted*. It is what the kernel puts in front of the model on each breath, and eviction
   means "out of view", never "gone": the files stay, and a truncated block always carries its own
   path so the agent can read the rest itself.

The rules below exist because the obvious alternative — "summarize the memory, keep the gist" — was
tried, measured, and is a quiet disaster. Summaries keep the topic and lose the constraint; the rare
high-stakes event (a reversal, a self-correction, a boundary collision) is exactly what a summarizer
drops; and deleting a source does not delete its descendants.

- **Compression is additive.** The only legitimate form is *index + backlink*: a waypoint file, or a
  paragraph in the working view, that points at exact locations (journal `seq`, file path + line) in
  the truth layer. If a step cannot be written as "a new file that points at the old files", it is not
  allowed to touch them.
- **Constraints are their own layer and are never summarized.** Lines with operational force
  (calibrations, alarms, prohibitions, boundaries) live in `context/constraints.md`, are always in
  view, and each one carries four fields: *prerequisite / authority / fallback / execution
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

- Kernel: `node --test "core/**/*.test.ts"` — no build step, Node runs the TypeScript directly.
- Shell: `cd shell && swift test`.
- Everything: `Scripts/verify-all.sh` (typecheck, kernel, contract, a zero-warnings concurrency check,
  self-checks, a live kernel with real `pi`, the voice path, reconnect, soak, scale). Prefer this over
  any number written in prose.
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
