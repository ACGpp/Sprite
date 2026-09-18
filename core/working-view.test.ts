/**
 * 压缩的新口径（2026-09-18 重新定）：**可驱逐的是视野，不是记忆**。
 *
 * 旧脚本（tools/compress-memory.sh，已停用）的做法是"替换"：删掉 47 篇日记换一篇总结、
 * 覆盖 identity.md、截断 stream.jsonl。新口径把它反过来：
 *   - `journal/` 是真相层，append-only，永不删；
 *   - `diary/` 等是投影、是它自己写下的东西，也永不替换；
 *   - 能"驱逐"的只有**工作视野**（工作记忆 + 操作件），原件永远在原地、用路径就能读回；
 *   - 有操作力的话（约束）单独一层，**不参与任何总结**。
 *
 * 这个文件守最后两条的可执行部分：
 *   1. 工作记忆与操作件真的会出现在它醒来时看到的内容里（截断时给出回链）；
 *   2. 它们没出现在视野里时不会编造空文件，也不会因为长而悄悄丢掉后半段。
 *
 * 运行：node --test core/working-view.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildObservation } from "./breath.ts";
import { startKernel } from "./main.ts";

const ROOT = path.join(process.cwd(), ".core-test");
const at = new Date("2026-09-18T01:00:00.000Z"); // 上海 09:00

test("工作记忆与操作件会出现在观察里，并带上文件路径（回链）", () => {
	const prompt = buildObservation({
		pending: [],
		quiet: false,
		at,
		workingMemory: {
			path: "context/working-memory.md",
			text: "- 昨天在跟一条五月的线\n- 拿不准就标出来",
			truncated: false,
		},
		constraints: {
			path: "context/constraints.md",
			text: "1. 22:45 该收了（前提：他第二天要上班；谁授权：他说的）",
			truncated: false,
		},
	});
	assert.match(prompt, /你的工作记忆（context\/working-memory\.md）/);
	assert.match(prompt, /拿不准就标出来/);
	assert.match(prompt, /你的操作件（context\/constraints\.md）/);
	assert.match(prompt, /这一层不参与任何总结/);
	assert.match(prompt, /22:45 该收了/);
	assert.match(prompt, /前提 \/ 谁授权 \/ 兜底/, "四字段的约定要在它面前");
});

test("截断时必须给回链，不许悄悄丢后半段", () => {
	const prompt = buildObservation({
		pending: [],
		quiet: false,
		at,
		constraints: { path: "context/constraints.md", text: "第一条很长的约束", truncated: true },
	});
	assert.match(prompt, /太长，只放了开头/);
	assert.match(prompt, /完整内容自己读 context\/constraints\.md/);
});

test("没有这两个文件时不编造空块", () => {
	const prompt = buildObservation({ pending: [], quiet: false, at });
	assert.doesNotMatch(prompt, /你的操作件/);
	assert.doesNotMatch(prompt, /你的工作记忆/);
});

test("操作件真的送到了引擎面前（假引擎把收到的提示词录下来）", { timeout: 60_000 }, async () => {
	const home = path.join(ROOT, "working-view");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(home, "config"), { recursive: true });
	fs.mkdirSync(path.join(home, "context"), { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), "");
	// 一个只有它自己会写的文件：操作件
	fs.writeFileSync(
		path.join(home, "context", "constraints.md"),
		"1. 不要跑那个会删日记的脚本（前提：它会删记忆；谁授权：用户）\n",
	);
	fs.writeFileSync(path.join(home, "context", "working-memory.md"), "- 正在重定压缩的口径\n");
	fs.writeFileSync(
		path.join(home, "config", "settings.json"),
		JSON.stringify({
			model: { mode: "provider", provider: "deepseek", model: "deepseek-chat" },
			quietHours: { start: 0, end: 0 },
			proactive: { enabled: true, perDay: 5 },
		}),
	);

	// 假引擎：把每次 prompt 的正文原样写进文件，方便断言"它到底看到了什么"
	const promptLog = path.join(home, "prompts.log");
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
			`    if (request.type === 'prompt') fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(request) + '\\n');`,
			"    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n');",
			"    if (request.type === 'prompt') process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');",
			"  }",
			"});",
		].join("\n"),
		{ mode: 0o755 },
	);

	const kernel = await startKernel({
		homeDir: home,
		piBin: fakePi,
		intervalMs: 400,
		quietHours: { start: 0, end: 0 },
		fsync: false,
		log: () => {},
	});
	try {
		for (let i = 0; i < 80 && !fs.existsSync(promptLog); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(fs.existsSync(promptLog), "引擎应当至少被叫醒过一次");
		const prompts = fs.readFileSync(promptLog, "utf8");
		assert.match(prompts, /不要跑那个会删日记的脚本/, "约束必须真的送到它面前");
		assert.match(prompts, /正在重定压缩的口径/, "工作记忆也要在视野里");
	} finally {
		await kernel.stop();
	}
});
