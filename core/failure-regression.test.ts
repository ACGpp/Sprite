/**
 * Failure-loop diagnostics and delivery regressions.
 *
 * These tests deliberately use a tiny in-process pi stub. They exercise the
 * same breath runner and journal state machine used by the daemon, without
 * waiting for a real provider or touching the user's memory.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBreathRunner } from "./breath.ts";
import { openJournal } from "./journal.ts";
import { queryMemoryHistory } from "./memory-history.ts";
import { createScheduler, BACKOFF_STEPS_MS } from "./scheduler.ts";
import { createStateTracker } from "./state.ts";
import { safeHistoryData } from "./history-projection.ts";
import { reviewFixture, waitFor } from "./__test__/review-fixture.ts";
import type { PiAgent } from "./agent/pi-rpc.ts";

function home(t: test.TestContext, label: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sprite-failure-${label}-`));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function wait(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

test("快速拒绝（约 20ms）如实记 run.failed(delivered:false)，留言回到待处理且只结算一拍", async t => {
	const dir = home(t, "prompt-rejected");
	const tracker = createStateTracker();
	const journal = openJournal({ dir, fsync: false, onAppend: event => tracker.apply(event) });
	t.after(() => journal.close());
	journal.append("message.in", { text: "不能丢掉的留言", source: "text" });

	let promptCalls = 0;
	const pi: PiAgent = {
		onEvent() {},
		async send(command) {
			if (command.type === "prompt") {
				promptCalls += 1;
				await wait(20);
				return { success: false, error: "provider unavailable" };
			}
			return { success: true };
		},
	};

	const startedAt = Date.now();
	const result = await createBreathRunner({ journal, pi, isQuiet: () => false }).run("timer");
	const duration = Date.now() - startedAt;
	const failed = journal.events.filter(event => event.type === "run.failed");

	assert.equal(promptCalls, 1, "一拍失败只允许一次 prompt，不得在 runner 内热循环");
	assert.equal(result.ok, false);
	assert.equal(failed.length, 1, "必须只有一条终结事件");
	assert.equal(failed[0]!.data.delivered, false, "prompt 被拒绝时不能宣称已送达");
	assert.equal(failed[0]!.data.outcomeUnknown, false, "收到明确拒绝时结果不是未知");
	assert.match(String(failed[0]!.data.reason), /prompt 被拒绝/);
	assert.ok(duration >= 15, `应保留 provider 快速失败的耗时，实际 ${duration}ms`);
	assert.deepEqual(tracker.state.pendingMessages.map(message => message.text), ["不能丢掉的留言"], "明确未送达的留言要回到待处理");
});

test("响应超时在未确认送达时记 delivered:false/outcomeUnknown:true，且不自动重放外部动作", async t => {
	const dir = home(t, "prompt-timeout");
	const tracker = createStateTracker();
	const journal = openJournal({ dir, fsync: false, onAppend: event => tracker.apply(event) });
	t.after(() => journal.close());
	journal.append("message.in", { text: "可能已经被远端收到", source: "text" });

	let prompts = 0;
	const pi: PiAgent = {
		onEvent() {},
		async send(command) {
			if (command.type === "prompt") {
				prompts += 1;
				return new Promise(() => { /* no acknowledgement: runner timeout */ });
			}
			return { success: true };
		},
		async terminate() {},
	};

	const result = await createBreathRunner({ journal, pi, isQuiet: () => false, timeoutMs: 25, cancelTimeoutMs: 5 }).run("timer");
	const failed = journal.events.filter(event => event.type === "run.failed");
	assert.equal(result.ok, false);
	assert.equal(prompts, 1);
	assert.equal(failed.length, 1);
	assert.equal(failed[0]!.data.delivered, false);
	assert.equal(failed[0]!.data.outcomeUnknown, true, "超时不能假设 prompt 没到或已经完成");
	assert.equal(tracker.state.pendingMessages.length, 0, "未知结果不得自动重放，避免外部动作重复执行");
	assert.equal(tracker.state.unsettledMessages[0]?.messages[0]?.text, "可能已经被远端收到");
});

test("连续失败的调度退避为 1/5/15 分钟，不在失败回调中贴着重试", () => {
	const scheduler = createScheduler({ now: () => new Date("2026-09-21T04:00:00.000Z"), quietHours: { start: 0, end: 0 } });
	const plans = [1, 2, 3].map(consecutiveFailures => scheduler.next({ consecutiveFailures, pause: null }));
	assert.deepEqual(plans.map(plan => plan.reason), ["backoff", "backoff", "backoff"]);
	assert.deepEqual(plans.map(plan => plan.intervalMs), BACKOFF_STEPS_MS);
	assert.ok(plans.every(plan => plan.intervalMs >= 60_000), "失败之后不允许 50ms 级热循环");
});

test("memory_history 暴露脱敏、限长的失败诊断，而不是原始 provider 错误", t => {
	const dir = home(t, "history-projection");
	const journal = openJournal({ dir, fsync: false });
	t.after(() => journal.close());
	const raw = journal.append("run.failed", {
		runId: "run-diagnostic",
		reason: "prompt 被拒绝：api_key=SECRET_FAILURE provider unavailable",
		durationMs: 20_004,
		delivered: false,
		outcomeUnknown: false,
	});
	assert.equal(raw.data.reason, "prompt 被拒绝：api_key=SECRET_FAILURE provider unavailable", "journal 原文有原因");

	const history = queryMemoryHistory(dir, { seq: raw.seq });
	assert.equal(history.entries.length, 1);
	assert.equal((history.entries[0]!.data as Record<string, unknown>).reason, "思考引擎明确拒绝了本轮输入。");
	assert.equal((history.entries[0]!.data as Record<string, unknown>).failureCode, "prompt_rejected", "旧事件也返回安全分类");
	assert.doesNotMatch(JSON.stringify(history.entries[0]!.data), /SECRET_FAILURE/);
});


test("失败诊断不泄漏任意原始错误或伪造分类，普通消息保持原文", t => {
 const dir = home(t, "diagnostic-secrets");
 const journal = openJournal({ dir, fsync: false });
 t.after(() => journal.close());
 for (const reason of ["BARE_SECRET", '{"apiKey":"JSON_SECRET"}', "Authorization: Bearer TOKEN_SECRET", "https://host/?key=URL_SECRET", "prompt 被拒绝: RAW_SECRET"]) {
  journal.append("run.failed", { reason, failureCode: "UNTRUSTED_SECRET" });
 }
 const history = queryMemoryHistory(dir);
 assert.doesNotMatch(JSON.stringify(history), /SECRET/);
 assert.equal(queryMemoryHistory(dir, { query: "SECRET" }).entries.length, 0);
 assert.ok(queryMemoryHistory(dir, { query: "prompt_rejected" }).entries.length > 0);
 for (const type of ["message.in", "message.out", "thought.recorded"] as const) {
  const text = "原话：token: abc123，password=example，是普通对话";
  assert.deepEqual(safeHistoryData({ seq: 1, at: "2026-09-22", type, data: { text } }), { text });
 }
});

for (const mode of ["before-ack", "after-ack", "idle"] as const) {
 test(`真实子进程 ${mode} 退出立即结算，后续调用使用新实例且不热循环`, { timeout: 10000 }, async t => {
  const f = reviewFixture(t, `failure-exit-${mode}`);
  const script = path.join(f.homeDir, "exit-pi.mjs");
  fs.writeFileSync(script, `import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
const root=process.env.SPRITE_MEMORY_HOME;
const file=path.join(root,'starts.jsonl');
const first=!fs.existsSync(file);
fs.appendFileSync(file,JSON.stringify({pid:process.pid})+'\\n');
const reply=(x)=>process.stdout.write(JSON.stringify(x)+'\\n');
if(first && ${JSON.stringify(mode)}==='idle') process.exit(78);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.type==='prompt') {
  fs.appendFileSync(path.join(root,'prompts.jsonl'),JSON.stringify({pid:process.pid})+'\\n');
  if(first && ${JSON.stringify(mode)}==='before-ack') process.exit(78);
  reply({type:'response',id:r.id,success:true});
  if(first) setTimeout(()=>process.exit(78),20);
  else reply({type:'agent_end'});
 } else reply({type:'response',id:r.id,success:true});
});`);
  const kernel = await f.start({ piBin: process.execPath, piArgs: [script] });
  t.after(async () => { await kernel.shutdown(); });
  if (mode === "idle") {
   await waitFor(() => kernel.journal.events.some(e => e.type === "system.problem" && e.data.code === "pi.exited"), "idle exit");
  } else {
   const start = Date.now();
   const outcome = await kernel.breathNow() as { ok: boolean };
   assert.equal(outcome.ok, false);
   assert.ok(Date.now() - start < 3000, "退出不能再等待20/120秒");
   const failed = kernel.journal.events.filter(e => e.type === "run.failed");
   assert.equal(failed.length, 1);
   assert.equal(failed[0]!.data.failureCode, "memory_context_failed");
   assert.equal(failed[0]!.data.delivered, mode === "after-ack");
   assert.equal(failed[0]!.data.outcomeUnknown, true);
   assert.equal(kernel.journal.events.filter(e => e.type === "breath.scheduled").at(-1)!.data.intervalMs, 60000);
  }
  assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true);
  await waitFor(() => f.readLines("starts.jsonl").length === 2, "replacement started");
  await wait(100);
  assert.equal(f.readLines("starts.jsonl").length, 2, "不能在退出回调里无限重启");
  const prompts = f.readLines<{pid:number}>("prompts.jsonl");
  const starts = f.readLines<{pid:number}>("starts.jsonl");
  assert.equal(prompts.at(-1)!.pid, starts[1]!.pid);
 });
}

test("pi 意外退出后同进程组后代也必须停止，不能在新实例启动后继续写入", { timeout: 6000 }, async t => {
 const { createPiRpc } = await import("./agent/pi-rpc.ts");
 const dir = home(t, "orphan-process");
 const marker = path.join(dir, "late-write");
 const descendant = path.join(dir, "descendant.mjs");
 fs.writeFileSync(descendant, `import fs from 'node:fs'; process.send('ready'); setTimeout(()=>fs.writeFileSync(process.argv[2], 'BAD'),500); setInterval(()=>{},1000);`);
 const parent = path.join(dir, "parent.mjs");
 fs.writeFileSync(parent, `import {fork} from 'node:child_process'; const child=fork(process.argv[2],[process.argv[3]],{stdio:['ignore','ignore','ignore','ipc']}); child.once('message',()=>process.exit(78));`);
 const pi = createPiRpc({ bin: process.execPath, args: [parent, descendant, marker] });
 t.after(async () => { await pi.terminate(); });
 let exited = false;
 pi.onEvent(event => { if (event.type === "_process_exit") exited = true; });
 pi.start();
 await waitFor(() => exited, "parent exited with live descendant");
 await pi.terminate();
 await wait(700);
 assert.equal(fs.existsSync(marker), false, "意外退出不能留下继续写入的后代");
});
