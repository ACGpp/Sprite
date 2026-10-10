import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { startKernel } from "./main.ts";
import { openJournal } from "./journal.ts";
import { rpcCall } from "./rpc/server.ts";

function fixture(name: string) {
	const home = path.join(process.cwd(), ".core-test", name);
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(home, { recursive: true });
	const piBin = path.join(home, "fake-pi.mjs");
	// 真子进程，观察内核传入的 session 路径，并模拟同文件的历史续接。
	fs.writeFileSync(piBin, `#!/usr/bin/env node
import fs from "node:fs";
process.chdir(process.env.SPRITE_MEMORY_HOME);
const args = process.argv.slice(2);
const session = args[args.indexOf("--session") + 1];
let history = fs.existsSync(session) ? fs.readFileSync(session, "utf8").trim().split("\\n").length : 0;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\\n")) >= 0) {
		const request = JSON.parse(buffer.slice(0, index));
		buffer = buffer.slice(index + 1);
		process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: true }) + "\\n");
		if (request.type !== "prompt") continue;
		fs.appendFileSync("prompts.jsonl", JSON.stringify({ session, history, pid: process.pid }) + "\\n");
		setTimeout(() => {
			fs.appendFileSync(session, JSON.stringify({ text: request.message }) + "\\n");
			history++;
			process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
		}, 100);
	}
});
`, { mode: 0o755 });
	return { homeDir: home, piBin, intervalMs: 3_600_000, quietHours: { start: 0, end: 0 }, fsync: false, log: () => {} };
}

function prompts(home: string): Array<{ session: string; history: number; pid: number }> {
	try {
		return fs.readFileSync(path.join(home, "prompts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	} catch { return []; }
}

async function waitFor(predicate: () => boolean) {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.fail("等待假引擎超时");
}

test("session 按上海日命名，同日复用和重启续接，跨日换文件", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-17T16:00:00Z") });
	const config = fixture("daily-session-restart");
	const legacy = path.join(config.homeDir, "sessions/2026-09-18.jsonl");
	fs.mkdirSync(path.dirname(legacy), { recursive: true });
	fs.writeFileSync(legacy, "OLD_SESSION_WITH_STALE_MEMORY\n");
	let kernel = await startKernel(config);
	try {
		await kernel.breathNow();
		await kernel.breathNow();
		const beforeRestart = prompts(config.homeDir);
		assert.equal(path.basename(path.dirname(beforeRestart[0]!.session)), "memory-v1");
		assert.equal(fs.readFileSync(legacy, "utf8"), "OLD_SESSION_WITH_STALE_MEMORY\n", "旧会话逐字保留且不当作新上下文恢复");
		assert.equal(path.basename(beforeRestart[0]!.session), "2026-09-18.jsonl", "上海零点比 UTC 日期早一天");
		assert.deepEqual(beforeRestart.map(p => p.history), [0, 1]);
		assert.equal(beforeRestart[0]!.pid, beforeRestart[1]!.pid, "同日不重启引擎");
		kernel.stop();
		kernel = await startKernel(config);
		await kernel.breathNow();
		assert.equal(prompts(config.homeDir)[2]!.history, 2, "同日重启续接原 session");
		t.mock.timers.setTime(new Date("2026-09-18T16:00:00Z").getTime());
		await kernel.breathNow();
		const after = prompts(config.homeDir);
		assert.equal(path.basename(after[3]!.session), "2026-09-19.jsonl");
		assert.equal(after[3]!.history, 0, "新一天不继续追加旧 session");
		assert.equal(fs.readFileSync(after[0]!.session, "utf8").trim().split("\n").length, 3, "旧 session 完整保留");
		assert.equal(kernel.journal.events.filter(e => e.type === "run.failed").length, 0);
	} finally { kernel.stop(); }
});

test("跨零点的回复先完成，随后排队的下一轮使用新 session", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-17T15:59:59Z") });
	const config = fixture("daily-session-inflight");
	const kernel = await startKernel(config);
	try {
		const first = kernel.breathNow();
		await waitFor(() => prompts(config.homeDir).length === 1);
		t.mock.timers.setTime(new Date("2026-09-17T16:00:00Z").getTime());
		assert.equal((await kernel.breathNow() as { busy?: boolean }).busy, true);
		assert.equal((await first as { ok: boolean }).ok, true, "旧一轮不能因日切被中断");
		await waitFor(() => kernel.journal.events.filter(e => e.type === "run.finished").length === 2);
		const entries = prompts(config.homeDir);
		assert.deepEqual(entries.map(p => path.basename(p.session)), ["2026-09-17.jsonl", "2026-09-18.jsonl"]);
		assert.equal(kernel.journal.events.filter(e => e.type === "run.failed").length, 0);
		assert.equal(kernel.journal.events.filter(e => e.type === "system.problem" && e.data.code === "pi.exited").length, 0);
	} finally { kernel.stop(); }
});

test("显式指定 session 的调用方跨日仍复用指定文件", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-17T15:59:59Z") });
	const config = fixture("daily-session-explicit");
	const fixedSession = path.join(config.homeDir, "fixed.jsonl");
	const kernel = await startKernel({ ...config, piArgs: ["--session", fixedSession] });
	try {
		await kernel.breathNow();
		t.mock.timers.setTime(new Date("2026-09-17T16:00:00Z").getTime());
		await kernel.breathNow();
		const entries = prompts(config.homeDir);
		assert.deepEqual(entries.map(p => p.session), [fixedSession, fixedSession]);
		assert.deepEqual(entries.map(p => p.history), [0, 1]);
		assert.equal(entries[0]!.pid, entries[1]!.pid);
	} finally { kernel.stop(); }
});

test("对话记录 RPC 按上海日期分开返回，零点前后互不混入", async () => {
	const config = fixture("daily-records");
	let at = new Date("2026-09-17T15:59:59Z");
	const journal = openJournal({ dir: config.homeDir, now: () => at, fsync: false });
	journal.append("message.in", { text: "昨天的问题", source: "text" });
	journal.append("message.out", { text: "昨天的回复", channel: "bubble" });
	at = new Date("2026-09-17T16:00:00Z");
	journal.append("message.in", { text: "今天的问题", source: "text" });
	journal.append("message.out", { text: "今天的回复", channel: "bubble" });
	journal.close();
	const kernel = await startKernel({ ...config, disableAgent: true });
	try {
		const response = await rpcCall(kernel.socketPath, { id: "days", type: "query.records", kind: "conversations", limit: 60 }) as {
			result: { entries: Array<{ date: string; text: string; count: number }> };
		};
		const entries = response.result.entries;
		assert.deepEqual(entries.map(e => e.date), ["2026-09-18", "2026-09-17"]);
		assert.deepEqual(entries.map(e => e.count), [2, 2]);
		assert.match(entries[0]!.text, /今天的问题/);
		assert.match(entries[0]!.text, /今天的回复/);
		assert.doesNotMatch(entries[0]!.text, /昨天/);
		assert.match(entries[1]!.text, /昨天的问题/);
		assert.doesNotMatch(entries[1]!.text, /今天/);
	} finally { kernel.stop(); }
});
