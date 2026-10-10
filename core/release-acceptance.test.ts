/** Independent release acceptance: uses disposable data and no model/network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startKernel, type Kernel } from "./main.ts";
import { createMemoryStore } from "./memory-store.ts";
import { rpcCall } from "./rpc/server.ts";
import { queryMemoryHistory } from "./memory-history.ts";
import { clearJournalArchiveCache } from "./journal-archive.ts";

async function fixture(t: test.TestContext) {
	// Keep the canonical path short enough for macOS Unix socket names.
	const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sra-")));
	let kernel: Kernel | undefined;
	const start = async () => {
		await kernel?.shutdown();
		kernel = await startKernel({ homeDir, disableAgent: true, intervalMs: 3600000, fsync: false, log: () => {} });
		return kernel;
	};
	t.after(async () => { await kernel?.shutdown(); fs.rmSync(homeDir, { recursive: true, force: true }); });
	const gateway = (request: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
		const socket = net.connect(path.join(homeDir, "runtime/gateway.sock"));
		let buffer = "";
		socket.setEncoding("utf8"); socket.setTimeout(5000);
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) { socket.destroy(); resolve(JSON.parse(buffer.split("\n")[0]!)); } });
		socket.on("timeout", () => { socket.destroy(); reject(new Error("gateway timeout")); });
		socket.on("error", reject);
	});
	return { homeDir, start, gateway };
}

test("independent: Agent cannot borrow user management to restore constraints or activate authorization", async t => {
	const f = await fixture(t);
	const kernel = await f.start();
	const initial = await rpcCall(kernel.socketPath, { id: "a", type: "memory.manage", action: "agreements" }) as any;
	assert.equal(initial.ok, true);
	const source = initial.result.revision;
	for (const request of [
		{ kind: "memory.manage", action: "agreement.add", text: "UNAUTHORIZED_GRANT", agreementKind: "authorization", status: "active", baseRevision: source, commandId: "agent-grant" },
		{ kind: "memory.manage", action: "restore", path: "context/constraints.md", version: "missing", baseVersion: "missing", commandId: "agent-restore" },
		{ kind: "memory.write", path: "runtime/memory/agreements.json", content: "{}", baseVersion: "missing", requestId: "agent-ledger" },
	]) assert.equal((await f.gateway(request)).ok, false);
	const after = await rpcCall(kernel.socketPath, { id: "b", type: "memory.manage", action: "agreements" }) as any;
	assert.equal(after.result.revision, source);
	assert.deepEqual(after.result.items, []);
	assert.equal(fs.existsSync(path.join(f.homeDir, "context/constraints.md")), false);
});

test("independent: model context expires a grant without restart and never treats expiry as fresh permission", async t => {
	const f = await fixture(t);
	const kernel = await f.start();
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-21T00:00:00Z") });
	const initial = await rpcCall(kernel.socketPath, { id: "a", type: "memory.manage", action: "agreements" }) as any;
	const added = await rpcCall(kernel.socketPath, { id: "b", type: "memory.manage", action: "agreement.add", text: "TIME_LIMITED_GRANT", agreementKind: "authorization", status: "active", expiresAt: "2026-09-21T00:01:00Z", baseRevision: initial.result.revision, commandId: "user-grant" }) as any;
	assert.equal(added.ok, true);
	const context = () => f.gateway({ kind: "memory.context", contextWindow: 128000, outputReserve: 8000, historyTokens: 0 });
	const before = await context(); assert.equal(before.ok, true);
	assert.match(String(before.text), /有效约定：\[{[^\n]*TIME_LIMITED_GRANT/);
	t.mock.timers.setTime(new Date("2026-09-21T00:01:00Z").valueOf());
	const after = await context(); assert.equal(after.ok, true);
	assert.match(String(after.text), /有效约定：\[\]/);
	assert.match(String(after.text), /已结束约定：1 条（撤销 0 条，到期 1 条）/);
	assert.doesNotMatch(String(after.text), /TIME_LIMITED_GRANT/);
	const history = await rpcCall(kernel.socketPath, { id: "expired-history", type: "memory.manage", action: "agreements" }) as any;
	assert.equal(history.result.items[0].text, "TIME_LIMITED_GRANT");
	assert.equal(history.result.items[0].status, "expired");
	assert.match(String(after.text), /到期或撤销限制不代表用户授权/);
});

test("independent: renamed message speakers survive rebuilding a missing projection", async t => {
	const f = await fixture(t);
	const store = createMemoryStore({ homeDir: f.homeDir, fsync: false });
	const initial = store.write("identity.md", "我叫原名。", "missing", "initial");
	await f.start();
	assert.equal((await f.gateway({ kind: "capability.leave_message", text: "OLD_REPLY" })).ok, true);
	assert.equal((await f.gateway({ kind: "memory.write", path: "identity.md", content: "我叫新名。", baseVersion: initial.version, requestId: "rename" })).ok, true);
	assert.equal((await f.gateway({ kind: "capability.leave_message", text: "NEW_REPLY" })).ok, true);
	const mailbox = path.join(f.homeDir, "conversations/mailbox.md");
	const expected = fs.readFileSync(mailbox, "utf8");
	assert.match(expected, /原名: OLD_REPLY/); assert.match(expected, /新名: NEW_REPLY/);
	fs.unlinkSync(mailbox);
	await f.start();
	assert.equal(fs.readFileSync(mailbox, "utf8"), expected);
});

test("independent: indexed history matches a direct oracle across shuffled filenames, Unicode and pagination", async t => {
	const f = await fixture(t);
	clearJournalArchiveCache(); t.after(clearJournalArchiveCache);
	fs.mkdirSync(path.join(f.homeDir, "journal"));
	const words = ["初见身份", "HELLO WORLD", "日记🌱", "a.b[1]", "没有关键词"];
	const events = Array.from({ length: 240 }, (_, i) => ({ seq: i + 1,
		at: `2026-09-${String(10 + i % 10).padStart(2, "0")}T17:00:00.000Z`, type: "message.in" as const,
		data: { text: `${words[i % words.length]} ${i}`, source: "text" } }));
	const fileFor = (seq: number) => path.join(f.homeDir, "journal", `${9 - seq % 6}.jsonl`);
	for (let file = 4; file <= 9; file++) {
		const target = path.join(f.homeDir, "journal", `${file}.jsonl`);
		fs.writeFileSync(target, events.filter(event => fileFor(event.seq) === target).reverse().map(event => JSON.stringify(event)).join("\n") + "\n");
	}
	for (const query of [undefined, "初见", "hello", "🌱", "a.b[1]", "not-present"]) {
		for (const date of [undefined, "2026-09-11", "2026-09-20"]) {
			const matching = events.filter(event => (!query || JSON.stringify(event.data).toLowerCase().includes(query))
				&& (!date || new Date(Date.parse(event.at) + 8 * 3600000).toISOString().slice(0, 10) === date)).reverse();
			const received: number[] = [];
			let beforeSeq: number | undefined;
			do {
				const page = queryMemoryHistory(f.homeDir, { query, date, limit: 7, beforeSeq });
				for (const entry of page.entries) {
					received.push(entry.seq); assert.equal(entry.path, fileFor(entry.seq));
				}
				beforeSeq = page.nextCursor ?? undefined;
			} while (beforeSeq !== undefined);
			assert.deepEqual(received, matching.map(event => event.seq), `query=${query}, date=${date}`);
		}
	}
});
