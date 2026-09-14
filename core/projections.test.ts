/**
 * 投影测试：格式与 v1 一致、只 append 不 rewrite、不粘行。
 * 运行：node --test core/projections.test.ts
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
	appendMailboxLine,
	appendThoughtLine,
	MAILBOX_RELATIVE,
	readRecentMailbox,
	shanghaiClock,
	shanghaiStamp,
	THOUGHTS_RELATIVE,
} from "./projections.ts";

const ROOT = path.join(process.cwd(), ".core-test");

function freshHome(name: string): string {
	const home = path.join(ROOT, name);
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(home, "thoughts"), { recursive: true });
	return home;
}

const hash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("时间换算：UTC 存储 → Asia/Shanghai 墙钟（与 v1 一致）", () => {
	const utc = new Date("2026-09-10T18:30:00Z");
	assert.equal(shanghaiStamp(utc), "2026/09/11 02:30", "跨天必须体现在日期上");
	assert.equal(shanghaiClock(utc), "02:30");
	// v1 的 19:39+08:00 反过来也应该是 11:39Z
	assert.equal(shanghaiStamp(new Date("2026-06-20T11:39:00Z")), "2026/06/20 19:39");
});

test("mailbox 投影：格式能被 v1 正则识别，且旧内容前缀不变", () => {
	const home = freshHome("projection-mailbox");
	const file = path.join(home, MAILBOX_RELATIVE);
	fs.writeFileSync(file, "[2026/06/20 18:39] 零号: 老的一行\n");
	const before = hash(file);
	const beforeBytes = fs.readFileSync(file);

	const line = appendMailboxLine(home, { speaker: "零号", text: "新的一行", at: new Date("2026-09-10T18:30:00Z") });

	assert.equal(line, "[2026/09/11 02:30] 零号: 新的一行");
	const raw = fs.readFileSync(file, "utf8");
	// v1 正则（与导入器、旧 agent-controller 同源）
	assert.match(raw.split("\n")[1], /^\[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}\]\s*[^:]{1,30}:\s?/);
	assert.notEqual(hash(file), before, "文件确实变了");
	const after = fs.readFileSync(file);
	assert.ok(after.subarray(0, beforeBytes.length).equals(beforeBytes), "旧内容必须逐字节不变（只 append）");
});

test("mailbox 投影：不粘行（文件未以换行结尾时先补换行）", () => {
	const home = freshHome("projection-no-newline");
	const file = path.join(home, MAILBOX_RELATIVE);
	fs.writeFileSync(file, "[2026/06/20 18:39] 零号: 没有结尾换行");
	appendMailboxLine(home, { speaker: "零号", text: "第二条", at: new Date("2026-09-10T18:30:00Z") }, { fsync: false });

	const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
	assert.equal(lines.length, 2, "必须是两行，不能粘成一行");
	assert.match(lines[0], /没有结尾换行$/);
	assert.match(lines[1], /^\[2026\/09\/11 02:30\] 零号: 第二条$/);
});

test("思维流投影：字段与 v1 一致（time/type/content）", () => {
	const home = freshHome("projection-thoughts");
	const file = path.join(home, THOUGHTS_RELATIVE);
	const line = appendThoughtLine(home, { text: "02:30。醒着。", kind: "breath", at: new Date("2026-09-10T18:30:00Z") });

	const parsed = JSON.parse(line) as Record<string, unknown>;
	assert.deepEqual(Object.keys(parsed), ["time", "type", "content"], "字段顺序与 v1 保持一致，便于人眼与 diff");
	assert.equal(parsed.time, "2026-09-10T18:30:00Z");
	assert.equal(parsed.type, "breath");
	assert.equal(parsed.content, "02:30。醒着。");
	assert.equal(fs.readFileSync(file, "utf8").trim(), line);
});

test("多字节内容不被截断，中文与 emoji 往返一致", () => {
	const home = freshHome("projection-utf8");
	const text = "它在读《潮汐》——波浪🌊与月亮🌙";
	appendMailboxLine(home, { speaker: "零号", text, at: new Date("2026-09-10T18:30:00Z") }, { fsync: false });
	appendThoughtLine(home, { text, kind: "spread", at: new Date("2026-09-10T18:30:00Z") }, { fsync: false });

	const recent = readRecentMailbox(home, 1);
	assert.equal(recent[0].text, text, "mailbox 往返必须一致");
	const thought = JSON.parse(fs.readFileSync(path.join(home, THOUGHTS_RELATIVE), "utf8").trim()) as { content: string };
	assert.equal(thought.content, text, "思维流往返必须一致");
});

test("readRecentMailbox：容错解析并保持时间顺序", () => {
	const home = freshHome("projection-read");
	const file = path.join(home, MAILBOX_RELATIVE);
	fs.writeFileSync(
		file,
		[
			"[2026/06/20 18:39] 零号: 第一条",
			"这是一行自由文本，不该被当成对话",
			"",
			"[2026/06/20 19:39] 用户: 第二条",
			"[2026/06/21 00:25] 用户: 第三条",
		].join("\n"),
	);
	const recent = readRecentMailbox(home, 2);
	assert.equal(recent.length, 2);
	assert.deepEqual(
		recent.map((entry) => entry.text),
		["第二条", "第三条"],
	);
	assert.equal(recent[0].speaker, "用户");
	assert.equal(recent[0].at, "2026-06-20T11:39:00.000Z", "读取时按 +08:00 还原成 UTC");
});

test("多段话必须压成一行（沿用既有的 ⏎ 约定），否则后续行会变成无主文本", () => {
	const home = freshHome("projection-multiline");
	const file = path.join(home, MAILBOX_RELATIVE);
	const multiline = "你好，你还在吗。\n\n有一阵子没见。\n你先说话，我不急。";

	const line = appendMailboxLine(home, { speaker: "零号", text: multiline, at: new Date("2026-09-10T18:30:00Z") }, { fsync: false });

	assert.ok(!line.includes("\n"), "写成的一行里不能有换行");
	// 段落（空行）用「 ⏎  ⏎ 」、单换行用「 ⏎ 」——沿用既有数据里的写法
	assert.equal(line, "[2026/09/11 02:30] 零号: 你好，你还在吗。 ⏎  ⏎ 有一阵子没见。 ⏎ 你先说话，我不急。");
	// 关键：整条记录必须能被 v1 正则识别（后续行不再是"无主文本"）
	assert.match(line, /^\[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}\]\s*[^:]{1,30}:\s?/);
	const raw = fs.readFileSync(file, "utf8").trim();
	assert.equal(raw.split("\n").length, 1, "一条话只占一行");
	// 读回来时内容不丢
	const readBack = readRecentMailbox(home, 1);
	assert.match(readBack[0].text, /有一阵子没见/);
	assert.match(readBack[0].text, /你先说话/);
});
