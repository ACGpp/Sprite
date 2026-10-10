/** Actual pi 0.70.2: recover before a turn, never replay a prompt or its tools. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { piBin, skipWithoutPi } from "./__test__/pi-available.ts";
import { reviewFixture } from "./__test__/review-fixture.ts";
import { createPiRpc, type PiEvent } from "./agent/pi-rpc.ts";

const skip = skipWithoutPi();
type Capture = { compaction: boolean; messages: Array<{ role: string; content: unknown }> };
async function fixture(t: TestContext, mode: string) {
	const f = reviewFixture(t, `mem-rec-${mode}`);
	fs.mkdirSync(path.join(f.homeDir, "context"));
	const identity = "FULL_IDENTITY_START\n" + "i".repeat(4000) + "\nFULL_IDENTITY_END";
	const constraints = "FULL_CONSTRAINTS_START\n" + "c".repeat(4000) + "\nFULL_CONSTRAINTS_END";
	fs.writeFileSync(path.join(f.homeDir, "identity.md"), identity);
	fs.writeFileSync(path.join(f.homeDir, "context/constraints.md"), constraints);
	const kernel = await f.start({ disableAgent: true });
	kernel.journal.append("question.asked", { questionId: "recovery-question", question: "FULL_UNRESOLVED_QUESTION", options: ["稍后"] });
	const agentDir = path.join(f.homeDir, "recovery-agent"); fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: mode.startsWith("auto-"), keepRecentTokens: 32, reserveTokens: 16384 }, retry: { enabled: false } }));
	const session = path.join(f.homeDir, "recovery-session.jsonl");
	const captures = () => f.readLines<Capture>("recovery-capture.jsonl");
	const events: PiEvent[] = [];
	const pi = createPiRpc({ bin: piBin(), cwd: f.homeDir, env: { ...f.config.piEnv,
		PI_CODING_AGENT_DIR: agentDir, MEMORY_TEST_KEY: "TEST_ONLY", SPRITE_MEMORY_RECOVERY_MODE: mode,
		SPRITE_MEMORY_CAPTURE: path.join(f.homeDir, "recovery-capture.jsonl"), SPRITE_MEMORY_HOME: f.homeDir,
		SPRITE_GATEWAY_SOCK: path.join(f.homeDir, "runtime/gateway.sock"), SPRITE_HOME: f.homeDir, SPRITE_AGENT_SHELL: "on",
	}, args: ["--mode", "rpc", "--provider", "memory-recovery", "--model", "recovery-1", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--system-prompt", "Recovery test runtime", "--append-system-prompt", " ", "--tools", "read,write,edit,memory_propose,memory_history", "-e", path.resolve("pi-extension/sprite.ts"), "-e", path.resolve("core/__test__/memory-recovery-provider.ts"), "--session", session] });
	pi.onEvent(event => events.push(event)); pi.start();
	t.after(async () => { await pi.terminate(); await kernel.shutdown(); });
	async function prompt(message: string) {
		const before = events.filter(event => event.type === "agent_end").length;
		assert.equal((await pi.send({ type: "prompt", message })).success, true);
		const deadline = Date.now() + 10000;
		while (events.filter(event => event.type === "agent_end").length === before) {
			assert.ok(pi.alive && Date.now() < deadline, "真实 pi 必须在时限内完成本轮");
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	}
	return { ...f, pi, kernel, events, session, captures, prompt, identity, constraints };
}

test("真实 pi：轮前历史超预算自动压缩一次，当轮正文与完整记忆不丢失、不重复", { skip, timeout: 30000 }, async t => {
	const f = await fixture(t, "success");
	const oldPrompt = "OLD_HISTORY_START\n" + "h".repeat(65000) + "\nOLD_HISTORY_END";
	const current = "CURRENT_REQUEST_START\n" + "n".repeat(65000) + "\nCURRENT_REQUEST_END";
	await f.prompt(oldPrompt); await f.prompt("Finish this prior turn. ".repeat(10)); await f.prompt(current);
	const calls = f.captures();
	assert.deepEqual(calls.map(call => call.compaction), [false, false, true, false]);
	assert.ok(!JSON.stringify(calls[2]!.messages).includes("CURRENT_REQUEST_START"), "本轮尚未入 session，不能被压缩");
	const last = JSON.stringify(calls.at(-1)!.messages);
	for (const text of [f.identity, f.constraints, current]) assert.ok(last.includes(JSON.stringify(text).slice(1, -1)), "完整原文必须进入恢复后的模型上下文");
	assert.match(last, /FULL_UNRESOLVED_QUESTION/);
	assert.match(last, /RECOVERED_HISTORY_SUMMARY/);
	assert.equal(last.split("CURRENT_REQUEST_START").length - 1, 1);
	assert.equal(last.split("内核记忆快照：").length - 1, 1);
	const entries = f.readLines<{ type: string; message?: { content?: unknown } }>("recovery-session.jsonl");
	assert.equal(entries.filter(entry => entry.type === "compaction").length, 1, "必须是 pi 持久化的实际压缩，不是截断历史");
	assert.equal(entries.filter(entry => entry.type === "message" && JSON.stringify(entry.message?.content).includes("CURRENT_REQUEST_START")).length, 1);
	assert.ok(fs.readFileSync(f.session, "utf8").includes("OLD_HISTORY_END"), "原始历史保留在 append-only session");
	assert.equal(fs.readFileSync(path.join(f.homeDir, "identity.md"), "utf8"), f.identity);
	assert.equal(fs.readFileSync(path.join(f.homeDir, "context/constraints.md"), "utf8"), f.constraints);
	assert.ok(!f.kernel.journal.events.some(event => event.type === "system.problem" && event.data.code === "memory.context.failed"), "可恢复的预检不向用户误报失败");
});

for (const mode of ["failure", "no-room"] as const) test(`真实 pi：${mode} 压缩最多一次，失败后不调用正常 provider`, { skip, timeout: 30000 }, async t => {
	const f = await fixture(t, mode);
	await f.prompt("OLD_HISTORY " + "h".repeat(65000));
	await f.prompt("Finish this prior turn. ".repeat(10));
	await assert.rejects(f.pi.send({ type: "prompt", message: "CURRENT_REQUEST " + "n".repeat(65000) }), /pi 已退出/);
	assert.deepEqual(f.captures().map(call => call.compaction), [false, false, true], "只允许一次摘要请求，不得继续或重放正常调用");
	assert.ok(f.events.some(event => event.type === "_process_exit" && event.code === 78));
	assert.ok(f.kernel.journal.events.some(event => event.type === "system.problem" && event.data.code === "memory.context.failed"));
	assert.ok(!fs.readFileSync(f.session, "utf8").includes("CURRENT_REQUEST"), "失败的轮前预检不消费本轮正文");
});

test("真实 pi：核心记忆自身过大时禁止用压缩绕过完整性检查", { skip, timeout: 30000 }, async t => {
	const f = await fixture(t, "core-too-large");
	fs.writeFileSync(path.join(f.homeDir, "context/constraints.md"), "x".repeat(140000));
	await assert.rejects(f.pi.send({ type: "prompt", message: "CURRENT_REQUEST" }), /pi 已退出/);
	assert.equal(f.captures().length, 0, "普通推理和摘要 provider 均不得被调用");
	assert.ok(f.events.some(event => event.type === "_process_exit" && event.code === 78));
});

test("真实 pi：工具后预算耗尽明确停止，不压缩重放已执行写入", { skip, timeout: 30000 }, async t => {
	const f = await fixture(t, "tool-too-large");
	fs.mkdirSync(path.join(f.homeDir, "notes"));
	fs.writeFileSync(path.join(f.homeDir, "notes/big.md"), "b".repeat(48000));
	assert.equal((await f.pi.send({ type: "prompt", message: "CURRENT_REQUEST " + "n".repeat(80000) })).success, true);
	const deadline = Date.now() + 10000;
	while (!f.events.some(event => event.type === "_process_exit")) {
		assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.equal(fs.readFileSync(path.join(f.homeDir, "notes/once.md"), "utf8"), "ONE_VERIFIED_WRITE");
	assert.equal(f.events.filter(event => event.type === "tool_execution_start" && event.toolCallId === "write-once").length, 1);
	assert.deepEqual(f.captures().map(call => call.compaction), [false], "工具之后既不调用摘要模型，也不再次调用普通模型");
	assert.ok(f.events.some(event => event.type === "_process_exit" && event.code === 78));
	assert.ok(f.kernel.journal.events.some(event => event.type === "system.problem" && event.data.code === "memory.context.failed"));
});

test("真实 pi：显式 RPC 压缩同样不能绕过必要记忆完整性检查", { skip, timeout: 30000 }, async t => {
	const f = await fixture(t, "manual-guard");
	await f.prompt("PRIOR_HISTORY ".repeat(1000));
	await f.prompt("Finish this prior turn. ".repeat(10));
	const constraintFile = path.join(f.homeDir, "context/constraints.md");
	fs.unlinkSync(constraintFile); fs.symlinkSync("/nonexistent-sprite-memory-recovery", constraintFile);
	await assert.rejects(f.pi.send({ type: "compact" }), /pi 已退出/);
	assert.deepEqual(f.captures().map(call => call.compaction), [false, false], "必要记忆损坏后不得调用摘要 provider");
	assert.ok(f.events.some(event => event.type === "_process_exit" && event.code === 78));
});

for (const mode of ["auto-success", "auto-guard"] as const) test(`真实 pi：官方自动压缩保持开启，${mode} 经过必要记忆检查`, { skip, timeout: 30000 }, async t => {
	const f = await fixture(t, mode);
	assert.equal((await f.pi.send({ type: "prompt", message: "PRIOR_HISTORY ".repeat(1000) })).success, true);
	const deadline = Date.now() + 10000;
	const done = () => f.events.some(event => mode === "auto-guard" ? event.type === "_process_exit" : event.type === "compaction_end" && event.reason === "threshold");
	while (!done()) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
	assert.deepEqual(f.captures().map(call => call.compaction), mode === "auto-guard" ? [false] : [false, true]);
	if (mode === "auto-guard") assert.ok(f.events.some(event => event.type === "_process_exit" && event.code === 78), "pi 吞hook异常也不能继续调用摘要provider");
	else assert.equal(f.readLines<{ type: string }>("recovery-session.jsonl").filter(entry => entry.type === "compaction").length, 1);
});
