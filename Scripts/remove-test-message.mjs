/**
 * 删除一条测试消息，以及它引发的那一整拍呼吸。
 *
 * 缘起：为了验证"发送"链路，我用与面板相同的代码路径往**真实记忆**里发了一条消息
 * （"这是一条通过面板同款代码路径发出的消息"）。它当真了，回了一段，并把这一轮写进了
 * 对话记录、思维流和 pi 的 session。用户要求删掉它。
 *
 * 删除范围（精确到事件，不做范围猜測）：
 *   journal ：message.in(1640) + 该轮的 run/thought/activity/回复 + command.applied
 *             **但保留 legacy.imported 所有权交接标记** —— 删了会导致整份历史被重新导入
 *   mailbox ：那条消息与它的回复（各一行）
 *   thoughts：该轮的思维流那一行
 *   session ：该轮在 pi 会话里的 6 条记录（用户观察 → 思考 → 工具调用 → 回复）
 *   checkpoint：删除（否则快照里还留着这条消息，重启就"复活"）
 *
 * 用法：node Scripts/remove-test-message.mjs [--apply]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const HOME = path.join(os.homedir(), ".claude-memory");
const JOURNAL_DIR = path.join(HOME, "journal");
const MAILBOX = path.join(HOME, "conversations", "mailbox.md");
const THOUGHTS = path.join(HOME, "thoughts", "stream.jsonl");
const SESSIONS = path.join(HOME, "sessions");
const CHECKPOINT = path.join(JOURNAL_DIR, "checkpoint.json");

const TEST_MESSAGE = "这是一条通过面板同款代码路径发出的消息";
const REPLY_MARKER = "收到，这条路通了";
const THOUGHT_MARKER = "收到他的测试消息";
const OWNERSHIP_KIND = "ownership.handoff";

const report = { journal: 0, mailbox: 0, thoughts: 0, session: 0, checkpoint: false };
const backups = [];

// ─── 1. journal：按事件精确删除 ───
const journalFiles = fs.readdirSync(JOURNAL_DIR).filter((n) => n.endsWith(".jsonl")).sort();
let testSeq = null;
const allEvents = [];
for (const name of journalFiles) {
	const filePath = path.join(JOURNAL_DIR, name);
	const lines = fs.readFileSync(filePath, "utf8").split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			allEvents.push({ file: name, event: JSON.parse(line), raw: line });
		} catch {
			allEvents.push({ file: name, event: null, raw: line });
		}
	}
}
const messageEvent = allEvents.find((e) => e.event?.type === "message.in" && e.event.data?.text === TEST_MESSAGE);
if (!messageEvent) {
	console.log("找不到那条测试消息（可能已经删过）。");
}
testSeq = messageEvent?.event.seq ?? null;

// 该轮的范围：从 message.in 到它之后最后一个 breath.scheduled
const startSeq = testSeq;
let endSeq = testSeq;
if (startSeq !== null) {
	const after = allEvents.filter((e) => e.event && e.event.seq > startSeq);
	for (const e of after) {
		if (e.event.type === "message.in") break; // 下一条用户消息：不属于这一轮
		endSeq = e.event.seq;
		if (e.event.type === "run.finished") {
			// 这一轮到此结束；把紧随其后的 presence/schedule 也算上
			const tail = after.filter((x) => x.event.seq > e.event.seq).slice(0, 2);
			for (const t of tail) endSeq = t.event.seq;
			break;
		}
	}
}
console.log(startSeq === null ? "（无 journal 变更）" : `journal：将删除 seq ${startSeq}–${endSeq} 中除「所有权交接标记」之外的全部事件`);

const removedSeqs = new Set();
if (startSeq !== null) {
	for (const e of allEvents) {
		if (!e.event) continue;
		if (e.event.seq < startSeq || e.event.seq > endSeq) continue;
		if (e.event.type === "legacy.imported" && e.event.data?.kind === OWNERSHIP_KIND) {
			console.log(`  保留 #${e.event.seq} ownership.handoff（${e.event.data.file}）—— 删了会重新导入整份历史`);
			continue;
		}
		removedSeqs.add(e.event.seq);
	}
	report.journal = removedSeqs.size;
}

// ─── 2. mailbox：删那两行 ───
const mailboxRaw = fs.readFileSync(MAILBOX, "utf8");
const mailboxLines = mailboxRaw.split("\n");
const mailboxKept = mailboxLines.filter((line) => !line.includes(TEST_MESSAGE) && !line.includes(REPLY_MARKER));
report.mailbox = mailboxLines.length - mailboxKept.length;
console.log(`mailbox：将删除 ${report.mailbox} 行`);

// ─── 3. thoughts：删那一行 ───
const thoughtsLines = fs.readFileSync(THOUGHTS, "utf8").split("\n");
const thoughtsKept = thoughtsLines.filter((line) => !line.includes(THOUGHT_MARKER));
report.thoughts = thoughtsLines.length - thoughtsKept.length;
console.log(`thoughts：将删除 ${report.thoughts} 行`);

// ─── 4. session：删那一轮（用户观察 → 回复）───
const sessionFiles = fs.readdirSync(SESSIONS).filter((n) => n.endsWith(".jsonl") && n >= "2026-09-11");
let sessionPlan = null;
for (const name of sessionFiles) {
	const filePath = path.join(SESSIONS, name);
	const lines = fs.readFileSync(filePath, "utf8").split("\n");
	const hit = lines.findIndex((line) => line.includes(TEST_MESSAGE));
	if (hit < 0) continue;
	// 向前后扩到轮次边界：从这条 user 记录，到下一个 user 记录之前
	let start = hit;
	let end = hit + 1;
	while (end < lines.length && !(lines[end].trim() && lines[end].includes('"role":"user"'))) end += 1;
	sessionPlan = { file: filePath, name, start, end, count: end - start };
	break;
}
if (sessionPlan) {
	report.session = sessionPlan.count;
	console.log(`session：${sessionPlan.name} 将删除第 ${sessionPlan.start}–${sessionPlan.end - 1} 行（${sessionPlan.count} 条记录，整轮）`);
} else {
	console.log("session：没有找到需要删除的记录");
}

// ─── 5. checkpoint ───
const hasCheckpoint = fs.existsSync(CHECKPOINT);
report.checkpoint = hasCheckpoint;
console.log(`checkpoint：${hasCheckpoint ? "将删除（否则快照会让这条消息在重启后复活）" : "无"}`);

if (!APPLY) {
	console.log("\n（预览模式）什么都没做。加 --apply 执行。");
	process.exit(0);
}

// ─── 执行：先备份 ───
const backupDir = path.join(process.cwd(), ".cleanup-backup", `test-message-removal-${Date.now()}`);
fs.mkdirSync(backupDir, { recursive: true });
for (const name of journalFiles) {
	fs.copyFileSync(path.join(JOURNAL_DIR, name), path.join(backupDir, `journal-${name}`));
}
fs.copyFileSync(MAILBOX, path.join(backupDir, "mailbox.md"));
fs.copyFileSync(THOUGHTS, path.join(backupDir, "stream.jsonl"));
if (sessionPlan) fs.copyFileSync(sessionPlan.file, path.join(backupDir, sessionPlan.name));
if (hasCheckpoint) fs.copyFileSync(CHECKPOINT, path.join(backupDir, "checkpoint.json"));
backups.push(backupDir);
console.log(`\n已备份到：${backupDir}`);

// journal 写回
for (const name of journalFiles) {
	const filePath = path.join(JOURNAL_DIR, name);
	const kept = fs
		.readFileSync(filePath, "utf8")
		.split("\n")
		.filter((line) => {
			if (!line.trim()) return false;
			try {
				const event = JSON.parse(line);
				return !removedSeqs.has(event.seq);
			} catch {
				return true;
			}
		});
	fs.writeFileSync(filePath, kept.length ? `${kept.join("\n")}\n` : "");
}
fs.writeFileSync(MAILBOX, mailboxKept.join("\n"));
fs.writeFileSync(THOUGHTS, thoughtsKept.join("\n"));
if (sessionPlan) {
	const kept = fs.readFileSync(sessionPlan.file, "utf8").split("\n").filter((_, index) => index < sessionPlan.start || index >= sessionPlan.end);
	fs.writeFileSync(sessionPlan.file, kept.join("\n"));
}
if (hasCheckpoint) fs.unlinkSync(CHECKPOINT);

console.log("\n═══ 完成 ═══");
console.log(`  journal 删除 ${report.journal} 条事件`);
console.log(`  mailbox 删除 ${report.mailbox} 行`);
console.log(`  thoughts 删除 ${report.thoughts} 行`);
console.log(`  session 删除 ${report.session} 条记录`);
console.log(`  checkpoint ${report.checkpoint ? "已删除" : "无"}`);
console.log(`  备份：${backups[0]}`);
