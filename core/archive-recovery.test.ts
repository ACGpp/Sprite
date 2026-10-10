import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createProjector } from "./projector.ts";
import { openJournal } from "./journal.ts";
import { readJournalEvents, queryConversationRecords } from "./record-store.ts";
import { readableSearchFiles, isSecretPath } from "../pi-extension/policy.ts";

function fixture(t: test.TestContext) {
	fs.mkdirSync(".core-test", { recursive: true });
	const dir = fs.mkdtempSync(path.resolve(".core-test/archive-recovery-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("搜索枚举保留正常笔记，排除密钥目录、嵌套密钥和符号链接", t => {
	const dir = fixture(t);
	fs.mkdirSync(path.join(dir, "notes")); fs.mkdirSync(path.join(dir, "config"));
	fs.mkdirSync(path.join(dir, "runtime"));
	fs.writeFileSync(path.join(dir, "notes/okay.txt"), "VISIBLE");
	fs.writeFileSync(path.join(dir, "config/settings.json"), "SECRET");
	fs.writeFileSync(path.join(dir, "runtime/private.txt"), "SECRET");
	fs.symlinkSync("../config/settings.json", path.join(dir, "notes/link.txt"));
	fs.symlinkSync("../config", path.join(dir, "notes/linked-config"));
	assert.equal(isSecretPath("notes/link.txt", dir), true);
	assert.deepEqual(readableSearchFiles(".", dir), [path.join(dir, "notes/okay.txt")]);
	assert.deepEqual(readableSearchFiles("notes", dir, "*.md"), []);
});

test("归档跨检查点与日期游标分页不丢记录，同时间按日志序号稳定排序", t => {
	const dir = fixture(t);
	const journal = openJournal({ dir, fsync: false, eventWindow: 2 }); t.after(() => journal.close());
	for (const day of ["17", "18", "19"]) {
		journal.append("message.in", { text: `USER_${day}`, legacyAt: `2026-09-${day}T00:00:00Z` });
		journal.append("message.out", { text: `AGENT_${day}`, legacyAt: `2026-09-${day}T00:00:00Z` });
	}
	assert.equal([...readJournalEvents(dir)].length, 6);
	const first = queryConversationRecords(dir, "它", { limit: 2 });
	assert.equal(first.total, 6); assert.equal(first.nextCursor, "2026-09-18");
	const second = queryConversationRecords(dir, "它", { limit: 2, beforeDate: first.nextCursor! });
	assert.deepEqual(second.entries.map(e => e.date), ["2026-09-17"]);
	assert.match(second.entries[0]!.text, /USER_17[\s\S]*AGENT_17/);
	assert.equal(second.nextCursor, null);
});

test("投影采用旧原文基线，保留人工附加文本，缺失后恢复并幂等", t => {
	const dir = fixture(t);
	const journal = openJournal({ dir, fsync: false }); t.after(() => journal.close());
	journal.append("message.in", { text: "导入内容", importSource: "mailbox", importLine: 0 });
	const mailbox = path.join(dir, "conversations/mailbox.md"); fs.mkdirSync(path.dirname(mailbox));
	fs.writeFileSync(mailbox, "手写标题\n原有格式的导入内容\n");
	let projector = createProjector({ homeDir: dir, companionName: "它", fsync: false });
	assert.deepEqual(projector.recover(readJournalEvents(dir)), []);
	const event = journal.append("message.out", { text: "NEW_REPLY" });
	assert.equal(projector.project(event).ok, true);
	fs.appendFileSync(mailbox, "人工追加\n");
	projector = createProjector({ homeDir: dir, companionName: "它", fsync: false });
	projector.recover(readJournalEvents(dir));
	const expected = fs.readFileSync(mailbox, "utf8");
	fs.unlinkSync(mailbox);
	projector = createProjector({ homeDir: dir, companionName: "它", fsync: false });
	assert.deepEqual(projector.recover(readJournalEvents(dir)), []);
	assert.equal(fs.readFileSync(mailbox, "utf8"), expected);
	assert.equal(expected.split("NEW_REPLY").length - 1, 1);
	assert.match(expected, /^手写标题\n原有格式的导入内容\n/); assert.match(expected, /人工追加/);
});

for (const phase of ["before", "partial", "after"]) test(`投影追加 ${phase} 中断可恢复，不重复事件`, t => {
	const dir = fixture(t);
	const mailbox = "conversations/mailbox.md";
	fs.mkdirSync(path.join(dir, "conversations")); fs.mkdirSync(path.join(dir, "runtime/projections"), { recursive: true });
	const before = { seq: 1, baseSeq: 1, bytes: 9, mtimeMs: 0 }; const after = { content: "ORIGINAL\nNEW\n" };
	fs.writeFileSync(path.join(dir, "runtime/projections/mailbox.md.json"), JSON.stringify(before));
	fs.writeFileSync(path.join(dir, "runtime/projections/pending.json"), JSON.stringify({ file: mailbox, before, seq: 2, line: "NEW\n" }));
	fs.writeFileSync(path.join(dir, mailbox), phase === "after" ? after.content : phase === "partial" ? "ORIGINAL\nNE" : "ORIGINAL\n");
	const projector = createProjector({ homeDir: dir, companionName: "它", fsync: false });
	assert.deepEqual(projector.recover([]), []); assert.deepEqual(projector.recover([]), []);
	assert.equal(fs.readFileSync(path.join(dir, mailbox), "utf8"), after.content);
	assert.equal(fs.existsSync(path.join(dir, "runtime/projections/pending.json")), false);
});


test("正常投影保持文件 inode 与原文基线，提交元数据不随历史增长", t => {
	const dir = fixture(t);
	const journal = openJournal({ dir, fsync: false }); t.after(() => journal.close());
	const projector = createProjector({ homeDir: dir, companionName: "它", fsync: false });
	projector.project(journal.append("message.out", { text: "FIRST" }));
	const mailbox = path.join(dir, "conversations/mailbox.md");
	const inode = fs.statSync(mailbox).ino;
	const baseline = fs.readFileSync(path.join(dir, "runtime/projections/mailbox.md.base"), "utf8");
	for (let i = 0; i < 100; i++) assert.equal(projector.project(journal.append("message.out", { text: "NEXT_" + i })).ok, true);
	assert.equal(fs.statSync(mailbox).ino, inode, "正常运行只追加，不原子重写整份历史");
	assert.equal(fs.readFileSync(path.join(dir, "runtime/projections/mailbox.md.base"), "utf8"), baseline);
	assert.ok(fs.statSync(path.join(dir, "runtime/projections/mailbox.md.json")).size < 512);
});

test("一次投影在写入意图前失败，后续事件不会把失败事件永久越过", async t => {
	const { reviewFixture } = await import("./__test__/review-fixture.ts");
	const f = reviewFixture(t, "projection-gap");
	const kernel = await f.start({ disableAgent: true });
	const obstruction = path.join(f.homeDir, "runtime/projections/pending.json.tmp");
	fs.mkdirSync(obstruction, { recursive: true });
	kernel.journal.append("message.out", { text: "MUST_RECOVER_FIRST", channel: "bubble" });
	assert.ok(kernel.journal.events.some(event => event.type === "system.problem" && event.data.code === "projection.failed"));
	fs.rmdirSync(obstruction);
	kernel.journal.append("message.out", { text: "MUST_KEEP_SECOND", channel: "bubble" });
	const mailbox = path.join(f.homeDir, "conversations/mailbox.md");
	const content = fs.readFileSync(mailbox, "utf8");
	assert.match(content, /MUST_RECOVER_FIRST[\s\S]*MUST_KEEP_SECOND/);
	await f.start({ disableAgent: true });
	assert.equal(fs.readFileSync(mailbox, "utf8"), content);
});

test("首次迁移途中中断：已有 native 按出现次数去重，缺失回复继续补写", t => {
	const dir = fixture(t);
	const journal = openJournal({ dir, fsync: false }); t.after(() => journal.close());
	const first = journal.append("message.out", { text: "REPEATED_REPLY" });
	const second = journal.append("message.out", { text: "MISSING_REPLY" });
	journal.append("message.out", { text: "REPEATED_REPLY" });
	const mailbox = path.join(dir, "conversations/mailbox.md"); fs.mkdirSync(path.dirname(mailbox));
	const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(first.at)).replaceAll("-", "/");
	const original = `手写标题\n[${stamp}] 旧名字: REPEATED_REPLY\n`;
	fs.writeFileSync(mailbox, original);
	let projector = createProjector({ homeDir: dir, companionName: "新名字", fsync: false });
	function* interrupted() { yield first; yield second; throw new Error("simulated crash during migration"); }
	assert.equal(projector.recover(interrupted())[0]?.ok, false);
	projector = createProjector({ homeDir: dir, companionName: "新名字", fsync: false });
	assert.deepEqual(projector.recover(readJournalEvents(dir)), []);
	const expected = fs.readFileSync(mailbox, "utf8");
	assert.ok(expected.startsWith(original));
	assert.equal(expected.split("REPEATED_REPLY").length - 1, 2);
	assert.equal(expected.split("MISSING_REPLY").length - 1, 1);
	fs.unlinkSync(mailbox);
	projector = createProjector({ homeDir: dir, companionName: "新名字", fsync: false });
	assert.deepEqual(projector.recover(readJournalEvents(dir)), []);
	assert.equal(fs.readFileSync(mailbox, "utf8"), expected);
});

test("handoff 前导入只排除 native 对应次数，游标后的同文独立记录仍导入", async t => {
	const { importLegacy } = await import("./importer.ts");
	const dir = fixture(t);
	const journal = openJournal({ dir, fsync: false }); t.after(() => journal.close());
	const projector = createProjector({ homeDir: dir, companionName: "它", fsync: false });
	const reply = journal.append("message.out", { text: "EQUAL\nBODY" });
	const thought = journal.append("thought.recorded", { text: "EQUAL_THOUGHT" });
	assert.equal(projector.project(reply).ok, true); assert.equal(projector.project(thought).ok, true);
	const files = ["conversations/mailbox.md", "thoughts/stream.jsonl"];
	const original = files.map(file => fs.readFileSync(path.join(dir, file), "utf8"));
	assert.equal(importLegacy(dir, journal).reduce((sum, report) => sum + report.events, 0), 0);
	for (const [i, file] of files.entries()) fs.appendFileSync(path.join(dir, file), original[i]!);
	assert.equal(importLegacy(dir, journal).reduce((sum, report) => sum + report.events, 0), 2);
	assert.equal([...readJournalEvents(dir)].filter(event => event.type === "message.out").length, 2);
	assert.equal([...readJournalEvents(dir)].filter(event => event.type === "thought.recorded").length, 2);
	assert.equal(importLegacy(dir, journal).reduce((sum, report) => sum + report.events, 0), 0);
});

test("已导入的同分钟同文旧行不能消耗后来 native 的投影匹配次数", async t => {
	const { importLegacy } = await import("./importer.ts");
	const { appendMailboxLine, appendThoughtLine } = await import("./projections.ts");
	const dir = fixture(t);
	const at = new Date("2026-09-19T00:01:23Z");
	appendMailboxLine(dir, { speaker: "它", text: "SAME", at }, { fsync: false });
	appendThoughtLine(dir, { text: "SAME_THOUGHT", kind: "breath", at }, { fsync: false });
	const journal = openJournal({ dir, fsync: false, now: () => at }); t.after(() => journal.close());
	assert.equal(importLegacy(dir, journal).reduce((sum, report) => sum + report.events, 0), 2);
	const projector = createProjector({ homeDir: dir, companionName: "它", fsync: false });
	projector.recover(readJournalEvents(dir));
	assert.equal(projector.project(journal.append("message.out", { text: "SAME" })).ok, true);
	assert.equal(projector.project(journal.append("thought.recorded", { text: "SAME_THOUGHT" })).ok, true);
	assert.equal(importLegacy(dir, journal).reduce((sum, report) => sum + report.events, 0), 0);
	assert.equal([...readJournalEvents(dir)].filter(event => event.type === "message.out").length, 2);
	assert.equal([...readJournalEvents(dir)].filter(event => event.type === "thought.recorded").length, 2);
});
