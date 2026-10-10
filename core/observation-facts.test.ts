/**
 * "只补事实"（2026-09-14 的产品决定 A）+ "它今天做了什么"的读数。
 *
 * 背景：它在醒来时收到的全部内容是"醒来。你想做什么？"——没有能力、没有记忆现状、
 * 没有上次做过什么，于是小模型三天里只会说"继续休息"，一次文件都没写过。
 * 这里守两件事：
 *   1. 这些**事实**必须真的出现在观察里（缺了就等于没补）；
 *   2. 寂静时段必须说清楚"只是不说话，读写想都不受限制"（它此前理解成"什么都别做"）。
 *
 * 运行：node --test core/observation-facts.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildObservation } from "./breath.ts";
import { startKernel } from "./main.ts";
import { rpcCall } from "./rpc/server.ts";
import { dayInShanghai } from "./text.ts";
import { reviewFixture, type PromptCapture } from "./__test__/review-fixture.ts";
import { patchSettings } from "./settings.ts";

const ROOT = path.join(process.cwd(), ".core-test");
const at = new Date("2026-09-14T02:00:00.000Z"); // 上海 10:00

test("纯调度连续空转、写入核验计数重启后保持；旧开始事件不是成功回执", async t => {
	const f = reviewFixture(t, "activity-outcomes");
	let kernel = await f.start({ disableAgent: true });
	for (let i = 0; i < 5; i++) {
		const runId = `idle-${i}`;
		kernel.journal.append("run.started", { runId });
		kernel.journal.append("run.activity", { runId, tool: "set_next_breath" });
		kernel.journal.append("run.finished", { runId, activities: 1 }); // Legacy format.
	}
	const facts = () => kernel.status() as { idleStreak: number; today: { actions: number; writes: number } };
	assert.equal(facts().idleStreak, 5);
	for (const [success, verified] of [[false, false], [true, false], [true, true]]) {
		kernel.journal.append("run.activity", { runId: "writing", tool: "edit" });
		kernel.journal.append("tool.finished", { runId: "writing", tool: "edit", success, verified });
	}
	assert.equal(facts().today.writes, 1);
	await kernel.shutdown();
	kernel = await f.start({ disableAgent: true });
	assert.equal(facts().idleStreak, 5);
	assert.equal(facts().today.writes, 1, "重启不能把失败或无回执的旧写入算成功");
	kernel.journal.append("run.started", { runId: "read" });
	kernel.journal.append("run.activity", { runId: "read", tool: "read" });
	kernel.journal.append("run.finished", { runId: "read", activities: 1, substantiveActivities: 1 });
	assert.equal(facts().idleStreak, 0);
	await kernel.shutdown();
});

test("记忆事实使用上海修改日期：刚跨午夜和满一天不能混为一谈", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-09T16:05:00Z") });
	const f = reviewFixture(t, "diary-calendar-day");
	const kernel = await f.start();
	fs.mkdirSync(path.join(f.homeDir, "diary"), { recursive: true });
	const file = path.join(f.homeDir, "diary", "yesterday.md");
	fs.writeFileSync(file, "YESTERDAY_DIARY");
	const modified = new Date("2026-10-09T15:00:00Z"); // 上海昨天 23:00，仅过去 65 分钟。
	fs.utimesSync(file, modified, modified);
	assert.equal((await kernel.breathNow("manual") as { ok: boolean }).ok, true);
	const prompt = f.readLines<PromptCapture>("prompts.jsonl").at(-1)!.message;
	assert.match(prompt, /最近修改于 2026-10-09（上海日期/);
	assert.doesNotMatch(prompt, /最近一篇是今天写的/);
	await kernel.shutdown();
});

test("主动由头只引用上一轮核验成功的写入，不把失败或更早的写入说成刚完成", async t => {
	const f = reviewFixture(t, "write-nudge");
	patchSettings(f.homeDir, { proactive: { enabled: true, perDay: 30 } });
	const kernel = await f.start();
	try {
		const finishWrite = (runId: string, verified: boolean) => {
			kernel.journal.append("run.started", { runId });
			kernel.journal.append("run.activity", { runId, tool: "write", summary: '{"path":"notes/test.md"}' });
			kernel.journal.append("tool.finished", { runId, tool: "write", path: "notes/test.md", success: verified, verified });
			kernel.journal.append("run.finished", { runId, activities: 1 });
		};
		finishWrite("successful-write", true);
		await kernel.breathNow("manual");
		assert.match(f.readLines<PromptCapture>("prompts.jsonl").at(-1)!.message, /你上一次醒来写了东西（notes\/test.md）/);
		finishWrite("failed-write", false);
		await kernel.breathNow("manual");
		assert.doesNotMatch(f.readLines<PromptCapture>("prompts.jsonl").at(-1)!.message, /你上一次醒来写了东西/);
	} finally { await kernel.shutdown(); }
});

test("事实必须出现在观察里：能力 / 记忆 / 上次醒来 / 今天做了什么", () => {
	const prompt = buildObservation({
		pending: [],
		quiet: false,
		at,
		facts: {
			capabilities: "你的手脚：能读写 diary/ notes/，也能跑命令。",
			memory: "你的记忆：日记 44 篇，最近一篇是 35 天前写的。",
			lastRun: "上一次醒来（1.5 小时前），你一个动作都没做。",
			today: "今天（上海日）：醒来 3 次，工具动作 0 次（写/改 0，读 0），说话 0 次。",
		},
	});
	assert.match(prompt, /你的手脚：/, "能力必须说清楚");
	assert.match(prompt, /日记 44 篇/, "记忆现状必须说清楚");
	assert.match(prompt, /一个动作都没做/, "上次醒来做了什么必须说");
	assert.match(prompt, /今天（上海日）：醒来 3 次/, "今天的读数必须出现");
	assert.match(prompt, /你想做什么？$/, "结尾仍然把决定权留给它（不是命令）");
});

test("安静时段必须讲清楚：只是不说话，读写想不受限制", () => {
	const quiet = buildObservation({ pending: [], quiet: true, at });
	assert.match(quiet, /安静时段只影响说话/, "少了这句，它会把安静理解成「什么都别做」（真实事故）");
	assert.match(quiet, /读、写、想都不受限制/);
	const awake = buildObservation({ pending: [], quiet: false, at });
	assert.doesNotMatch(awake, /安静时段只影响说话/, "不安静时不该出现这句");
});

test("事实缺省时不留空块（旧调用方不该看到空标题）", () => {
	const prompt = buildObservation({ pending: [], quiet: false, at });
	assert.doesNotMatch(prompt, /undefined/);
	assert.match(prompt, /你想做什么？$/);
});

test("跨上海日的第一拍不能把前一天的统计喂给 Agent", { timeout: 60_000 }, async () => {
	const home = path.join(ROOT, "observation-facts-day-rollover");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(home, "journal"), { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), "");
	const today = dayInShanghai(new Date());
	const yesterday = dayInShanghai(new Date(Date.now() - 86_400_000));
	fs.writeFileSync(
		path.join(home, "journal", `${today}.jsonl`),
		JSON.stringify({
			seq: 1,
			at: `${yesterday}T04:00:00.000Z`,
			type: "run.started",
			data: { runId: "old-day", trigger: "timer" },
		}) + "\n",
	);
	const promptFile = path.join(home, "prompt.txt");
	const fakePi = path.join(home, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		[
			"#!/usr/bin/env node",
			"import fs from 'node:fs';",
			"process.stdin.setEncoding('utf8');",
			"let buf = '';",
			"process.stdin.on('data', (chunk) => {",
			"  buf += chunk;",
			"  let i;",
			"  while ((i = buf.indexOf('\\n')) >= 0) {",
			"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
			"    if (!line.trim()) continue;",
			"    const request = JSON.parse(line);",
			`    if (request.type === 'prompt') fs.writeFileSync(${JSON.stringify(promptFile)}, request.message);`,
			"    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n');",
			"    if (request.type === 'prompt') process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');",
			"  }",
			"});",
		].join("\n"),
		{ mode: 0o755 },
	);
	const kernel = await startKernel({
		homeDir: home,
		piBin: fakePi,
		intervalMs: 3_600_000,
		quietHours: { start: 0, end: 0 },
		fsync: false,
		log: () => {},
	});
	try {
		await kernel.breathNow("manual");
		const prompt = fs.readFileSync(promptFile, "utf8");
		assert.match(prompt, new RegExp(`今天（上海日）：醒来 0 次`), "跨日第一拍应先清零昨天的读数");
	} finally {
		await kernel.stop();
	}
});

test("内核读数：今天做了什么 + 连续空转，界面上要能看见", { timeout: 60_000 }, async () => {
	const home = path.join(ROOT, "observation-facts");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), "");
	// 一篇 35 天前的日记：记忆现状必须读到它
	fs.mkdirSync(path.join(home, "diary"), { recursive: true });
	const diaryFile = path.join(home, "diary", "2026-08-10.md");
	fs.writeFileSync(diaryFile, "# 旧日记\n");
	const old = new Date(Date.now() - 35 * 86_400_000);
	fs.utimesSync(diaryFile, old, old);

	// 假引擎：什么都不做（不调工具）→ 连续空转应当累加
	const fakePi = path.join(home, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		[
			"#!/usr/bin/env node",
			"process.stdin.setEncoding('utf8');",
			"let buf = '';",
			"process.stdin.on('data', (chunk) => {",
			"  buf += chunk;",
			"  let i;",
			"  while ((i = buf.indexOf('\\n')) >= 0) {",
			"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
			"    if (!line.trim()) continue;",
			"    const request = JSON.parse(line);",
			"    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n');",
			"    if (request.type === 'prompt') process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');",
			"  }",
			"});",
		].join("\n"),
		{ mode: 0o755 },
	);

	const kernel = await startKernel({
		homeDir: home,
		piBin: fakePi,
		intervalMs: 400,
		quietHours: { start: 0, end: 0 },
		fsync: false,
		log: () => {},
	});
	try {
		for (let i = 0; i < 60; i += 1) {
			const round = (await rpcCall(kernel.socketPath, { id: "s", type: "query.status" })) as {
				result: { today?: { wakes: number; actions: number; writes: number; reads: number; said: number }; idleStreak?: number };
			};
			if (round.result.today && round.result.today.wakes >= 2) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const status = (await rpcCall(kernel.socketPath, { id: "s2", type: "query.status" })) as {
			result: { today?: { wakes: number; actions: number; writes: number; reads: number; said: number }; idleStreak?: number };
		};
		assert.ok(status.result.today, "status 必须带今天的读数（界面靠它显示「它今天做了什么」）");
		assert.ok(status.result.today!.wakes >= 2, `醒来次数应当累计（实际 ${status.result.today!.wakes}）`);
		assert.equal(status.result.today!.actions, 0, "这一轮假引擎什么都没做");
		assert.ok((status.result.idleStreak ?? 0) >= 1, "连续空转必须能数出来，界面才有东西提示");

		// 外壳的 state 来自 **snapshot**（不是 status）：两处都必须带读数，
		// 否则界面永远显示不出"它今天做了什么"（实测踩过：只加了 status，面板空白）。
		const snapshot = (await rpcCall(kernel.socketPath, { id: "snap", type: "query.snapshot" })) as {
			result: { state?: { today?: { wakes: number }; idleStreak?: number } };
		};
		assert.ok(snapshot.result.state?.today, "snapshot 的 state 也必须带今天的读数");
		assert.ok((snapshot.result.state?.today?.wakes ?? 0) >= 1, "snapshot 里的读数应当有值");
	} finally {
		await kernel.stop();
	}
});
