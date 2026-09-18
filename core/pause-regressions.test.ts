/**
 * 2026-09-14 的现场回归：它"什么都没做，只是在睡觉"。
 *
 * 真实事故（三天的日志摆在一起才看清）：
 *   1. 09-11 的旧代码在"安静时段改动"时写了 `breath.paused{settingsChange:true}`
 *      （**不是**用户在暂停，是旧实现的坏行为；B3 修复只是不再写它）。
 *   2. `restorePause()` 只扫"最近一条暂停/继续"，于是每次重启都把这条旧事件读成
 *      **无限期暂停** → 09-12 重启后它一直以为自己是暂停状态。
 *   3. 暂停期间内核照样每 5 分钟问一次模型（两天 488 次空转），而收尾时又把 presence
 *      写成 quiet/breathing——界面显示"安静"，用户根本看不出它被暂停了。
 *
 * 运行：node --test core/pause-regressions.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { openJournal } from "./journal.ts";
import { startKernel } from "./main.ts";
import { rpcCall } from "./rpc/server.ts";

const ROOT = path.join(process.cwd(), ".core-test");

function makeHome(name: string): string {
	const home = path.join(ROOT, name);
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), "");
	return home;
}

/** 往日志里塞一条 09-11 那种旧格式的暂停事件（真实日志里就是这么写的） */
function writeLegacyPause(home: string, seq = 1): void {
	const dir = path.join(home, "journal");
	fs.mkdirSync(dir, { recursive: true });
	const event = {
		seq,
		at: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
		type: "breath.paused",
		// 注意：没有 mode 字段（新格式才有），而且带着 settingsChange
		data: { reason: "安静时段改为 23:00–7:00", settingsChange: true },
	};
	fs.writeFileSync(path.join(dir, "2026-09-11.jsonl"), `${JSON.stringify(event)}\n`);
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

/** 写一个"永远成功、立刻结束"的假引擎；可选把每次 prompt 记进日志 */
function writeFakePi(home: string, promptLog?: string): string {
	const fakePi = path.join(home, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		[
			"#!/usr/bin/env node",
			"import fs from 'node:fs';",
			"process.stdin.setEncoding('utf8');",
			"let buf = '';",
			"process.stdin.on('data', (chunk) => {",
			"  buf += chunk;",
			"  let i;",
			"  while ((i = buf.indexOf('\\n')) >= 0) {",
			"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
			"    if (!line.trim()) continue;",
			"    const request = JSON.parse(line);",
			promptLog ? `    if (request.type === 'prompt') fs.appendFileSync(${JSON.stringify(promptLog)}, 'prompt\\n');` : "",
			"    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n');",
			"    if (request.type === 'prompt') process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');",
			"  }",
			"});",
		]
			.filter((line) => line !== "")
			.join("\n"),
		{ mode: 0o755 },
	);
	return fakePi;
}

test("旧格式的 settingsChange 暂停不得复活：重启后它照样呼吸", { timeout: 60_000 }, async () => {
	const home = makeHome("pause-legacy");
	writeLegacyPause(home);
	const kernel = await startKernel({
		homeDir: home,
		piBin: writeFakePi(home),
		intervalMs: 400,
		quietHours: { start: 0, end: 0 }, // 全天不安静，便于观察
		fsync: false,
		log: () => {},
	});
	try {
		for (let i = 0; i < 60 && !kernel.journal.events.some((event) => event.type === "run.started"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const scheduled = kernel.journal.events.filter((event) => event.type === "breath.scheduled");
		assert.ok(scheduled.length > 0, "应当排期");
		const pausedPlans = scheduled.filter((event) => event.data.reason === "paused");
		assert.equal(
			pausedPlans.length,
			0,
			`旧实现把 settingsChange 的暂停读成了"无限期暂停"，于是每一拍都排成 paused（实际 ${pausedPlans.length} 拍）`,
		);
		const status = (await rpcCall(kernel.socketPath, { id: "s", type: "query.status" })) as {
			result: { presence: string };
		};
		assert.notEqual(status.result.presence, "paused", "它不该是暂停状态");
	} finally {
		await kernel.stop();
	}
});

test("暂停期间不许空转：定时拍不叫引擎，presence 如实是 paused", { timeout: 60_000 }, async () => {
	const home = makeHome("pause-noop");
	// 记录每一次 prompt：暂停时空转的表现就是引擎被反复叫醒
	const piLog = path.join(home, "pi-prompts.log");
	const fakePi = writeFakePi(home, piLog);

	const kernel = await startKernel({
		homeDir: home,
		piBin: fakePi,
		intervalMs: 300, // 故意很快：暂停时也不该有 prompt
		quietIntervalMs: 300,
		quietHours: { start: 0, end: 0 },
		fsync: false,
		log: () => {},
	});
	try {
		await call(kernel.socketPath, {
			id: "p",
			type: "command",
			command: { id: "pause-1", type: "breath.pause", until: null },
		});
		const promptsBefore = fs.existsSync(piLog) ? fs.readFileSync(piLog, "utf8").split("\n").filter(Boolean).length : 0;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		const promptsAfter = fs.existsSync(piLog) ? fs.readFileSync(piLog, "utf8").split("\n").filter(Boolean).length : 0;
		assert.equal(
			promptsAfter,
			promptsBefore,
			`暂停期间定时拍不得叫引擎（实测多叫了 ${promptsAfter - promptsBefore} 次；真实事故里两天空转 488 次）`,
		);
		const status = (await rpcCall(kernel.socketPath, { id: "s", type: "query.status" })) as {
			result: { presence: string };
		};
		assert.equal(status.result.presence, "paused", "暂停时 presence 必须如实是 paused，界面才知道该显示什么");
	} finally {
		await kernel.stop();
	}
});

test("日志按天轮转：跨过零点要写进新的一天的文件", () => {
	const dir = makeHome("journal-rotate");
	let clock = new Date("2026-09-14T02:00:00.000Z"); // 上海 10:00
	const journal = openJournal({ dir, exclusive: true, fsync: false, now: () => clock });
	journal.append("message.in", { text: "第一天的", source: "text" });
	clock = new Date("2026-09-14T17:00:00.000Z"); // 上海次日 01:00
	journal.append("message.in", { text: "第二天的", source: "text" });
	journal.close();

	const names = fs.readdirSync(path.join(dir, "journal")).filter((name) => name.endsWith(".jsonl")).sort();
	assert.equal(names.length, 2, `跨天必须换文件（实际：${names.join(", ")}）`);
	const [first, second] = names.map((name) => fs.readFileSync(path.join(dir, "journal", name), "utf8"));
	assert.match(first!, /第一天的/);
	assert.match(second!, /第二天的/);
	assert.doesNotMatch(first!, /第二天的/, "第二天的事件不得写进旧文件");
});
