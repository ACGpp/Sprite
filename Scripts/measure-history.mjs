/** Safe synthetic archive benchmark; never opens SPRITE_HOME or starts a kernel/provider. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { queryConversationRecords } from "../core/record-store.ts";
import { queryMemoryHistory } from "../core/memory-history.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(root, ".core-test", "history-scale");
const count = Number(process.env.HISTORY_EVENTS ?? 700_000);
const days = Number(process.env.HISTORY_DAYS ?? 365);
const cases = ["records", "records-page", "seq", "date", "keyword-rare", "keyword-common"];
if (!Number.isSafeInteger(count) || count < 100 || !Number.isSafeInteger(days) || days < 1 || days > count) throw new Error("Invalid benchmark scale");

function generate() {
	fs.rmSync(work, { recursive: true, force: true });
	fs.mkdirSync(path.join(work, "journal"), { recursive: true });
	const start = Date.parse("2025-01-01T00:00:00+08:00");
	let bytes = 0;
	for (let day = 0; day < days; day++) {
		const first = Math.floor(day * count / days) + 1;
		const last = Math.floor((day + 1) * count / days);
		const lines = [];
		for (let seq = first; seq <= last; seq++) {
			const at = new Date(start + day * 86_400_000 + ((seq - first) / (last - first + 1)) * 86_400_000).toISOString();
			const kind = seq % 10;
			const type = ["message.in", "message.out", "thought.recorded", "run.finished"][kind] ?? "tool.decided";
			const data = kind < 3 ? { text: seq === 10 ? "needle ancient 仅此一条" : `hello 第 ${seq} 次记录：今天读到的东西值得想一想。`, source: "text" }
				: kind === 3 ? { runId: `run-${seq}`, durationMs: 1234 } : { tool: "read", input: "private/internal", decision: "allow" };
			lines.push(JSON.stringify({ seq, at, type, data }));
		}
		// Deliberately misleading filenames: queries must use actual event timestamps.
		const name = `${new Date(start + ((day + 17) % days) * 86_400_000).toISOString().slice(0, 10)}.jsonl`;
		const body = `${lines.join("\n")}\n`;
		fs.writeFileSync(path.join(work, "journal", name), body); bytes += Buffer.byteLength(body);
	}
	fs.writeFileSync(path.join(work, "fixture.json"), JSON.stringify({ count, days, bytes }));
	return { count, days, bytes };
}

function runCase(name) {
	const seq = Math.floor(count / 20) * 10;
	const date = new Date(Date.parse("2025-01-01T00:00:00Z") + Math.floor(days / 2) * 86_400_000).toISOString().slice(0, 10);
	switch (name) {
		case "records": return queryConversationRecords(work, "它", { limit: 7 });
		case "records-page": return queryConversationRecords(work, "它", { limit: 7, beforeDate: date });
		case "seq": { const result = queryMemoryHistory(work, { seq }); assert.equal(result.entries[0]?.seq, seq); return result; }
		case "date": return queryMemoryHistory(work, { date, limit: 20 });
		case "keyword-rare": { const result = queryMemoryHistory(work, { query: "needle ancient", limit: 20 }); assert.deepEqual(result.entries.map(item => item.seq), [10]); return result; }
		case "keyword-common": return queryMemoryHistory(work, { query: "hello", limit: 20 });
		default: throw new Error("Unknown case");
	}
}

if (process.argv[2] === "--worker") {
	const name = process.argv[3];
	const durations = [];
	let result;
	for (let i = 0; i < 4; i++) { const start = performance.now(); result = runCase(name); durations.push(performance.now() - start); }
	global.gc?.();
	console.log(JSON.stringify({ name, coldMs: Number(durations[0].toFixed(1)), warmMedianMs: Number(durations.slice(1).sort((a, b) => a - b)[1].toFixed(1)),
		entries: result.entries.length, total: result.total ?? null, nextCursor: result.nextCursor ?? null,
		heapMiB: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)), rssMiB: Number((process.memoryUsage().rss / 1048576).toFixed(1)) }));
} else {
	const label = process.argv[2] ?? "current";
	if (!/^[a-z0-9-]+$/.test(label)) throw new Error("Invalid report label");
	const fixture = generate();
	const results = [];
	for (const name of cases) {
		const child = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--worker", name], { cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 });
		if (child.status !== 0) throw new Error(child.stderr || child.error?.message || `worker ${name} failed`);
		const item = JSON.parse(child.stdout.trim()); results.push(item); console.log(JSON.stringify(item));
	}
	const report = { label, at: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, fixture, results,
		note: "Cold means a fresh process without an application index. OS filesystem cache is not flushed. Warm is median of three subsequent calls. Heap measured after explicit GC." };
	fs.writeFileSync(path.join(root, ".core-test", `history-${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
}
