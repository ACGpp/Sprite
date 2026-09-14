/**
 * v1 记忆导入器：把 ~/.claude-memory 的既有文件接进事件日志。
 *
 * 三条硬约束：
 *   1. **只读**：绝不修改、绝不重写用户已有的记忆文件（测试用 sha256 断言）
 *   2. **幂等**：游标记录在 journal 里，重复运行不产生新事件
 *   3. **无损**：认不出的内容作为 legacy.imported 原样保留，不丢
 *
 * 为什么游标存在 journal 里：多一个 cursor 文件就多一个可能损坏、可能与日志不一致的状态源。
 * 游标 = 从事件序列推导出来的东西，天然可恢复。
 *
 * 现实世界的教训：v1 的文件格式并不整齐——mailbox.md 是"格式化行 + 自由对话"的混合文本，
 * thoughts/stream.jsonl 是"JSONL + markdown 前言"的混合体（压缩脚本改写过它）。
 * 导入器必须容错，否则就是在丢用户的记忆。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EventType } from "../contracts/events.ts";
import type { Journal } from "./journal.ts";

export type ParsedLine = { type: EventType; data: Record<string, unknown> };

export type LegacySource = {
	name: string;
	relativePath: string;
	/**
	 * 解析一段完整的文本（以换行结尾），返回事件。认不出的内容必须自行保留。
	 *
	 * `firstLine` 是这段文本在整个文件里的**起始绝对行号**：每个事件都要把它带上
	 * （`importSource` + `importLine`），这样崩溃之后能精确到行接着导，不多不少。
	 */
	parse(text: string, firstLine: number): ParsedLine[];
};

export type ImportReport = {
	source: string;
	file: string;
	consumedBytes: number;
	events: number;
	status: "imported" | "up-to-date" | "changed-underneath" | "missing" | "owned-by-core";
};

const lineHash = (text: string) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

/** 前 `length` 个字节里有几个换行 = 已经完整消费的行数 */
function countLines(prefix: Buffer): number {
	let lines = 0;
	for (let index = 0; index < prefix.length; index += 1) {
		if (prefix[index] === 0x0a) lines += 1;
	}
	return lines;
}

/** 第 `line` 行（0 起）在文件里的字节偏移；行数超过文件长度就返回文件长度 */
function byteOffsetOfLine(buffer: Buffer, line: number): number {
	if (line <= 0) return 0;
	let seen = 0;
	for (let index = 0; index < buffer.length; index += 1) {
		if (buffer[index] !== 0x0a) continue;
		seen += 1;
		if (seen === line) return index + 1;
	}
	return buffer.length;
}

// ─── mailbox.md：格式化行 + 自由文本 ───

const MAILBOX_LINE = /^\[(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})\]\s*([^:]{1,30}):\s?(.*)$/;
const USER_SPEAKER = "用户";

export const mailboxSource: LegacySource = {
	name: "mailbox",
	relativePath: "conversations/mailbox.md",
	parse(text, firstLine) {
		const events: ParsedLine[] = [];
		for (const [index, line] of text.split("\n").entries()) {
			if (!line.trim()) continue;
			const absoluteLine = firstLine + index;
			const match = MAILBOX_LINE.exec(line);
			if (match) {
				const [, year, month, day, hour, minute, speaker, body] = match;
				// 正则只保证"两位数字"，不保证是合法时间：24 时、13 月、02-30 都会进来。
				// 老代码直接 `.toISOString()`——Invalid Date 会抛 RangeError，而调用方没有
				// try/catch，于是**一行写坏的时间会让内核每次启动都失败**（用户的记忆打不开）。
				const [y, mo, d, hh, mm] = [Number(year), Number(month), Number(day), Number(hour), Number(minute)];
				const inRange = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
				let at: string | null = null;
				if (inRange) {
					// v1 的墙钟时间按 Asia/Shanghai 记录（UTC+8）
					const candidate = new Date(Date.UTC(y, mo - 1, d, hh - 8, mm));
					// 回读校验：2026-02-30 不抛错，但会静默滚到 3 月 2 日——按上海本地时间比对
					const shanghai = new Date(candidate.getTime() + 8 * 3_600_000);
					const sameMoment =
						!Number.isNaN(candidate.getTime()) &&
						shanghai.getUTCFullYear() === y &&
						shanghai.getUTCMonth() + 1 === mo &&
						shanghai.getUTCDate() === d &&
						shanghai.getUTCHours() === hh &&
						shanghai.getUTCMinutes() === mm;
					if (sameMoment) at = candidate.toISOString();
				}
				if (!at) {
					// 解析不了就**原样留着**：宁可这一行以原文进记忆，也不能丢，
					// 更不能因为一行坏时间让整个内核起不来。
					events.push({
						type: "legacy.imported",
						data: { source: "mailbox", raw: line, problem: "这一行的时间写坏了，按原文保留", importSource: "mailbox", importLine: absoluteLine },
					});
					continue;
				}
				events.push({
					type: speaker.trim() === USER_SPEAKER ? "message.in" : "message.out",
					data: {
						text: body,
						source: "text",
						channel: "digest",
						speaker: speaker.trim(),
						legacyAt: at,
						legacyLine: absoluteLine,
						importSource: "mailbox",
						importLine: absoluteLine,
					},
				});
			} else {
				// 自由对话（v1 里大量存在）：原样保留，绝不丢
				events.push({
					type: "legacy.imported",
					data: { kind: "mailbox.text", text: line, line: absoluteLine, hash: lineHash(line), importSource: "mailbox", importLine: absoluteLine },
				});
			}
		}
		return events;
	},
};

// ─── thoughts/stream.jsonl：JSONL + markdown 前言 ───

export const thoughtsSource: LegacySource = {
	name: "thoughts",
	relativePath: "thoughts/stream.jsonl",
	parse(text, firstLine) {
		const events: ParsedLine[] = [];
		for (const [index, line] of text.split("\n").entries()) {
			if (!line.trim()) continue;
			const absoluteLine = firstLine + index;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				events.push({
					type: "legacy.imported",
					data: { kind: "thoughts.raw", text: line, line: absoluteLine, hash: lineHash(line), importSource: "thoughts", importLine: absoluteLine },
				});
				continue;
			}
			const record = parsed as Record<string, unknown>;
			if (typeof record.content !== "string") {
				events.push({
					type: "legacy.imported",
					data: { kind: "thoughts.unknown", text: line, line: absoluteLine, hash: lineHash(line), importSource: "thoughts", importLine: absoluteLine },
				});
				continue;
			}
			events.push({
				type: "thought.recorded",
				data: {
					text: record.content,
					legacyType: typeof record.type === "string" ? record.type : "unknown",
					legacyTime: typeof record.time === "string" ? record.time : null,
					legacyLine: absoluteLine,
					importSource: "thoughts",
					importLine: absoluteLine,
				},
			});
		}
		return events;
	},
};

export const DEFAULT_SOURCES: LegacySource[] = [mailboxSource, thoughtsSource];

// ─── 游标 ───

type Cursor = { offset: number; prefixHash: string; line: number };

/**
 * 游标不是外部状态：它由日志里的 legacy.imported 事件推导得出。
 *
 * 注意：这个索引由 journal 在恢复扫描时建好，**不依赖内存里的事件数组**——
 * 后者只保留滑动窗口，历史游标事件早已不在其中。
 */
export function cursorFor(journal: Journal, source: string, file: string): Cursor | null {
	return journal.cursorFor(source, file);
}

/**
 * 所有权交接：内核一旦往某个产物文件里写过东西，这个文件就归内核所有，导入器必须停手。
 *
 * 为什么必须有这个标记：否则会出现反馈回路——
 * 内核把新留言投影进 mailbox.md → 下次启动导入器把这段自己写的字节当成"新历史"读回来
 * → 留言翻倍。这个 bug 是 main.ts 的重启冒烟测试抓到的，不是想出来的。
 */
export function hasOwnershipHandoff(journal: Journal, file: string): boolean {
	return journal.hasOwnershipHandoff(file);
}

export function ownershipHandoffEvent(file: string): ParsedLine {
	return { type: "legacy.imported", data: { kind: "ownership.handoff", file, at: new Date().toISOString() } };
}

export function importLegacy(homeDir: string, journal: Journal, sources: LegacySource[] = DEFAULT_SOURCES): ImportReport[] {
	const reports: ImportReport[] = [];

	for (const source of sources) {
		const absolute = path.join(homeDir, source.relativePath);
		if (hasOwnershipHandoff(journal, source.relativePath)) {
			reports.push({ source: source.name, file: source.relativePath, consumedBytes: 0, events: 0, status: "owned-by-core" });
			continue;
		}
		if (!fs.existsSync(absolute)) {
			reports.push({ source: source.name, file: source.relativePath, consumedBytes: 0, events: 0, status: "missing" });
			continue;
		}

		const buffer = fs.readFileSync(absolute);
		const cursor = cursorFor(journal, source.name, source.relativePath);
		const consumedLine = cursor?.line ?? 0;
		// 崩溃留下的痕迹：事件自带的行号。断点 = max(游标行, 最后一条已导入事件的行 + 1)
		const resumeLine = Math.max(consumedLine, journal.importedLineFor(source.name) + 1);
		// 由行号反算字节偏移（用 offset 也行，但行号更精确——中途崩溃时游标还没写）
		const start = Math.min(byteOffsetOfLine(buffer, resumeLine), buffer.length);
		if (resumeLine > consumedLine) {
			// 说明上次崩在导入中途：这次从断点接着导，而不是整段重来（评审 M2）
			journal.append("system.problem", {
				code: "legacy.import.resume",
				userMessage: `${source.relativePath} 上次导入到第 ${resumeLine} 行时中断，本次从那里接着导。`,
				file: source.relativePath,
			});
		}

		// 游标处之前的内容必须与上次导入时一致；否则文件被外部改写过
		if (cursor && cursor.offset > 0 && resumeLine <= consumedLine) {
			const prefixHash = crypto.createHash("sha256").update(buffer.subarray(0, start)).digest("hex").slice(0, 16);
			if (prefixHash !== cursor.prefixHash) {
				journal.append("system.problem", {
					code: "legacy.file.changed",
					userMessage: `${source.relativePath} 在导入之后被外部修改过；为避免重复导入，本次跳过。`,
					file: source.relativePath,
				});
				reports.push({ source: source.name, file: source.relativePath, consumedBytes: 0, events: 0, status: "changed-underneath" });
				continue;
			}
		}

		// 只消费完整的行；半行留给下次（v1 进程可能正在写）
		const tail = buffer.subarray(start).toString("utf8");
		const lastNewline = tail.lastIndexOf("\n");
		if (lastNewline < 0) {
			reports.push({ source: source.name, file: source.relativePath, consumedBytes: 0, events: 0, status: "up-to-date" });
			continue;
		}
		const consumable = tail.slice(0, lastNewline + 1);
		const consumedBytes = Buffer.byteLength(consumable, "utf8");
		// 起始绝对行号：只数换行，不去解析内容（半行已经在上面切掉了）
		const firstLine = start === 0 ? 0 : countLines(buffer.subarray(0, start));
		const parsed = source.parse(consumable, firstLine);

		for (const item of parsed) journal.append(item.type, item.data, undefined);
		const newOffset = start + consumedBytes;
		const newLine = countLines(buffer.subarray(0, newOffset));
		journal.append("legacy.imported", {
			kind: "cursor",
			source: source.name,
			file: source.relativePath,
			offset: newOffset,
			line: newLine,
			lines: parsed.length,
			// 前缀哈希：下次靠它发现文件被外部改写
			prefixHash: crypto.createHash("sha256").update(buffer.subarray(0, newOffset)).digest("hex").slice(0, 16),
		});

		reports.push({
			source: source.name,
			file: source.relativePath,
			consumedBytes,
			events: parsed.length,
			status: parsed.length > 0 ? "imported" : "up-to-date",
		});
	}

	return reports;
}
