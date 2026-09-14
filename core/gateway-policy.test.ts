/**
 * 能力网关策略验证：真正跑在产品里的拦截层（pi-extension/sprite.ts）。
 *
 * 为什么单独测：这是 agent 与世界之间唯一的门。
 * 之前只有 spike 里的另一份网关被验过，产品里这份的拦截路径从未跑过。
 *
 * 断言分两层：
 *   1. journal 里有正确的决策记录（可解释）
 *   2. **文件系统上确实什么都没发生**（真拦住了，而不只是记了一笔）
 *
 * 运行：node --test core/gateway-policy.test.ts
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
const PROBE_PROVIDER = path.join(process.cwd(), "core", "__test__", "policy-probe-provider.ts");

async function waitFor<T>(predicate: () => Promise<T | undefined | false | null>, timeoutMs = 60_000, label = "条件"): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value as T;
		if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

test("能力网关：危险命令被拦下且真的没有执行，越界写入被拒，正常动作放行留痕", { timeout: 180_000, skip: skipWithoutPi() }, async () => {
	const home = path.join(ROOT, "gateway-policy");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(home, "thoughts"), { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), "");
	fs.writeFileSync(path.join(home, "thoughts", "stream.jsonl"), "");
	fs.writeFileSync(path.join(home, "identity.md"), "# 我是谁\n\n我是策略探针。\n");

	// 危险命令的目标：跑完必须还在（证明命令真的没执行）
	const victim = path.join(home, "victim.txt");
	fs.writeFileSync(victim, "我必须活下来\n");
	// 越界写入的目标：跑完必须不存在（允许根只有 home）
	const outside = path.join(ROOT, "outside-allowed-root.txt");
	fs.rmSync(outside, { force: true });

	const piHome = path.join(ROOT, "gateway-policy-pi-home");
	fs.mkdirSync(piHome, { recursive: true });

	const logs: string[] = [];
	const kernel: Kernel = await startKernel({
		homeDir: home,
		piBin: PI_BIN,
		piArgs: [
			"--mode", "rpc", "--no-session",
			"--provider", "spike", "--model", "spike-1",
			"-e", GATEWAY,
			"-e", PROBE_PROVIDER,
		],
		piEnv: {
			HOME: piHome,
			SPRITE_SPIKE_KEY: "spike",
			SPRITE_POLICY_VICTIM: victim,
			SPRITE_POLICY_OUTSIDE: outside,
		},
		intervalMs: 3_600_000,
		quietHours: { start: 0, end: 0 },
		fsync: false,
		allowedRoots: [home],
		log: (message) => logs.push(message),
	});

	try {
		await new Promise((resolve) => setTimeout(resolve, 1800));
		await rpcCall(kernel.socketPath, {
			id: "c1",
			type: "command",
			command: { id: "policy-1", type: "message.send", text: "跑一遍策略探针。" },
		});

		const state = await waitFor(
			async () => {
				const status = (await rpcCall(kernel.socketPath, { id: "s1", type: "query.status" })) as {
					result: { runs: number; danglingRun: boolean; toolDecisions: number; outgoing: Array<{ text: string }> };
				};
				return status.result.runs >= 1 && !status.result.danglingRun ? status.result : null;
			},
			90_000,
			"策略探针跑完",
		);

		// ─── 第一层：策略决策必须留痕 ───
		const decisions = kernel.journal.events
			.filter((event) => event.type === "tool.decided")
			.map((event) => ({
				tool: String(event.data.tool ?? ""),
				decision: String(event.data.decision ?? ""),
				input: String(event.data.input ?? ""),
				reason: String(event.data.reason ?? ""),
			}));

		assert.equal(state.toolDecisions, decisions.length, "读模型里的决策数必须等于日志里的条数");
		assert.ok(decisions.length >= 5, `每次工具调用都要留痕，实际 ${decisions.length} 条`);

		const blocked = decisions.filter((decision) => decision.decision === "block");
		assert.ok(
			blocked.some((decision) => decision.tool === "bash" && decision.input.includes("rm -rf")),
			`危险 bash 必须被拦: ${JSON.stringify(decisions)}`,
		);
		assert.ok(
			blocked.some((decision) => decision.tool === "bash" && /sudo/.test(decision.input)),
			"sudo 必须被拦",
		);
		assert.ok(
			blocked.some((decision) => decision.tool === "write" && decision.reason.includes("越界")),
			`越界写入必须被拦: ${JSON.stringify(blocked)}`,
		);
		assert.ok(
			decisions.some((decision) => decision.tool === "bash" && decision.decision === "allow" && decision.input.includes("echo")),
			"普通 bash 应当放行并留痕",
		);
		assert.ok(
			decisions.some((decision) => decision.tool === "read" && decision.decision === "allow"),
			"读操作应当放行并留痕（它需要能翻世界）",
		);

		// ─── 第二层：文件系统上确实什么都没发生 ───
		assert.ok(fs.existsSync(victim), "危险命令的目标文件必须还在——说明命令真的没被执行");
		assert.equal(fs.readFileSync(victim, "utf8"), "我必须活下来\n");
		assert.ok(!fs.existsSync(outside), "允许根之外的路径不得被写入");

		// ─── 说话节流：一轮四次，只有三次能出去 ───
		const says = state.outgoing.filter((message) => message.text.includes("句"));
		assert.equal(says.length, 3, `一轮最多说 3 次，实际 ${says.length} 次`);
		assert.ok(!says.some((message) => message.text.includes("第四句")), "第四次必须被节流");
		assert.ok(
			blocked.some((decision) => decision.tool === "say"),
			"节流也要留痕（否则用户会以为它不想说话）",
		);

		// ─── 它不能自作主张把节奏改到失控 ───
		const scheduled = kernel.journal.events.filter((event) => event.type === "breath.scheduled");
		const lastSchedule = scheduled.at(-1);
		const intervalMs = Number(lastSchedule?.data.intervalMs ?? 0);
		assert.ok(intervalMs > 0, "必须有排期事件");
		assert.ok(
			intervalMs <= 6 * 60 * 60 * 1000,
			`它要求的 999999 秒必须被限幅到 6 小时以内，实际 ${intervalMs}ms`,
		);
	} finally {
		kernel.stop();
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
});
