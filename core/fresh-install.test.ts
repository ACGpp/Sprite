/**
 * 全新安装：把一个**完全空的目录**当作记忆之家，看它能不能自己长出来。
 *
 * 这是新用户唯一会走的路径，而此前所有测试用的都是"已经摆好目录的夹具"——
 * 于是这条路径从未被验证过。
 *
 * 运行：node --test core/fresh-install.test.ts
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

async function waitFor<T>(predicate: () => Promise<T | undefined | false | null>, timeoutMs = 30_000, label = "条件"): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value as T;
		if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

test("全新安装：空目录也能自己长出来（含思考引擎与投影）", { timeout: 120_000, skip: skipWithoutPi() }, async () => {
	const home = path.join(ROOT, "fresh-install");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(home, { recursive: true }); // 只有目录，什么都没有
	assert.deepEqual(fs.readdirSync(home), [], "前提：目录必须是空的");

	const piHome = path.join(ROOT, "fresh-install-pi-home");
	fs.mkdirSync(piHome, { recursive: true });

	const startedAt = Date.now();
	const kernel: Kernel = await startKernel({
		homeDir: home,
		piBin: PI_BIN,
		piArgs: ["--mode", "rpc", "--no-session", "--provider", "spike", "--model", "spike-1", "-e", GATEWAY, "-e", FAKE_PROVIDER],
		piEnv: { HOME: piHome, SPRITE_SPIKE_KEY: "spike" },
		intervalMs: 3_600_000,
		quietHours: { start: 0, end: 0 },
		fsync: false,
	});
	const bootMs = Date.now() - startedAt;

	try {
		await new Promise((resolve) => setTimeout(resolve, 1800));

		// 1. 目录自己长出来了，而且没有污染别的路径
		const entries = fs.readdirSync(home).sort();
		assert.ok(entries.includes("journal"), `必须创建 journal/，实际: ${entries}`);
		assert.ok(entries.includes("runtime"), `必须创建 runtime/，实际: ${entries}`);
		assert.ok(entries.includes("sessions"), `启用 pi 时必须创建 sessions/，实际: ${entries}`);
		assert.deepEqual(
			entries.filter((name) => !["journal", "runtime", "sessions", "conversations", "thoughts"].includes(name)),
			[],
			`不该凭空造出别的目录: ${entries}`,
		);

		// 2. 首次运行报告必须如实说"什么都还没有"
		const snapshot = (await rpcCall(kernel.socketPath, { id: "s1", type: "query.snapshot" })) as {
			ok: boolean;
			result: { setup: { hasIdentity: boolean; hasModelConfig: boolean; piAvailable: boolean }; seq: number; state: { messages: unknown[] } };
		};
		assert.equal(snapshot.ok, true);
		assert.equal(snapshot.result.setup.hasIdentity, false, "全新安装没有 identity");
		assert.equal(snapshot.result.setup.hasModelConfig, false, "全新安装没有模型配置");
		assert.equal(snapshot.result.setup.piAvailable, true, "思考引擎必须已经跑起来");
		assert.equal(snapshot.result.state.messages.length, 0, "还没有任何对话");

		// 3. 第一句话：应当被接受并触发第一拍
		const send = (await rpcCall(kernel.socketPath, {
			id: "c1",
			type: "command",
			command: { id: "first-words", type: "message.send", text: "你好，我是新来的。" },
		})) as { ok: boolean; result: { deferred: boolean } };
		assert.equal(send.ok, true);
		assert.equal(send.result.deferred, false, "非安静时段第一句话应当立即得到回应");

		const state = await waitFor(
			async () => {
				const status = (await rpcCall(kernel.socketPath, { id: "s2", type: "query.status" })) as {
					result: { runs: number; danglingRun: boolean; messages: Array<{ text: string }>; outgoing: unknown[] };
				};
				return status.result.runs >= 1 && !status.result.danglingRun ? status.result : null;
			},
			45_000,
			"第一拍完成",
		);
		assert.equal(state.messages.length, 1);
		assert.equal(state.messages[0].text, "你好，我是新来的。");
		assert.ok(state.outgoing.length >= 1, "它应该回了话");

		// 4. 产物：对话与思维流文件必须被创建出来（目录也是现建的）
		const mailboxPath = path.join(home, "conversations", "mailbox.md");
		assert.ok(fs.existsSync(mailboxPath), "mailbox.md 必须被创建");
		const mailbox = fs.readFileSync(mailboxPath, "utf8");
		assert.match(mailbox, /你好，我是新来的。/, "用户的话必须落盘");
		assert.match(mailbox, /我在，今天想读点东西。/, "它的话必须落盘");
		assert.ok(fs.existsSync(path.join(home, "thoughts", "stream.jsonl")), "思维流必须被创建");

		// 5. 全新安装不该产生任何"问题"事件
		const final = (await rpcCall(kernel.socketPath, { id: "s3", type: "query.status" })) as {
			result: { problems: string[]; failures: string[] };
		};
		assert.deepEqual(final.result.failures, [], `全新安装不该有失败: ${JSON.stringify(final.result.failures)}`);
		assert.deepEqual(final.result.problems, [], `全新安装不该有问题: ${JSON.stringify(final.result.problems)}`);

		console.log(`     冷启动到可服务：${bootMs}ms（含常驻 pi 起来）`);
	} finally {
		kernel.stop();
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
});

test("全新安装：没有 pi 时也能开张，并如实降级（不假装在呼吸）", { timeout: 60_000 }, async () => {
	const home = path.join(ROOT, "fresh-install-nopi");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(home, { recursive: true });

	const kernel = await startKernel({
		homeDir: home,
		disableAgent: true,
		intervalMs: 3_600_000,
		quietHours: { start: 0, end: 0 },
		fsync: false,
	});
	try {
		const snapshot = (await rpcCall(kernel.socketPath, { id: "s1", type: "query.snapshot" })) as {
			result: { setup: { piAvailable: boolean }; state: { presence: string; problems: string[] } };
		};
		assert.equal(snapshot.result.setup.piAvailable, false);
		assert.equal(snapshot.result.state.presence, "degraded", "没有思考引擎时必须如实降级");
		assert.ok(snapshot.result.state.problems.length >= 1, "必须留下可解释的问题记录");

		// 留言仍然可用：它至少能当一本记事本
		const send = (await rpcCall(kernel.socketPath, {
			id: "c1",
			type: "command",
			command: { id: "note-1", type: "message.send", text: "先留一句，等你有引擎了再看。" },
		})) as { ok: boolean; result: { deferred: boolean } };
		assert.equal(send.ok, true, "没有 pi 也必须能留言");

		const state = (await rpcCall(kernel.socketPath, { id: "s2", type: "query.status" })) as {
			result: { messages: Array<{ text: string }>; failures: string[] };
		};
		assert.equal(state.result.messages.length, 1);
		assert.ok(
			state.result.failures.some((failure) => failure.includes("pi 不可用")),
			`无法呼吸时必须如实记录: ${JSON.stringify(state.result.failures)}`,
		);
		assert.ok(fs.existsSync(path.join(home, "conversations", "mailbox.md")), "留言仍必须落盘");
	} finally {
		kernel.stop();
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
});

assert.ok(fs.existsSync(GATEWAY) && fs.existsSync(FAKE_PROVIDER));
