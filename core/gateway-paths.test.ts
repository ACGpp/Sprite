/**
 * 写入白名单：`..` / `~` / 符号链接都必须挡得住。
 *
 * 为什么单独立一个测试：评审指出老实现只折叠 `//` 与 `/./`，而 pi 侧会
 * `expandPath(~)` + `path.resolve(..)` 之后再写——策略放行、执行展开，
 * 合起来就是一次真实越界写入（`…/.claude-memory/../../../etc/passwd`）。
 * 原有的 gateway-policy 测试只喂了自己正则里写死的字面量，对这条完全无感。
 *
 * 运行：node --test core/gateway-paths.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.join(process.cwd(), ".core-test", "gateway-paths");
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "diary"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "diary", "note.md"), "自己的东西\n");

// 家外的目标（必须永远写不到）
const OUTSIDE = path.join(process.cwd(), ".core-test", "gateway-paths-outside");
fs.rmSync(OUTSIDE, { recursive: true, force: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
// 一个指向家外的符号链接（realpath 必须识破）
const link = path.join(ROOT, "escape-link");
try {
	fs.symlinkSync(OUTSIDE, link);
} catch {
	// 已存在
}

process.env.SPRITE_ALLOWED_ROOTS = ROOT;
const { inAllowedRoot } = await import("../pi-extension/policy.ts");

test("允许根之外的路径一律拒绝（含 .. / ~ / 符号链接）", () => {
	// 生产里 pi 的工作目录就是记忆之家，所以相对路径按它解析
	const allowed = [
		["diary/note.md", ROOT],
		[path.join(ROOT, "diary", "note.md"), ROOT],
		["diary/../diary/note.md", ROOT], // 归一化之后还在家里 → 允许
		[path.join(ROOT, "new-file.md"), ROOT],
	] as const;
	for (const [candidate, cwd] of allowed) {
		assert.equal(inAllowedRoot(candidate, cwd), true, `应当允许：${candidate}`);
	}
	// 同一个相对路径，如果工作目录不是家（例如被人换了 cwd），就必须拒绝
	assert.equal(inAllowedRoot("diary/note.md", "/tmp"), false, "cwd 不在家里时相对路径必须拒绝");

	const rejected = [
		path.join(ROOT, "..", "..", "..", "..", "etc", "passwd"),
		path.join(ROOT, "diary", "..", "..", "..", "tmp", "rel-escape"),
		"~/Documents/evil.md",
		"~",
		"/etc/passwd",
		path.join(OUTSIDE, "x.md"),
		path.join(ROOT, "escape-link", "x.md"), // 符号链接指到外面
		path.join(ROOT, "escape-link"),
		"",
	];
	for (const candidate of rejected) {
		assert.equal(inAllowedRoot(candidate, ROOT), false, `必须拒绝：${candidate}`);
	}
});

test("没写真实文件：策略层拒绝就是拒绝（不是靠执行层兜）", () => {
	// 上面那些 rejected 路径跑完之后，家外目录必须还是空的
	assert.deepEqual(fs.readdirSync(OUTSIDE), [], "家外目录不该被写入任何东西");
});

test("密钥与内核运行时文件：读也不许（不主动把钥匙递到 agent 手里）", async () => {
	const { isSecretPath } = await import("../pi-extension/policy.ts");
	const blocked = [
		path.join(ROOT, "config", "settings.json"),
		path.join(ROOT, "config", "settings.json"),
		path.join(ROOT, "journal", "2026-09-11.jsonl"),
		path.join(ROOT, "runtime", "core.sock"),
		path.join(ROOT, "sessions", "2026-09-11.jsonl"),
	];
	for (const candidate of blocked) {
		assert.equal(isSecretPath(candidate, ROOT), true, `必须挡住：${candidate}`);
	}
	const allowed = [path.join(ROOT, "diary", "x.md"), path.join(ROOT, "identity.md"), "diary/note.md"];
	for (const candidate of allowed) {
		assert.equal(isSecretPath(candidate, ROOT), false, `不该挡：${candidate}`);
	}
});

test("可写根收窄：config / journal / runtime / sessions 都不在允许写入的范围里", async () => {
	const { inAllowedRoot } = await import("../pi-extension/policy.ts");
	// 生产的默认可写根是记忆之家下的内容目录（不再是整个 home）
	process.env.SPRITE_ALLOWED_ROOTS = ["diary", "explorations", "notes", "private", "context"].map((name) => path.join(ROOT, name)).join(":");
	const { inAllowedRoot: narrowed } = await import(`../pi-extension/policy.ts?narrow=${Date.now()}`);
	for (const bad of ["config/settings.json", "journal/2026-09-11.jsonl", "runtime/core.sock", "sessions/x.jsonl", "conversations/mailbox.md"]) {
		assert.equal(narrowed(bad, ROOT), false, `不该允许写入：${bad}`);
	}
	for (const good of ["diary/2026-09-11.md", "explorations/prml.md", "private/notes.md", "context/working-memory.md"]) {
		assert.equal(narrowed(good, ROOT), true, `应当允许写入：${good}`);
	}
	// 收窄之后目录可能还不存在：最近存在祖先的 realpath 逻辑要能处理
	assert.equal(narrowed("diary/子目录/新的.md", ROOT), true, "允许目录下的新子目录也要能写");
});
