import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { clearJournalArchiveCache, journalArchiveCacheStats } from "./journal-archive.ts";
import { queryMemoryHistory } from "./memory-history.ts";
import { queryConversationRecords, readJournalEvents } from "./record-store.ts";

function fixture(t: test.TestContext) {
	clearJournalArchiveCache();
	fs.mkdirSync(".core-test", { recursive: true });
	const home = fs.mkdtempSync(path.resolve(".core-test/history-index-"));
	fs.mkdirSync(path.join(home, "journal"));
	t.after(() => { fs.rmSync(home, { recursive: true, force: true }); clearJournalArchiveCache(); });
	const event = (seq: number, text: string, at = "2026-09-21T00:00:00Z", extra: Record<string, unknown> = {}) => ({ seq, at, type: "message.in", data: { text, ...extra } });
	const write = (file: string, events: unknown[]) => fs.writeFileSync(path.join(home, "journal", file), events.map(item => JSON.stringify(item)).join("\n") + "\n");
	return { home, event, write };
}

test("warm index observes append, torn-tail completion, truncation and deletion without hiding old events", t => {
	const f = fixture(t);
	f.write("old.jsonl", [f.event(1, "old")]);
	f.write("new.jsonl", [f.event(2, "new")]);
	assert.deepEqual(queryMemoryHistory(f.home).entries.map(item => item.seq), [2, 1]);
	const file = path.join(f.home, "journal/new.jsonl");
	fs.appendFileSync(file, JSON.stringify(f.event(3, "complete")) + "\n" + JSON.stringify(f.event(4, "tail")));
	assert.deepEqual(queryMemoryHistory(f.home).entries.map(item => item.seq), [3, 2, 1]);
	fs.appendFileSync(file, "\n");
	assert.deepEqual(queryMemoryHistory(f.home).entries.map(item => item.seq), [4, 3, 2, 1]);
	f.write("new.jsonl", [f.event(5, "replacement")]);
	assert.deepEqual(queryMemoryHistory(f.home).entries.map(item => item.seq), [5, 1]);
	fs.unlinkSync(file);
	assert.deepEqual(queryMemoryHistory(f.home).entries.map(item => item.seq), [1]);
	assert.equal(queryConversationRecords(f.home, "它", { limit: 7 }).total, 1);
});

test("same-size rewrite with restored mtime and atomic replacement invalidate index and keyword filters", t => {
	const f = fixture(t); const file = path.join(f.home, "journal/events.jsonl");
	f.write("events.jsonl", [f.event(1, "first")]);
	const before = fs.statSync(file);
	assert.equal(queryMemoryHistory(f.home, { query: "first" }).entries.length, 1);
	f.write("events.jsonl", [f.event(1, "other")]);
	fs.utimesSync(file, before.atime, before.mtime);
	assert.equal(fs.statSync(file).size, before.size);
	assert.equal(queryMemoryHistory(f.home, { query: "first" }).entries.length, 0);
	assert.equal(queryMemoryHistory(f.home, { query: "other" }).entries.length, 1);
	f.write("replace.tmp", [f.event(1, "newer")]);
	fs.renameSync(path.join(f.home, "journal/replace.tmp"), file);
	fs.utimesSync(file, before.atime, before.mtime);
	assert.equal(queryMemoryHistory(f.home, { query: "newer" }).entries.length, 1);
});

test("filename-independent legacy dates, pagination, total and exact seq survive cache reset", t => {
	const f = fixture(t);
	f.write("1999-01-01.jsonl", [f.event(30, "latest", "2026-09-21T16:00:00Z"), f.event(10, "imported", "2026-09-21T00:00:00Z", { legacyAt: "2025-01-01T00:00:00Z" })]);
	f.write("2099-01-01.jsonl", [f.event(20, "middle", "2026-09-20T00:00:00Z")]);
	const first = queryConversationRecords(f.home, "它", { limit: 1 });
	assert.equal(first.total, 3); assert.equal(first.entries[0].date, "2026-09-22");
	assert.equal(queryConversationRecords(f.home, "它", { limit: 1, beforeDate: first.nextCursor! }).entries[0].date, "2026-09-20");
	const date = queryMemoryHistory(f.home, { date: "2025-01-01" });
	assert.deepEqual(date.entries.map(item => item.seq), [10]);
	assert.equal(date.entries[0].path, path.join(f.home, "journal/1999-01-01.jsonl"));
	clearJournalArchiveCache();
	assert.deepEqual(queryMemoryHistory(f.home, { date: "2025-01-01" }), date);
	assert.equal(queryMemoryHistory(f.home, { seq: 30 }).entries[0].data.text, "latest");
});

test("cold and warm archives exclude links and never return cached content after linking a source", t => {
	const f = fixture(t);
	f.write("source.jsonl", [f.event(1, "before")]);
	assert.equal(queryMemoryHistory(f.home).entries.length, 1);
	const source = path.join(f.home, "journal/source.jsonl");
	const secret = path.join(f.home, "secret.jsonl");
	fs.writeFileSync(secret, JSON.stringify(f.event(2, "SECRET")) + "\n");
	fs.unlinkSync(source); fs.symlinkSync(secret, source);
	fs.linkSync(secret, path.join(f.home, "journal/hardlink.jsonl"));
	assert.equal(queryMemoryHistory(f.home).entries.length, 0);
	assert.equal(queryConversationRecords(f.home, "它", { limit: 7 }).total, 0);
	assert.deepEqual([...readJournalEvents(f.home)], []);
	fs.rmSync(path.join(f.home, "journal"), { recursive: true });
	fs.mkdirSync(path.join(f.home, "replacement")); fs.symlinkSync(path.join(f.home, "replacement"), path.join(f.home, "journal"));
	assert.throws(() => queryConversationRecords(f.home, "它", { limit: 7 }), /路径不安全/);
});

test("newest-first pruning preserves duplicate sequence selection and does not leak hidden fields into keyword indexes", t => {
	const f = fixture(t);
	f.write("a.jsonl", [f.event(9, "first"), f.event(2, "small", undefined, { secret: "hiddenkey" })]);
	f.write("b.jsonl", [f.event(9, "later"), f.event(100, "top")]);
	assert.equal(queryMemoryHistory(f.home, { seq: 9 }).entries[0].data.text, "first");
	assert.equal(queryMemoryHistory(f.home, { seq: 9, query: "later" }).entries[0].data.text, "later");
	assert.deepEqual(queryMemoryHistory(f.home, { limit: 1 }).entries.map(item => item.seq), [100]);
	assert.equal(queryMemoryHistory(f.home, { query: "hiddenkey" }).entries.length, 0);
	for (const query of ["f", "fi", "fir", "FIRST"]) assert.equal(queryMemoryHistory(f.home, { query }).entries[0].seq, 9);
});

test("content LRU stays bounded and evicted archives are still queryable and fully paginated", t => {
	const f = fixture(t);
	for (let day = 0; day < 70; day++) {
		const at = new Date(Date.parse("2026-01-01T00:00:00Z") + day * 86_400_000).toISOString();
		f.write(`${day.toString().padStart(3, "0")}.jsonl`, Array.from({ length: 300 }, (_, i) => f.event(day * 300 + i + 1, `${day === 0 ? "ancientneedle" : "ordinary"} ${"x".repeat(700)}`, at)));
	}
	const page = queryConversationRecords(f.home, "它", { limit: 7 });
	assert.equal(page.total, 21_000);
	const stats = journalArchiveCacheStats();
	assert.ok(stats.contentBytes <= stats.contentLimit);
	assert.ok(stats.indexBytes <= stats.indexLimit);
	assert.ok(stats.cachedFiles < 70, "fixture must exercise real eviction");
	assert.equal(queryMemoryHistory(f.home, { seq: 1 }).entries[0].seq, 1);
	assert.equal(queryMemoryHistory(f.home, { query: "ancientneedle", limit: 100 }).entries.length, 100);
	let count = 0, beforeDate: string | undefined;
	do { const next = queryConversationRecords(f.home, "它", { limit: 7, beforeDate }); count += next.entries.length; beforeDate = next.nextCursor ?? undefined; } while (beforeDate);
	assert.equal(count, 70, "LRU capacity is not an archive retention limit");
});

test("index eviction has an explicit global budget and rebuilds older files on demand", t => {
	const f = fixture(t);
	for (let i = 0; i < 2100; i++) f.write(`${i.toString().padStart(4, "0")}.jsonl`, [f.event(i + 1, `item-${i}`)]);
	assert.equal(queryMemoryHistory(f.home, { seq: 1 }).entries[0].seq, 1);
	const stats = journalArchiveCacheStats();
	assert.ok(stats.indexBytes <= stats.indexLimit);
	assert.ok(stats.indexedFiles < 2100, "fixture must exceed the index budget");
	assert.equal(queryMemoryHistory(f.home, { seq: 2100 }).entries[0].seq, 2100);
	assert.equal(queryConversationRecords(f.home, "它", { limit: 1 }).total, 2100);
});
