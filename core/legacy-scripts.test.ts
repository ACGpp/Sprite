/**
 * 遗留脚本的安全闸。
 *
 * 背景：`tools/compress-memory.sh` 出自 v2（五月）。它读的是老数据源
 * `thoughts/stream.jsonl`，收尾会**删掉 `diary/*.md` 全部日记**换成一整篇 LLM 总结、
 * **整篇覆盖 `identity.md`**、并把 `stream.jsonl` 截成 20 条。
 * v3 的真相层是 `journal/`（append-only），`diary/` 是投影、也是它自己写下的东西——
 * 都不允许被替换。
 *
 * 这份脚本保留在原处只为留证，但它必须**在任何文件操作之前**被拦下。
 * 下面两个用例就是那道闸的证明：
 *   1. 拿它跑在一个**假的 $HOME** 上（真的记忆碰不到），断言退出非零、且夹具一个字节没变；
 *   2. 全仓搜调用点——没有任何脚本/服务会拉起它。
 *
 * 运行：node --test core/legacy-scripts.test.ts
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "tools", "compress-memory.sh");

function sha(file: string): string {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 造一个假的记忆之家：里面放日记、身份、思维流——全是"被删掉就会疼"的东西 */
function fakeHome(name: string): { home: string; memory: string; files: string[] } {
	const home = path.join(ROOT, ".core-test", name);
	fs.rmSync(home, { recursive: true, force: true });
	const memory = path.join(home, ".claude-memory");
	fs.mkdirSync(path.join(memory, "diary"), { recursive: true });
	fs.mkdirSync(path.join(memory, "thoughts"), { recursive: true });
	fs.mkdirSync(path.join(memory, "config"), { recursive: true });
	fs.writeFileSync(path.join(memory, "identity.md"), "# 我是谁\n\n我叫零号。\n");
	fs.writeFileSync(path.join(memory, "diary", "2026-09-14.md"), "一天的日记\n");
	fs.writeFileSync(path.join(memory, "diary", "2026-09-15.md"), "另一天的日记\n");
	fs.writeFileSync(path.join(memory, "thoughts", "stream.jsonl"), '{"content":"一条想法"}\n');
	return {
		home,
		memory,
		files: [
			path.join(memory, "identity.md"),
			path.join(memory, "diary", "2026-09-14.md"),
			path.join(memory, "diary", "2026-09-15.md"),
			path.join(memory, "thoughts", "stream.jsonl"),
		],
	};
}

test("停用的 v2 压缩脚本必须拒绝执行，且不碰任何文件", () => {
	assert.ok(fs.existsSync(SCRIPT), "脚本还在（留着留证），但它必须拒绝执行");
	const fixture = fakeHome("legacy-compress-guard");
	const before = fixture.files.map(sha);
	const diaryBefore = fs.readdirSync(path.join(fixture.memory, "diary")).sort();

	const result = spawnSync("bash", [SCRIPT], {
		encoding: "utf8",
		// 假 HOME：即使闸门失效，动的也是夹具而不是真实记忆
		env: { ...process.env, HOME: fixture.home },
	});

	assert.notEqual(result.status, 0, "必须拒绝执行（退出非零）");
	assert.match(result.stderr, /已停用/, "要说清楚它为什么不能跑");
	assert.match(result.stderr, /ARCHITECTURE\.md/, "要指向新口径");

	const after = fixture.files.map(sha);
	assert.deepEqual(after, before, "闸门之前的文件必须一个字节都没变");
	assert.deepEqual(
		fs.readdirSync(path.join(fixture.memory, "diary")).sort(),
		diaryBefore,
		"日记一篇都不许少",
	);
});

test("没有任何脚本/服务/代码调用这个遗留脚本", () => {
	const offenders: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const name = entry.name;
			if (["node_modules", ".git", ".core-test", ".build", ".build-release", "backups"].includes(name)) continue;
			const full = path.join(dir, name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!/\.(sh|bash|ts|mjs|js|yml|yaml|plist|md)$/.test(name)) continue;
			if (full === SCRIPT) continue; // 它自己不算调用点
			if (full === import.meta.filename) continue; // 这个测试自己会提到它
			const text = fs.readFileSync(full, "utf8");
			if (!text.includes("compress-memory")) continue;
			// 文档里提到它是允许的（说明、停用理由、探索笔记）——只拦"真的会执行它"的写法。
			// 第一版把注释里的提及也当成调用，结果把自己和别的文档全列成了罪犯。
			const runs = /(^|\s)(bash|sh|zsh|source|\.)\s+[^\n]*compress-memory\.sh|["'`][^\n]*\/compress-memory\.sh/;
			const offending = text
				.split("\n")
				.filter((line) => runs.test(line) && !/^\s*(#|\/\/|\*)/.test(line));
			if (offending.length > 0) offenders.push(path.relative(ROOT, full));
		}
	};
	for (const top of ["Scripts", "tools", "core", "shell", "pi-extension", ".github"]) {
		const dir = path.join(ROOT, top);
		if (fs.existsSync(dir)) walk(dir);
	}
	assert.deepEqual(
		offenders,
		[],
		`这些文件会拉起那个会删记忆的脚本（应当没有）：\n${offenders.join("\n")}`,
	);
});
