import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { queryMemoryHistory } from "./memory-history.ts";

function fixture(t: test.TestContext) {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-memory-history-"));
	t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(homeDir, "journal"));
	const write = (name: string, events: unknown[]) => fs.writeFileSync(path.join(homeDir, "journal", name), events.map(event => JSON.stringify(event)).join("\n") + "\n");
	const event = (seq: number, type: string, data: Record<string, unknown>, at = "2026-09-18T16:00:00Z") => ({ seq, type, data, at });
	return { homeDir, write, event };
}

test("事件历史跨文件按seq分页，返回真实路径，上海日期不依赖旧文件名", t => {
	const f = fixture(t);
	f.write("2026-05-01.jsonl", [f.event(3, "message.in", { text: "third" }), f.event(1, "message.out", { text: "first" })]);
	f.write("2026-04-01.jsonl", [f.event(4, "message.out", { text: "fourth" }), f.event(2, "message.in", { text: "second", legacyAt: "2026-09-17T15:59:00Z" })]);
	const page = queryMemoryHistory(f.homeDir, { limit: 2 });
	assert.deepEqual(page.entries.map(entry => entry.seq), [4, 3]); assert.equal(page.nextCursor, 3);
	assert.equal(page.entries[0]!.path, fs.realpathSync(path.join(f.homeDir, "journal/2026-04-01.jsonl")));
	const older = queryMemoryHistory(f.homeDir, { limit: 2, beforeSeq: page.nextCursor! });
	assert.deepEqual(older.entries.map(entry => entry.seq), [2, 1]); assert.equal(older.nextCursor, null);
	assert.deepEqual(queryMemoryHistory(f.homeDir, { date: "2026-09-19" }).entries.map(entry => entry.seq), [4, 3, 1]);
	assert.deepEqual(queryMemoryHistory(f.homeDir, { date: "2026-09-17" }).entries.map(entry => entry.seq), [2]);
	assert.equal(queryMemoryHistory(f.homeDir, { seq: 3 }).entries[0]!.data.text, "third");
});

test("只返回安全事件与显式字段，错误密钥、工具输入和配置永不进入结果或搜索", t => {
	const f = fixture(t);
	f.write("events.jsonl", [
		f.event(1, "message.in", { text: "HELLO", internal: "SECRET_A", __commandEffect: { key: "SECRET_B" } }),
		f.event(2, "run.failed", { runId: "r1", reason: "api_key=SECRET_C", delivered: true, outcomeUnknown: true }),
		f.event(3, "run.activity", { tool: "bash", input: "SECRET_D" }),
		f.event(4, "settings.changed", { apiKey: "SECRET_E" }),
		f.event(5, "question.asked", { questionId: "q1", question: "Choice", options: ["A", { secret: "SECRET_F" }] }),
	]);
	const result = queryMemoryHistory(f.homeDir);
	assert.deepEqual(result.entries.map(entry => entry.seq), [5, 2, 1]);
	assert.ok(!JSON.stringify(result).includes("SECRET"));
	assert.equal(queryMemoryHistory(f.homeDir, { query: "secret" }).entries.length, 0);
	assert.equal(queryMemoryHistory(f.homeDir, { query: "hello" }).entries.length, 1);
});

test("链接文件不能用于读配置；journal目录链接不能用于读其他目录", t => {
	const f = fixture(t);
	fs.mkdirSync(path.join(f.homeDir, "config"));
	const secret = path.join(f.homeDir, "config/settings.json");
	fs.writeFileSync(secret, JSON.stringify(f.event(1, "message.in", { text: "SECRET" })) + "\n");
	fs.symlinkSync(secret, path.join(f.homeDir, "journal/linked.jsonl"));
	fs.linkSync(secret, path.join(f.homeDir, "journal/hardlinked.jsonl"));
	assert.equal(queryMemoryHistory(f.homeDir).entries.length, 0);
	fs.rmSync(path.join(f.homeDir, "journal"), { recursive: true });
	fs.symlinkSync(path.join(f.homeDir, "config"), path.join(f.homeDir, "journal"));
	assert.throws(() => queryMemoryHistory(f.homeDir), /路径不安全/);
});

test("忽略撕裂尾行与非法事件，查询参数有边界", t => {
	const f = fixture(t);
	f.write("events.jsonl", [f.event(1, "thought.recorded", { text: "sound" }), { invalid: true }]);
	fs.appendFileSync(path.join(f.homeDir, "journal/events.jsonl"), JSON.stringify(f.event(2, "message.in", { text: "uncommitted" })));
	assert.deepEqual(queryMemoryHistory(f.homeDir).entries.map(entry => entry.seq), [1]);
	assert.throws(() => queryMemoryHistory(f.homeDir, { limit: NaN }), /正整数/);
	assert.throws(() => queryMemoryHistory(f.homeDir, { beforeSeq: 0 }), /正整数/);
	assert.throws(() => queryMemoryHistory(f.homeDir, { date: "2026-02-30" }), /有效/);
	assert.throws(() => queryMemoryHistory(f.homeDir, { query: "x".repeat(1001) }), /过长/);
});
