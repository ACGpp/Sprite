/**
 * 会话连续性：重启内核之后，它还记不记得之前聊过什么。
 *
 * 这是"它有记忆"的技术底线，也是内核 K4（pi agent 运行时）唯一无法用单元测试证明的部分：
 * 必须用真 pi 进程 + 真 session 文件，跨两次内核生命周期观察。
 *
 * 做法：假 provider 每次都会汇报"我看到多少条历史"。
 *   - 第一次呼吸：历史很少（只有这次观察）
 *   - 重启后第二次呼吸：历史明显更多 → 说明 pi 从 session 文件里读回了之前的对话
 *
 * 运行：node --test core/session.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { skipWithoutPi } from "./__test__/pi-available.ts";
import { startKernel, type Kernel } from "./main.ts";
import { rpcCall } from "./rpc/server.ts";

const ROOT = path.join(process.cwd(), ".core-test");
// 不写死任何人的家目录：优先环境变量，其次 PATH 里的 pi
const PI_BIN = process.env.PI_BIN ?? "pi";
const GATEWAY = path.join(process.cwd(), "pi-extension", "sprite.ts");
const FAKE_PROVIDER = path.join(process.cwd(), "core", "__test__", "fake-provider.ts");
const PI_HOME = path.join(ROOT, "pi-home-session");

async function waitFor<T>(predicate: () => Promise<T | undefined | false | null>, timeoutMs = 60_000, label = "条件"): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value as T;
		if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

type StatusResult = {
	runs: number;
	danglingRun: boolean;
	thoughts: string[];
	messages: Array<{ text: string; imported: boolean | null }>;
	failures: string[];
};

async function status(socketPath: string): Promise<StatusResult> {
	const response = (await rpcCall(socketPath, { id: `s-${Date.now()}`, type: "query.status" })) as { result: StatusResult };
	return response.result;
}

/** 从思维流里抓出"历史 N 条"里的 N */
function historyCount(thoughts: string[]): number | null {
	for (const thought of [...thoughts].reverse()) {
		const match = /历史 (\d+) 条/.exec(thought);
		if (match) return Number(match[1]);
	}
	return null;
}

test("会话连续性：重启内核后，pi 从 session 文件读回了之前的对话", { timeout: 180_000, skip: skipWithoutPi() }, async () => {
	const home = path.join(ROOT, "session-continuity");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(home, "thoughts"), { recursive: true });
	fs.mkdirSync(PI_HOME, { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), "");
	fs.writeFileSync(path.join(home, "thoughts", "stream.jsonl"), "");

	const sessionFile = path.join(home, "sessions", "2026-09-11.jsonl");
	const config = {
		homeDir: home,
		piBin: PI_BIN,
		// 与产品默认一致：用 --session 让会话按天持久化（不是 --no-session）
		piArgs: ["--mode", "rpc", "--provider", "spike", "--model", "spike-1", "--session", sessionFile, "-e", GATEWAY, "-e", FAKE_PROVIDER],
		piEnv: { HOME: PI_HOME, SPRITE_SPIKE_KEY: "spike" },
		intervalMs: 3_600_000,
		quietHours: { start: 0, end: 0 },
		fsync: false,
	};

	// ─── 第一次生命周期 ───
	const first: Kernel = await startKernel(config);
	let firstHistory: number | null = null;
	let runsAfterFirst = 0;
	try {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await rpcCall(first.socketPath, {
			id: "c1",
			type: "command",
			command: { id: "session-1", type: "message.send", text: "第一段对话：我今天在读潮汐。" },
		});
		const state = await waitFor(async () => {
			const current = await status(first.socketPath);
			return current.runs >= 1 && !current.danglingRun && current.thoughts.length > 0 ? current : null;
		}, 60_000, "第一次呼吸完成");
		firstHistory = historyCount(state.thoughts);
		runsAfterFirst = state.runs;
		assert.ok(firstHistory !== null, `第一次呼吸应该汇报历史条数，实际思维流: ${JSON.stringify(state.thoughts)}`);
	} finally {
		first.stop();
		await new Promise((resolve) => setTimeout(resolve, 600));
	}

	// session 文件必须真的落盘——否则"记忆"只活在内存里
	assert.ok(fs.existsSync(sessionFile), `session 文件必须存在: ${sessionFile}`);
	const sessionBytes = fs.statSync(sessionFile).size;
	assert.ok(sessionBytes > 0, "session 文件不应为空");

	// ─── 第二次生命周期（同一个 session 文件）───
	const second: Kernel = await startKernel(config);
	try {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await rpcCall(second.socketPath, {
			id: "c2",
			type: "command",
			command: { id: "session-2", type: "message.send", text: "第二段对话：潮汐那篇我读完了。" },
		});
		const state = await waitFor(async () => {
			const current = await status(second.socketPath);
			return current.runs >= 1 && !current.danglingRun && historyCount(current.thoughts) !== null ? current : null;
		}, 60_000, "重启后的呼吸完成");

		const secondHistory = historyCount(state.thoughts);
		assert.ok(secondHistory !== null, "第二次呼吸也要汇报历史条数");
		assert.ok(
			secondHistory! > firstHistory!,
			`重启后 pi 必须记得之前的对话：第一次看到 ${firstHistory} 条历史，重启后只看到 ${secondHistory} 条 —— 说明会话没有延续`,
		);

		// 重启不该把留言弄丢或弄重
		const own = state.messages.filter((message) => !message.imported);
		assert.equal(own.length, 2, `两段对话都必须在记录里，实际 ${own.length}`);
		assert.equal(state.runs, runsAfterFirst + 1, `本生命周期只应新增一拍（之前 ${runsAfterFirst} 拍），实际总计 ${state.runs} 拍`);

		const sessionAfter = fs.statSync(sessionFile).size;
		assert.ok(sessionAfter > sessionBytes, "第二段对话必须写回同一个 session 文件");
		console.log(`     session 文件增长：${sessionBytes} → ${sessionAfter} 字节；历史条数：${firstHistory} → ${secondHistory}`);
	} finally {
		second.stop();
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
});

assert.ok(fs.existsSync(GATEWAY) && fs.existsSync(FAKE_PROVIDER));
