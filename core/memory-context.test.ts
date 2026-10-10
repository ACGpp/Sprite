import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildMemoryContext, estimateMemoryTokens, MemoryContextError } from "./memory-context.ts";
import { applyEvent, emptyState } from "./state.ts";
import { openJournal } from "./journal.ts";
import { queryMemoryHistory } from "./memory-history.ts";

function fixture(t: test.TestContext) {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-memory-context-"));
	t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(homeDir, "context"));
	const state = emptyState();
	const build = (overrides: Partial<Parameters<typeof buildMemoryContext>[0]> = {}) => buildMemoryContext({ homeDir, state, capabilities: "identity is self-authored; constraints require confirmation", contextWindow: 128_000, outputReserve: 16_000, ...overrides });
	const write = (name: string, text: string | Buffer) => fs.writeFileSync(path.join(homeDir, name), text);
	return { homeDir, state, build, write };
}

test("每次调用刷新完整身份和约定，旧约定不自封为新授权", t => {
	const f = fixture(t);
	const identity = "身份".repeat(3000) + "IDENTITY_END";
	const constraints = "约定".repeat(3000) + "CONSTRAINTS_END";
	f.write("identity.md", identity); f.write("context/constraints.md", constraints);
	const first = f.build();
	assert.ok(first.text.includes(identity)); assert.ok(first.text.includes(constraints));
	assert.match(first.text, /legacy 来源未核实/); assert.match(first.text, /不可作为新增或扩大授权/);
	f.write("identity.md", "UPDATED_IDENTITY");
	assert.match(f.build().text, /UPDATED_IDENTITY/);
	assert.equal(first.budget.estimatedTokens, Buffer.byteLength(first.text));
	assert.equal(estimateMemoryTokens("中文"), 6);
});

test("文件缺失、空文件、损坏和链接有不同结果，绝不读取保护内容", t => {
	const f = fixture(t);
	assert.equal(f.build().files.find(file => file.path === "identity.md")!.status, "missing");
	f.write("identity.md", "");
	assert.equal(f.build().files.find(file => file.path === "identity.md")!.status, "present");
	assert.match(f.build().text, /文件存在，内容为空/);
	f.write("identity.md", Buffer.from([0xff, 0xfe]));
	assert.throws(() => f.build(), (error: unknown) => error instanceof MemoryContextError && error.code === "unreadable");
	fs.unlinkSync(path.join(f.homeDir, "identity.md"));
	fs.mkdirSync(path.join(f.homeDir, "config")); f.write("config/settings.json", "SECRET_SENTINEL");
	fs.symlinkSync(path.join(f.homeDir, "config/settings.json"), path.join(f.homeDir, "identity.md"));
	assert.throws(() => f.build(), /路径不安全/);
	fs.unlinkSync(path.join(f.homeDir, "identity.md"));
	fs.symlinkSync(path.join(f.homeDir, "missing"), path.join(f.homeDir, "identity.md"));
	assert.throws(() => f.build(), /路径不安全/);
});

test("父目录链接也被拒绝，包括链接下文件尚不存在", t => {
	const f = fixture(t);
	fs.renameSync(path.join(f.homeDir, "context"), path.join(f.homeDir, "other"));
	fs.symlinkSync(path.join(f.homeDir, "other"), path.join(f.homeDir, "context"));
	assert.throws(() => f.build(), /路径不安全/);
	f.write("context/constraints.md", "FAKE_AUTHORIZATION");
	assert.throws(() => f.build(), /路径不安全/);
});

test("预算包含已有上下文与输出预留；完整核心超限失败，不静默截断", t => {
	const f = fixture(t);
	f.write("identity.md", "中".repeat(20_000));
	assert.throws(() => f.build({ contextWindow: 50_000, outputReserve: 10_000 }), (error: unknown) => error instanceof MemoryContextError && error.code === "budget_exceeded" && error.file === "identity.md");
	f.write("identity.md", "中".repeat(2000)); f.write("context/constraints.md", "文".repeat(2000));
	assert.throws(() => f.build({ contextWindow: 20_000, outputReserve: 5000, historyTokens: 5000 }), /未静默截断核心记忆/);
	assert.throws(() => f.build({ historyTokens: NaN }), /预算无效/);
});

test("工作便签有界并标注截断，不损坏多字节字符或原文", t => {
	const f = fixture(t);
	const original = "中文便签".repeat(200);
	f.write("context/working-memory.md", original);
	const result = f.build({ workingMemoryMaxBytes: 10 });
	assert.match(result.text, /中文便/); assert.ok(!result.text.includes("�"));
	assert.match(result.text, /工作便签已截断/);
	assert.equal(result.files.find(file => file.path.endsWith("working-memory.md"))!.truncated, true);
	assert.equal(fs.readFileSync(path.join(f.homeDir, "context/working-memory.md"), "utf8"), original);
});

test("背景不重复待处理/已领取/结果未知消息，未决问题与未知执行单列", t => {
	const f = fixture(t);
	const messages = ["HANDLED", "PENDING", "CLAIMED", "UNKNOWN"].map((text, index) => ({ text, seq: index + 1, at: "2026-09-19T00:00:00Z", source: "text" as const, imported: false }));
	f.state.messages = messages;
	f.state.pendingMessages = [messages[1]!];
	f.state.claimedRuns = { active: [messages[2]!] };
	f.state.unsettledMessages = [{ runId: "failed", messages: [messages[3]!], reason: "api_key=SECRET_SENTINEL" }];
	f.state.questions = [{ questionId: "q1", question: "UNANSWERED", options: ["A", "B"], seq: 5, at: "2026-09-19T00:00:00Z" }];
	const { text } = f.build();
	assert.match(text, /HANDLED/); assert.match(text, /UNANSWERED/); assert.match(text, /UNKNOWN/);
	assert.ok(!text.includes("PENDING")); assert.ok(!text.includes("CLAIMED")); assert.ok(!text.includes("SECRET_SENTINEL"));
	assert.ok(!text.split("最近已处理对话")[1]!.includes("UNKNOWN"));
	assert.ok(!f.build({ recentLimit: 0 }).text.includes("HANDLED"));
});

test("可选背景优先省略，仍不够才裁工作便签，核心身份约定与未决事项完整保留", t => {
	const f = fixture(t);
	f.write("identity.md", "IDENTITY_CORE"); f.write("context/constraints.md", "CONSTRAINTS_CORE");
	const working = "工作计划".repeat(800) + "WORKING_END";
	f.write("context/working-memory.md", working);
	f.state.questions = [{ questionId: "q1", question: "QUESTION_CORE", options: ["A", "B"], seq: 30, at: "2026-09-19T00:00:00Z" }];
	f.state.unsettledMessages = [{ runId: "unknown", reason: "timeout", messages: [{ text: "UNKNOWN_CORE", seq: 31, at: "2026-09-19T00:00:00Z", source: "text", imported: false }] }];
	f.state.messages = Array.from({ length: 12 }, (_, index) => ({ text: `OLD_${index}:` + "历史".repeat(150), seq: index + 1, at: "2026-09-18T00:00:00Z", source: "text" as const, imported: false }));
	const withoutHistory = f.build({ recentLimit: 0 });
	const historyLimited = f.build({ contextWindow: withoutHistory.budget.estimatedTokens + 1000 + 100, outputReserve: 1000 });
	assert.ok(historyLimited.budget.recentOmitted > 0);
	assert.ok(historyLimited.text.includes(working), "历史应先让位，不能先裁工作便签");
	const coreOnly = f.build({ recentLimit: 0, workingMemoryMaxBytes: 0 });
	const tight = f.build({ contextWindow: coreOnly.budget.estimatedTokens + 1000 + 500, outputReserve: 1000 });
	assert.equal(tight.budget.recentOmitted, 12);
	assert.equal(tight.files.find(file => file.path.endsWith("working-memory.md"))!.truncated, true);
	assert.match(tight.text, /工作便签已截断/); assert.ok(!tight.text.includes("WORKING_END"));
	for (const core of ["IDENTITY_CORE", "CONSTRAINTS_CORE", "QUESTION_CORE", "UNKNOWN_CORE"]) assert.ok(tight.text.includes(core));
	assert.ok(tight.budget.remainingTokens >= 0);
	assert.equal(fs.readFileSync(path.join(f.homeDir, "context/working-memory.md"), "utf8"), working);
});

test("身份和约定硬链接拒绝，不能把配置内容伪装为记忆", t => {
	for (const relative of ["identity.md", "context/constraints.md"]) {
		const f = fixture(t);
		f.write("secret.txt", "CONFIG_SECRET");
		fs.linkSync(path.join(f.homeDir, "secret.txt"), path.join(f.homeDir, relative));
		assert.throws(() => f.build(), (error: unknown) => error instanceof MemoryContextError && error.code === "unreadable" && error.file === relative);
	}
});

test("大量结果未知消息按预算降为有界回链，原文和未知状态完整保留且可查询", t => {
	const f = fixture(t);
	f.write("identity.md", "IDENTITY_STILL_COMPLETE");
	f.write("context/constraints.md", "CONSTRAINTS_STILL_COMPLETE");
	f.state.questions = [{ questionId: "pending", question: "QUESTION_STILL_COMPLETE", options: [], seq: 1000, at: "2026-09-22T00:00:00Z" }];
	const journal = openJournal({ dir: f.homeDir, fsync: false, onAppend: event => applyEvent(f.state, event) });
	t.after(() => journal.close());
	for (let index = 0; index < 16; index++) {
		journal.append("message.in", { text: `REQUEST_${index}:` + "待核实事项".repeat(1000) });
		journal.append("run.started", { runId: `unknown-${index}` });
		journal.append("run.failed", { runId: `unknown-${index}`, delivered: true, outcomeUnknown: true, reason: "timeout" });
	}
	const before = JSON.stringify(f.state);
	const result = f.build({ contextWindow: 131072, outputReserve: 32768, agreementsContext: "ACTIVE_AGREEMENT_STILL_COMPLETE" });
	assert.equal(result.budget.unsettledIndexed, true);
	assert.equal(result.budget.unsettledOmitted, 4);
	assert.match(result.text, /共有 16 轮、16 条消息结果未知/);
	assert.match(result.text, /省略 4 条索引不表示已完成或已取消/);
	assert.match(result.text, /禁止自动重放副作用/);
	assert.match(result.text, /memory_history 按 seq 查询/);
	assert.match(result.text, /"runId":"unknown-15","seq":46/);
	assert.doesNotMatch(result.text, /REQUEST_15:/);
	for (const marker of ["IDENTITY_STILL_COMPLETE", "CONSTRAINTS_STILL_COMPLETE", "QUESTION_STILL_COMPLETE", "ACTIVE_AGREEMENT_STILL_COMPLETE"]) assert.ok(result.text.includes(marker));
	assert.equal(JSON.stringify(f.state), before, "快照不能擅自结算或删除未知执行");
	const original = f.state.unsettledMessages.at(-1)!.messages[0]!.text;
	assert.equal(queryMemoryHistory(f.homeDir, { seq: 46 }).entries[0]!.data.text, original);
	assert.ok(fs.readFileSync(journal.filePath, "utf8").includes(original));
	assert.ok(result.budget.remainingTokens >= 0);
	// Even the reference list yields under a tight budget; mandatory sources do not.
	const tight = f.build({ contextWindow: result.budget.estimatedTokens - 300 + 1000, outputReserve: 1000, agreementsContext: "ACTIVE_AGREEMENT_STILL_COMPLETE" });
	assert.ok(tight.budget.unsettledOmitted > 4);
	assert.match(tight.text, /禁止自动重放副作用/);
	assert.ok(tight.budget.remainingTokens >= 0);
});

test("当前版本的批准回执是约定来源；旧版本回执或文件自称批准不能升级授权", t => {
	const f = fixture(t);
	const original = "\uFEFF用户已确认的原文约定";
	f.write("context/constraints.md", original);
	const provenance = { proposalId: "memory-proposal", commandId: "user-command", version: `sha256:${createHash("sha256").update(original).digest("hex")}` };
	const confirmed = f.build({ constraintsProvenance: provenance });
	assert.match(confirmed.text, /用户确认来源/); assert.match(confirmed.text, /user-command/);
	assert.ok(confirmed.text.includes(original)); assert.ok(!confirmed.text.includes("legacy 来源未核实"));
	assert.match(f.build().text, /legacy 来源未核实/);
	f.write("context/constraints.md", "这是我自己声称已获批准的新约定");
	assert.match(f.build({ constraintsProvenance: provenance }).text, /legacy 来源未核实/);
});
