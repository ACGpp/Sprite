/**
 * 规模特性：记忆变老之后，内核必须依然轻快。
 *
 * 这是一个要陪你几年的东西。实测（200k 事件 / 100 天）此前有两处会随年龄恶化：
 *   - 每次 `query.status` 重放全部事件 → **1387ms**（外壳每次呼吸都查一次）
 *   - 全部事件留在内存 → 约 1.7KB/条，一年约 1.2GB
 *
 * 现在：读模型增量维护（查询 O(1)）、内存只留滑动窗口、持久索引在恢复扫描时建好。
 * 这个测试把这些性质固定下来——否则它们会悄悄退化。
 *
 * 运行：node --test core/scale.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { openJournal } from "./journal.ts";
import { createStateTracker } from "./state.ts";
import { startKernel } from "./main.ts";
import { rpcCall } from "./rpc/server.ts";

const ROOT = path.join(process.cwd(), ".core-test");
const EVENTS = 30_000; // 够大到能暴露 O(n) 退化，又能在几秒内跑完

/** 造一份"活了很久"的记忆，末尾故意留下待处理留言。 */
function buildAgedMemory(name: string) {
	const home = path.join(ROOT, name);
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "journal"), { recursive: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(home, "thoughts"), { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), "");
	fs.writeFileSync(path.join(home, "thoughts", "stream.jsonl"), "");

	const lines: string[] = [];
	const start = new Date("2025-01-01T00:00:00Z").getTime();
	let runs = 0;
	for (let seq = 1; seq <= EVENTS; seq++) {
		const at = new Date(start + seq * 300_000).toISOString(); // 5 分钟一拍
		const roll = seq % 10;
		if (roll === 0) {
			runs += 1;
			lines.push(JSON.stringify({ seq, at, type: "run.started", data: { trigger: "timer", runId: `run-${seq}` } }));
		} else if (roll === 5) {
			lines.push(JSON.stringify({ seq, at, type: "thought.recorded", data: { text: `第 ${seq} 条想法` } }));
		} else if (roll === 9) {
			lines.push(JSON.stringify({ seq, at, type: "message.out", data: { text: `第 ${seq} 条回话`, channel: "bubble" } }));
		} else {
			lines.push(JSON.stringify({ seq, at, type: "run.activity", data: { kind: "tool", tool: "read", summary: `读第 ${seq} 段` } }));
		}
	}
	// 最后一条 run.started 之后到达的留言：必须精确留在待处理队列里（不受窗口影响）
	for (let i = 0; i < 3; i++) {
		const seq = EVENTS + 1 + i;
		lines.push(JSON.stringify({ seq, at: new Date().toISOString(), type: "message.in", data: { text: `暂停期间的留言 ${i + 1}`, source: "text" } }));
	}
	fs.writeFileSync(path.join(home, "journal", "2025-01-01.jsonl"), `${lines.join("\n")}\n`);
	return { home, runs, total: EVENTS + 3 };
}

test("规模：查询是 O(1)，内存事件有窗口，计数仍然精确", { timeout: 120_000 }, async () => {
	const fixture = buildAgedMemory("scale-aged");
	const kernel = await startKernel({
		homeDir: fixture.home,
		disableAgent: true,
		intervalMs: 3_600_000,
		quietHours: { start: 0, end: 0 },
		fsync: false,
	});

	try {
		// 查询延迟：O(n) 退化时这里会是几百毫秒
		const latencies: number[] = [];
		for (let i = 0; i < 5; i++) {
			const started = Date.now();
			await rpcCall(kernel.socketPath, { id: `q${i}`, type: "query.status" });
			latencies.push(Date.now() - started);
		}
		const worst = Math.max(...latencies);
		assert.ok(worst < 100, `状态查询必须接近瞬时（实测最慢 ${worst}ms，O(n) 退化时是 1387ms）`);

		const diagnostics = (await rpcCall(kernel.socketPath, { id: "d", type: "query.diagnostics" })) as {
			result: { events: number; seq: number };
		};
		assert.ok(
			diagnostics.result.events <= 2000,
			`内存里的事件必须被窗口限制，实际 ${diagnostics.result.events} 条（日志共 ${fixture.total} 条）`,
		);
		// 内核启动自身也会追加事件（presence/system.problem/breath.scheduled），
		// 所以是 >= 而不是 ==；关键是它没有从头开始重新计数。
		assert.ok(
			diagnostics.result.seq >= fixture.total,
			`seq 必须延续全部历史（日志到 ${fixture.total}，实际 ${diagnostics.result.seq}）`,
		);

		// 计数必须精确（窗口只裁剪明细，不裁剪累计值）
		const state = kernel.status() as {
			runs: number;
			messages: Array<{ text: string }>;
			pendingMessages: Array<{ text: string }>;
			thoughts: string[];
			outgoing: unknown[];
		};
		assert.equal(state.runs, fixture.runs, "呼吸次数必须等于日志里的 run.started 数");
		assert.ok(state.messages.length <= 200, `消息明细必须被窗口限制，实际 ${state.messages.length}`);
		assert.ok(state.thoughts.length <= 200, `思维明细必须被窗口限制，实际 ${state.thoughts.length}`);

		// 待处理队列必须精确：窗口不能让它丢留言
		assert.equal(state.pendingMessages.length, 3, "暂停期间到达的留言一条都不能丢");
		assert.deepEqual(
			state.pendingMessages.map((message) => message.text),
			["暂停期间的留言 1", "暂停期间的留言 2", "暂停期间的留言 3"],
		);
	} finally {
		kernel.stop();
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
});

test("规模：持久索引不受内存窗口影响（游标与所有权交接必须还在）", () => {
	const home = path.join(ROOT, "scale-indexes");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "journal"), { recursive: true });

	const first = openJournal({ dir: home, exclusive: true, fsync: false });
	// 很早以前写下的游标与交接标记
	first.append("legacy.imported", { kind: "cursor", source: "mailbox", file: "conversations/mailbox.md", offset: 1234, prefixHash: "abc123" });
	first.append("legacy.imported", { kind: "ownership.handoff", file: "conversations/mailbox.md" });
	// 之后又过了几千条事件，把它们挤出内存窗口
	for (let i = 0; i < 3000; i++) first.append("run.activity", { kind: "tool", tool: "read", i });
	assert.ok(first.events.length <= 2000, "内存里应当只剩窗口");
	first.close();

	// 重启：索引必须从磁盘重建，而不是依赖内存里还剩什么
	const reopened = openJournal({ dir: home, exclusive: true, fsync: false });
	assert.ok(reopened.events.length <= 2000, "重启后仍然只保留窗口");
	assert.deepEqual(
		reopened.cursorFor("mailbox", "conversations/mailbox.md"),
		// line 是后加的：导入断点精确到行（评审 M2），旧日志里没有它就算 0
		{ offset: 1234, prefixHash: "abc123", line: 0 },
		"被挤出窗口的导入游标必须仍然可查（否则会重复导入整份历史）",
	);
	assert.equal(reopened.hasOwnershipHandoff("conversations/mailbox.md"), true, "所有权交接标记必须仍然可查");
	reopened.close();
});

test("检查点：恢复出的读模型必须与全量折叠完全一致", { timeout: 60_000 }, () => {
	const home = path.join(ROOT, "scale-checkpoint");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "journal"), { recursive: true });

	// 造一段有代表性的历史：对话、思维、工具、失败、问题、被中断的呼吸
	const seed = openJournal({ dir: home, exclusive: true, fsync: false });
	seed.append("message.in", { text: "第一句", source: "text" });
	seed.append("run.started", { reason: "timer", runId: "run-1" });
	seed.append("run.activity", { kind: "tool", tool: "read", summary: "读了一段" });
	seed.append("thought.recorded", { text: "想了一点" });
	seed.append("tool.decided", { tool: "read", decision: "allow" });
	seed.append("message.out", { text: "回一句", channel: "bubble" });
	seed.append("run.finished", { runId: "run-1" });
	seed.append("breath.scheduled", { nextBreathAt: new Date().toISOString(), intervalMs: 300000 });
	seed.append("wake.deferred", { reason: "安静时段" });
	seed.append("run.failed", { reason: "provider 炸了" });
	seed.append("system.problem", { code: "x", userMessage: "有个小问题" });
	seed.append("question.asked", { question: "要我读哪篇？", options: ["A", "B"] });
	seed.append("message.in", { text: "第二句", source: "text" });
	for (let i = 0; i < 50; i++) seed.append("run.activity", { kind: "tool", tool: "bash", i });
	seed.close();

	// ── 全量折叠（没有检查点） ──
	const full = createStateTracker();
	const first = openJournal({
		dir: home,
		exclusive: true,
		fsync: false,
		checkpointPayload: () => full.snapshot(),
		onRecover: (event) => full.apply(event),
	});
	assert.equal(first.usedCheckpoint, false, "第一次没有检查点可用");
	assert.ok(first.recoveredEvents > 50, `第一次必须真的重扫历史，实际 ${first.recoveredEvents}`);
	const expected = full.snapshot();
	assert.equal(first.writeCheckpoint(), true, "检查点必须写入成功");
	first.close();

	// ── 带检查点恢复 ──
	const restored = createStateTracker();
	const second = openJournal({
		dir: home,
		exclusive: true,
		fsync: false,
		checkpointPayload: () => restored.snapshot(),
		onCheckpoint: (payload) => {
			const ok = restored.restore(payload);
			assert.equal(ok, true, "快照必须能恢复");
			return ok;
		},
		onRecover: (event) => restored.apply(event),
	});
	assert.equal(second.usedCheckpoint, true, "第二次必须用上检查点");
	assert.equal(second.recoveredEvents, 0, "检查点之后没有新事件，不该再折叠任何历史");
	assert.deepEqual(restored.snapshot(), expected, "恢复出的读模型必须与全量折叠完全一致");
	assert.equal(second.seq, first.seq, "seq 必须一致");
	second.close();
});

test("检查点：损坏或过期时必须退回全量重扫，绝不猜", { timeout: 60_000 }, () => {
	const home = path.join(ROOT, "scale-checkpoint-corrupt");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "journal"), { recursive: true });

	const seed = openJournal({ dir: home, exclusive: true, fsync: false });
	for (let i = 0; i < 40; i++) seed.append("thought.recorded", { text: `第 ${i} 条` });
	seed.close();

	// 1) 校验和被改坏
	const good = openJournal({ dir: home, exclusive: true, fsync: false, checkpointPayload: () => ({ presence: "breathing", messages: [] }) });
	good.writeCheckpoint();
	good.close();
	const checkpointPath = path.join(home, "journal", "checkpoint.json");
	const broken = JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as { payload: unknown };
	broken.payload = { presence: "asleep", messages: [], 被篡改: true };
	fs.writeFileSync(checkpointPath, JSON.stringify(broken));

	const tracker = createStateTracker();
	const afterCorrupt = openJournal({
		dir: home,
		exclusive: true,
		fsync: false,
		checkpointPayload: () => tracker.snapshot(),
		onCheckpoint: (payload) => tracker.restore(payload),
		onRecover: (event) => tracker.apply(event),
	});
	assert.equal(afterCorrupt.usedCheckpoint, false, "校验和不匹配必须丢弃检查点");
	assert.ok(afterCorrupt.recoveredEvents >= 40, "必须退回全量重扫");
	afterCorrupt.close();

	// 2) 检查点声称的 seq 在日志里找不到（日志被删过）
	const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as { seq: number };
	checkpoint.seq = 999_999;
	fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint));
	const afterStale = openJournal({ dir: home, exclusive: true, fsync: false });
	assert.equal(afterStale.usedCheckpoint, false, "seq 超出日志范围必须丢弃检查点");
	assert.ok(afterStale.seq <= 100, `seq 必须来自日志本身，实际 ${afterStale.seq}`);
	afterStale.close();
});

test("检查点：日志被删改过（体积变小）时必须丢弃检查点，不能让已删除的内容复活", { timeout: 60_000 }, () => {
	const home = path.join(ROOT, "scale-checkpoint-shrunk");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "journal"), { recursive: true });

	const seed = openJournal({ dir: home, exclusive: true, fsync: false });
	seed.append("message.in", { text: "要说的话", source: "text" });
	seed.append("thought.recorded", { text: "想法" });
	for (let i = 0; i < 20; i++) seed.append("run.activity", { kind: "tool", tool: "read", i });
	seed.close();

	// 写一个检查点（内含上面全部内容）
	const writer = openJournal({
		dir: home,
		exclusive: true,
		fsync: false,
		checkpointPayload: () => ({ presence: "breathing", messages: [{ text: "要说的话" }] }),
	});
	assert.equal(writer.writeCheckpoint(), true);
	const journalFile = path.join(home, "journal", path.basename(writer.filePath));
	writer.close();

	// 模拟"从日志里删掉一条"（真实事故：用户要求删除一条记录）
	const kept = fs.readFileSync(journalFile, "utf8").split("\n").filter((line) => line.trim() && !line.includes("要说的话"));
	fs.writeFileSync(journalFile, `${kept.join("\n")}\n`);

	// 重启：检查点若被采信，删掉的那条就会复活
	const restored = createStateTracker();
	const reopened = openJournal({
		dir: home,
		exclusive: true,
		fsync: false,
		checkpointPayload: () => restored.snapshot(),
		onCheckpoint: (payload) => restored.restore(payload),
		onRecover: (event) => restored.apply(event),
	});
	assert.equal(reopened.usedCheckpoint, false, "日志体积变小 → 检查点必须被丢弃");
	const texts = restored.snapshot().messages.map((message) => message.text);
	assert.deepEqual(texts, [], `被删除的内容不得复活，实际: ${JSON.stringify(texts)}`);
	reopened.close();
});
