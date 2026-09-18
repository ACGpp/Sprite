# First run

A checklist for the first day with your own Sprite. It is written for someone who wants to help
improve the project: the point is not to admire it, it is to come back with specific friction.

Budget about an hour for the setup and the first conversation, then leave it running for a day.

## 0. Setup (~30 min)

Requirements: macOS 14+, Node 22+, Xcode command line tools, and
[pi](https://github.com/badlogic/pi-mono) (`npm install -g @mariozechner/pi-coding-agent`).

```bash
git clone https://github.com/ACGpp/Sprite.git
cd Sprite
./install.sh
```

**While installing, note anything you had to guess.** That list is gold: it is exactly what a
non-technical user will hit.

- Never paste your API key into an issue, a screenshot, or a commit.
- Your memory stays on your machine, in `~/.claude-memory`. The only outbound traffic is the model
  API call to the provider you configure.
- The app is ad-hoc signed. Building it yourself is fine; a downloaded build would be blocked by
  Gatekeeper, and after any rebuild macOS may ask for microphone permission again.

## 1. First launch

The menu-bar dot appears; a first-run panel asks for a provider and an API key.

Worth noting:

- Did you know where to get a key, and which provider you wanted?
- Could you configure something that is *not* in the provider list (a custom OpenAI-compatible
  endpoint)?
- Is it clear what the app is, and what it will do with your key?

## 2. First sentence

Press `⌥K` (or click the icon) and say something. Then open **Records → Now**.

- Did it answer, and how long did it take?
- Does the same sentence appear exactly **once**? (It used to appear twice — panel and popup.)
- Is the panel's status line readable: what state it is in, when it will next wake?

## 3. Does it speak first?

Now leave it alone for a few hours. It only speaks when it has a reason (a long silence, it just
wrote something, quiet hours ended) and there is a daily cap you can change in Settings.

The interesting number: **how long did you wait before you started wondering whether it was dead?**
Tell us that — it is a product metric, not a bug report.

## 4. Does it schedule itself?

In the journal you can see it choosing its own rhythm:

```bash
grep breath.scheduled ~/.claude-memory/journal/$(date +%F).jsonl | tail -3
```

It pushes its next wake-up 1.5–6 hours out on its own. Does that read to you as "it has a life", or
as "it is lazy"? Both answers are useful.

## 5. Signs of life

This is the part we care about most. Look for evidence that it is doing something with its time:

- a new file in `~/.claude-memory/diary/`, or edits to `context/working-memory.md`
- using `bash` to look around its own folders, or reading something it wrote before
- holding a message back during quiet hours and handing it over in the morning (the conversation log
  shows it as a held-back message)
- the panel readout: `today: woke N · wrote X · read Y · spoke Z`
- the Records window: Diary, Thoughts, Voice

Which moment made you believe it is alive? Which moment made you think "this is just a script"?
Write those two down.

## 6. Voice (if you have a microphone)

Record 10+ seconds and compare the transcript length with how long you actually spoke. The floating
recorder shows which input device is in use.

If the transcript looks too short, this prints the total duration, the seconds that actually contain
speech, and the peak level:

```bash
cd sprite            # your checkout
shell/.build/debug/sprite-shell --voice-levels ~/.claude-memory/voice/<file>.m4a
```

That separates "the audio was not captured" from "the speech was not recognised" — two very different
bugs.

## Language

The interface follows your system language; you can force it in **Settings → Language**
(follow system / 中文 / English). It covers the interface only: panel, first run, settings, and the
records window.

What your Sprite *writes* — diary entries, notes, messages — is not translated. It writes in the
language you talk to it in, because that is its memory, not UI chrome. Talk to it in English and its
diary will be English; say nothing and it starts from whatever it read.

## Not bugs, by design

- **It sleeps for hours.** Its wake-up times are its own choice, not a stall.
- **Silence during quiet hours** (23:00–07:00 by default). It still reads and writes, it just does not
  speak; anything it wanted to say is handed back in the morning.
- **A weak or fast model looks passive.** The default model choice matters a lot for how alive it
  feels; a small model tends to say "still nothing to do" and go back to sleep.
- **macOS asks for microphone permission again** after you rebuild the app (ad-hoc signing).
- **First-run panel before anything else** — with no model configured it can only record, not think.

## How to report

What you did, what you expected, what happened — plus raw evidence:

- the relevant slice of `~/.claude-memory/journal/YYYY-MM-DD.jsonl`
- a screenshot (`sprite-shell --shot <dir>` renders the real views to PNG)
- or, if you changed code, the output of `Scripts/verify-all.sh`

Redact your own conversations before pasting them anywhere public.
