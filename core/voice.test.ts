/**
 * 语音留言：音频落盘 + 事件 + 回读。
 *
 * 用户的原话（音频）和机器的理解（转写）必须一起存下来，并且能原样读回去播放。
 * 这里验证的是**字节一致**与**越权被拒**——不是"接口返回了 ok"。
 *
 * 运行：node --test core/voice.test.ts
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { rpcCall } from "./rpc/server.ts";

const ROOT = path.join(process.cwd(), ".core-test");
const MAIN = path.join(process.cwd(), "core", "main.ts");

async function waitFor<T>(predicate: () => T | undefined | false, timeoutMs = 15_000, label = "条件"): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = predicate();
		if (value) return value as T;
		if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}

type Fixture = { home: string; socketPath: string };

function makeFixture(name: string): Fixture {
	const home = path.join(ROOT, name);
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), "");
	return { home, socketPath: path.join(home, "runtime", "core.sock") };
}

function launch(fixture: Fixture): { child: ChildProcess; logs: string[] } {
	const logs: string[] = [];
	const child = spawn(process.execPath, [MAIN], {
		env: {
			...process.env,
			SPRITE_HOME: fixture.home,
			SPRITE_SOCKET: fixture.socketPath,
			SPRITE_NO_PI: "1",
			SPRITE_QUIET_START: "0",
			SPRITE_QUIET_END: "0",
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

test("语音留言：音频落盘、可原样读回、写不进去的路径读不出来", async () => {
	const fixture = makeFixture("voice-roundtrip");
	const { child, logs } = launch(fixture);
	const pid = process.pid;
	try {
		await waitFor(() => fs.existsSync(fixture.socketPath), 15_000, "socket 出现");

		// 一段"能当音频看"的字节：带长度的随机数据，逐字节比对才有意义
		const audio = crypto.randomBytes(4096);
		const commit = (id: string) =>
			rpcCall(fixture.socketPath, {
				id: `req-${id}`,
				type: "command",
				command: {
					id,
					type: "voice.commit",
					transcript: "这是一段被机器听写下来的原话。",
					audioBase64: audio.toString("base64"),
					mimeType: "audio/mp4",
					durationMs: 7420,
				},
			}) as Promise<{ ok: boolean; result: { duplicate: boolean; file?: string; bytes?: number } }>;

		const first = await commit("voice-1");
		assert.equal(first.ok, true, `提交失败：${JSON.stringify(first)}`);
		assert.equal(first.result.duplicate, false);
		assert.ok(first.result.file?.startsWith("voice/"), "必须在 voice/ 下落盘");

		// 重复投递：同一个 commandId 不得写出第二个文件，也不得写第二条事件
		const again = await commit("voice-1");
		assert.equal(again.result.duplicate, true, "重复投递必须判重");
		const files = fs.readdirSync(path.join(fixture.home, "voice"));
		assert.equal(files.length, 1, `重复投递不得产生第二个音频文件，实际 ${files.length} 个`);

		// 落盘的字节必须和用户说出口的一模一样
		const onDisk = fs.readFileSync(path.join(fixture.home, first.result.file!));
		assert.equal(onDisk.byteLength, audio.byteLength, "音频长度必须一致");
		assert.equal(crypto.createHash("sha256").update(onDisk).digest("hex"), crypto.createHash("sha256").update(audio).digest("hex"), "音频字节必须逐字节一致");

		// 原样读回（播放路径）
		const readBack = (await rpcCall(fixture.socketPath, {
			id: "req-audio",
			type: "query.audio",
			path: first.result.file!,
		})) as { ok: boolean; result: { base64: string; bytes: number; mimeType: string } };
		assert.equal(readBack.ok, true);
		assert.equal(readBack.result.bytes, audio.byteLength);
		assert.equal(readBack.result.base64, audio.toString("base64"), "读回来的音频必须能逐字节还原");
		assert.equal(readBack.result.mimeType, "audio/mp4");

		// 越权：日志、身份文件、路径穿越——一律拒绝
		for (const bad of ["journal/" + files[0], "context/identity.md", "voice/../../etc/hosts", "voice/x.txt"]) {
			const denied = (await rpcCall(fixture.socketPath, { id: `req-${bad}`, type: "query.audio", path: bad })) as { ok: boolean };
			assert.equal(denied.ok, false, `越权路径必须被拒绝：${bad}`);
		}

		// 记录窗口：语音条目带着时长与大小（用户要能看出"这条有多长"）
		const records = (await rpcCall(fixture.socketPath, { id: "req-records", type: "query.records", kind: "voice", limit: 10 })) as {
			ok: boolean;
			result: { entries: Array<Record<string, unknown>> };
		};
		assert.equal(records.ok, true, `records 失败：${JSON.stringify(records)}`);
		assert.equal(records.result.entries.length, 1, "一条语音就该是一条记录");
		const entry = records.result.entries[0]!;
		assert.equal(entry.text, "这是一段被机器听写下来的原话。", "记录里必须带转写文字");
		assert.match(String(entry.meta), /0:07/, "记录里必须带时长");
		assert.match(String(entry.meta), /4 KB/, "记录里必须带文件大小");
		assert.equal(entry.path, first.result.file, "记录必须指向音频文件（播放要用）");

		// 转写文字为空、只有音频：照样入库（用户按了录音但识别没听清，原话不能丢）
		const silent = (await rpcCall(fixture.socketPath, {
			id: "req-silent",
			type: "command",
			command: { id: "voice-2", type: "voice.commit", transcript: "", audioBase64: audio.subarray(0, 128).toString("base64"), mimeType: "audio/mp4" },
		})) as { ok: boolean; result: { file?: string } };
		assert.equal(silent.ok, true, "只有音频也必须能存");
		assert.ok(silent.result.file, "只有音频时同样要落盘");

		// 完全空的语音：拒绝，不能污染日志
		const empty = (await rpcCall(fixture.socketPath, {
			id: "req-empty",
			type: "command",
			command: { id: "voice-3", type: "voice.commit", transcript: "   " },
		})) as { ok: boolean; error?: string };
		assert.equal(empty.ok, false, "空语音必须被拒绝");

		// 内核必须如实记录：日志里两条 voice.recorded，没有多余事件
		const journalText = fs
			.readdirSync(path.join(fixture.home, "journal"))
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => fs.readFileSync(path.join(fixture.home, "journal", name), "utf8"))
			.join("");
		assert.equal(journalText.split('"voice.recorded"').length - 1, 2, "两次成功提交 = 两条事件");

		// 进程还活着（没有因为坏输入崩掉）
		assert.equal(child.exitCode, null, `内核不该退出：${logs.join("").slice(-400)}`);
	} finally {
		await stop(child);
		void pid;
	}
});

test("坏字符不得弄空整窗记录：孤立代理项必须被净化，而不是让整条响应作废", async () => {
	const home = path.join(ROOT, "surrogate-records");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(home, "thoughts"), { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), "");
	// 真实记忆里就有这种行：旧版本写下的不成对 UTF-16（\ud83d 单独出现）。
	// Swift 的 JSONDecoder 遇到它会**拒收整个响应**——58 天的记录一起变空白。
	fs.writeFileSync(
		path.join(home, "thoughts", "stream.jsonl"),
		['{"time":"2026-09-11T01:00:00Z","type":"breath","content":"正常的一句"}', '{"time":"2026-09-11T02:00:00Z","type":"breath","content":"坏字符：\\ud83d 后面没了"}'].join("\n") + "\n",
	);
	const child = spawn(process.execPath, [MAIN], {
		env: {
			...process.env,
			SPRITE_HOME: home,
			SPRITE_SOCKET: path.join(home, "runtime", "core.sock"),
			SPRITE_NO_PI: "1",
			SPRITE_QUIET_START: "0",
			SPRITE_QUIET_END: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		const socketPath = path.join(home, "runtime", "core.sock");
		await waitFor(() => fs.existsSync(socketPath), 15_000, "socket 出现");

		// 直接读原始响应：要验证的是**线上字节**里没有孤立代理项转义
		const raw = await new Promise<string>((resolve, reject) => {
			const socket = net.connect(socketPath);
			let buffer = "";
			socket.on("connect", () => socket.write(JSON.stringify({ id: "r1", type: "query.records", kind: "thoughts", limit: 60, protocolVersion: 1 }) + "\n"));
			socket.on("data", (chunk) => {
				buffer += chunk;
				if (buffer.includes("\n")) {
					socket.destroy();
					resolve(buffer.split("\n")[0]!);
				}
			});
			socket.on("error", reject);
		});
		assert.equal(/\\ud[89ab][0-9a-f]{2}/i.test(raw), false, `响应里不得出现孤立代理项转义：${raw.slice(0, 200)}`);
		assert.equal(/[^\x00-\x7f]/.test(raw.slice(0, 0)), false);
		const parsed = JSON.parse(raw) as { ok: boolean; result: { entries: Array<{ text: string }> } };
		assert.equal(parsed.ok, true);
		assert.equal(parsed.result.entries.length, 1, "一天的记录必须在（不能因为一个坏字符整条响应作废）");
		assert.match(parsed.result.entries[0]!.text, /正常的一句/);
		assert.match(parsed.result.entries[0]!.text, /\uFFFD/, "坏字符要换成替换字符，而不是消失或逃逸出去");
	} finally {
		await stop(child);
	}
});

test("补写转写：只认日志里存在的那段语音，后写的覆盖先前的", async () => {
	const fixture = makeFixture("voice-transcript");
	const { child } = launch(fixture);
	try {
		await waitFor(() => fs.existsSync(fixture.socketPath), 15_000, "socket 出现");
		const audio = crypto.randomBytes(256);
		const commit = (await rpcCall(fixture.socketPath, {
			id: "req-v1",
			type: "command",
			command: { id: "v1", type: "voice.commit", transcript: "", audioBase64: audio.toString("base64"), mimeType: "audio/mp4", durationMs: 3000 },
		})) as { ok: boolean; result: { file?: string } };
		assert.equal(commit.ok, true);
		const file = commit.result.file!;

		// 凭空补写：日志里没有这个文件 → 拒绝（不能拿它当写文件的入口）
		const bogus = (await rpcCall(fixture.socketPath, {
			id: "req-bogus",
			type: "command",
			command: { id: "v2", type: "voice.transcript", file: "voice/不存在.m4a", transcript: "偷偷塞进来的话" },
		})) as { ok: boolean };
		assert.equal(bogus.ok, false, "不存在的语音文件必须被拒绝");
		const escape = (await rpcCall(fixture.socketPath, {
			id: "req-escape",
			type: "command",
			command: { id: "v3", type: "voice.transcript", file: "context/identity.md", transcript: "越界" },
		})) as { ok: boolean };
		assert.equal(escape.ok, false, "voice/ 之外的路径必须被拒绝");

		// 正式补写
		const fixed = (await rpcCall(fixture.socketPath, {
			id: "req-fix",
			type: "command",
			command: { id: "v4", type: "voice.transcript", file, transcript: "设备端没听出来，系统通道听出来的第一版" },
		})) as { ok: boolean };
		assert.equal(fixed.ok, true);
		const again = (await rpcCall(fixture.socketPath, {
			id: "req-fix2",
			type: "command",
			command: { id: "v4", type: "voice.transcript", file, transcript: "重复投递不该再写一条" },
		})) as { ok: boolean; result: { duplicate: boolean } };
		assert.equal(again.result.duplicate, true, "同一个 commandId 必须判重");

		const records = (await rpcCall(fixture.socketPath, { id: "req-r", type: "query.records", kind: "voice", limit: 5 })) as {
			result: { entries: Array<Record<string, unknown>> };
		};
		assert.equal(records.result.entries.length, 1, "补写不是新建——还是一条语音");
		assert.equal(records.result.entries[0]!.text, "设备端没听出来，系统通道听出来的第一版", "补写后的文字必须出现在记录里");

		// 再补一次（用户可能换通道重试）：最后一次算数
		await rpcCall(fixture.socketPath, {
			id: "req-fix3",
			type: "command",
			command: { id: "v5", type: "voice.transcript", file, transcript: "第二次重试的结果" },
		});
		const after = (await rpcCall(fixture.socketPath, { id: "req-r2", type: "query.records", kind: "voice", limit: 5 })) as {
			result: { entries: Array<Record<string, unknown>> };
		};
		assert.equal(after.result.entries[0]!.text, "第二次重试的结果", "后写的转写要覆盖先前的");
		assert.equal(after.result.entries.length, 1, "重试不该多出一条语音记录");
	} finally {
		await stop(child);
	}
});
