/**
 * 调度器 / 呼吸 / 投影器 的测试（用假 pi，不联网、不依赖真实模型）。
 * 运行：node --test core/breath.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { PiEvent } from "./agent/pi-rpc.ts";
import { buildObservation, createBreathRunner } from "./breath.ts";
import { openJournal } from "./journal.ts";
import { createProjector } from "./projector.ts";
import { clampInterval, createScheduler, isQuietAt, MAX_INTERVAL_MS, MIN_INTERVAL_MS } from "./scheduler.ts";
import { deriveState } from "./state.ts";

const ROOT = path.join(process.cwd(), ".core-test");

function freshDir(name: string): string {
	const dir = path.join(ROOT, name);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** 假 pi：按脚本发出事件，用来驱动真实的呼吸逻辑。 */
function fakePi(script: (emit: (event: PiEvent) => void) => void | Promise<void>) {
	const handlers: Array<(event: PiEvent) => void> = [];
	const prompts: string[] = [];
	return {
		prompts,
		agent: {
			onEvent(handler: (event: PiEvent) => void) {
				handlers.push(handler);
			},
			async send(command: Record<string, unknown>) {
				prompts.push(String(command.message ?? ""));
				const emit = (event: PiEvent) => handlers.forEach((handler) => handler(event));
				// 在下一个 tick 执行脚本，模拟真实异步流
				void Promise.resolve().then(() => script(emit));
				return { success: true };
			},
		},
	};
}

// ─── 调度器 ───

test("调度器：安静时段判断与间隔选择", () => {
	const at = (iso: string) => () => new Date(iso);
	const night = createScheduler({ now: at("2026-09-10T16:00:00Z") }); // 北京 00:00
	assert.equal(night.isQuiet(), true);
	const day = createScheduler({ now: at("2026-09-10T04:00:00Z") }); // 北京 12:00
	assert.equal(day.isQuiet(), false);

	assert.equal(isQuietAt(new Date("2026-09-10T16:00:00Z"), { start: 23, end: 7 }), true);
	assert.equal(isQuietAt(new Date("2026-09-10T02:00:00Z"), { start: 23, end: 7 }), false);
	assert.equal(isQuietAt(new Date("2026-09-10T02:00:00Z"), { start: 9, end: 9 }), false, "起止相同 = 不设安静时段");
});

test("调度器：间隔、自主要求、限幅、暂停、失败退避", () => {
	const scheduler = createScheduler({ now: () => new Date("2026-09-10T04:00:00Z"), intervalMs: 300_000, quietIntervalMs: 1_800_000 });
	const base = scheduler.next({ consecutiveFailures: 0, pause: null });
	assert.equal(base.intervalMs, 300_000);
	assert.equal(base.reason, "interval");

	const requested = scheduler.next({ consecutiveFailures: 0, pause: null, requestedIntervalMs: 60_000 });
	assert.equal(requested.reason, "self-requested");
	assert.equal(requested.intervalMs, 60_000);

	assert.equal(clampInterval(1_000), MIN_INTERVAL_MS, "不能比 30 秒更频繁");
	assert.equal(clampInterval(99 * 60 * 60 * 1000), MAX_INTERVAL_MS, "不能超过 6 小时");

	const backoff = scheduler.next({ consecutiveFailures: 2, pause: null });
	assert.equal(backoff.reason, "backoff");
	assert.equal(backoff.intervalMs, 300_000, "连续失败要退避，而不是疯狂重试");

	const paused = scheduler.next({ consecutiveFailures: 0, pause: { until: new Date("2026-09-10T05:00:00Z").getTime() } });
	assert.equal(paused.reason, "paused");
	assert.equal(paused.intervalMs, 3_600_000);
	assert.equal(scheduler.activePause({ until: new Date("2026-09-10T03:00:00Z").getTime() }), null, "过期的暂停自动失效");
});

// ─── 呼吸 ───

test("呼吸：完整一拍把真实事件写进 journal", async () => {
	const dir = freshDir("breath-ok");
	const journal = openJournal({ dir, exclusive: true, fsync: false });
	journal.append("message.in", { text: "好，慢慢来。", source: "text" });

	const pi = fakePi(async (emit) => {
		emit({ type: "tool_execution_start", toolName: "read", args: { path: "diary/2026-09-09.md" } });
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "读了 9 号的日记。" }] } });
		emit({ type: "agent_end" });
	});

	const runner = createBreathRunner({ journal, pi: pi.agent, isQuiet: () => false, now: () => new Date("2026-09-10T18:30:00Z") });
	const outcome = await runner.run("message");

	assert.equal(outcome.ok, true);
	assert.equal(outcome.activities, 1);
	assert.equal(outcome.thought, "读了 9 号的日记。");

	const state = deriveState(journal.events);
	assert.equal(state.runs, 1);
	assert.equal(state.danglingRun, false);
	assert.equal(state.activities.length, 1);
	assert.equal(state.activities[0].tool, "read");
	assert.equal(state.thoughts.length, 1);
	assert.equal(state.presence, "thinking", "呼吸期间是 thinking；回到静息由调度器负责");

	assert.match(pi.prompts[0], /好，慢慢来。/, "观察里必须带上待处理留言");
	assert.match(pi.prompts[0], /\[02:30\] 醒来/, "观察的时间是 Beijing 墙钟");
	journal.close();
});

test("呼吸：失败如实记录 run.failed，不假装成功", async () => {
	const dir = freshDir("breath-fail");
	const journal = openJournal({ dir, exclusive: true, fsync: false });
	const pi = {
		onEvent() {},
		async send() {
			return { success: false, error: "provider 炸了" };
		},
	};
	const runner = createBreathRunner({ journal, pi, isQuiet: () => false });
	const outcome = await runner.run("timer");

	assert.equal(outcome.ok, false);
	const state = deriveState(journal.events);
	assert.equal(state.failures.length, 1);
	assert.match(state.failures[0], /prompt 被拒绝/);
	assert.equal(state.danglingRun, false, "失败也要收尾，不能留下挂起的 run");
	journal.close();
});

test("呼吸：超时按失败处理并释放并发锁", async () => {
	const dir = freshDir("breath-timeout");
	const journal = openJournal({ dir, exclusive: true, fsync: false });
	const pi = { onEvent() {}, async send() { return { success: true }; } }; // 永不发 agent_end
	const runner = createBreathRunner({ journal, pi, isQuiet: () => false, timeoutMs: 120 });

	const outcome = await runner.run("timer");
	assert.equal(outcome.ok, false);
	assert.match(String(outcome.reason), /超时/);
	assert.equal(runner.running, false, "超时后必须能再次呼吸");
	assert.equal(deriveState(journal.events).failures.length, 1);
	journal.close();
});

test("呼吸：不并发——正在跑时新的触发被拒绝，由调用方排队", async () => {
	const dir = freshDir("breath-serialize");
	const journal = openJournal({ dir, exclusive: true, fsync: false });
	// 用一个"闸门"把第一次呼吸卡住，好观察第二次触发被拒绝。
	// 注意用初值而非 null：只在闭包里赋值的 let 会被类型收窄成 never。
	let releaseGate: () => void = () => {
		throw new Error("闸门还没准备好");
	};
	const pi = fakePi(async (emit) => {
		await new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		emit({ type: "agent_end" });
	});
	const runner = createBreathRunner({ journal, pi: pi.agent, isQuiet: () => false });

	const first = runner.run("timer");
	await new Promise((resolve) => setTimeout(resolve, 20));
	const second = await runner.run("message");
	assert.equal(second.busy, true, "第二次触发必须被拒绝");
	assert.equal(second.ok, false);

	releaseGate();
	const done = await first;
	assert.equal(done.ok, true);
	assert.equal(deriveState(journal.events).runs, 1, "只应有一次 run");
	journal.close();
});

test("观察文本：安静时段标注、无留言时的措辞", () => {
	const text = buildObservation({ pending: [], quiet: true, at: new Date("2026-09-10T18:30:00Z") });
	assert.match(text, /\(安静时段\)|（安静时段）/);
	assert.match(text, /（没有新留言）/);
	assert.match(text, /你想做什么？$/);
});

// ─── 投影器 ───

test("投影器：新内容按 v1 格式落文件，导入事件不重复投影", () => {
	const dir = freshDir("projector");
	const journal = openJournal({ dir, exclusive: true, fsync: false });
	const projector = createProjector({ homeDir: dir, companionName: "零号", fsync: false });

	// 模拟导入阶段的历史事件：水位线之前，不应投影
	const imported = journal.append("message.in", { text: "从 v1 读出来的老留言" });
	const watermark = journal.seq;

	// 水位线之后的新内容
	const incoming = journal.append("message.in", { text: "新的留言" });
	const outgoing = journal.append("message.out", { text: "新的回话", channel: "bubble" });
	const thought = journal.append("thought.recorded", { text: "02:30。醒着。" });
	const ignored = journal.append("presence.changed", { state: "breathing" });

	for (const event of [imported, incoming, outgoing, thought, ignored]) {
		if (event.seq <= watermark) continue;
		const result = projector.project(event);
		assert.equal(result.ok, true, `投影 ${event.type} 不应失败`);
		if (result.ok && event.type !== "presence.changed") {
			assert.ok(result.file.length > 0, `${event.type} 必须报告它写进了哪个产物文件（所有权交接依赖这个）`);
		}
	}

	const mailbox = fs.readFileSync(path.join(dir, "conversations", "mailbox.md"), "utf8");
	assert.match(mailbox, /新的一行|新的留言/, "新内容必须落盘");
	assert.doesNotMatch(mailbox, /从 v1 读出来的老留言/, "导入的历史不得被再投影一遍");
	assert.match(mailbox, /\] 零号: 新的回话/);
	const thoughts = fs.readFileSync(path.join(dir, "thoughts", "stream.jsonl"), "utf8").trim().split("\n");
	assert.equal(thoughts.length, 1);
	assert.equal((JSON.parse(thoughts[0]) as { content: string }).content, "02:30。醒着。");
	assert.ok(projector.supported("message.in") && !projector.supported("presence.changed"));
	journal.close();
});

test("投影器：失败不抛出，返回错误交给调用方上报", () => {
	const projector = createProjector({ homeDir: "/dev/null/definitely-not-a-dir", companionName: "零号", fsync: false });
	const result = projector.project({
		seq: 1,
		at: new Date().toISOString(),
		type: "message.out",
		data: { text: "写不进去" },
	});
	assert.equal(result.ok, false, "必须返回失败而不是抛异常");
	assert.ok(result.ok === false && result.error.length > 0);
});
