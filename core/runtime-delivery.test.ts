/** Runtime lifecycle regression: isolated journals/processes, no network or user files. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createBreathRunner } from "./breath.ts";
import { createPiRpc, type PiAgent, type PiEvent } from "./agent/pi-rpc.ts";
import { openJournal } from "./journal.ts";
import { applyEvent, createStateTracker, emptyState } from "./state.ts";
import { reviewFixture, waitFor } from "./__test__/review-fixture.ts";

for (const succeeds of [true, false]) {
	test(`F04 auto retry reports only final ${succeeds ? "success" : "failure"}`, async t => {
		const f = reviewFixture(t, "retry");
		const journal = openJournal({ dir: f.homeDir, fsync: false });
		t.after(() => journal.close());
		let emit: (event: PiEvent) => void = () => {};
		let retryEmitted = false;
		const pi: PiAgent = {
			onEvent(handler) { emit = handler; },
			async send() {
				queueMicrotask(() => {
					emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "temporary" } });
					emit({ type: "agent_end" });
					emit({ type: "auto_retry_start" });
					setTimeout(() => {
						retryEmitted = true;
						if (succeeds) emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "RETRIED" }], stopReason: "stop" } });
						emit({ type: "auto_retry_end", success: succeeds, finalError: "retry exhausted" });
						emit({ type: "agent_end" });
					}, 20);
				});
				return { success: true };
			},
		};
		const result = await createBreathRunner({ journal, pi, isQuiet: () => false }).run("manual");
		assert.equal(retryEmitted, true);
		assert.equal(result.ok, succeeds);
		assert.equal(journal.events.filter(event => event.type === (succeeds ? "run.finished" : "run.failed")).length, 1);
		assert.equal(journal.events.filter(event => event.type === (succeeds ? "run.failed" : "run.finished")).length, 0);
	});
}

test("F03 exact claimed batch survives checkpoint and hot-cache trimming", () => {
	const tracker = createStateTracker(2);
	let seq = 0;
	const append = (type: Parameters<typeof applyEvent>[1]["type"], data: Record<string, unknown>) => tracker.apply({ seq: ++seq, at: new Date().toISOString(), type, data });
	for (let i = 0; i < 12; i++) append("message.in", { text: `claimed-${i}` });
	append("run.started", { runId: "batch", claimedMessageSeqs: Array.from({ length: 12 }, (_, i) => i + 1) });
	const restored = createStateTracker(2);
	assert.equal(restored.restore(JSON.parse(JSON.stringify(tracker.snapshot()))), true);
	restored.apply({ seq: ++seq, at: new Date().toISOString(), type: "message.in", data: { text: "later" } });
	restored.apply({ seq: ++seq, at: new Date().toISOString(), type: "run.failed", data: { runId: "batch", delivered: false } });
	assert.deepEqual(restored.state.pendingMessages.map(message => message.text), [...Array.from({ length: 12 }, (_, i) => `claimed-${i}`), "later"]);
	assert.deepEqual(restored.state.claimedRuns, {});
	const old = { ...emptyState() } as Record<string, unknown>;
	delete old.claimedRuns;
	assert.equal(createStateTracker().restore(old), false, "old checkpoint must rebuild exact batches from journal");
});

test("F03 unknown outcome retains messages without replaying external actions", () => {
	const state = emptyState();
	applyEvent(state, { seq: 1, at: "2026-09-19", type: "message.in", data: { text: "external work" } });
	applyEvent(state, { seq: 2, at: "2026-09-19", type: "run.started", data: { runId: "crashed" } });
	applyEvent(state, { seq: 3, at: "2026-09-19", type: "run.failed", data: { runId: "crashed", outcomeUnknown: true, delivered: false } });
	assert.equal(state.pendingMessages.length, 0);
	assert.equal(state.unsettledMessages[0]?.messages[0]?.text, "external work");
	assert.equal(state.danglingRun, false);
});

test("F05 cancel waits for termination and permanently retires the old runner", async t => {
	const f = reviewFixture(t, "cancel-gate");
	const journal = openJournal({ dir: f.homeDir, fsync: false });
	t.after(() => journal.close());
	let emit: (event: PiEvent) => void = () => {};
	let terminateStarted = false;
	let release!: () => void;
	const termination = new Promise<void>(resolve => { release = resolve; });
	const pi: PiAgent = {
		onEvent(handler) { emit = handler; },
		async send(command) {
			if (command.type === "abort") queueMicrotask(() => emit({ type: "agent_end" }));
			return { success: true };
		},
		async terminate() { terminateStarted = true; await termination; },
	};
	const runner = createBreathRunner({ journal, pi, isQuiet: () => false });
	const first = runner.run("message");
	const cancellation = runner.cancel("permissions changed");
	await waitFor(() => terminateStarted, "termination requested");
	assert.equal(runner.running, true, "running stays true until process termination is confirmed");
	assert.equal((await runner.run("message")).busy, true);
	release();
	await cancellation;
	assert.equal((await first).ok, false);
	assert.equal(runner.retired, true);
	const beforeLate = journal.seq;
	emit({ type: "tool_execution_start", toolName: "write" });
	emit({ type: "agent_end" });
	assert.equal(journal.seq, beforeLate, "late events cannot modify the closed run");
	assert.equal((await runner.run("message")).restartRequired, true);
});

test("F05 hung process is killed; delayed old side effects never reach the next instance", { timeout: 8000 }, async t => {
	const f = reviewFixture(t, "kill-process");
	const marker = path.join(f.homeDir, "should-not-exist");
	const script = path.join(f.homeDir, "hanging-pi.mjs");
	fs.writeFileSync(script, `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {});
let buf = '';
process.stdin.on('data', chunk => {
 buf += chunk;
 let n;
 while ((n = buf.indexOf('\\n')) >= 0) {
  const request = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
  process.stdout.write(JSON.stringify({type:'response', id:request.id, success:true})+'\\n');
  if (request.type === 'prompt') {
   spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'OLD_SIDE_EFFECT'),1200)", process.argv[2]], {stdio:'ignore'});
   setTimeout(() => process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n'), 1400);
  }
 }
});
`);
	const journal = openJournal({ dir: f.homeDir, fsync: false });
	const pi = createPiRpc({ bin: process.execPath, args: [script, marker] });
	t.after(async () => { await pi.terminate(); journal.close(); });
	pi.start();
	const runner = createBreathRunner({ journal, pi, isQuiet: () => false, timeoutMs: 150, cancelTimeoutMs: 30 });
	const result = await runner.run("manual");
	assert.equal(result.ok, false);
	assert.equal(result.restartRequired, true);
	assert.equal(pi.alive, false, "process exit is confirmed before completing timeout");
	fs.writeFileSync(script, `
let buffer = '';
process.stdin.on('data', chunk => {
 buffer += chunk;
 let at;
 while ((at = buffer.indexOf('\\n')) >= 0) {
  const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
  process.stdout.write(JSON.stringify({type:'response',id:request.id,success:true})+'\\n');
  if (request.type === 'prompt') process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');
 }
});
`);
	pi.start();
	const replacement = createBreathRunner({ journal, pi, isQuiet: () => false });
	assert.equal((await replacement.run("manual")).ok, true);
	await new Promise(resolve => setTimeout(resolve, 900));
	assert.equal(fs.existsSync(marker), false, "the old shell child must not survive cancellation");
	assert.equal(journal.events.filter(event => event.type === "run.finished").length, 1, "only the replacement may finish successfully");
});

test("F05 missing prompt acknowledgement is uncertain and never silently requeued", async t => {
	const f = reviewFixture(t, "no-ack");
	const tracker = createStateTracker();
	const journal = openJournal({ dir: f.homeDir, fsync: false, onAppend: event => tracker.apply(event) });
	t.after(() => journal.close());
	journal.append("message.in", { text: "DO_NOT_REPLAY" });
	const pi: PiAgent = { onEvent() {}, async send() { throw new Error("pipe closed after write"); }, async terminate() {} };
	const outcome = await createBreathRunner({ journal, pi, getState: () => tracker.state, isQuiet: () => false, cancelTimeoutMs: 10 }).run("message");
	assert.equal(outcome.ok, false);
	assert.equal(outcome.restartRequired, true);
	assert.equal(tracker.state.pendingMessages.length, 0);
	assert.equal(tracker.state.unsettledMessages[0]?.messages[0]?.text, "DO_NOT_REPLAY");
});

// Uses the installed pi retry state machine, with a local in-memory provider.
for (const mode of ["retry-success", "retry-fail"] as const) {
	test(`F04 actual pi ${mode} settles once after its final attempt`, { timeout: 15_000 }, async t => {
		const { piBin, skipWithoutPi } = await import("./__test__/pi-available.ts");
		const unavailable = skipWithoutPi();
		if (unavailable) { t.skip(unavailable); return; }
		const { patchSettings } = await import("./settings.ts");
		const f = reviewFixture(t, mode);
		patchSettings(f.homeDir, { model: { mode: "provider", provider: "spike", model: "spike-1", apiKey: "TEST_ONLY" } });
		const agentHome = path.join(f.homeDir, "runtime/pi-agent");
		fs.mkdirSync(path.join(agentHome, "extensions"), { recursive: true });
		fs.writeFileSync(path.join(agentHome, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 20 } }));
		fs.symlinkSync(path.resolve("core/__test__/review-provider.ts"), path.join(agentHome, "extensions/review-provider.ts"));
		const capture = path.join(f.homeDir, "capture.json");
		const kernel = await f.start({ piBin: piBin(), piExtensions: [path.resolve("core/__test__/review-provider.ts")], piEnv: { SPRITE_SPIKE_KEY: "spike", SPRITE_REVIEW_MODE: mode, SPRITE_REVIEW_CAPTURE: capture } });
		const result = await kernel.breathNow() as { ok: boolean; thought: string };
		assert.equal(fs.readFileSync(`${capture}.attempts`, "utf8"), "2", "must await pi's second attempt");
		assert.equal(result.ok, mode === "retry-success");
		const terminals = kernel.journal.events.filter(event => event.type === "run.finished" || event.type === "run.failed");
		assert.equal(terminals.length, 1);
		assert.equal(terminals[0]?.type, mode === "retry-success" ? "run.finished" : "run.failed");
	});
}
