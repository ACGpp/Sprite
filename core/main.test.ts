/**
 * main.ts 冒烟测试：真进程、真 socket、真文件。
 *
 * 验证的是组装，而不是单元逻辑：
 *   - 导入 → 水位线 → 新内容投影（旧内容逐字节不变）
 *   - RPC 幂等指令
 *   - 没有 pi 时诚实降级（presence=degraded + system.problem），而不是假装在呼吸
 *
 * 运行：node --test core/main.test.ts
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { hourInShanghai } from "./text.ts";
import { rpcCall } from "./rpc/server.ts";

const ROOT = path.join(process.cwd(), ".core-test");
const MAIN = path.join(process.cwd(), "core", "main.ts");

const MAILBOX_FIXTURE = "[2026/06/20 18:39] 零号: 老的一行\n[2026/06/20 19:39] 用户: 老的回话\n";
const THOUGHTS_FIXTURE = '{"time":"2026-05-07T01:13:46Z","type":"breath","content":"老思维"}\n';

async function waitFor<T>(predicate: () => T | undefined | false, timeoutMs = 15_000, label = "条件"): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = predicate();
		if (value) return value as T;
		if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}

type Fixture = { home: string; socketPath: string; before: { mailbox: string; thoughts: string }; mailboxPath: string };

function makeFixture(name: string): Fixture {
	const home = path.join(ROOT, name);
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(home, "thoughts"), { recursive: true });
	const mailboxPath = path.join(home, "conversations", "mailbox.md");
	fs.writeFileSync(mailboxPath, MAILBOX_FIXTURE);
	fs.writeFileSync(path.join(home, "thoughts", "stream.jsonl"), THOUGHTS_FIXTURE);
	const hash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	return {
		home,
		socketPath: path.join(home, "runtime", "core.sock"),
		mailboxPath,
		before: { mailbox: hash(mailboxPath), thoughts: hash(path.join(home, "thoughts", "stream.jsonl")) },
	};
}

function launch(fixture: Fixture, extraEnv: Record<string, string> = {}): { child: ChildProcess; logs: string[] } {
	const logs: string[] = [];
	const child = spawn(process.execPath, [MAIN], {
		env: {
			...process.env,
			SPRITE_HOME: fixture.home,
			SPRITE_SOCKET: fixture.socketPath,
			SPRITE_NO_PI: "1",
			SPRITE_QUIET_START: "0",
			SPRITE_QUIET_END: "0", // 关闭安静时段，让测试可控
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => logs.push(chunk));
	child.stderr?.on("data", (chunk: string) => logs.push(`[stderr] ${chunk}`));
	return { child, logs };
}

async function stop(child: ChildProcess) {
	if (child.exitCode !== null || child.signalCode) return;
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
}

test("冒烟：导入 → 开门 → 指令 → 投影（旧内容逐字节不变）", async () => {
	const fixture = makeFixture("main-smoke");
	const { child, logs } = launch(fixture);
	try {
		await waitFor(() => fs.existsSync(fixture.socketPath), 15_000, "socket 出现");

		const snapshot = (await rpcCall(fixture.socketPath, { id: "s1", type: "query.snapshot" })) as {
			ok: boolean;
			result: {
				seq: number;
				state: { messages: unknown[]; outgoing: unknown[]; presence: string };
				imports: Array<{ source: string; status: string; events: number }>;
				piAvailable: boolean;
			};
		};
		assert.equal(snapshot.ok, true);
		assert.equal(snapshot.result.piAvailable, false, "SPRITE_NO_PI=1 时不得声称 agent 可用");
		assert.ok(snapshot.result.seq > 0, "导入必须已经写进 journal");
		assert.equal(snapshot.result.state.messages.length, 1, "夹具里有一条用户留言");
		assert.equal(snapshot.result.state.outgoing.length, 1, "夹具里有一条它的留言");
		assert.ok(snapshot.result.imports.every((report) => report.status === "imported"));
		assert.equal(snapshot.result.state.presence, "degraded", "没有 pi 时必须如实降级");

		// 幂等指令
		const send = (id: string) =>
			rpcCall(fixture.socketPath, {
				id: `req-${id}`,
				type: "command",
				command: { id, type: "message.send", text: "新的一句话" },
			}) as Promise<{ ok: boolean; result: { duplicate: boolean } }>;
		const first = await send("smoke-1");
		const second = await send("smoke-1");
		assert.equal(first.result.duplicate, false);
		assert.equal(second.result.duplicate, true, "重复投递必须判重");

		// 投影：新内容落盘，旧内容前缀逐字节不变
		await waitFor(
			() => fs.readFileSync(fixture.mailboxPath, "utf8").includes("新的一句话"),
			5000,
			"新留言落盘",
		);
		const after = fs.readFileSync(fixture.mailboxPath);
		const original = Buffer.from(MAILBOX_FIXTURE, "utf8");
		assert.ok(after.subarray(0, original.length).equals(original), "旧内容必须逐字节不变");
		assert.equal(
			after.toString("utf8").split("\n").filter((line) => line.includes("新的一句话")).length,
			1,
			"重复指令不得写两遍",
		);

		// 没有 pi：触发呼吸要如实失败，并且内核仍然活着
		const status = (await rpcCall(fixture.socketPath, { id: "s2", type: "query.status" })) as {
			ok: boolean;
			result: { failures: string[]; presence: string };
		};
		assert.equal(status.ok, true, "内核必须仍然可服务");
		assert.ok(
			status.result.failures.some((failure) => failure.includes("pi 不可用")),
			`没有 pi 时必须如实记失败，实际: ${JSON.stringify(status.result.failures)}`,
		);

		// 导入的思维流没有被再投影一遍
		const thoughts = fs.readFileSync(path.join(fixture.home, "thoughts", "stream.jsonl"), "utf8").trim().split("\n");
		assert.equal(thoughts.length, 1, `导入的历史不得重复投影，实际 ${thoughts.length} 行`);
	} finally {
		await stop(child);
	}
});

test("冒烟：暂停与继续（把它安静下来是用户的权力）", async () => {
	const fixture = makeFixture("main-pause");
	const { child } = launch(fixture);
	try {
		await waitFor(() => fs.existsSync(fixture.socketPath), 15_000, "内核就绪");

		const paused = (await rpcCall(fixture.socketPath, {
			id: "p1",
			type: "command",
			command: { id: "pause-1", type: "breath.pause", until: "hour" },
		})) as { ok: boolean; result: { paused: boolean; until: number | null } };
		assert.equal(paused.result.paused, true);
		assert.ok((paused.result.until ?? 0) > Date.now(), "「一小时」必须给出未来的时刻");

		const pausedState = (await rpcCall(fixture.socketPath, { id: "p2", type: "query.status" })) as {
			result: { presence: string };
		};
		assert.equal(pausedState.result.presence, "paused", "暂停必须如实反映在状态里");

		// 暂停期间的留言仍然入库（不丢），只是不会立刻醒来
		await rpcCall(fixture.socketPath, {
			id: "p3",
			type: "command",
			command: { id: "pause-msg", type: "message.send", text: "它在休息的时候我说的话" },
		});
		const afterMessage = (await rpcCall(fixture.socketPath, { id: "p4", type: "query.status" })) as {
			result: { messages: Array<{ text: string }>; runs: number; presence: string };
		};
		assert.equal(
			afterMessage.result.messages.filter((message) => message.text === "它在休息的时候我说的话").length,
			1,
			"暂停期间的留言不得丢失",
		);
		assert.equal(afterMessage.result.runs, 0, "暂停期间不得擅自呼吸");
		assert.equal(afterMessage.result.presence, "paused");

		const resumed = (await rpcCall(fixture.socketPath, {
			id: "p5",
			type: "command",
			command: { id: "resume-1", type: "breath.resume" },
		})) as { result: { paused: boolean } };
		assert.equal(resumed.result.paused, false);

		const resumedState = (await rpcCall(fixture.socketPath, { id: "p6", type: "query.status" })) as {
			result: { presence: string; nextBreathAt: string | null };
		};
		assert.notEqual(resumedState.result.presence, "paused", "继续之后不能还停在暂停态");
		assert.ok(resumedState.result.nextBreathAt, "继续之后必须重新安排下一拍");

		// journal 里必须留下可解释的记录
		const events = fs
			.readFileSync(path.join(fixture.home, "journal", fs.readdirSync(path.join(fixture.home, "journal")).find((f) => f.endsWith(".jsonl"))!), "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as { type: string });
		assert.ok(events.some((event) => event.type === "breath.paused"), "暂停必须留痕");
		assert.ok(events.some((event) => event.type === "breath.resumed"), "继续必须留痕");
	} finally {
		await stop(child);
	}
});

test("首次运行报告：模型配置只看键在不在，绝不泄漏值", async () => {
	const fixture = makeFixture("main-setup");
	const { child } = launch(fixture);
	try {
		await waitFor(() => fs.existsSync(fixture.socketPath), 15_000, "内核就绪");

		const before = (await rpcCall(fixture.socketPath, { id: "s1", type: "query.snapshot" })) as {
			result: { setup: Record<string, unknown> };
		};
		assert.equal(before.result.setup.hasModelConfig, false, "夹具没有 config/settings.json，必须如实说没有");
		assert.equal(before.result.setup.hasIdentity, false);
		assert.equal(before.result.setup.piAvailable, false, "SPRITE_NO_PI=1 时思考引擎不可用");
		assert.equal(typeof before.result.setup.configPath, "string");
		assert.deepEqual(before.result.setup.quietHours, { start: 0, end: 0 });
		// 读模型里绝不能出现密钥
		const serialized = JSON.stringify(before.result.setup);
		assert.ok(!serialized.includes("sk-"), "读模型不得包含任何密钥痕迹");
		assert.ok(!/api[_-]?key"\s*:\s*"[^"]+"/i.test(serialized), "读模型不得回传密钥字段的值");

		// 补上配置后重启内核：必须变成"已就绪"。
		// v3 只有一个来源：`config/settings.json`（旧的 llm.conf 不再认——
		// 数据在 2026-09-18 迁进 settings.json，之后兼容代码一并删掉了）。
		fs.mkdirSync(path.join(fixture.home, "config"), { recursive: true });
		fs.writeFileSync(
			path.join(fixture.home, "config", "settings.json"),
			JSON.stringify({
				model: { mode: "provider", provider: "deepseek", model: "some-model", apiKey: "sk-should-never-appear" },
				quietHours: { start: 0, end: 0 },
			}),
		);
		fs.writeFileSync(path.join(fixture.home, "identity.md"), "# 我是谁\n\n我叫测试。\n");
	} finally {
		await stop(child);
	}

	const second = launch(fixture);
	try {
		await waitFor(() => fs.existsSync(fixture.socketPath), 15_000, "内核二次就绪");
		const after = (await rpcCall(fixture.socketPath, { id: "s2", type: "query.snapshot" })) as {
			result: { setup: Record<string, unknown> };
		};
		assert.equal(after.result.setup.hasModelConfig, true, "写了 PI_MODEL 之后必须报告已配置");
		assert.equal(after.result.setup.hasIdentity, true);
		const serialized = JSON.stringify(after.result.setup);
		assert.ok(!serialized.includes("sk-should-never-appear"), `读模型泄漏了密钥: ${serialized}`);
	} finally {
		await stop(second.child);
	}
});

test("冒烟：重启后不丢、不重，且锁能接管", async () => {
	const fixture = makeFixture("main-restart");
	const first = launch(fixture);
	try {
		await waitFor(() => fs.existsSync(fixture.socketPath), 15_000, "首次启动");
		await rpcCall(fixture.socketPath, {
			id: "r1",
			type: "command",
			command: { id: "restart-1", type: "message.send", text: "重启前的留言" },
		});
	} finally {
		await stop(first.child);
	}

	const second = launch(fixture);
	try {
		await waitFor(() => fs.existsSync(fixture.socketPath), 15_000, "二次启动");
		const status = (await rpcCall(fixture.socketPath, { id: "s3", type: "query.status" })) as {
			ok: boolean;
			result: { messages: Array<{ text: string }>; failures: string[] };
		};
		assert.equal(status.ok, true, "重启后必须能接管锁并服务");
		const texts = status.result.messages.map((message) => message.text);
		assert.equal(texts.filter((text) => text === "重启前的留言").length, 1, "留言不得重复");

		// 重启后重投同一幂等键仍判重
		const replay = (await rpcCall(fixture.socketPath, {
			id: "r2",
			type: "command",
			command: { id: "restart-1", type: "message.send", text: "重启前的留言" },
		})) as { result: { duplicate: boolean } };
		assert.equal(replay.result.duplicate, true, "跨重启幂等必须成立");
	} finally {
		await stop(second.child);
	}
});

test("显式叫醒越过安静时段：用户的意图高于日程，自动呼吸照旧遵守", async () => {
	const fixture = makeFixture("quiet-override");
	// "除了当前这一小时，全天都算安静时段"——这样测试在任何时刻跑都成立（不能靠固定小时赌）
	// 用上海小时（产品语义）：本地小时在别的时区会算错窗口（CI 上翻过车）
	const currentHour = hourInShanghai(new Date());
	// 让"现在"落进安静时段：跨夜形式 start > end 时，hour >= start 即为安静。
	// start = 当前小时、end = 当前小时 - 1 ⇒ 任何时刻跑都是安静的。
	const quietStart = currentHour;
	const quietEnd = (currentHour + 23) % 24;
	const { child } = launch(fixture, { SPRITE_QUIET_START: String(quietStart), SPRITE_QUIET_END: String(quietEnd) });
	try {
		await waitFor(() => fs.existsSync(fixture.socketPath), 15_000, "socket 出现");

		// 留言：安静时段里必须**推迟**（如实入库，不吵醒它）
		const message = (await rpcCall(fixture.socketPath, {
			id: "req-m",
			type: "command",
			command: { id: "q-1", type: "message.send", text: "安静时段里的一句留言" },
		})) as { ok: boolean; result: { deferred: boolean } };
		assert.equal(message.result.deferred, true, "安静时段里普通留言应当推迟");

		// 显式叫醒：必须真的叫醒（返回 overrodeQuiet，且不推迟）
		const wake = (await rpcCall(fixture.socketPath, {
			id: "req-w",
			type: "command",
			command: { id: "q-2", type: "wake.now" },
		})) as { ok: boolean; result: { deferred: boolean; overrodeQuiet?: boolean } };
		assert.equal(wake.result.deferred, false, "显式叫醒不得被安静时段挡回去");
		assert.equal(wake.result.overrodeQuiet, true, "要如实告诉调用方：这次是越过了安静时段");

		// 日志里要有这次"在安静时段里发生的呼吸"的记录（不撒谎：能查得到）
		await waitFor(
			() =>
				fs
					.readdirSync(path.join(fixture.home, "journal"))
					.filter((name) => name.endsWith(".jsonl"))
					.some((name) => {
						const text = fs.readFileSync(path.join(fixture.home, "journal", name), "utf8");
						return text.includes('"trigger":"wake"') && text.includes('"quiet":true');
					}),
			8000,
			"run.started(trigger=wake, quiet=true)",
		);
	} finally {
		await stop(child);
	}
});
