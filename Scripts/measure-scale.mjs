/**
 * 规模测量：记忆变老之后，内核还能不能轻快地起来。
 *
 * 一个 5 分钟一拍的守护灵，一天约 2000 条事件、一年约 70 万条。
 * 内核启动时会把 journal 全部读进内存并折叠成读模型——这个设计在"几年"尺度上是否成立，
 * 只能靠量，不能靠猜。
 *
 * 用法：node Scripts/measure-scale.mjs [事件数] [天数]
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const TOTAL_EVENTS = Number(process.argv[2] ?? 50_000);
const DAYS = Number(process.argv[3] ?? 30);
const WORK = path.join(ROOT, ".core-test", "scale");

// ─── 1. 造一份"活了很久"的 journal ───

function generate() {
	fs.rmSync(WORK, { recursive: true, force: true });
	fs.mkdirSync(path.join(WORK, "journal"), { recursive: true });
	fs.mkdirSync(path.join(WORK, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(WORK, "thoughts"), { recursive: true });
	fs.writeFileSync(path.join(WORK, "conversations", "mailbox.md"), "");
	fs.writeFileSync(path.join(WORK, "thoughts", "stream.jsonl"), "");

	const perDay = Math.ceil(TOTAL_EVENTS / DAYS);
	const start = new Date("2024-01-01T00:00:00Z").getTime();
	const chunk = [];
	let seq = 0;
	for (let day = 0; day < DAYS; day++) {
		const dayStart = start + day * 86_400_000;
		const stamp = new Date(dayStart).toISOString().slice(0, 10);
		for (let i = 0; i < perDay; i++) {
			const at = new Date(dayStart + (i / perDay) * 86_400_000).toISOString();
			// 真实配比：多数是呼吸与工具活动，少量对话与思维
			const roll = i % 10;
			seq += 1;
			if (roll === 0) {
				chunk.push(JSON.stringify({ seq, at, type: "run.started", data: { trigger: "timer", runId: `run-${seq}` } }));
			} else if (roll === 1 || roll === 2) {
				chunk.push(JSON.stringify({ seq, at, type: "run.activity", data: { kind: "tool", tool: "read", summary: `读 diary/${stamp}.md 的一段内容`, runId: `run-${seq}` } }));
			} else if (roll === 3) {
				chunk.push(JSON.stringify({ seq, at, type: "run.finished", data: { runId: `run-${seq}`, durationMs: 1200, activities: 2 } }));
			} else if (roll === 4) {
				chunk.push(JSON.stringify({ seq, at, type: "thought.recorded", data: { text: `${stamp} 醒来。今天读到的东西有点意思，先记一笔。`, runId: `run-${seq}` } }));
			} else if (roll === 5) {
				chunk.push(JSON.stringify({ seq, at, type: "breath.scheduled", data: { nextBreathAt: at, intervalMs: 300000, quiet: false, reason: "interval" } }));
			} else if (roll === 6) {
				chunk.push(JSON.stringify({ seq, at, type: "tool.decided", data: { tool: "read", decision: "allow", input: `diary/${stamp}.md`, runId: `run-${seq}` } }));
			} else if (roll === 7) {
				chunk.push(JSON.stringify({ seq, at, type: "presence.changed", data: { state: "breathing" } }));
			} else if (roll === 8) {
				chunk.push(JSON.stringify({ seq, at, type: "message.out", data: { text: "我在。今天想读点东西。", channel: "bubble" } }));
			} else {
				chunk.push(JSON.stringify({ seq, at, type: "message.in", data: { text: "好，慢慢来。", source: "text" } }));
			}
		}
		if (chunk.length > 20_000) {
			fs.appendFileSync(path.join(WORK, "journal", `${stamp}.jsonl`), `${chunk.join("\n")}\n`);
			chunk.length = 0;
		}
	}
	if (chunk.length) fs.appendFileSync(path.join(WORK, "journal", "last.jsonl"), `${chunk.join("\n")}\n`);

	const bytes = fs
		.readdirSync(path.join(WORK, "journal"))
		.filter((name) => name.endsWith(".jsonl"))
		.reduce((sum, name) => sum + fs.statSync(path.join(WORK, "journal", name)).size, 0);
	return { seq, bytes, files: fs.readdirSync(path.join(WORK, "journal")).length };
}

// ─── 2. 起一个真内核，量启动与查询 ───

function rpcOnce(socketPath, request, timeoutMs = 30_000) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		let buffer = "";
		let settled = false;
		const done = (error, value) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			error ? reject(error) : resolve(value);
		};
		socket.setEncoding("utf8");
		socket.setTimeout(timeoutMs);
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const index = buffer.indexOf("\n");
			if (index < 0) return;
			try {
				done(null, JSON.parse(buffer.slice(0, index)));
			} catch (error) {
				done(error);
			}
		});
		socket.on("timeout", () => done(new Error("超时")));
		socket.on("error", (error) => done(error));
	});
}

async function measure() {
	const socketPath = path.join(WORK, "runtime", "core.sock");
	const startedAt = Date.now();
	const core = spawn(process.execPath, [path.join(ROOT, "core", "main.ts")], {
		env: {
			...process.env,
			SPRITE_HOME: WORK,
			SPRITE_SOCKET: socketPath,
			SPRITE_NO_PI: "1",
			SPRITE_QUIET_START: "0",
			SPRITE_QUIET_END: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let ready = false;
	const logs = [];
	core.stdout.setEncoding("utf8");
	core.stdout.on("data", (chunk) => logs.push(String(chunk)));

	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		if (fs.existsSync(socketPath)) {
			try {
				await rpcOnce(socketPath, { id: "probe", type: "query.status" }, 20_000);
				ready = true;
				break;
			} catch {
				// 还没起来
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const bootMs = Date.now() - startedAt;
	if (!ready) {
		core.kill("SIGKILL");
		throw new Error(`内核未能在 180s 内就绪:\n${logs.join("")}`);
	}

	// 状态查询的往返延迟（读模型已经在内存里，应当很快）
	const latencies = [];
	for (let i = 0; i < 5; i++) {
		const t = Date.now();
		await rpcOnce(socketPath, { id: `q${i}`, type: "query.status" });
		latencies.push(Date.now() - t);
	}

	// 恢复扫描会产生大量临时对象；静置一会儿让 GC 跑完，再采稳态内存
	await new Promise((resolve) => setTimeout(resolve, 3000));
	const diag = await rpcOnce(socketPath, { id: "d", type: "query.diagnostics" });
	core.kill("SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, 400));

	return {
		bootMs,
		rssMb: Math.round(diag.result.rssBytes / 1048576),
		heapMb: Math.round(diag.result.heapUsedBytes / 1048576),
		events: diag.result.events,
		seq: diag.result.seq,
		statusMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
	};
}

console.log(`\n=== 规模测量：${TOTAL_EVENTS.toLocaleString()} 条事件 / ${DAYS} 天 ===`);
const generated = generate();
console.log(`journal：${generated.files} 个文件，${(generated.bytes / 1048576).toFixed(1)} MB，seq 到 ${generated.seq.toLocaleString()}`);
const result = await measure();
console.log(`启动到可服务：${result.bootMs}ms（本次为冷启动：目录已被重建，无检查点可用）`);
console.log(`堆（活对象）：${result.heapMb} MB　RSS（含 V8 预留）：${result.rssMb} MB`);
console.log(`内存中事件：${result.events.toLocaleString()} 条（滑动窗口；日志共 ${result.seq.toLocaleString()} 条）`);
console.log(`状态查询往返：${result.statusMs}ms`);
console.log(`提示：RSS 与"每条事件成本"不是有效指标——活对象只有堆里的那点，窗口之外的明细已不在内存。`);
