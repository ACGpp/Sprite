/**
 * 端到端：真内核 + 真 pi 进程 + 真能力网关（离线假 provider 驱动）。
 *
 * 验证的是整条链路，而不是任何单个部件：
 *   指令 → journal → 调度 → 常驻 pi → 工具调用 → 能力网关 socket → 内核事件 → 产物文件
 *
 * 全程不联网、不使用真实 API key；pi 的 HOME 被隔离到测试目录。
 * 运行：node --test core/e2e.test.ts
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
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
const PI_HOME = path.join(ROOT, "pi-home");

const MAILBOX_FIXTURE = "[2026/06/20 18:39] 零号: 老的一行\n[2026/06/20 19:39] 用户: 老的回话\n";

async function waitFor<T>(predicate: () => T | undefined | false | null | Promise<T | undefined | false | null>, timeoutMs = 30_000, label = "条件"): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		// 必须 await：异步断言返回的 Promise 恒为真值，不 await 会让整个等待形同虚设
		const value = await predicate();
		if (value) return value as T;
		if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function makeHome(name: string): string {
	const home = path.join(ROOT, name);
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(home, "thoughts"), { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), MAILBOX_FIXTURE);
	fs.writeFileSync(path.join(home, "thoughts", "stream.jsonl"), "");
	return home;
}

test("端到端：一次真实呼吸，从指令到能力网关再落到产物", { timeout: 120_000, skip: skipWithoutPi() }, async () => {
	const home = makeHome("e2e-agent");
	fs.mkdirSync(PI_HOME, { recursive: true });
	const mailboxPath = path.join(home, "conversations", "mailbox.md");
	const originalBytes = fs.readFileSync(mailboxPath);

	const logs: string[] = [];
	const kernel: Kernel = await startKernel({
		homeDir: home,
		piBin: PI_BIN,
		piArgs: ["--mode", "rpc", "--no-session", "--provider", "spike", "--model", "spike-1", "-e", GATEWAY, "-e", FAKE_PROVIDER],
		// 仅测试：隔离 pi 的 HOME，避免写用户真实的 ~/.pi（产品运行时不要这么做）
		piEnv: { HOME: PI_HOME, SPRITE_SPIKE_KEY: "spike" },
		intervalMs: 3_600_000,
		quietHours: { start: 0, end: 0 },
		fsync: false,
		log: (message) => logs.push(message),
	});

	try {
		// 等 pi 起来并就绪（能接受 prompt 需要一点时间）
		await new Promise((resolve) => setTimeout(resolve, 1500));

		const snapshot = (await rpcCall(kernel.socketPath, { id: "s1", type: "query.snapshot" })) as {
			ok: boolean;
			result: { piAvailable: boolean; seq: number };
		};
		assert.equal(snapshot.ok, true);
		assert.equal(snapshot.result.piAvailable, true, "常驻 pi 必须已就绪");

		// 发一条留言：应触发一拍真实呼吸
		const command = (await rpcCall(kernel.socketPath, {
			id: "c1",
			type: "command",
			command: { id: "e2e-1", type: "message.send", text: "今天想读点什么吗？" },
		})) as { ok: boolean; result: { deferred: boolean } };
		assert.equal(command.ok, true);
		assert.equal(command.result.deferred, false, "非安静时段应立即醒来");

		// 等这一拍跑完（含一次工具调用经网关回内核）
		const state = await waitFor(
			async () => {
				const status = (await rpcCall(kernel.socketPath, { id: "s2", type: "query.status" })) as {
					result: { runs: number; danglingRun: boolean; toolDecisions: number; outgoing: Array<{ text: string; channel: string; imported: boolean | null }>; activities: unknown[]; thoughts: string[]; questions: Array<{ question: string; options: string[] }> };
				};
				const value = status.result;
				return value.runs >= 1 && !value.danglingRun && value.outgoing.length > 0 ? value : null;
			},
			60_000,
			"呼吸完成且它说了话",
		);

		// 真实工具调用被记录（say 经能力网关）
		assert.ok(state.activities.length >= 1, `必须有工具活动记录，实际 ${state.activities.length}`);
		assert.ok(state.toolDecisions >= 1, "每一次工具调用都必须留痕");
		assert.ok(state.thoughts.length >= 1, "思维流必须有内容");

		// 它说的话：一条是导入的历史回话，一条是这一拍真的说的
		const freshOutgoing = state.outgoing.filter((message) => !message.imported);
		assert.equal(freshOutgoing.length, 1, `这一拍只说了一句话，实际 ${freshOutgoing.length}`);
		assert.equal(freshOutgoing[0].channel, "bubble", "非安静时段应当是气泡");
		assert.equal(freshOutgoing[0].text, "我在，今天想读点东西。");
		assert.equal(state.outgoing.length, 2, "历史回话仍必须留在谈话记录里（不能因为不算新就丢掉）");

		// ask_user：问题必须落到内核并被读模型看见（外壳靠它显示"等你回答"）
		assert.equal(state.questions.length, 1, `必须有且只有一条待答问题，实际 ${state.questions.length}`);
		assert.equal(state.questions[0].question, "今天想让我读点什么？");
		assert.deepEqual(state.questions[0].options, ["潮汐那篇", "随便读读", "先不用"]);

		// 产物：新内容落盘，旧内容逐字节不变
		await waitFor(() => fs.readFileSync(mailboxPath, "utf8").includes("我在，今天想读点东西。"), 10_000, "它的话落盘");
		const after = fs.readFileSync(mailboxPath);
		assert.ok(after.subarray(0, originalBytes.length).equals(originalBytes), "旧内容必须逐字节不变");

		// journal 是唯一事实来源：RPC 读模型与事件序列一致
		const journalLines = fs
			.readdirSync(path.join(home, "journal"))
			.filter((file) => file.endsWith(".jsonl"))
			.flatMap((file) => fs.readFileSync(path.join(home, "journal", file), "utf8").split("\n"))
			.filter((line) => line.trim());
		const parsed = journalLines.map((line) => JSON.parse(line) as { seq: number });
		assert.deepEqual(
			parsed.map((event) => event.seq),
			Array.from({ length: parsed.length }, (_, index) => index + 1),
			"事件 seq 必须连续无缺口",
		);

		// 能力网关的 socket 必须是 0600（agent 的门不能对别人开着）
		const gatewayMode = fs.statSync(path.join(home, "runtime", "gateway.sock")).mode & 0o777;
		assert.equal(gatewayMode, 0o600, `gateway.sock 权限必须是 0600，实际 ${gatewayMode.toString(8)}`);
	} finally {
		kernel.stop();
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
});

test("端到端：重启后内核接管锁、不重跑、pi 重新就绪", { timeout: 120_000, skip: skipWithoutPi() }, async () => {
	const home = makeHome("e2e-restart");
	fs.mkdirSync(PI_HOME, { recursive: true });
	const config = {
		homeDir: home,
		piBin: PI_BIN,
		piArgs: ["--mode", "rpc", "--no-session", "--provider", "spike", "--model", "spike-1", "-e", GATEWAY, "-e", FAKE_PROVIDER],
		piEnv: { HOME: PI_HOME, SPRITE_SPIKE_KEY: "spike" },
		intervalMs: 3_600_000,
		quietHours: { start: 0, end: 0 },
		fsync: false,
	};

	const first = await startKernel(config);
	try {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await rpcCall(first.socketPath, { id: "c1", type: "command", command: { id: "e2e-restart-1", type: "message.send", text: "重启前" } });
		await waitFor(
			async () => {
				const status = (await rpcCall(first.socketPath, { id: "s1", type: "query.status" })) as { result: { runs: number; danglingRun: boolean } };
				return status.result.runs >= 1 && !status.result.danglingRun ? true : null;
			},
			60_000,
			"第一拍完成",
		);
	} finally {
		first.stop();
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	const second = await startKernel(config);
	try {
		const status = (await rpcCall(second.socketPath, { id: "s2", type: "query.status" })) as {
			ok: boolean;
			result: { runs: number; messages: Array<{ text: string }>; failures: string[]; danglingRun: boolean };
		};
		assert.equal(status.ok, true, "重启后必须能接管（锁已释放）");
		assert.equal(status.result.runs, 1, "不得重复执行历史呼吸");
		assert.equal(status.result.danglingRun, false);
		assert.equal(
			status.result.messages.filter((message) => message.text === "重启前").length,
			1,
			"留言不得因为重启而翻倍（投影-导入反馈回路已被所有权交接挡住）",
		);
	} finally {
		second.stop();
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
});

// 保证 GATEWAY 与 FAKE_PROVIDER 文件确实存在（避免测试静默失效）
assert.ok(fs.existsSync(GATEWAY), `能力网关扩展不存在: ${GATEWAY}`);
assert.ok(fs.existsSync(FAKE_PROVIDER), `假 provider 不存在: ${FAKE_PROVIDER}`);
assert.ok(crypto.createHash("sha256").update("sprite").digest("hex").length === 64);
