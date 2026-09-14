/**
 * 投影：把新内容以 v1 兼容格式追加到 markdown 产物里。
 *
 * 边界（P1 已收紧）：
 *   - **只 append，绝不 rewrite**。既有历史是只读的；投影失败可以重放，历史覆盖不可逆。
 *   - 格式必须与 v1 完全一致，旧阅读器（正则、人眼、同步脚本）不受影响。
 *   - 时间：journal 存 UTC，产物写 Asia/Shanghai 墙钟（与 v1 一致）。
 *
 * 一个容易漏的细节：如果文件不以换行结尾就追加，新内容会粘在最后一行后面。
 * 这与 journal 的撕裂尾巴是同一类错误，必须显式处理。
 */

import fs from "node:fs";
import path from "node:path";

const ASIA_SHANGHAI = "Asia/Shanghai";

/** UTC → v1 的墙钟字符串：`2026/09/11 02:30` */
export function shanghaiStamp(at: Date): string {
	const parts = new Intl.DateTimeFormat("sv-SE", {
		timeZone: ASIA_SHANGHAI,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(at);
	return parts.replaceAll("-", "/");
}

/** UTC → v1 的简短时刻：`02:30` */
export function shanghaiClock(at: Date): string {
	return new Intl.DateTimeFormat("sv-SE", {
		timeZone: ASIA_SHANGHAI,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(at);
}

/** 追加一行，保证不会粘在未结尾的行后面。 */
function appendLine(filePath: string, line: string, fsync: boolean): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	let needsLeadingNewline = false;
	try {
		const size = fs.statSync(filePath).size;
		if (size > 0) {
			const fd = fs.openSync(filePath, "r");
			const lastByte = Buffer.alloc(1);
			fs.readSync(fd, lastByte, 0, 1, size - 1);
			fs.closeSync(fd);
			needsLeadingNewline = lastByte[0] !== 0x0a;
		}
	} catch {
		needsLeadingNewline = false;
	}
	const fd = fs.openSync(filePath, "a");
	fs.writeSync(fd, `${needsLeadingNewline ? "\n" : ""}${line}\n`);
	if (fsync) fs.fsyncSync(fd);
	fs.closeSync(fd);
}

export const MAILBOX_RELATIVE = path.join("conversations", "mailbox.md");
export const THOUGHTS_RELATIVE = path.join("thoughts", "stream.jsonl");

/** 追加一条对话记录，格式与 v1 一致：`[2026/09/11 02:30] 零号: 内容` */
export function appendMailboxLine(
	homeDir: string,
	input: { speaker: string; text: string; at: Date },
	options: { fsync?: boolean } = {},
): string {
	// mailbox 是**按行**记录对话的：一条话必须占一行，否则后续行没有说话人前缀，
	// 读者（包括导入器与人眼）会把它们当成无主的自由文本。
	// 换行用 ` ⏎ ` 表示——这是这套记忆文件里既有的约定，不是新发明的。
	const oneLine = input.text
		.replace(/\r?\n[ \t]*\r?\n/g, " ⏎  ⏎ ") // 空行 = 段落分隔（与既有数据一致）
		.replace(/\r?\n/g, " ⏎ ")
		.trim();
	const line = `[${shanghaiStamp(input.at)}] ${input.speaker}: ${oneLine}`;
	appendLine(path.join(homeDir, MAILBOX_RELATIVE), line, options.fsync ?? true);
	return line;
}

/** 追加一条思维流，格式与 v1 一致：`{"time":"…Z","type":"breath","content":"…"}` */
export function appendThoughtLine(
	homeDir: string,
	input: { text: string; kind: string; at: Date },
	options: { fsync?: boolean } = {},
): string {
	const line = JSON.stringify({
		time: input.at.toISOString().replace(/\.\d{3}Z$/, "Z"),
		type: input.kind,
		content: input.text,
	});
	appendLine(path.join(homeDir, THOUGHTS_RELATIVE), line, options.fsync ?? true);
	return line;
}

/**
 * 读取 mailbox 尾部若干条对话（供"走近面板"显示最近几条）。
 * 只读，不依赖索引；解析规则与导入器一致（容错、不丢自由文本）。
 */
export function readRecentMailbox(homeDir: string, limit = 5): Array<{ at: string; speaker: string; text: string }> {
	const filePath = path.join(homeDir, MAILBOX_RELATIVE);
	let raw = "";
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		return [];
	}
	const pattern = /^\[(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})\]\s*([^:]{1,30}):\s?(.*)$/;
	const entries: Array<{ at: string; speaker: string; text: string }> = [];
	for (const line of raw.split("\n")) {
		const match = pattern.exec(line);
		if (!match) continue;
		const [, year, month, day, hour, minute, speaker, body] = match;
		entries.push({
			at: new Date(`${year}-${month}-${day}T${hour}:${minute}:00+08:00`).toISOString(),
			speaker: speaker.trim(),
			text: body,
		});
	}
	return entries.slice(-limit);
}
