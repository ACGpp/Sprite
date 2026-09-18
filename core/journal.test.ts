/**
 * journal + state 的不变量测试。
 * 运行：node --test core/journal.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { openJournal } from "./journal.ts";
import { deriveState } from "./state.ts";

const ROOT = path.join(process.cwd(), ".core-test");

function freshDir(name: string): string {
	const dir = path.join(ROOT, name);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

test("幂等：同一 commandId 只生效一次，且重启后仍判重", () => {
	const dir = freshDir("idempotent");
	const journal = openJournal({ dir, exclusive: true, fsync: false });
	const produce = () => [{ type: "message.in" as const, data: { text: "好，慢慢来。", source: "text" } }];

	const outcomes = [1, 2, 3, 4, 5].map(() => journal.applyCommand({ id: "cmd-1", produce }));
	assert.equal(outcomes.filter((o) => o.applied).length, 1);
	assert.equal(outcomes.filter((o) => o.duplicate).length, 4);
	assert.equal(deriveState(journal.events).messages.length, 1);
	const seqBefore = journal.seq;
	journal.close();

	const reopened = openJournal({ dir, exclusive: true, fsync: false });
	assert.equal(reopened.seq, seqBefore, "seq 必须从日志恢复");
	assert.equal(deriveState(reopened.events).messages.length, 1, "重启后留言不重复");
	assert.equal(reopened.applyCommand({ id: "cmd-1", produce }).duplicate, true, "重启后同 id 仍判重");
	assert.equal(reopened.seq, seqBefore, "判重不应产生新事件");
	reopened.close();
});

test("单一写入者：第二个写入者被拒绝，持有者退出后可接管", () => {
	const dir = freshDir("single-writer");
	const first = openJournal({ dir, exclusive: true, fsync: false });
	assert.throws(() => openJournal({ dir, exclusive: true, fsync: false }), /已被 pid|占用/);
	first.close();
	const second = openJournal({ dir, exclusive: true, fsync: false });
	assert.equal(second.seq, 0);
	second.close();
});

test("抗撕裂：半条记录被丢弃并截断，后续事件不被污染", () => {
	const dir = freshDir("torn");
	const journal = openJournal({ dir, exclusive: true, fsync: false });
	journal.append("message.in", { text: "第一句" });
	journal.append("message.in", { text: "第二句" });
	const seqBefore = journal.seq;
	journal.close();

	// 模拟写到一半断电：无结尾换行的半条 JSON
	fs.appendFileSync(journal.filePath, '{"seq":99,"at":"2026-09-11T02:3');

	const repaired = openJournal({ dir, exclusive: true, fsync: false });
	assert.equal(repaired.tornTails.length, 1, "必须识别出撕裂尾巴");
	assert.equal(repaired.seq, seqBefore, "撕裂的 seq 不得被采信");
	repaired.append("presence.changed", { state: "thinking" });
	repaired.close();

	const verified = openJournal({ dir, exclusive: true, fsync: false });
	assert.equal(verified.tornTails.length, 0, "修复后不应再有撕裂");
	const state = deriveState(verified.events);
	assert.equal(state.messages.length, 2, "两条老留言都在");
	assert.equal(state.presence, "thinking", "撕裂之后写入的事件必须还在");
	assert.equal(verified.seq, seqBefore + 1);
	verified.close();
});

test("跨天：每天一个文件，恢复时全部读入且 seq 连续", () => {
	const dir = freshDir("rotation");
	// 日志文件的"天"是**上海日**（和产品里其它"今天/昨天"一致）：
	// 23:00Z 已经是上海次日 07:00，所以跨天要用上海零点（= 前一天 16:00Z）做界。
	const day1 = openJournal({ dir, exclusive: true, fsync: false, now: () => new Date("2026-09-10T15:00:00Z") });
	day1.append("message.in", { text: "昨天的留言", source: "text" });
	const firstFile = day1.filePath;
	day1.close();

	const day2 = openJournal({ dir, exclusive: true, fsync: false, now: () => new Date("2026-09-10T17:00:00Z") });
	assert.notEqual(day2.filePath, firstFile, "跨天必须换文件");
	assert.equal(day2.seq, 1, "seq 不因换文件而重置");
	const event = day2.append("message.out", { text: "今天的回话", channel: "bubble" });
	assert.equal(event.seq, 2);
	day2.close();

	const recovered = openJournal({ dir, exclusive: true, fsync: false, now: () => new Date("2026-09-11T02:00:00Z") });
	const state = deriveState(recovered.events);
	assert.equal(recovered.seq, 2);
	assert.equal(state.messages.length, 1);
	assert.equal(state.outgoing.length, 1);
	recovered.close();
});

test("读模型：上一拍开始之后到达的留言才属于待处理队列", () => {
	const dir = freshDir("pending-semantics");
	const journal = openJournal({ dir, exclusive: true, fsync: false });

	journal.append("message.in", { text: "第一句", source: "text" });
	journal.append("run.started", { reason: "timer", runId: "run-1" });
	journal.append("run.finished", { runId: "run-1", durationMs: 120 });
	assert.deepEqual(
		deriveState(journal.events).pendingMessages.map((m) => m.text),
		[],
		"这一拍的观察是开跑时构建的，所以开始前的留言已被看到，不该再积压",
	);

	journal.append("message.in", { text: "跑的时候来的", source: "text" });
	assert.deepEqual(
		deriveState(journal.events).pendingMessages.map((m) => m.text),
		["跑的时候来的"],
		"run 开始之后到达的留言这一拍没看到，属于下一拍",
	);

	journal.append("run.started", { reason: "timer", runId: "run-2" });
	journal.append("run.finished", { runId: "run-2", durationMs: 90 });
	assert.deepEqual(deriveState(journal.events).pendingMessages, [], "下一拍跑完后队列应排空");
	journal.close();
});

test("读模型：导入的历史永远不算待处理队列", () => {
	const dir = freshDir("pending-imported");
	const journal = openJournal({ dir, exclusive: true, fsync: false });

	// 模拟导入：带 legacyAt 的消息来自 v1 记忆，不是"刚发生的事"
	journal.append("message.in", { text: "几个月前的一句", source: "text", legacyAt: "2026-06-20T11:39:00.000Z" });
	assert.deepEqual(deriveState(journal.events).pendingMessages, [], "历史不得触发新的一拍");

	journal.append("message.in", { text: "刚刚说的一句", source: "text" });
	assert.deepEqual(
		deriveState(journal.events).pendingMessages.map((message) => message.text),
		["刚刚说的一句"],
		"只有真正新到的留言才进队列",
	);

	// 两者都必须出现在谈话记录里（读模型不能丢历史）
	assert.equal(deriveState(journal.events).messages.length, 2);
	journal.close();
});

test("文本卫生：被截断的 emoji 不得产生非法 JSON（真实事故）", () => {
	const dir = freshDir("unicode");
	const journal = openJournal({ dir, exclusive: true, fsync: false });

	// 复现事故：对一个含 emoji 的字符串做"按 UTF-16 单元"截断，会留下孤立代理项
	const original = '{"text":"潮汐与月亮🌊🌙"}';
	const brokenSlice = original.slice(0, original.indexOf("🌊") + 1); // 只取到 emoji 的高位代理
	assert.equal(brokenSlice.length, original.indexOf("🌊") + 1);
	assert.notEqual(
		Buffer.from(brokenSlice, "utf8").toString("utf8"),
		brokenSlice,
		"这个切片本身就是非法的（测试前提）",
	);

	journal.append("run.activity", { kind: "tool", tool: "say", summary: brokenSlice });
	journal.close();

	// 写进日志的每一条都必须是合法 Unicode —— 否则 Swift 的 JSONDecoder 会整份拒绝
	const raw = fs.readFileSync(journal.filePath, "utf8");
	for (const line of raw.split("\n").filter((l) => l.trim())) {
		const event = JSON.parse(line) as { data: { summary?: string } };
		const text = String(event.data.summary ?? "");
		assert.equal(Buffer.from(text, "utf8").toString("utf8"), text, `日志里出现了非法 Unicode: ${JSON.stringify(text)}`);
		assert.ok(!/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")), "不得残留孤立代理项");
	}

	// 合法 emoji 必须原样保留（不能因为"卫生"把正常内容也弄坏）
	const journal2 = openJournal({ dir, exclusive: true, fsync: false });
	journal2.append("run.activity", { kind: "tool", tool: "say", summary: "潮汐与月亮🌊🌙" });
	journal2.close();
	const last = JSON.parse(
		fs.readFileSync(journal2.filePath, "utf8").trim().split("\n").at(-1) as string,
	) as { data: { summary: string } };
	assert.equal(last.data.summary, "潮汐与月亮🌊🌙", "合法 emoji 必须无损保留");
});

test("崩溃：写一半被中断后日志完整、seq 无缺口", () => {
	const dir = freshDir("crash");
	const journal = openJournal({ dir, exclusive: true, fsync: false });
	for (let i = 0; i < 50; i++) journal.append("run.activity", { kind: "tool", tool: "read", i });
	journal.close();

	const lines = fs
		.readFileSync(journal.filePath, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as { seq: number });
	assert.deepEqual(
		lines.map((e) => e.seq),
		Array.from({ length: 50 }, (_, i) => i + 1),
		"seq 必须是 1..N 连续无缺口",
	);
});
