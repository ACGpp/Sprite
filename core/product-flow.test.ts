import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { command, reviewFixture, stateOf, waitFor, type PromptCapture } from "./__test__/review-fixture.ts";
import { readContextFile } from "./session-bootstrap.ts";

function gateway(homeDir: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(path.join(homeDir, "runtime/gateway.sock"));
		let buffer = "";
		socket.setEncoding("utf8");
		socket.setTimeout(3000, () => socket.destroy(new Error("test gateway timeout")));
		socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
		socket.on("data", chunk => {
			buffer += chunk;
			if (buffer.includes("\n")) { socket.destroy(); resolve(JSON.parse(buffer.split("\n")[0]!)); }
		});
		socket.on("error", reject);
	});
}

test("F11 问题可回答，重试和重启不重复，未答问题不被窗口淘汰", async t => {
	const f = reviewFixture(t, "question-flow");
	let kernel = await f.start({ disableAgent: true });
	await command(kernel, { type: "breath.pause", until: "manual" });
	const response = await gateway(f.homeDir, { kind: "capability.ask_user", question: "选择哪篇？", options: ["A", "B"] });
	assert.equal(response.ok, true);
	const questionId = String(response.questionId);
	for (let i = 0; i < 25; i++) kernel.journal.append("question.asked", { question: `问题 ${i}` });
	assert.equal(stateOf(kernel).questions.length, 26);
	const answer = { id: "answer-stable", type: "question.answer", questionId, answer: "A" };
	await command(kernel, answer);
	assert.equal((await command(kernel, answer)).duplicate, true);
	assert.equal(stateOf(kernel).questions.length, 25);
	assert.equal(stateOf(kernel).messages.filter(message => message.id === "answer-stable").length, 1);
	assert.match(stateOf(kernel).pendingMessages[0]!.text, /选择哪篇.*A/);
	kernel = await f.start({ disableAgent: true });
	assert.equal((await command(kernel, answer)).duplicate, true);
	assert.equal(stateOf(kernel).questions.some(question => question.questionId === questionId), false);
	assert.equal(stateOf(kernel).messages.filter(message => message.id === "answer-stable").length, 1);
	await assert.rejects(command(kernel, { type: "question.answer", questionId, answer: "B" }), /已经回答/);
});

test("F08 相同文字的不同 ID 独立入库，同一个 ID 重试只确认一次", async t => {
	const f = reviewFixture(t, "message-id");
	const kernel = await f.start({ disableAgent: true });
	await command(kernel, { type: "breath.pause", until: "manual" });
	await command(kernel, { id: "a", type: "message.send", text: "一样的话" });
	await command(kernel, { id: "b", type: "message.send", text: "一样的话" });
	assert.equal((await command(kernel, { id: "a", type: "message.send", text: "一样的话" })).duplicate, true);
	assert.deepEqual(stateOf(kernel).messages.map(message => message.id), ["a", "b"]);
});

test("F10 跨上海零点后内核提供当前完整记忆与近期背景，观察消息不固化记忆", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-18T15:59:50Z") });
	const f = reviewFixture(t, "bootstrap-day");
	fs.mkdirSync(path.join(f.homeDir, "context"));
	fs.writeFileSync(path.join(f.homeDir, "identity.md"), "# Sprite\nIDENTITY_STABLE");
	fs.writeFileSync(path.join(f.homeDir, "context/constraints.md"), "BOUNDARY_STABLE");
	fs.writeFileSync(path.join(f.homeDir, "context/working-memory.md"), "UNFINISHED_STABLE");
	const kernel = await f.start();
	await kernel.breathNow();
	kernel.journal.append("message.out", { text: "YESTERDAY_REFERENCE" });
	t.mock.timers.setTime(new Date("2026-09-18T16:00:01Z").getTime());
	await kernel.breathNow();
	const prompts = f.readLines<PromptCapture>("prompts.jsonl");
	assert.equal(prompts.length, 2);
	for (const prompt of prompts) assert.doesNotMatch(prompt.message, /IDENTITY_STABLE|BOUNDARY_STABLE|UNFINISHED_STABLE/);
	const generation = f.readLines<{ generation: string }>("starts.jsonl").at(-1)!.generation;
	const fresh = await gateway(f.homeDir, { kind: "memory.context", generation, contextWindow: 128000, outputReserve: 4096, historyTokens: 0 });
	assert.equal(fresh.ok, true);
	for (const sentinel of ["IDENTITY_STABLE", "BOUNDARY_STABLE", "UNFINISHED_STABLE", "YESTERDAY_REFERENCE"]) assert.ok(String(fresh.text).includes(sentinel));
	assert.match(String(fresh.text), /seq=/);
});

test("F10 背景读取有预算，不跟随 identity 链接读取设置秘密", t => {
	const f = reviewFixture(t, "bootstrap-bounds");
	fs.writeFileSync(path.join(f.homeDir, "identity.md"), "身".repeat(10_000));
	const view = readContextFile(f.homeDir, "identity.md", 4000)!;
	assert.equal(view.text.length, 4000);
	assert.equal(view.truncated, true);
	fs.unlinkSync(path.join(f.homeDir, "identity.md"));
	fs.mkdirSync(path.join(f.homeDir, "config"));
	fs.writeFileSync(path.join(f.homeDir, "config/settings.json"), "TEST_ONLY_SECRET");
	fs.symlinkSync("config/settings.json", path.join(f.homeDir, "identity.md"));
	assert.equal(readContextFile(f.homeDir, "identity.md"), undefined);
});

test("显式叫醒越过安静和主动额度仅一轮，原暂停仍保留", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-18T17:00:00Z") });
	const f = reviewFixture(t, "wake-intent");
	const kernel = await f.start({ quietHours: { start: 23, end: 7 }, piEnv: { SPRITE_REVIEW_SAY: "1" } });
	await command(kernel, { type: "settings.update", patch: { proactive: { enabled: false } } });
	await command(kernel, { type: "breath.pause", until: "manual" });
	const result = await command(kernel, { type: "wake.now" });
	assert.equal(result.overrodeQuiet, true);
	await waitFor(() => kernel.journal.events.some(event => event.type === "run.finished"), "显式唤醒结束");
	assert.equal(stateOf(kernel).outgoing.at(-1)!.channel, "bubble");
	assert.equal(stateOf(kernel).presence, "paused");
	assert.equal(kernel.journal.events.find(event => event.type === "run.started")!.data.quiet, false);
	const count = stateOf(kernel).runs;
	await kernel.breathNow("timer");
	assert.equal(stateOf(kernel).runs, count);
});

test("F06 旧进程世代被拒绝，新工具集按最新权限裁定", async t => {
	const f = reviewFixture(t, "generation");
	const kernel = await f.start();
	await kernel.breathNow();
	const old = f.readLines<{ generation: string }>("starts.jsonl")[0]!.generation;
	await command(kernel, { type: "settings.update", patch: { security: { agentShell: "readonly" } } });
	await kernel.breathNow();
	const generation = f.readLines<{ generation: string }>("starts.jsonl").at(-1)!.generation;
	assert.notEqual(generation, old);
	assert.equal((await gateway(f.homeDir, { kind: "capability.say", text: "STALE_REPLY", generation: old })).ok, false);
	assert.equal((await gateway(f.homeDir, { kind: "tool.authorize", tool: "write", generation })).ok, false);
	assert.equal((await gateway(f.homeDir, { kind: "tool.authorize", tool: "read", generation })).ok, true);
	assert.equal(stateOf(kernel).outgoing.some(message => message.text === "STALE_REPLY"), false);
});
