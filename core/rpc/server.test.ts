/**
 * RPC 契约测试：幂等命令、读模型、事件续传、错误不致命。
 * 运行：node --test core/rpc/server.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { connect, type Socket } from "node:net";
import path from "node:path";
import test from "node:test";
import { parseCommand, PROTOCOL_VERSION } from "../../contracts/events.ts";
import { openJournal } from "../journal.ts";
import { deriveState } from "../state.ts";
import { createRpcServer, rpcCall } from "./server.ts";

const ROOT = path.join(process.cwd(), ".core-test");

async function waitFor<T>(predicate: () => T | undefined | false, timeoutMs = 5000, label = "条件"): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = predicate();
		if (value) return value as T;
		if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

type Harness = Awaited<ReturnType<typeof makeHarness>>;

async function makeHarness(name: string) {
	const dir = path.join(ROOT, name);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const socketPath = path.join(dir, "core.sock");
	const journal = openJournal({ dir, exclusive: true, fsync: false });

	const server = createRpcServer({
		socketPath,
		handlers: {
			status: () => deriveState(journal.events),
			snapshot: () => ({ state: deriveState(journal.events), seq: journal.seq, protocolVersion: PROTOCOL_VERSION }),
			command: (raw) => {
				const parsed = parseCommand(raw);
				if ("error" in parsed) throw new Error(parsed.error);
				if (parsed.type === "message.send") {
					const outcome = journal.applyCommand({
						id: parsed.id,
						produce: () => [{ type: "message.in" as const, data: { text: parsed.text, source: parsed.source } }],
					});
					return { duplicate: outcome.duplicate, result: outcome.result };
				}
				const event = journal.append("wake.deferred", { reason: "测试", commandId: parsed.id });
				server.publish(event);
				return { duplicate: false };
			},
			diagnostics: () => ({
				uptimeMs: 1,
				rssBytes: 1024 * 1024,
				events: journal.events.length,
				seq: journal.seq,
				presence: deriveState(journal.events).presence,
			}),
			eventsSince: (seq) => journal.events.filter((event) => event.seq > seq),
		},
	});

	await server.start();

	function record(type: "message.out" | "thought.recorded", data: Record<string, unknown>) {
		const event = journal.append(type, data);
		server.publish(event);
		return event;
	}

	return { dir, socketPath, journal, server, record };
}

function subscribe(socketPath: string, fromSeq: number) {
	const socket: Socket = connect(socketPath);
	const events: Array<Record<string, unknown>> = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("connect", () => {
		socket.write(`${JSON.stringify({ id: "sub", type: "events.subscribe", fromSeq })}\n`);
	});
	socket.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.trim()) events.push(JSON.parse(line) as Record<string, unknown>);
		}
	});
	return {
		events,
		close: () => socket.destroy(),
		waitForCount: (count: number, label: string) => waitFor(() => events.length >= count, 5000, label),
	};
}

async function cleanup(harness: Harness) {
	harness.server.close();
	harness.journal.close();
	await new Promise((resolve) => setTimeout(resolve, 50));
}

test("query.status：返回读模型而不是原始记录", async () => {
	const harness = await makeHarness("rpc-status");
	harness.journal.append("message.in", { text: "你好", source: "text" });

	const response = (await rpcCall(harness.socketPath, { id: "q1", type: "query.status" })) as {
		ok: boolean;
		result: { messages: unknown[] };
	};
	assert.equal(response.ok, true);
	assert.equal(response.result.messages.length, 1);
	await cleanup(harness);
});

test("command：幂等——重复投递只生效一次", async () => {
	const harness = await makeHarness("rpc-idempotent");
	const send = () =>
		rpcCall(harness.socketPath, {
			id: "r1",
			type: "command",
			command: { id: "cmd-1", type: "message.send", text: "好，慢慢来。" },
		}) as Promise<{ ok: boolean; result: { duplicate: boolean } }>;

	const first = await send();
	const second = await send();
	const third = await send();

	assert.equal(first.result.duplicate, false);
	assert.equal(second.result.duplicate, true);
	assert.equal(third.result.duplicate, true);
	assert.equal(deriveState(harness.journal.events).messages.length, 1, "只入库一条");
	await cleanup(harness);
});

test("command：非法输入返回错误但不致命", async () => {
	const harness = await makeHarness("rpc-invalid");
	const bad = (await rpcCall(harness.socketPath, {
		id: "r2",
		type: "command",
		command: { id: "x", type: "message.send", text: "   " },
	})) as { ok: boolean; error: string };
	assert.equal(bad.ok, false);
	assert.match(bad.error, /留言内容为空/);

	const unknown = (await rpcCall(harness.socketPath, {
		id: "r3",
		type: "command",
		command: { id: "y", type: "explode" },
	})) as { ok: boolean; error: string };
	assert.equal(unknown.ok, false);
	assert.match(unknown.error, /未知命令/);

	// 服务必须还活着
	const still = (await rpcCall(harness.socketPath, { id: "r4", type: "query.status" })) as { ok: boolean };
	assert.equal(still.ok, true, "错误请求不得拖垮内核");
	await cleanup(harness);
});

test("events.subscribe：先补历史，再收实时事件，seq 严格递增", async () => {
	const harness = await makeHarness("rpc-subscribe");
	harness.journal.append("message.in", { text: "历史一", source: "text" });
	harness.record("message.out", { text: "历史二", channel: "bubble" });

	const subscriber = subscribe(harness.socketPath, 0);
	await subscriber.waitForCount(2, "历史补发");
	assert.deepEqual(
		subscriber.events.map((event) => event.seq),
		[1, 2],
	);

	harness.record("thought.recorded", { text: "实时一" });
	await subscriber.waitForCount(3, "实时推送");
	assert.equal(subscriber.events[2].type, "thought.recorded");

	const sequences = subscriber.events.map((event) => Number(event.seq));
	assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), "seq 必须递增");
	subscriber.close();
	await cleanup(harness);
});

test("events.subscribe：断线重连可从 fromSeq 续传，不重不漏", async () => {
	const harness = await makeHarness("rpc-resume");
	harness.journal.append("message.in", { text: "一", source: "text" });
	harness.journal.append("message.in", { text: "二", source: "text" });

	const first = subscribe(harness.socketPath, 0);
	await first.waitForCount(2, "首批");
	const lastSeq = Number(first.events.at(-1)?.seq);
	first.close();

	harness.journal.append("message.in", { text: "三（断线期间）", source: "text" });
	harness.journal.append("message.in", { text: "四（断线期间）", source: "text" });

	const resumed = subscribe(harness.socketPath, lastSeq);
	await resumed.waitForCount(2, "续传");
	assert.deepEqual(
		resumed.events.map((event) => event.seq),
		[3, 4],
		"只补断线期间的事件，不重复已收到的",
	);
	resumed.close();
	await cleanup(harness);
});

test("处理器抛错时必须回一条错误，绝不让调用方干等", async () => {
	const dir = path.join(ROOT, "rpc-handler-throws");
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const socketPath = path.join(dir, "core.sock");
	const server = createRpcServer({
		socketPath,
		handlers: {
			status: () => {
				throw new Error("故意炸一下");
			},
			snapshot: () => ({ ok: true }),
			command: () => ({ ok: true }),
			eventsSince: () => [],
		},
	});
	await server.start();
	try {
		const response = (await rpcCall(socketPath, { id: "x", type: "query.status" })) as { ok: boolean; error?: string };
		assert.equal(response.ok, false, "抛错必须变成 ok:false，而不是没有响应");
		assert.match(String(response.error), /故意炸一下/);

		// 关键：内核不能因为一个坏处理器就整体不可用
		const stillAlive = (await rpcCall(socketPath, { id: "y", type: "query.snapshot" })) as { ok: boolean };
		assert.equal(stillAlive.ok, true, "一个处理器抛错不能拖垮整个内核");
	} finally {
		server.close();
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
});

test("诊断查询：进程级指标可读（长跑泄漏靠它观察）", async () => {
	const harness = await makeHarness("rpc-diagnostics");
	try {
		const response = (await rpcCall(harness.socketPath, { id: "d", type: "query.diagnostics" })) as {
			ok: boolean;
			result?: { rssBytes: number; events: number; seq: number; presence: string };
			error?: string;
		};
		assert.equal(response.ok, true, `诊断查询必须可用: ${response.error}`);
		assert.ok((response.result?.rssBytes ?? 0) > 0, "必须能读到进程内存");
		assert.equal(response.result?.events, harness.journal.events.length);
		assert.equal(response.result?.seq, harness.journal.seq);
	} finally {
		await cleanup(harness);
	}
});
test("协议版本不匹配时明确拒绝", async () => {
	const harness = await makeHarness("rpc-version");
	const response = (await rpcCall(harness.socketPath, {
		id: "v1",
		type: "query.status",
		protocolVersion: PROTOCOL_VERSION + 1,
	})) as { ok: boolean; error: string };
	assert.equal(response.ok, false);
	assert.match(response.error, /协议版本不匹配/);
	await cleanup(harness);
});
