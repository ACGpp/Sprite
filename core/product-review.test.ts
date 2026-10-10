/**
 * 2026-09-19 产品审查的正确性验收（不是“证明 bug 存在”的反向断言）。
 * 修复前部分测试应失败；不得改成 todo/skip 或降低断言来制造绿灯。
 * 运行：node --test core/product-review.test.ts
 * 修复顺序与人工场景：docs/remediation-plan-2026-09-19.md
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createBreathRunner } from "./breath.ts";
import type { PiAgent, PiEvent } from "./agent/pi-rpc.ts";
import { openJournal } from "./journal.ts";
import { applyEvent, emptyState } from "./state.ts";
import { patchSettings } from "./settings.ts";
import { rpcCall } from "./rpc/server.ts";
import { command, reviewFixture, stateOf, waitFor, type PromptCapture } from "./__test__/review-fixture.ts";

for (const mode of ["provider", "custom"] as const) {
	test(`F01 ${mode}：保存与轮换 Key 后，下一次模型调用使用新凭据`, { timeout: 15_000 }, async t => {
		const f = reviewFixture(t, `key-${mode}`);
		const firstKey = "TEST_ONLY_FIRST_KEY";
		patchSettings(f.homeDir, { model: mode === "provider"
			? { mode, provider: "deepseek", model: "deepseek-chat", apiKey: firstKey }
			: { mode, baseUrl: "http://127.0.0.1:1/v1", model: "review-model", apiFormat: "openai-completions", apiKey: firstKey } });
		const kernel = await f.start({ piEnv: { SPRITE_REVIEW_EXPECTED_KEY: firstKey, SPRITE_REVIEW_NEXT_KEY: "TEST_ONLY_SECOND_KEY" } });
		await kernel.breathNow();
		const first = f.readLines<PromptCapture>("prompts.jsonl")[0]!;
		assert.equal(mode === "provider" ? first.providerKeyMatches : first.customKeyMatches, true, "启动进程必须拿到界面保存的 Key");
		// 同时验证新 Key 匹配和旧 Key 失效；不输出实际凭据。
		await command(kernel, { type: "settings.update", patch: { model: { apiKey: "TEST_ONLY_SECOND_KEY" } } });
		await kernel.breathNow();
		const second = f.readLines<PromptCapture>("prompts.jsonl").at(-1)!;
		assert.equal(mode === "provider" ? second.providerKeyMatches : second.customKeyMatches, false, "新调用不得继续沿用旧 Key");
		assert.equal(mode === "provider" ? second.providerNextKeyMatches : second.customNextKeyMatches, true, "新调用必须使用轮换后的 Key");
	});
}

test("F02 检查点恢复：待处理留言必须实际交给模型，才能从队列消失", { timeout: 10_000 }, async t => {
	const f = reviewFixture(t, "pending");
	let kernel = await f.start({ disableAgent: true });
	await command(kernel, { type: "breath.pause", until: "manual" });
	await command(kernel, { type: "message.send", text: "PENDING_AFTER_RESTART" });
	assert.equal(stateOf(kernel).pendingMessages.length, 1);
	// 先解除暂停再关机，把“投递正确性”与“恢复时遵守暂停”分成两个用例。
	await command(kernel, { type: "breath.resume" });
	kernel = await f.start();
	await waitFor(() => kernel.journal.events.some(e => e.type === "run.finished"), "恢复后的运行完成");
	const prompts = f.readLines<PromptCapture>("prompts.jsonl");
	assert.equal(prompts.filter(p => p.message.includes("PENDING_AFTER_RESTART")).length, 1, "检查点里的待处理消息必须出现且只投递一次");
	assert.equal(stateOf(kernel).pendingMessages.length, 0);
});

test("F02 暂停中重启：即使有待处理留言，也必须等用户继续", { timeout: 10_000 }, async t => {
	const f = reviewFixture(t, "paused");
	let kernel = await f.start({ disableAgent: true });
	await command(kernel, { type: "breath.pause", until: "manual" });
	await command(kernel, { type: "message.send", text: "WAIT_FOR_RESUME" });
	kernel = await f.start();
	// 等子进程确实启动，并给错误的自动唤醒分支处理完毕的机会。
	await waitFor(() => f.readLines("starts.jsonl").length > 0, "引擎启动");
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal(kernel.journal.events.filter(e => e.type === "run.started").length, 0, "恢复队列不得越过手动暂停");
	assert.equal(stateOf(kernel).presence, "paused");
	assert.equal(stateOf(kernel).pendingMessages.length, 1);
});

test("F03 发送失败只退回本轮领取的消息，保留运行途中到达的新消息", () => {
	const state = emptyState();
	let seq = 0;
	const append = (type: Parameters<typeof applyEvent>[1]["type"], data: Record<string, unknown> = {}) =>
		applyEvent(state, { seq: ++seq, at: new Date().toISOString(), type, data });
	append("message.in", { text: "ALREADY_HANDLED" });
	append("run.started", { runId: "old" });
	append("run.finished", { runId: "old" });
	append("message.in", { text: "RETRY_THIS" });
	append("run.started", { runId: "new" });
	append("message.in", { text: "ARRIVED_DURING_RUN" });
	append("run.failed", { runId: "new", delivered: false });
	assert.deepEqual(state.pendingMessages.map(m => m.text), ["RETRY_THIS", "ARRIVED_DURING_RUN"], "不能重放旧任务；按原始 seq 保留本轮和在途新消息");
});

for (const stopReason of ["error", "aborted"] as const) {
	test(`F04 模型 ${stopReason} 不能被 agent_end 伪装成成功`, async t => {
		const f = reviewFixture(t, stopReason);
		const journal = openJournal({ dir: f.homeDir, fsync: false });
		t.after(() => journal.close());
		let emit: (event: PiEvent) => void = () => {};
		const pi: PiAgent = {
			onEvent: handler => { emit = handler; },
			async send() {
				queueMicrotask(() => {
					const message = { role: "assistant", content: [], stopReason, errorMessage: "TEST_ONLY_PROVIDER_FAILURE" };
					emit({ type: "message_end", message });
					emit({ type: "agent_end", messages: [message] });
				});
				return { success: true };
			},
		};
		journal.append("message.in", { text: "PLEASE_REPLY" });
		const outcome = await createBreathRunner({ journal, pi, isQuiet: () => false }).run("message");
		assert.equal(outcome.ok, false, "RPC 接收成功不等于模型执行成功");
		assert.equal(journal.events.some(e => e.type === "run.finished"), false);
		assert.equal(journal.events.some(e => e.type === "run.failed"), true);
	});
}

test("F05 超时必须向 Agent 请求取消", { timeout: 5000 }, async t => {
	const f = reviewFixture(t, "timeout");
	const journal = openJournal({ dir: f.homeDir, fsync: false });
	t.after(() => journal.close());
	const sent: string[] = [];
	let emit: (event: PiEvent) => void = () => {};
	const pi: PiAgent = {
		onEvent: handler => { emit = handler; },
		async send(request) {
			sent.push(String(request.type));
			if (request.type === "abort") queueMicrotask(() => emit({ type: "agent_end", messages: [] }));
			return { success: true };
		},
	};
	const runner = createBreathRunner({ journal, pi, isQuiet: () => false, timeoutMs: 30 });
	const outcome = await runner.run("manual");
	assert.equal(outcome.ok, false);
	assert.ok(sent.includes("abort"), "超时必须真正向 Agent 发取消，不能只清 running 标志");
	assert.equal(sent.filter(type => type === "prompt").length, 1);
});

for (const access of ["readonly", "off"] as const) {
	test(`F06 on → ${access}：保存后下一轮真实工具集受限`, { timeout: 10_000 }, async t => {
		const f = reviewFixture(t, `tools-${access}`);
		const kernel = await f.start();
		await kernel.breathNow();
		await command(kernel, { type: "settings.update", patch: { security: { agentShell: access } } });
		await kernel.breathNow();
		const tools = f.readLines<PromptCapture>("prompts.jsonl").at(-1)!.tools;
		assert.ok(["bash", "write", "edit"].every(tool => !tools.includes(tool)), "不能只改设置和提示词，执行器必须收回工具");
		assert.equal(tools.includes("read"), access === "readonly");
	});
}

test("F09 空闲时暂停一小时，到期自动恢复运行", { timeout: 10_000 }, async t => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-09-19T02:00:00Z") });
	const f = reviewFixture(t, "expiry");
	const kernel = await f.start();
	await command(kernel, { type: "breath.pause", until: "hour" });
	t.mock.timers.tick(3_599_999);
	assert.equal(kernel.journal.events.some(e => e.type === "run.started"), false, "到期之前不能启动");
	t.mock.timers.tick(2);
	const started = kernel.journal.events.some(e => e.type === "run.started");
	t.mock.timers.reset();
	if (started) await waitFor(() => !stateOf(kernel).danglingRun, "到期运行完成");
	assert.equal(started, true, "到期必须有真正的唤醒，不依赖下一次点击或重启");
	assert.notEqual(stateOf(kernel).presence, "paused");
});

test("F12 历史查询保留超过缓存窗口的双方对话和旧日期", async t => {
	const f = reviewFixture(t, "archive");
	const kernel = await f.start({ disableAgent: true });
	for (let i = 0; i < 205; i++) {
		const legacyAt = i < 5 ? "2026-09-17T12:00:00Z" : "2026-09-18T12:00:00Z";
		kernel.journal.append("message.in", { text: `USER_${i}_END`, legacyAt });
		kernel.journal.append("message.out", { text: `AGENT_${i}_END`, legacyAt, channel: "bubble" });
	}
	const response = await rpcCall(kernel.socketPath, { id: "archive", type: "query.records", kind: "conversations", limit: 60 }) as {
		ok: boolean; result: { entries: Array<{ date: string; text: string; count: number }> };
	};
	assert.equal(response.ok, true);
	assert.equal(response.result.entries.reduce((count, e) => count + e.count, 0), 410, "归档不能退化为每方 200 条缓存");
	const oldest = response.result.entries.find(e => e.date === "2026-09-17");
	assert.ok(oldest, "掉出缓存的旧日期仍须可查询");
	assert.match(oldest.text, /USER_0_END/);
	assert.match(oldest.text, /AGENT_0_END/);
});

test("F13 缺失的对话/思维投影可重建，重复重启不产生重复内容", async t => {
	const f = reviewFixture(t, "projection");
	let kernel = await f.start({ disableAgent: true });
	kernel.journal.append("message.out", { text: "DURABLE_REPLY", channel: "bubble" });
	kernel.journal.append("thought.recorded", { text: "DURABLE_THOUGHT" });
	f.stop();
	const files = ["conversations/mailbox.md", "thoughts/stream.jsonl"];
	for (const name of files) fs.unlinkSync(path.join(f.homeDir, name));
	kernel = await f.start({ disableAgent: true });
	assert.ok(files.every(name => fs.existsSync(path.join(f.homeDir, name))), "启动必须补回缺失的可重建投影");
	const restored = files.map(name => fs.readFileSync(path.join(f.homeDir, name), "utf8"));
	assert.equal(restored[0]!.split("DURABLE_REPLY").length - 1, 1);
	assert.equal(restored[1]!.split("DURABLE_THOUGHT").length - 1, 1);
	await f.start({ disableAgent: true });
	assert.deepEqual(files.map(name => fs.readFileSync(path.join(f.homeDir, name), "utf8")), restored);
});
