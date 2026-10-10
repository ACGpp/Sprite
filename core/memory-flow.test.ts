/** End-to-end memory ownership and approval boundaries, using only isolated homes. */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { command, reviewFixture, stateOf, waitFor } from "./__test__/review-fixture.ts";
import { createMemoryStore } from "./memory-store.ts";
import { rpcCall } from "./rpc/server.ts";
import type { Kernel } from "./main.ts";

function gateway(homeDir: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(path.join(homeDir, "runtime/gateway.sock"));
		let buffer = "";
		socket.setEncoding("utf8");
		socket.setTimeout(4000, () => socket.destroy(new Error("memory gateway timeout")));
		socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
		socket.on("data", chunk => {
			buffer += chunk;
			if (buffer.includes("\n")) { socket.destroy(); resolve(JSON.parse(buffer.split("\n")[0]!)); }
		});
		socket.on("error", reject);
	});
}

async function rawAnswer(kernel: Kernel, questionId: unknown, answer: string, id = crypto.randomUUID()) {
	return await rpcCall(kernel.socketPath, { id: crypto.randomUUID(), type: "command", command: { id, type: "question.answer", questionId, answer } }) as { ok: boolean; error?: string; result?: Record<string, unknown> };
}

test("memory gateway：普通记忆写入回读核验，版本冲突不覆盖，重试和重启保持幂等", async t => {
	const f = reviewFixture(t, "memory-write-flow");
	let kernel = await f.start({ disableAgent: true });
	const missing = await gateway(f.homeDir, { kind: "memory.read", path: "notes/task.md" });
	assert.equal(missing.ok, true); assert.equal(missing.content, null); assert.equal(missing.version, "missing");
	const write = { kind: "memory.write", path: "notes/task.md", content: "FIRST", baseVersion: missing.version, requestId: "ordinary-stable" };
	const first = await gateway(f.homeDir, write);
	assert.equal(first.ok, true); assert.equal(first.verified, true);
	assert.equal(fs.readFileSync(path.join(f.homeDir, "notes/task.md"), "utf8"), "FIRST");
	assert.deepEqual(await gateway(f.homeDir, write), first);
	const conflict = await gateway(f.homeDir, { ...write, requestId: "stale-write", content: "WRONG" });
	assert.equal(conflict.ok, false); assert.match(String(conflict.error), /版本/);
	const edited = await gateway(f.homeDir, { kind: "memory.edit", path: "notes/task.md", baseVersion: first.version, requestId: "ordinary-edit", oldText: "FIRST", newText: "SECOND" });
	assert.equal(edited.ok, true); assert.equal(edited.verified, true);
	kernel = await f.start({ disableAgent: true });
	assert.deepEqual(await gateway(f.homeDir, write), first, "完成请求重试应返回原回执，不能重放旧内容");
	assert.equal((await gateway(f.homeDir, { kind: "memory.read", path: "notes/task.md" })).content, "SECOND");
	assert.equal(fs.readdirSync(path.join(f.homeDir, "runtime/memory/versions")).length, 2);
	assert.equal(stateOf(kernel).questions.length, 0);
});

test("identity自主创建写入和编辑，历史可回退、重试不回滚、冲突及只读档位不覆盖，无审批卡", async t => {
	const f = reviewFixture(t, "identity-autonomous-flow");
	let kernel = await f.start({ disableAgent: true });
	assert.equal((await gateway(f.homeDir, { kind: "memory.read", path: "identity.md" })).version, "missing");
	const create = { kind: "memory.write", path: "identity.md", content: "SELF", baseVersion: "missing", requestId: "identity-create" };
	const first = await gateway(f.homeDir, create);
	assert.equal(first.ok, true); assert.equal(first.verified, true);
	const second = await gateway(f.homeDir, { ...create, content: "SELF\nNEW EXPERIENCE", baseVersion: first.version, requestId: "identity-update" });
	assert.equal(second.ok, true);
	const edit = { kind: "memory.edit", path: "identity.md", oldText: "NEW EXPERIENCE", newText: "NEW UNDERSTANDING", baseVersion: second.version, requestId: "identity-edit" };
	const third = await gateway(f.homeDir, edit);
	assert.equal(third.ok, true); assert.equal(third.verified, true);
	assert.equal(fs.readFileSync(path.join(f.homeDir, "identity.md"), "utf8"), "SELF\nNEW UNDERSTANDING");
	assert.deepEqual(await gateway(f.homeDir, create), first);
	assert.deepEqual(await gateway(f.homeDir, edit), third);
	const conflict = await gateway(f.homeDir, { ...create, content: "STALE", baseVersion: first.version, requestId: "identity-stale" });
	assert.equal(conflict.ok, false); assert.match(String(conflict.error), /版本/);
	const history = createMemoryStore({ homeDir: f.homeDir, fsync: false });
	assert.equal(history.readVersion(first.version as string), "SELF");
	assert.equal(history.readVersion(second.version as string), "SELF\nNEW EXPERIENCE");
	assert.equal(history.readVersion(third.version as string), "SELF\nNEW UNDERSTANDING");
	assert.deepEqual(stateOf(kernel).questions, []);
	kernel = await f.start({ disableAgent: true });
	assert.deepEqual(await gateway(f.homeDir, edit), third);
	assert.deepEqual(stateOf(kernel).questions, []);
	for (const mode of ["readonly", "off"] as const) {
		await command(kernel, { type: "settings.update", patch: { security: { agentShell: mode } } });
		for (const request of [{ ...create, baseVersion: third.version, content: "DENIED", requestId: `${mode}-identity-write` }, { ...edit, baseVersion: third.version, oldText: "SELF", newText: "DENIED", requestId: `${mode}-identity-edit` }]) {
			const denied = await gateway(f.homeDir, request);
			assert.equal(denied.ok, false); assert.match(String(denied.error), /档位/);
		}
		assert.equal(fs.readFileSync(path.join(f.homeDir, "identity.md"), "utf8"), "SELF\nNEW UNDERSTANDING");
		assert.deepEqual(stateOf(kernel).questions, []);
	}
});

test("constraints：直接写拒绝，完整前后文本审批，自由回答不构成授权，明确批准才落盘", async t => {
	const f = reviewFixture(t, "identity-approval-flow");
	const before = "身份原文\n" + "原经历。".repeat(1000) + "BEFORE_END";
	const after = before + "\n冻结点及回链 AFTER_END";
	fs.mkdirSync(path.join(f.homeDir, "context"), { recursive: true });
	fs.writeFileSync(path.join(f.homeDir, "context/constraints.md"), before);
	const kernel = await f.start({ disableAgent: true });
	const snapshot = await gateway(f.homeDir, { kind: "memory.read", path: "context/constraints.md" });
	const direct = await gateway(f.homeDir, { kind: "memory.write", path: "context/constraints.md", content: after, baseVersion: snapshot.version, requestId: "direct-denied" });
	assert.equal(direct.ok, false); assert.match(String(direct.error), /批准|提案/);
	const proposal = await gateway(f.homeDir, { kind: "memory.propose", path: "context/constraints.md", content: after, baseVersion: snapshot.version, reason: "只追加截止与回链", requestId: "identity-proposal" });
	assert.equal(proposal.ok, true); assert.equal(proposal.status, "pending");
	assert.equal(fs.readFileSync(path.join(f.homeDir, "context/constraints.md"), "utf8"), before);
	const question = stateOf(kernel).questions.find(question => question.questionId === proposal.questionId)!;
	assert.ok(question); assert.ok(question.question.includes(before)); assert.ok(question.question.includes(after));
	assert.deepEqual(question.options, ["批准此修改", "拒绝此修改"]);
	const unauthorized = await gateway(f.homeDir, { kind: "memory.resolve", proposalId: proposal.proposalId, approve: true, requestId: "agent-self-approve" });
	assert.equal(unauthorized.ok, false, "Agent不能调用审批入口");
	for (const freeText of ["好的", "批准此修改\n顺便加点别的", "你自己决定"]) {
		assert.equal((await rawAnswer(kernel, proposal.questionId, freeText)).ok, false);
		assert.equal(fs.readFileSync(path.join(f.homeDir, "context/constraints.md"), "utf8"), before);
		assert.ok(stateOf(kernel).questions.some(question => question.questionId === proposal.questionId));
	}
	const approved = await command(kernel, { id: "identity-approval", type: "question.answer", questionId: proposal.questionId, answer: "批准此修改" });
	assert.equal(approved.status, "applied"); assert.equal(approved.verified, true);
	assert.equal(fs.readFileSync(path.join(f.homeDir, "context/constraints.md"), "utf8"), after);
	assert.ok(!stateOf(kernel).questions.some(question => question.questionId === proposal.questionId));
	assert.equal((await command(kernel, { id: "identity-approval", type: "question.answer", questionId: proposal.questionId, answer: "批准此修改" })).duplicate, true);
	assert.equal(stateOf(kernel).messages.filter(message => message.id === "identity-approval").length, 1);
});

test("constraints：拒绝保持原文，审批期间版本变化不能覆盖新约定", async t => {
	const f = reviewFixture(t, "constraint-reject-flow");
	fs.mkdirSync(path.join(f.homeDir, "context"));
	const file = path.join(f.homeDir, "context/constraints.md");
	fs.writeFileSync(file, "ORIGINAL");
	const kernel = await f.start({ disableAgent: true });
	const snapshot = await gateway(f.homeDir, { kind: "memory.read", path: "context/constraints.md" });
	const request = { kind: "memory.propose", path: "context/constraints.md", content: "PROPOSED", baseVersion: snapshot.version, reason: "具体约定变更", requestId: "reject-me" };
	const proposal = await gateway(f.homeDir, request);
	const rejected = await command(kernel, { type: "question.answer", questionId: proposal.questionId, answer: "拒绝此修改" });
	assert.equal(rejected.status, "rejected"); assert.equal(rejected.verified, false);
	assert.equal(fs.readFileSync(file, "utf8"), "ORIGINAL");
	assert.equal((await rawAnswer(kernel, proposal.questionId, "批准此修改")).ok, false);
	const conflict = await gateway(f.homeDir, { ...request, requestId: "conflicting-proposal" });
	fs.writeFileSync(file, "NEW_USER_AGREEMENT");
	assert.equal((await rawAnswer(kernel, conflict.questionId, "批准此修改")).ok, false);
	assert.equal(fs.readFileSync(file, "utf8"), "NEW_USER_AGREEMENT");
});

test("实时档位：readonly阻止所有Agent修改，off也阻止读取历史；用户明确审批仍有效", async t => {
	const f = reviewFixture(t, "memory-permission-flow");
	fs.mkdirSync(path.join(f.homeDir, "context"), { recursive: true });
	fs.writeFileSync(path.join(f.homeDir, "context/constraints.md"), "BEFORE");
	const kernel = await f.start({ disableAgent: true });
	const snapshot = await gateway(f.homeDir, { kind: "memory.read", path: "context/constraints.md" });
	const proposal = await gateway(f.homeDir, { kind: "memory.propose", path: "context/constraints.md", content: "AFTER", baseVersion: snapshot.version, reason: "用户确认具体改动", requestId: "approval-after-off" });
	const mutations = [
		{ kind: "memory.write", path: "notes/denied.md", content: "DENIED", baseVersion: "missing", requestId: "denied-write" },
		{ kind: "memory.edit", path: "context/working-memory.md", oldText: "A", newText: "B", baseVersion: "missing", requestId: "denied-edit" },
		{ kind: "memory.propose", path: "context/constraints.md", content: "DENIED", baseVersion: snapshot.version, reason: "DENIED", requestId: "denied-proposal" },
	];
	for (const mode of ["readonly", "off"] as const) {
		await command(kernel, { type: "settings.update", patch: { security: { agentShell: mode } } });
		for (const request of mutations) {
			const response = await gateway(f.homeDir, request);
			assert.equal(response.ok, false, `${mode}: ${request.kind}`); assert.match(String(response.error), /档位/);
		}
		for (const request of [{ kind: "memory.read", path: "context/constraints.md" }, { kind: "memory.history", limit: 2 }]) {
			assert.equal((await gateway(f.homeDir, request)).ok, mode === "readonly", `${mode}: ${request.kind}`);
		}
		assert.equal((await gateway(f.homeDir, { kind: "memory.context", contextWindow: 128000, outputReserve: 16000, historyTokens: 0 })).ok, true, "自动必要背景不是Agent主动文件权限");
	}
	assert.ok(!fs.existsSync(path.join(f.homeDir, "notes/denied.md")));
	const approved = await command(kernel, { type: "question.answer", questionId: proposal.questionId, answer: "批准此修改" });
	assert.equal(approved.status, "applied"); assert.equal(fs.readFileSync(path.join(f.homeDir, "context/constraints.md"), "utf8"), "AFTER");
});

test("记忆网关拒绝旧Agent generation，包括手写请求；新实例仍可读取", { timeout: 10000 }, async t => {
	const f = reviewFixture(t, "memory-generation-flow");
	fs.writeFileSync(path.join(f.homeDir, "identity.md"), "IDENTITY");
	const kernel = await f.start();
	await waitFor(() => f.readLines("starts.jsonl").length === 1, "第一实例启动");
	const first = f.readLines<{ generation: string }>("starts.jsonl")[0]!.generation;
	assert.equal((await gateway(f.homeDir, { kind: "memory.read", path: "identity.md", generation: first })).ok, true);
	await command(kernel, { type: "settings.update", patch: { security: { agentShell: "readonly" } } });
	await waitFor(() => f.readLines("starts.jsonl").length === 2, "替换实例启动");
	const second = f.readLines<{ generation: string }>("starts.jsonl")[1]!.generation;
	assert.notEqual(first, second);
	for (const request of [{ kind: "memory.read", path: "identity.md" }, { kind: "memory.history" }, { kind: "memory.context", contextWindow: 128000, outputReserve: 16000, historyTokens: 0 }, { kind: "memory.write", path: "notes/stale.md", content: "BAD", baseVersion: "missing", requestId: "old-write" }]) {
		for (const generation of [first, undefined]) {
			const response = await gateway(f.homeDir, { ...request, generation });
			assert.equal(response.ok, false); assert.match(String(response.error), /实例已失效/);
		}
	}
	assert.equal((await gateway(f.homeDir, { kind: "memory.read", path: "identity.md", generation: second })).ok, true);
	assert.ok(!fs.existsSync(path.join(f.homeDir, "notes/stale.md")));
});

test("历史网关按seq提供可核对的真实路径，屏蔽工具负载与失败密钥", async t => {
	const f = reviewFixture(t, "memory-history-flow");
	const kernel = await f.start({ disableAgent: true });
	const message = kernel.journal.append("message.out", { text: "HISTORICAL_FACT", channel: "bubble", privateField: "SECRET_EXTRA" });
	kernel.journal.append("run.activity", { kind: "tool_start", tool: "bash", input: "SECRET_TOOL" });
	kernel.journal.append("run.failed", { runId: "r1", reason: "apiKey=SECRET_FAILURE", outcomeUnknown: true });
	const response = await gateway(f.homeDir, { kind: "memory.history", seq: message.seq });
	assert.equal(response.ok, true);
	const entries = response.entries as Array<{ path: string; seq: number; data: Record<string, unknown> }>;
	assert.equal(entries.length, 1); assert.equal(entries[0]!.seq, message.seq); assert.equal(entries[0]!.data.text, "HISTORICAL_FACT");
	assert.ok(entries[0]!.path.startsWith(fs.realpathSync(path.join(f.homeDir, "journal")) + path.sep));
	const source = fs.readFileSync(entries[0]!.path, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.equal(source.find(event => event.seq === entries[0]!.seq).data.text, "HISTORICAL_FACT");
	const all = await gateway(f.homeDir, { kind: "memory.history", limit: 100 });
	assert.ok(!JSON.stringify(all).includes("SECRET"));
	assert.equal((await gateway(f.homeDir, { kind: "memory.history", query: "SECRET" })).entries instanceof Array, true);
	assert.deepEqual((await gateway(f.homeDir, { kind: "memory.history", query: "SECRET" })).entries, []);
});

test("崩溃边界：提案已落盘但问题未发布，批准已落盘但回答未入账，重启均恢复一次", async t => {
	const f = reviewFixture(t, "memory-crash-boundary-flow");
	fs.mkdirSync(path.join(f.homeDir, "context"), { recursive: true });
	fs.writeFileSync(path.join(f.homeDir, "context/constraints.md"), "ORIGINAL");
	const store = createMemoryStore({ homeDir: f.homeDir, fsync: false });
	const snapshot = store.read("context/constraints.md");
	const proposal = store.proposal("context/constraints.md", "APPROVED", snapshot.version, "批准具体内容", "proposal-before-question");
	let kernel = await f.start({ disableAgent: true });
	const questionId = `memory:${proposal.id}`;
	assert.equal(stateOf(kernel).questions.filter(question => question.questionId === questionId).length, 1);
	kernel = await f.start({ disableAgent: true });
	assert.equal(stateOf(kernel).questions.filter(question => question.questionId === questionId).length, 1);
	f.stop();
	// Simulate the durable approval receipt/file commit preceding the message.in write.
	const restartedStore = createMemoryStore({ homeDir: f.homeDir, fsync: false });
	restartedStore.resolve(proposal.id, true, "approval-before-journal");
	kernel = await f.start({ disableAgent: true });
	assert.equal(fs.readFileSync(path.join(f.homeDir, "context/constraints.md"), "utf8"), "APPROVED");
	assert.ok(!stateOf(kernel).questions.some(question => question.questionId === questionId));
	assert.equal(stateOf(kernel).messages.filter(message => message.id === "approval-before-journal").length, 1);
	kernel = await f.start({ disableAgent: true });
	assert.equal(stateOf(kernel).messages.filter(message => message.id === "approval-before-journal").length, 1);
	const retried = await command(kernel, { id: "approval-before-journal", type: "question.answer", questionId, answer: "批准此修改" });
	assert.equal(retried.duplicate, true); assert.equal(retried.verified, true);
});
