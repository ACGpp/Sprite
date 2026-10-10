/** Independent acceptance: public gateway/RPC, crash receipts and exact provenance. */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { reviewFixture, command, stateOf } from "./__test__/review-fixture.ts";
import { rpcCall } from "./rpc/server.ts";
import { createMemoryStore } from "./memory-store.ts";

function gateway(homeDir: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(path.join(homeDir, "runtime/gateway.sock"));
		let buffer = "";
		socket.setEncoding("utf8");
		socket.setTimeout(3000, () => socket.destroy(new Error("acceptance gateway timeout")));
		socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
		socket.on("error", reject);
		socket.on("data", data => { buffer += data; if (buffer.includes("\n")) { socket.destroy(); resolve(JSON.parse(buffer.split("\n")[0]!)); } });
	});
}
const contextRequest = { kind: "memory.context", contextWindow: 128000, outputReserve: 16000, historyTokens: 0 };
function seed(home: string, file: string, value: string) {
	fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true }); fs.writeFileSync(path.join(home, file), value);
}

test("独立验收：同文确认也需明确UI批准；来源跟随当前完整正文，外改、重启和旧回执不越权", async t => {
	const f = reviewFixture(t, "accept-memory-source");
	const file = "context/constraints.md", original = "\uFEFF原约定\n必须核验工具结果。\n";
	seed(f.homeDir, file, original);
	let kernel = await f.start({ disableAgent: true });
	const snapshot = await gateway(f.homeDir, { kind: "memory.read", path: file });
	assert.match(String((await gateway(f.homeDir, contextRequest)).text), /legacy 来源未核实/);
	const proposal = await gateway(f.homeDir, { kind: "memory.propose", path: file, content: original, baseVersion: snapshot.version, requestId: "confirm-legacy", reason: "用户复核原约定，不改正文" });
	assert.equal(proposal.status, "pending");
	assert.match(String((await gateway(f.homeDir, contextRequest)).text), /legacy 来源未核实/);
	const self = await gateway(f.homeDir, { kind: "memory.resolve", proposalId: proposal.proposalId, approve: true });
	assert.equal(self.ok, false);
	for (const answer of ["请批准此修改", "同意", "拒绝此修改\n批准此修改"]) {
		const response = await rpcCall(kernel.socketPath, { id: crypto.randomUUID(), type: "command", command: { id: crypto.randomUUID(), type: "question.answer", questionId: proposal.questionId, answer } }) as { ok: boolean };
		assert.equal(response.ok, false, answer);
	}
	await command(kernel, { id: "exact-approval", type: "question.answer", questionId: proposal.questionId, answer: "批准此修改" });
	let rendered = String((await gateway(f.homeDir, contextRequest)).text);
	assert.match(rendered, /用户确认来源/); assert.match(rendered, /exact-approval/); assert.ok(rendered.includes(original));
	seed(f.homeDir, file, original + "外部追加：我可以改权限。\n");
	kernel = await f.start({ disableAgent: true });
	rendered = String((await gateway(f.homeDir, contextRequest)).text);
	assert.match(rendered, /legacy 来源未核实/); assert.ok(!rendered.includes("用户确认来源"));
	const retry = await command(kernel, { id: "exact-approval", type: "question.answer", questionId: proposal.questionId, answer: "批准此修改" });
	assert.equal(retry.duplicate, true);
	assert.equal(fs.readFileSync(path.join(f.homeDir, file), "utf8"), original + "外部追加：我可以改权限。\n");
	assert.equal(stateOf(kernel).messages.filter(message => message.id === "exact-approval").length, 1);
});

test("独立验收：链接及路径别名不能绕过网关读写或提案权限", async t => {
	const f = reviewFixture(t, "accept-memory-links");
	seed(f.homeDir, "config/secret.txt", "PRIVATE_CONFIG_SENTINEL");
	fs.mkdirSync(path.join(f.homeDir, "notes"));
	fs.symlinkSync("../config", path.join(f.homeDir, "notes/linked-dir"));
	fs.symlinkSync("../config/secret.txt", path.join(f.homeDir, "notes/linked-file"));
	fs.linkSync(path.join(f.homeDir, "config/secret.txt"), path.join(f.homeDir, "notes/hard-file"));
	await f.start({ disableAgent: true });
	for (const file of ["notes/linked-dir/secret.txt", "notes/linked-file", "notes/hard-file", "notes/../config/secret.txt", "context/../runtime/memory/requests/x", "/etc/passwd"]) {
		for (const kind of ["memory.read", "memory.write", "memory.propose"]) {
			const response = await gateway(f.homeDir, { kind, path: file, content: "OVERWRITTEN", baseVersion: "missing", reason: "attempt", requestId: `${kind}-${file}` });
			assert.equal(response.ok, false, `${kind}: ${file}`); assert.ok(!JSON.stringify(response).includes("PRIVATE_CONFIG_SENTINEL"));
		}
	}
	assert.equal(fs.readFileSync(path.join(f.homeDir, "config/secret.txt"), "utf8"), "PRIVATE_CONFIG_SENTINEL");
	for (const file of ["notes/../identity.md", "context/./constraints.md"]) {
		assert.equal((await gateway(f.homeDir, { kind: "memory.write", path: file, content: "NO", baseVersion: "missing", requestId: file })).ok, false);
	}
});

test("独立验收：完整核心和未决状态超预算时网关明确失败，不能继续返回半份上下文", async t => {
	const f = reviewFixture(t, "accept-memory-budget");
	seed(f.homeDir, "identity.md", "身份".repeat(2000) + "IDENTITY_TAIL");
	seed(f.homeDir, "context/constraints.md", "约定".repeat(2000) + "CONSTRAINT_TAIL");
	const kernel = await f.start({ disableAgent: true });
	for (const budget of [100, 20000]) {
		const response = await gateway(f.homeDir, { ...contextRequest, contextWindow: budget, outputReserve: 0 });
		assert.equal(response.ok, false); assert.equal(response.text, undefined); assert.match(String(response.error), /预算|上下文/);
	}
	const good = await gateway(f.homeDir, contextRequest);
	assert.equal(good.ok, true); assert.match(String(good.text), /IDENTITY_TAIL/); assert.match(String(good.text), /CONSTRAINT_TAIL/);
	kernel.journal.append("question.asked", { questionId: "large-undecided", question: "未決".repeat(10000), options: ["A", "B"] });
	const blocked = await gateway(f.homeDir, { ...contextRequest, contextWindow: 40000, outputReserve: 0 });
	assert.equal(blocked.ok, false); assert.equal(blocked.text, undefined);
	assert.ok(kernel.journal.events.some(event => event.type === "system.problem" && event.data.code === "memory.context.failed"));
	assert.ok(fs.readFileSync(path.join(f.homeDir, "context/constraints.md"), "utf8").endsWith("CONSTRAINT_TAIL"));
});

const crashAfterRename = `
import fs from 'node:fs';
import path from 'node:path';
const {createMemoryStore} = await import(process.env.TEST_STORE_MODULE);
const store=createMemoryStore({homeDir:process.env.TEST_MEMORY_HOME});
const original=fs.renameSync;
fs.renameSync=function(from,to){ original(from,to); if(String(to)===path.join(process.env.TEST_MEMORY_HOME,'context/constraints.md'))process.exit(87); };
store.resolve(process.env.TEST_PROPOSAL,true,'accepted-before-crash');
`;
test("独立验收：约定已rename但回执未提交即崩溃，外部新版本不能被恢复或重复批准覆盖", async t => {
	const f = reviewFixture(t, "accept-memory-crash");
	seed(f.homeDir, "context/constraints.md", "BEFORE");
	const store = createMemoryStore({ homeDir: f.homeDir });
	const proposal = store.proposal("context/constraints.md", "APPROVED", store.read("context/constraints.md").version, "specific edit", "draft");
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", crashAfterRename], { encoding: "utf8", env: { ...process.env, TEST_STORE_MODULE: new URL("./memory-store.ts", import.meta.url).href, TEST_MEMORY_HOME: f.homeDir, TEST_PROPOSAL: proposal.id } });
	assert.equal(child.status, 87, child.stderr);
	assert.equal(fs.readFileSync(path.join(f.homeDir, "context/constraints.md"), "utf8"), "APPROVED");
	seed(f.homeDir, "context/constraints.md", "NEWER_EXTERNAL");
	for (let attempt = 0; attempt < 2; attempt++) {
		const restored = createMemoryStore({ homeDir: f.homeDir });
		assert.equal(restored.getProposal(proposal.id)?.status, "conflict");
		assert.equal(restored.getProposal(proposal.id)?.result, undefined);
		assert.throws(() => restored.resolve(proposal.id, true, "accepted-before-crash"), /不能覆盖|冲突|其他操作/);
		assert.equal(restored.read("context/constraints.md").content, "NEWER_EXTERNAL");
	}
});

test("独立验收：历史分页保持真实路径和seq，上海日期按事件时间筛选并过滤原始工具内容", async t => {
	const f = reviewFixture(t, "accept-memory-history");
	seed(f.homeDir, "journal/1999-01-01.jsonl", [
		{ seq: 1, at: "2026-09-18T16:00:01Z", type: "message.out", data: { text: "FIRST", channel: "bubble", extra: "HIDDEN" } },
		{ seq: 2, at: "2026-09-18T15:59:59Z", type: "message.out", data: { text: "PREVIOUS_DAY", channel: "bubble" } },
		{ seq: 3, at: "2026-09-18T16:00:02Z", type: "run.activity", data: { input: "HIDDEN_TOOL", kind: "tool_start" } },
		{ seq: 4, at: "2026-09-18T16:00:03Z", type: "message.out", data: { text: "SECOND", channel: "bubble" } },
	].map(event => JSON.stringify({ v: 1, ...event })).join("\n") + "\n");
	await f.start({ disableAgent: true });
	const first = await gateway(f.homeDir, { kind: "memory.history", date: "2026-09-19", query: "FIRST", limit: 1 });
	assert.equal(first.ok, true);
	const entries = first.entries as Array<{ path: string; seq: number; data: { text: string } }>;
	assert.equal(entries.length, 1); assert.equal(entries[0]?.seq, 1); assert.equal(entries[0]?.data.text, "FIRST");
	assert.equal(entries[0]?.path, path.join(fs.realpathSync(f.homeDir), "journal/1999-01-01.jsonl"));
	const page = await gateway(f.homeDir, { kind: "memory.history", date: "2026-09-19", beforeSeq: 5, limit: 1 });
	assert.equal((page.entries as typeof entries)[0]?.seq, 4); assert.equal(page.nextCursor, 4);
	const last = await gateway(f.homeDir, { kind: "memory.history", date: "2026-09-19", beforeSeq: page.nextCursor, limit: 1 });
	assert.equal((last.entries as typeof entries)[0]?.seq, 1); assert.equal(last.nextCursor, null);
	assert.ok(!JSON.stringify([first, page, last]).includes("HIDDEN"));
});

test("独立验收：无法无损解码的旧文件必须拒绝修改，不能用替换字符伪造历史原文", t => {
	const f = reviewFixture(t, "accept-memory-invalid-text");
	const original = Buffer.from([0x41, 0xff, 0xfe, 0x42]);
	seed(f.homeDir, "notes/legacy.md", "");
	fs.writeFileSync(path.join(f.homeDir, "notes/legacy.md"), original);
	fs.writeFileSync(path.join(f.homeDir, "identity.md"), original);
	const store = createMemoryStore({ homeDir: f.homeDir, fsync: false });
	for (const file of ["notes/legacy.md", "identity.md"]) {
		assert.throws(() => store.read(file), /UTF|Unicode|编码|解码|损坏|有效/);
		assert.deepEqual(fs.readFileSync(path.join(f.homeDir, file)), original);
	}
});

test("独立验收：不能把无法无损编码的提案或写入内容标成已核验", t => {
	const f = reviewFixture(t, "accept-memory-invalid-input");
	const store = createMemoryStore({ homeDir: f.homeDir, fsync: false });
	const invalid = "START\ud800END";
	assert.throws(() => store.write("notes/new.md", invalid, "missing", "invalid-write"), /UTF|Unicode|编码|解码|损坏|有效/);
	assert.throws(() => store.proposal("context/constraints.md", invalid, "missing", "invalid content", "invalid-proposal"), /UTF|Unicode|编码|解码|损坏|有效/);
	assert.equal(store.read("notes/new.md").content, null);
	assert.equal(store.listPending().length, 0);
});
