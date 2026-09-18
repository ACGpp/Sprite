/**
 * 修一件事：把今天被写坏的多行对话并回一行。
 *
 * 背景：内核投影早期版本把带换行的多段话直接写进 mailbox.md，
 * 导致只有第一行有 `[时间] 说话人:` 前缀，后续行成了"无主文本"。
 * 现在投影已改为用 ` ⏎ ` 压平（沿用这套记忆文件里既有的约定），
 * 这个脚本负责把**今天已经写坏的那几条**恢复成同一种格式。
 *
 * 安全性：
 *   · 只处理 journal 里 seq > 导入水位线、且是 message.out 的事件（即今天新产生的）
 *   · 只按这些事件的原文精确匹配，**不碰任何历史行**
 *   · 先备份到 .cleanup-backup/
 *
 * 用法：node Scripts/repair-mailbox.mjs [--apply]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const HOME = path.join(os.homedir(), ".claude-memory");
const MAILBOX = path.join(HOME, "conversations", "mailbox.md");
const JOURNAL_DIR = path.join(HOME, "journal");

const PREFIX = /^\[(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})\]\s*([^:]{1,30}):\s?/;
const SPEAKER_GROUP = 6; // 年份 1 / 月 2 / 日 3 / 时 4 / 分 5 / **说话人 6**

function stampOf(iso) {
	const parts = new Intl.DateTimeFormat("sv-SE", {
		timeZone: "Asia/Shanghai",
		year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", hour12: false,
	}).format(new Date(iso));
	return parts.replaceAll("-", "/");
}

// ─── 1. 从 journal 取出"今天新产生的、带换行的"对话 ───
const events = [];
for (const name of fs.readdirSync(JOURNAL_DIR).filter((n) => n.endsWith(".jsonl")).sort()) {
	for (const line of fs.readFileSync(path.join(JOURNAL_DIR, name), "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// 跳过坏行
		}
	}
}
// 说话人：从 identity.md 读（内核的投影也是这么做的）
const { readCompanionName } = await import("../core/identity.ts");
const companionName = readCompanionName(HOME);
const SPEAKERS = new Map(); // 本脚本只写它自己的话，所以就是一个名字
const watermark = events.findLast?.((e) => e.type === "legacy.imported" && e.data.kind === "cursor")?.seq ?? 0;
const broken = events.filter(
	(e) => e.type === "message.out" && e.seq > watermark && !e.data.legacyAt && typeof e.data.text === "string" && e.data.text.includes("\n"),
);

console.log(`journal 事件 ${events.length} 条，导入水位线 seq=${watermark}`);
console.log(`今天被写坏的对话：${broken.length} 条`);
for (const e of broken) { SPEAKERS.set(e.seq, companionName); console.log(`  · seq ${e.seq}　${JSON.stringify(e.data.text).slice(0, 80)}…`); }

if (broken.length === 0) {
	console.log("没有需要修复的内容。");
	process.exit(0);
}

// ─── 2. 在 mailbox 里定位并合并 ───
const original = fs.readFileSync(MAILBOX, "utf8");
const lines = original.split("\n");
const out = [...lines];
let repaired = 0;

for (const event of broken) {
	const text = event.data.text;
	const firstLine = text.split("\n")[0];
	const stamp = stampOf(event.at);
	// 找到这次写入的起始行：时间戳 + 说话人 + 正文第一行
	const startIndex = out.findIndex((line) => line.startsWith(`[${stamp}] `) && PREFIX.test(line) && line.includes(firstLine.slice(0, 20)));
	if (startIndex < 0) {
		console.log(`  ⚠︎ 找不到 seq ${event.seq} 对应的行，跳过（它可能已经被修过）`);
		continue;
	}
	// 往后吃掉属于同一条的续行：直到下一个带前缀的行或文件末尾
	let end = startIndex + 1;
	while (end < out.length && !(out[end].trim() && PREFIX.test(out[end]))) end += 1;
	const consumed = out.slice(startIndex, end);

	// 说话人优先取自 identity.md（而不是从旧行里抠——那条路我抠错过一次，把"分钟"当成了名字）
	const speaker = SPEAKERS.get(event.seq) ?? PREFIX.exec(consumed[0])?.[SPEAKER_GROUP]?.trim() ?? "守护灵";
	const flattened = text
		.replace(/\r?\n[ \t]*\r?\n/g, " ⏎  ⏎ ")
		.replace(/\r?\n/g, " ⏎ ")
		.trim();
	const expected = `[${stamp}] ${speaker}: ${flattened}`;
	if (consumed.length === 1 && consumed[0] === expected) continue; // 已经正确
	out.splice(startIndex, end - startIndex, expected);
	repaired += 1;
	console.log(`  ✓ 合并 seq ${event.seq}：${consumed.length} 行 → 1 行`);
}

if (repaired === 0) {
	console.log("没有可合并的行。");
	process.exit(0);
}

if (!APPLY) {
	console.log(`\n（预览模式）将把 ${repaired} 条对话压回一行，原文件不动。加 --apply 执行。`);
	process.exit(0);
}

// ─── 3. 备份后写入 ───
const backupDir = path.join(process.cwd(), ".cleanup-backup");
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `mailbox-before-repair-${Date.now()}.md`);
fs.writeFileSync(backup, original);
console.log(`\n已备份原文件：${backup}`);

const next = out.join("\n");
fs.writeFileSync(MAILBOX, next);
console.log(`已写入：${repaired} 条对话压回一行；文件 ${original.length} → ${next.length} 字节`);
