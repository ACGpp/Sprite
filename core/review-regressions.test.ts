/**
 * 代码评审（docs/review-v3-2026-09-12.md）里已复现缺陷的回归测试。
 *
 * 每一条都对应一个"真实会发生、而用户无从察觉"的失效：
 * 它起不来、它记不住、它睡不着。先有复现，再有修复，测试留在这里看着。
 *
 * 运行：node --test core/review-regressions.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { openJournal } from "./journal.ts";
import { startKernel, type Kernel } from "./main.ts";
import { rpcCall } from "./rpc/server.ts";
import { dayInShanghai, hourInShanghai } from "./text.ts";
import { isQuietAt } from "./scheduler.ts";

const ROOT = path.join(process.cwd(), ".core-test");

function makeHome(name: string): string {
	const home = path.join(ROOT, name);
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), "");
	return home;
}

function call(socketPath: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		let buffer = "";
		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.includes("\n")) {
				socket.destroy();
				resolve(JSON.parse(buffer.split("\n")[0]!) as Record<string, unknown>);
			}
		});
		socket.on("error", reject);
	});
}

/** 这一小时之外都算安静时段：保证测试在任何时刻跑都成立 */
function notQuietNow(): { start: number; end: number } {
	const hour = hourInShanghai(new Date());
	return { start: (hour + 1) % 24, end: hour };
}

/** 现在这一刻算安静时段：start = 当前小时，end = 当前小时 - 1（跨夜形式） */
function quietNowHours(): { start: number; end: number } {
	const hour = hourInShanghai(new Date());
	return { start: hour, end: (hour + 23) % 24 };
}

/**
 * 从**磁盘上的日志**读出所有 run.started 的 data（真相来源，不读内存窗口）。
 * 窗口是缓存，测试要验的是"这件事到底有没有发生"。
 */
function readRunStarts(home: string): Array<Record<string, unknown>> {
	const dir = path.join(home, "journal");
	const runs: Array<Record<string, unknown>> = [];
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return runs;
	}
	for (const name of names) {
		for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
			if (!line.includes('"run.started"')) continue;
			try {
				runs.push((JSON.parse(line) as { data: Record<string, unknown> }).data);
			} catch {
				// 半行跳过
			}
		}
	}
	return runs;
}

// ─── B1：一行写坏的时间不得让内核起不来 ───

test("B1 坏时间不让内核起不来：原样保留该行，其余照常导入", async () => {
	const home = makeHome("review-b1");
	fs.writeFileSync(
		path.join(home, "conversations", "mailbox.md"),
		[
			"[2026/06/20 18:39] 零号: 正常的一行",
			"[2026/09/11 24:30] 用户: 小时写成了 24",
			"[2026/13/45 99:99] 用户: 月日时分全错",
			"[2026/02/30 10:00] 用户: 二月三十号（不报错但会滚到三月）",
		].join("\n") + "\n",
	);
	const kernel: Kernel = await startKernel({
		homeDir: home,
		disableAgent: true,
		intervalMs: 3_600_000,
		quietHours: { start: 0, end: 0 },
		fsync: false,
		log: () => {},
	});
	try {
		const messages = kernel.journal.events.filter((event) => event.type === "message.out" || event.type === "message.in");
		assert.equal(messages.length, 1, "合法的那一行要正常导入");
		const raw = kernel.journal.events.filter((event) => event.type === "legacy.imported" && typeof event.data.raw === "string");
		assert.equal(raw.length, 3, "三行坏时间必须原样留着（不能丢用户的记忆）");
		assert.match(String(raw[0]!.data.raw), /24:30/);
	} finally {
		await kernel.stop();
	}
});

// ─── B2：尾部读不出 seq 时不许跳过整个文件 ───

test("B2 最后一行超过 8KB 时，带检查点重启不得跳过这一整天", () => {
	const dir = path.join(ROOT, "review-b2");
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, "journal"), { recursive: true });
	const write = (day: string, events: Array<Record<string, unknown>>) => {
		fs.writeFileSync(path.join(dir, "journal", `${day}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
	};
	const ev = (seq: number, day: string, text: string) => ({ seq, at: `${day}T00:00:00.000Z`, type: "thought.recorded", data: { text } });
	write("2026-09-10", Array.from({ length: 20 }, (_, i) => ev(i + 1, "2026-09-10", `天1-${i + 1}`)));
	write("2026-09-11", [ev(21, "2026-09-11", "天2-21"), ev(22, "2026-09-11", "天2-22"), ev(31, "2026-09-11", `很长：${"字".repeat(9000)}`)]);

	let journal = openJournal({ dir, exclusive: true, fsync: false, checkpointPayload: () => ({ probe: "b2" }) });
	assert.equal(journal.seq, 31);
	assert.equal(journal.writeCheckpoint(), true, "检查点要写成功（模拟崩在检查点之前的那种状态）");
	journal.close();

	journal = openJournal({ dir, exclusive: true, fsync: false });
	try {
		assert.equal(journal.seq, 31, "seq 不许回退（老实现会退到 20）");
		assert.ok(
			journal.events.some((event) => event.type === "thought.recorded" && String(event.data.text).startsWith("天2-")),
			"天2 的事件必须可见（老实现整份文件被跳过）",
		);
	} finally {
		journal.close();
	}
});

// ─── B3：暂停跨重启存活 ───

test("B3 暂停跨重启存活：'直到我说继续'不能在重启后失效", async () => {
	const home = makeHome("review-b3");
	const options = {
		homeDir: home,
		disableAgent: true,
		intervalMs: 3_600_000,
		quietHours: { start: 0, end: 0 },
		fsync: false,
		log: () => {},
	};
	let kernel = await startKernel(options);
	await call(kernel.socketPath, { id: "p", type: "command", command: { id: "pause-1", type: "breath.pause", until: "manual" } });
	await kernel.stop();

	// 重启：暂停必须还在（它写在日志里，不能只活在内存里）
	kernel = await startKernel(options);
	try {
		const sent = (await call(kernel.socketPath, { id: "m", type: "command", command: { id: "msg-1", type: "message.send", text: "重启后说的话" } })) as {
			result: { deferred: boolean };
		};
		assert.equal(sent.result.deferred, true, "暂停还在 → 留言必须被如实延后，而不是把它叫醒");
		// 继续之后就该醒
		await call(kernel.socketPath, { id: "r", type: "command", command: { id: "resume-1", type: "breath.resume" } });
		const after = (await call(kernel.socketPath, { id: "m2", type: "command", command: { id: "msg-2", type: "message.send", text: "继续之后说的话" } })) as {
			result: { deferred: boolean };
		};
		assert.equal(after.result.deferred, false, "继续之后不该再延后");
	} finally {
		await kernel.stop();
	}
});

// ─── M4：提示词没送到，留言要回到待处理 ───

test("M4 引擎没收到这句话时，留言回到待处理（不能被静默吞掉）", async () => {
	const home = makeHome("review-m4");
	// 假引擎：收到 prompt 直接回失败 → 内核会记 run.failed(delivered:false)
	const fakePi = path.join(home, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		[
			"#!/usr/bin/env node",
			"process.stdin.setEncoding('utf8');",
			"let buf = '';",
			"process.stdin.on('data', (chunk) => {",
			"  buf += chunk;",
			"  let i;",
			"  while ((i = buf.indexOf('\\n')) >= 0) {",
			"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
			"    if (!line.trim()) continue;",
			"    const request = JSON.parse(line);",
			"    if (request.type === 'prompt') {",
			"      process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: false, error: '模型拒绝' }) + '\\n');",
			"    } else {",
			"      process.stdout.write(JSON.stringify({ id: request.id, success: true }) + '\\n');",
			"    }",
			"  }",
			"});",
		].join("\n"),
		{ mode: 0o755 },
	);

	const kernel = await startKernel({
		homeDir: home,
		piBin: fakePi,
		piArgs: [],
		intervalMs: 3_600_000,
		quietHours: { start: 0, end: 0 },
		fsync: false,
		log: () => {},
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, 800));
		await call(kernel.socketPath, { id: "m", type: "command", command: { id: "msg-1", type: "message.send", text: "它根本没看到的这句话" } });
		// 等这一拍失败
		for (let i = 0; i < 40; i += 1) {
			if (kernel.journal.events.some((event) => event.type === "run.failed")) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const failed = kernel.journal.events.find((event) => event.type === "run.failed");
		assert.ok(failed, "这一拍应当失败");
		assert.equal(failed!.data.delivered, false, "要如实记下'没送到'");
		const status = (await rpcCall(kernel.socketPath, { id: "s", type: "query.status" })) as {
			result: { pendingMessages: Array<{ text: string }> };
		};
		assert.equal(status.result.pendingMessages.length, 1, "留言必须回到待处理——否则用户的话被静默吞掉");
		assert.match(status.result.pendingMessages[0]!.text, /没看到/);

		// 失败也**不能**变成贴着重试的热循环：引擎整段拒绝（key 失效、provider 挂了）时，
		// 曾经的实现每 50ms 就补一拍，几十秒能刷出上百条 run.started 并把对方打满。
		// 正确行为：交给调度器的指数退避（60s 起），这句话在退避期间一直躺在待处理里。
		const startedWhenFailed = kernel.journal.events.filter((event) => event.type === "run.started").length;
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const startedAfterWait = kernel.journal.events.filter((event) => event.type === "run.started").length;
		assert.equal(startedAfterWait, startedWhenFailed, "失败后不许贴着重试：下一拍要走退避");
		const stillPending = (await rpcCall(kernel.socketPath, { id: "s2", type: "query.status" })) as {
			result: { pendingMessages: Array<{ text: string }> };
		};
		assert.equal(stillPending.result.pendingMessages.length, 1, "退避期间这句话依然在待处理队列里（没丢）");
	} finally {
		await kernel.stop();
	}
});

// ─── M6：安静时段按 Asia/Shanghai，不随机器时区变 ───

test("M6 安静时段是产品语义：机器时区变了也按上海时间判断", () => {
	// 2026-09-11 15:30 UTC = 上海 23:30（该安静）；纽约 11:30（当地不安静）
	const moment = new Date("2026-09-11T15:30:00.000Z");
	assert.equal(hourInShanghai(moment), 23, "上海小时数必须算对");
	assert.equal(isQuietAt(moment, { start: 23, end: 7 }), true, "上海 23:30 应当安静");
	// 上海 12:00（UTC 04:00）不该安静
	assert.equal(isQuietAt(new Date("2026-09-11T04:00:00.000Z"), { start: 23, end: 7 }), false);
	assert.equal(dayInShanghai(new Date("2026-09-11T16:30:00.000Z")), "2026-09-12", "UTC 16:30 已经是上海的第二天");
});

// ─── M1：主动额度按上海日重置 ───

test("M1 主动额度按上海日重置，不是永不重置", async () => {
	const home = makeHome("review-m1");
	fs.mkdirSync(path.join(home, "config"), { recursive: true });
	fs.writeFileSync(
		path.join(home, "config", "settings.json"),
		JSON.stringify({
			model: { mode: "provider", provider: "deepseek", model: "deepseek-chat" },
			quietHours: notQuietNow(),
			proactive: { enabled: true, perDay: 1 },
		}),
	);
	// 昨天（上海日）已经主动说过 3 次 → 今天不该受影响
	const yesterday = dayInShanghai(new Date(Date.now() - 24 * 3600_000));
	fs.mkdirSync(path.join(home, "journal"), { recursive: true });
	fs.writeFileSync(
		path.join(home, "journal", `${yesterday}.jsonl`),
		[1, 2, 3]
			.map((n) =>
				JSON.stringify({
					seq: n,
					at: `${yesterday}T00:0${n}:00.000Z`,
					type: "message.out",
					data: { text: `昨天主动说的第 ${n} 句`, channel: "bubble", origin: "timer" },
				}),
			)
			.join("\n") + "\n",
	);

	const kernel = await startKernel({
		homeDir: home,
		disableAgent: true,
		intervalMs: 3_600_000,
		quietHours: notQuietNow(),
		fsync: false,
		log: () => {},
	});
	try {
		const gateway = path.join(home, "runtime", "gateway.sock");
		const said = (await call(gateway, { kind: "capability.say", text: "今天的第一句" })) as { delivered?: string; reason?: string };
		assert.equal(said.delivered, "bubble", `昨天的额度不该算到今天：${JSON.stringify(said)}`);
	} finally {
		await kernel.stop();
	}
});

// ─── M3：取观察阶段抛错不许把它卡死 ───

test("M3 观察阶段抛错之后还能继续呼吸（running 必须归位）", async () => {
	const home = makeHome("review-m3");
	// 需要真的有引擎（哪怕是假的）：observationExtras 只在 breath.run 里被调用
	const fakePi = path.join(home, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		[
			"#!/usr/bin/env node",
			"process.stdin.setEncoding('utf8');",
			"let buf = '';",
			"process.stdin.on('data', (chunk) => {",
			"  buf += chunk;",
			"  let i;",
			"  while ((i = buf.indexOf('\\n')) >= 0) {",
			"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
			"    if (!line.trim()) continue;",
			"    const request = JSON.parse(line);",
			"    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n');",
			"  }",
			"});",
		].join("\n"),
		{ mode: 0o755 },
	);

	let throwOnce = true;
	const kernel = await startKernel({
		homeDir: home,
		piBin: fakePi,
		piArgs: [],
		intervalMs: 400,
		quietHours: { start: 0, end: 0 },
		fsync: false,
		// 注入一次"取观察阶段抛错"：老写法里 running=true 在 try 之外，
		// 这一抛会让它**永远**不再呼吸，而且没有任何自愈
		observationExtras: () => {
			if (throwOnce) {
				throwOnce = false;
				throw new Error("注入的观察期异常");
			}
			return {};
		},
		log: () => {},
	});
	try {
		// 第一次抛错必须留痕
		for (let i = 0; i < 40 && !kernel.journal.events.some((event) => event.data.code === "breath.prepare"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(
			kernel.journal.events.some((event) => event.data.code === "breath.prepare"),
			"观察期抛错要如实记一条 system.problem（breath.prepare）",
		);
		// 关键：抛错之后它还能被叫醒并真的跑起来（说明 running 已归位）。
		// 注意别等"自动下一拍"：失败会触发退避（400ms → 60s），那是设计；
		// 这里用显式叫醒来验证 running 没卡住。
		const prepareAt = kernel.journal.events.find((event) => event.data.code === "breath.prepare")!.seq;
		await call(kernel.socketPath, { id: "w", type: "command", command: { id: "wake-1", type: "wake.now" } });
		for (let i = 0; i < 40 && !kernel.journal.events.some((event) => event.type === "run.started" && event.seq > prepareAt); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const after = kernel.journal.events.filter((event) => event.type === "run.started" && event.seq > prepareAt);
		assert.ok(after.length >= 1, "抛错之后必须还能被叫醒并跑起来——老实现会永久卡在 running=true");
	} finally {
		await kernel.stop();
	}
});

// ─── M2：导入要么全成、要么从中断处接着导（不许重复，也不许丢） ───

test("M2 导入崩在中途：重启从断点接着导，不重复也不丢", async () => {
	const home = makeHome("review-m2");
	// 12 行留言
	const lines = Array.from({ length: 12 }, (_, i) => `[2026/09/11 1${i % 10}:00] 用户: 第 ${i} 行`);
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), `${lines.join("\n")}\n`);

	const { openJournal } = await import("./journal.ts");
	const { importLegacy, mailboxSource } = await import("./importer.ts");

	// 模拟"上次导入到第 5 行时崩了"：前 5 条事件已经写进日志，但游标还没写
	const journal = openJournal({ dir: home, exclusive: true, fsync: false });
	const head = mailboxSource.parse(`${lines.slice(0, 5).join("\n")}\n`, 0);
	for (const item of head) journal.append(item.type, item.data, undefined);
	assert.equal(
		journal.events.filter((event) => event.type === "message.in").length,
		5,
		"先造出'写到一半'的现场",
	);
	assert.equal(journal.importedLineFor("mailbox"), 4, "已导入的绝对行号要能读回来");

	// 第二次启动：应该从第 5 行接着导（不是整段重来）
	const reports = importLegacy(home, journal);
	const imported = journal.events.filter((event) => event.type === "message.in" || event.type === "message.out");
	const texts = imported.map((event) => String(event.data.text));
	assert.equal(texts.length, 12, `一共 12 行，导完应当是 12 条（实际 ${texts.length}）`);
	assert.equal(new Set(texts).size, 12, "不许有重复导入的留言");
	assert.ok(reports.some((report) => report.events > 0), "应当有增量导入");
	assert.ok(
		journal.events.some((event) => event.data.code === "legacy.import.resume"),
		"从中断处续导要如实留痕（legacy.import.resume）",
	);

	// 再跑一次：完全幂等
	const again = importLegacy(home, journal);
	assert.equal(
		journal.events.filter((event) => event.type === "message.in" || event.type === "message.out").length,
		12,
		"重复导入不得新增任何留言",
	);
	assert.ok(again.every((report) => report.events === 0), "第二次不该再导入任何东西");
	journal.close();
});

// ─── M7：安静时段收着的话，早上要交回去（不能只躺在日志里） ───

test("M7 安静时段收着的话，早上摆回它面前", async () => {
	const { buildObservation } = await import("./breath.ts");
	const night = new Date("2026-09-11T15:30:00.000Z"); // 上海 23:30
	const morning = new Date("2026-09-11T23:30:00.000Z"); // 上海次日 07:30

	// 夜里（安静时段）：不该把"收着的话"摆出来（那会诱导它在安静时段说话）
	const quietPrompt = buildObservation({ pending: [], quiet: true, at: night, heldBack: ["夜里想说的一句"] });
	assert.equal(quietPrompt.includes("夜里想说的一句"), false, "安静时段不该把话摆出来");

	// 早上（非安静 + 安静刚结束）：必须摆出来，并明确"可以说"
	const morningPrompt = buildObservation({
		pending: [],
		quiet: false,
		at: morning,
		heldBack: ["夜里想说的一句", "还有第二句"],
		nudge: "安静时段刚结束。你昨夜收着的那几句在下面——想说就说，不想说也留着。",
	});
	assert.match(morningPrompt, /安静时段里你收着这几句/, "要有一段把收着的话列出来");
	assert.match(morningPrompt, /- 夜里想说的一句/);
	assert.match(morningPrompt, /- 还有第二句/);
	assert.match(morningPrompt, /安静时段刚结束/, "要有由头提示");
	assert.match(morningPrompt, /最近用户留言/, "原有的观察不能少");

	// 没有收着的话时，不能出现空标题
	const emptyPrompt = buildObservation({ pending: [], quiet: false, at: morning, heldBack: [] });
	assert.equal(emptyPrompt.includes("你收着这几句"), false, "没有收着的话就不该出现这一块");
});

// ─── M7（内核侧胶水）：安静结束后的第一拍，确实把收着的话交回去 ───

test("M7 内核胶水：安静时段收下的 digest，在安静结束后的第一拍被交回（run.started 里能看到）", { timeout: 60_000 }, async () => {
	const home = makeHome("review-m7-glue");
	// 假引擎：回成功，并立刻发 agent_end（让每一拍快速结束，不卡 120 秒超时）
	const fakePi = path.join(home, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		[
			"#!/usr/bin/env node",
			"process.stdin.setEncoding('utf8');",
			"let buf = '';",
			"process.stdin.on('data', (chunk) => {",
			"  buf += chunk;",
			"  let i;",
			"  while ((i = buf.indexOf('\\n')) >= 0) {",
			"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
			"    if (!line.trim()) continue;",
			"    const request = JSON.parse(line);",
			"    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n');",
			"    if (request.type === 'prompt') process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');",
			"  }",
			"});",
		].join("\n"),
		{ mode: 0o755 },
	);

	// 现在这一刻算安静时段：start = 当前小时，end = 当前小时 - 1（跨夜形式）
	const hour = hourInShanghai(new Date());
	const quietNow = { start: hour, end: (hour + 23) % 24 };
	fs.mkdirSync(path.join(home, "config"), { recursive: true });
	fs.writeFileSync(
		path.join(home, "config", "settings.json"),
		JSON.stringify({
			model: { mode: "provider", provider: "deepseek", model: "deepseek-chat" },
			quietHours: quietNow,
			proactive: { enabled: true, perDay: 5 },
		}),
	);

	const kernel = await startKernel({
		homeDir: home,
		piBin: fakePi,
		// 定时拍故意放得很远：这个测试要**自己控制每一拍**，
		// 否则"翻转安静时段"的瞬间可能正好有一拍在飞，它的后处理会把
		// "上一拍是否安静"覆盖成 false——测试就会随机失败（评审教训：测试里的时序假设也要写清楚）。
		intervalMs: 3_600_000,
		quietIntervalMs: 300,
		quietHours: quietNow,
		fsync: false,
		log: () => {},
	});
	try {
		const quietBreath = () =>
			kernel.journal.events.some((event) => event.type === "run.started" && event.data.quiet === true && event.data.trigger === "timer");
		for (let i = 0; i < 60 && !quietBreath(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
		assert.ok(quietBreath(), "先要有一拍在安静时段里跑过（记下安静开始的时刻）");

		// 安静时段里它想说一句 → 内核收成 digest
		const gateway = path.join(home, "runtime", "gateway.sock");
		const said = (await call(gateway, { kind: "capability.say", text: "夜里收着的一句" })) as { delivered?: string };
		assert.equal(said.delivered, "digest", "安静时段应该收成 digest");

		// 安静结束（改设置）+ 显式叫醒 → 这一拍必须把收着的话交回去
		await call(kernel.socketPath, {
			id: "q",
			type: "command",
			command: { id: "quiet-off", type: "settings.update", patch: { quietHours: notQuietNow() } },
		});
		await call(kernel.socketPath, { id: "w", type: "command", command: { id: "wake-glue", type: "wake.now" } });
		const readRuns = () => readRunStarts(home);
		for (let i = 0; i < 100; i += 1) {
			if (readRuns().some((data) => Number(data.heldBack ?? 0) > 0)) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const handedBack = readRuns().filter((data) => Number(data.heldBack ?? 0) > 0);
		assert.equal(
			handedBack.length,
			1,
			`安静结束后的第一拍要把收着的 1 句话交回去（实际 ${handedBack.length} 拍；所有拍的 heldBack = ${JSON.stringify(readRuns().map((d) => d.heldBack))}）`,
		);
		assert.match(String(handedBack[0]!.nudge ?? ""), /安静时段刚结束/, "由头也要在");
	} finally {
		await kernel.stop();
	}
});

// ─── M7（竞态）：唤醒撞上正在飞的安静那一拍，不能把"安静起点"抹掉 ───

test("M7 竞态：唤醒在安静那一拍飞行途中被拒，收着的话照样交回", { timeout: 60_000 }, async () => {
	const home = makeHome("review-m7-busy");
	// 假引擎：prompt 慢 800ms 才回 —— 让安静那一拍**确实在飞行**，
	// 测试随后发的那次唤醒必然撞上它（这就是实测抓到的竞态现场：
	// 被 busy 拒掉的那一拍曾经照样写 quietStartedAt = null / lastBreathQuiet，
	// 于是正在跑的那一拍收尾时"收着的话"已经找不到窗口，早上交不回去）。
	const fakePi = path.join(home, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		[
			"#!/usr/bin/env node",
			"process.stdin.setEncoding('utf8');",
			"let buf = '';",
			"process.stdin.on('data', (chunk) => {",
			"  buf += chunk;",
			"  let i;",
			"  while ((i = buf.indexOf('\\n')) >= 0) {",
			"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
			"    if (!line.trim()) continue;",
			"    const request = JSON.parse(line);",
			"    if (request.type === 'prompt') {",
			"      setTimeout(() => {",
			"        process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n');",
			"        process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');",
			"      }, 800);",
			"    } else {",
			"      process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n');",
			"    }",
			"  }",
			"});",
		].join("\n"),
		{ mode: 0o755 },
	);

	const quietNow = quietNowHours();
	fs.mkdirSync(path.join(home, "config"), { recursive: true });
	fs.writeFileSync(
		path.join(home, "config", "settings.json"),
		JSON.stringify({
			model: { mode: "provider", provider: "deepseek", model: "deepseek-chat" },
			quietHours: quietNow,
			proactive: { enabled: true, perDay: 5 },
		}),
	);

	const kernel = await startKernel({
		homeDir: home,
		piBin: fakePi,
		intervalMs: 3_600_000,
		quietIntervalMs: 300,
		quietHours: quietNow,
		fsync: false,
		log: () => {},
	});
	try {
		// 等安静那一拍**真的开始跑**（run.started 落盘时它的 prompt 正在引擎里飞）
		const startedQuiet = () =>
			kernel.journal.events.some((event) => event.type === "run.started" && event.data.quiet === true && event.data.trigger === "timer");
		for (let i = 0; i < 200 && !startedQuiet(); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.ok(startedQuiet(), "先要有一拍在安静时段里跑起来");

		// 它想说的话 → 内核收成 digest（安静时段）
		const gateway = path.join(home, "runtime", "gateway.sock");
		const said = (await call(gateway, { kind: "capability.say", text: "被唤醒撞掉的那一句" })) as { delivered?: string };
		assert.equal(said.delivered, "digest", "安静时段应该收成 digest");

		// 那一拍还在飞：翻转安静时段 + 叫醒 → 这次唤醒必然被 busy 拒
		await call(kernel.socketPath, {
			id: "q",
			type: "command",
			command: { id: "quiet-off", type: "settings.update", patch: { quietHours: notQuietNow() } },
		});
		await call(kernel.socketPath, { id: "w", type: "command", command: { id: "wake-busy", type: "wake.now" } });

		for (let i = 0; i < 200; i += 1) {
			if (readRunStarts(home).some((data) => Number(data.heldBack ?? 0) > 0)) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const runs = readRunStarts(home);
		const handedBack = runs.filter((data) => Number(data.heldBack ?? 0) > 0);
		assert.equal(
			handedBack.length,
			1,
			`被拒的唤醒不得吃掉夜里收着的那句话（实际 ${handedBack.length} 拍交回；所有拍 heldBack = ${JSON.stringify(runs.map((d) => d.heldBack))}）`,
		);
		assert.equal(handedBack[0]!.trigger, "recovered-queue", "应当由那一拍结束后的补跑交回");
		assert.match(String(handedBack[0]!.nudge ?? ""), /安静时段刚结束/);
	} finally {
		await kernel.stop();
	}
});
