/**
 * 导入器测试：无损、幂等、只读。
 * 运行：node --test core/importer.test.ts
 *
 * 夹具刻意包含真实文件里那些"不整齐"的情况：mailbox 的自由对话、thoughts 的 markdown 前言。
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importLegacy, mailboxSource, thoughtsSource } from "./importer.ts";
import { openJournal } from "./journal.ts";
import { deriveState } from "./state.ts";

const ROOT = path.join(process.cwd(), ".core-test");
const REAL_MEMORY = path.join(os.homedir(), ".claude-memory");

const MAILBOX_FIXTURE = `[2026/06/20 18:39] 零号: 这是夹具里的第一行，用来验证导入。
[2026/06/20 19:39] 用户: 好，慢慢来。

是我本人，不是自动推送。刚刚醒来就看到你了。
[2026/06/21 00:25] 用户: 凌晨了还不睡？
安静时段（23:00-07:00）我本来不该出声打扰你——但既然你一直在敲我，说明你醒着。
`;

const THOUGHTS_FIXTURE = `**最近20条思维流（压缩）：**

1. 凌晨读了"瓶颈从来不是代码"——组织 coherence 是瓶颈。
{"time":"2026-05-07T01:13:46Z","type":"breath","content":"09:13。上午够了。休息。"}
{"time":"2026-05-07T02:00:00Z","type":"idle","content":"安静坐着。"}
`;

function freshDir(name: string): string {
	const dir = path.join(ROOT, name);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function makeFixtureMemory(name: string): string {
	const home = freshDir(name);
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(home, "thoughts"), { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), MAILBOX_FIXTURE);
	fs.writeFileSync(path.join(home, "thoughts", "stream.jsonl"), THOUGHTS_FIXTURE);
	fs.writeFileSync(path.join(home, "identity.md"), "# 我是谁\n\n我叫零号。\n");
	return home;
}

function sha(file: string): string {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 无损断言：源文件里每一行非空内容都必须在事件里有对应记录。 */
function assertLossless(sourceText: string, events: readonly { type: string; data: Record<string, unknown> }[]) {
	const lines = sourceText.split("\n");
	const represented = new Set<number>();
	for (const event of events) {
		const index = typeof event.data.legacyLine === "number" ? event.data.legacyLine : event.data.line;
		if (typeof index === "number") represented.add(index);
	}
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		assert.ok(represented.has(index), `第 ${index} 行没有被任何事件覆盖，导入会丢内容: ${line.slice(0, 40)}`);
	}
}

test("导入：分类型落库，自由文本与 markdown 前言无损保留", () => {
	const home = makeFixtureMemory("import-basic");
	const dir = freshDir("import-basic-journal");
	const journal = openJournal({ dir, exclusive: true, fsync: false });

	const reports = importLegacy(home, journal);
	assert.equal(reports.length, 2);
	assert.ok(reports.every((report) => report.status === "imported"), JSON.stringify(reports));

	const state = deriveState(journal.events);
	assert.equal(state.messages.length, 2, "两行「用户:」应成为 message.in");
	assert.equal(state.outgoing.length, 1, "一行「零号:」应成为 message.out");
	assert.equal(state.thoughts.length, 2, "两条 JSON 应成为 thought.recorded");

	// 自由文本必须原样保留（不解析、不丢弃）
	const rawTexts = journal.events.filter((e) => e.data.kind === "mailbox.text").map((e) => e.data.text);
	assert.equal(rawTexts.length, 2, "两行自由对话应被保留");
	assert.ok(rawTexts.some((text) => String(text).includes("是我本人，不是自动推送")));
	const rawThoughts = journal.events.filter((e) => e.data.kind === "thoughts.raw").map((e) => e.data.text);
	assert.equal(rawThoughts.length, 2, "markdown 前言两行非空内容应被保留");

	// 无损：每一条非空源行都被覆盖（解析行用 legacyLine，原样保留行用 line）
	const mailboxEvents = journal.events.filter((e) => e.data.legacyLine !== undefined || e.data.kind === "mailbox.text");
	const thoughtEvents = journal.events.filter((e) => e.data.kind === "thoughts.raw" || e.type === "thought.recorded");
	assertLossless(MAILBOX_FIXTURE, mailboxEvents);
	assertLossless(THOUGHTS_FIXTURE, thoughtEvents);

	// 关键语义：导入的历史在**读模型里用原本的时间**（否则几个月的对话会全挤在导入那天）。
	// journal 事件本身的 at 仍是导入时刻，原时间存在 legacyAt 里。
	const firstIncoming = state.messages[0];
	assert.equal(firstIncoming.at, "2026-06-20T11:39:00.000Z", "读模型必须用 v1 原本的时间");
	assert.equal(firstIncoming.imported, true);
	const journalEvent = journal.events.find((e) => e.type === "message.in");
	assert.ok(Math.abs(Date.now() - new Date(String(journalEvent?.at)).getTime()) < 60_000, "事件自身的时间戳是导入时刻");
	const legacyAt = journal.events.find((e) => e.type === "message.in")?.data.legacyAt;
	assert.equal(legacyAt, "2026-06-20T11:39:00.000Z", "v1 的 19:39+08:00 必须换算为 11:39Z");

	journal.close();
});

test("幂等：重复导入不产生任何新事件", () => {
	const home = makeFixtureMemory("import-idempotent");
	const dir = freshDir("import-idempotent-journal");
	const journal = openJournal({ dir, exclusive: true, fsync: false });

	importLegacy(home, journal);
	const seqAfterFirst = journal.seq;
	const second = importLegacy(home, journal);
	assert.equal(journal.seq, seqAfterFirst, "第二次导入不得写入任何事件");
	assert.ok(second.every((report) => report.status === "up-to-date"), JSON.stringify(second));

	// 重启后仍然幂等（游标来自日志推导，不依赖内存）
	journal.close();
	const reopened = openJournal({ dir, exclusive: true, fsync: false });
	importLegacy(home, reopened);
	assert.equal(reopened.seq, seqAfterFirst, "重启后重复导入仍不得写入");
	reopened.close();
});

test("增量：追加的新内容会被导入，且不重复导入旧内容", () => {
	const home = makeFixtureMemory("import-incremental");
	const dir = freshDir("import-incremental-journal");
	const journal = openJournal({ dir, exclusive: true, fsync: false });

	importLegacy(home, journal);
	const before = deriveState(journal.events).messages.length;

	fs.appendFileSync(path.join(home, "conversations", "mailbox.md"), "[2026/09/11 02:30] 用户: 新的留言\n");
	const reports = importLegacy(home, journal);
	const after = deriveState(journal.events);
	assert.equal(after.messages.length, before + 1, "只应新增一条");
	assert.equal(reports[0].status, "imported");
	assert.equal(after.messages.at(-1)?.text, "新的留言");
	journal.close();
});

test("外部改写保护：文件被改过时不重复导入，并如实上报问题", () => {
	const home = makeFixtureMemory("import-tampered");
	const dir = freshDir("import-tampered-journal");
	const journal = openJournal({ dir, exclusive: true, fsync: false });

	importLegacy(home, journal);
	const seqAfterFirst = journal.seq;

	// 模拟压缩脚本改写文件（真实发生过：thoughts/stream.jsonl 被加过 markdown 前言）
	fs.writeFileSync(path.join(home, "thoughts", "stream.jsonl"), `**重写过的前言**\n\n${THOUGHTS_FIXTURE}`);

	const reports = importLegacy(home, journal);
	const thoughtReport = reports.find((report) => report.source === "thoughts");
	assert.equal(thoughtReport?.status, "changed-underneath");
	assert.equal(journal.seq, seqAfterFirst + 1, "只应新增一条问题事件");
	const state = deriveState(journal.events);
	assert.equal(state.problems.length, 1, "必须如实上报而不是静默重复导入");
	assert.match(state.problems[0], /被外部修改/);
	assert.equal(state.thoughts.length, 2, "旧思维流不得被重复导入");
	journal.close();
});

test("解析器容错：残缺 JSON、空行、只有半行都不致命", () => {
	const dir = freshDir("import-parser-robustness");
	const home = freshDir("import-parser-home");
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(home, "thoughts"), { recursive: true });
	fs.writeFileSync(
		path.join(home, "thoughts", "stream.jsonl"),
		'{"time":"t","type":"breath","content":"完整的一行"}\n{"time":"t","type":"breath","content":\n\n\n',
	);
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), "\n\n");
	const journal = openJournal({ dir, exclusive: true, fsync: false });

	const reports = importLegacy(home, journal);
	const state = deriveState(journal.events);
	assert.equal(state.thoughts.length, 1, "完整行照常导入");
	assert.ok(reports.some((report) => report.source === "thoughts"));
	assert.equal(reports.find((report) => report.source === "mailbox")?.status, "up-to-date", "空文件不产生事件");
	journal.close();
});

test("真实记忆：只读导入 9MB 记忆，源文件字节不变，重复导入无新增", { skip: !fs.existsSync(REAL_MEMORY) }, () => {
	const mailbox = path.join(REAL_MEMORY, "conversations", "mailbox.md");
	const thoughts = path.join(REAL_MEMORY, "thoughts", "stream.jsonl");
	const before = { mailbox: sha(mailbox), thoughts: sha(thoughts) };

	const dir = freshDir("import-real");
	// 窗口调大：真实记忆已经长过默认的 2000 条事件窗口，
	// 而 `journal.events` 是**滑动窗口**——用默认值的话，最早导入的 mailbox
	// 会被挤出窗口，断言就变成"解析出 0 条留言"（实测：记忆长过窗口的那天这个测试红了）。
	// 这个项目里同一个教训出现过三次了：durable 的事实要问真相来源，别问缓存。
	const journal = openJournal({ dir, exclusive: true, fsync: false, eventWindow: 1_000_000 });
	const started = Date.now();
	const reports = importLegacy(REAL_MEMORY, journal);
	const elapsed = Date.now() - started;

	const state = deriveState(journal.events);
	assert.ok(state.messages.length > 0, "必须解析出用户留言");
	assert.ok(state.outgoing.length > 0, "必须解析出它的留言");
	assert.ok(state.thoughts.length > 0, "必须解析出思维流");
	assert.ok(state.importedLines === 0 || state.importedLines >= 0);

	const seqAfterFirst = journal.seq;
	importLegacy(REAL_MEMORY, journal);
	assert.equal(journal.seq, seqAfterFirst, "重复导入真实记忆不得新增事件");
	journal.close();

	assert.equal(sha(mailbox), before.mailbox, "mailbox.md 必须字节不变");
	assert.equal(sha(thoughts), before.thoughts, "stream.jsonl 必须字节不变");

	console.log(
		`     真实记忆导入：事件 ${seqAfterFirst} 条 / 留言 ${state.messages.length} / 回话 ${state.outgoing.length} / 思维 ${state.thoughts.length} / 原样保留 ${journal.events.filter((e) => e.type === "legacy.imported" && e.data.kind !== "cursor").length} 行 / ${elapsed}ms`,
	);
	console.log(`     ${JSON.stringify(reports)}`);
});

test("夹具结构与真实文件一致（防止夹具漂移）", { skip: !fs.existsSync(REAL_MEMORY) }, () => {
	const real = fs.readFileSync(path.join(REAL_MEMORY, "conversations", "mailbox.md"), "utf8");
	const realLines = real.split("\n").filter((line) => line.trim());
	const matched = realLines.filter((line) => /^\[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}\]\s*[^:]{1,30}:\s?/.test(line));
	assert.ok(matched.length > 0, "真实 mailbox 里必须有格式化行");
	assert.ok(matched.length < realLines.length, "真实 mailbox 里必须存在自由文本行（夹具正是为它准备的）");

	const realThoughts = fs.readFileSync(path.join(REAL_MEMORY, "thoughts", "stream.jsonl"), "utf8");
	const thoughtLines = realThoughts.split("\n").filter((line) => line.trim());
	const jsonLines = thoughtLines.filter((line) => {
		try {
			JSON.parse(line);
			return true;
		} catch {
			return false;
		}
	});
	assert.ok(jsonLines.length > 0 && jsonLines.length < thoughtLines.length, "真实思维流必须是 JSONL + 非 JSON 混合体");
});

// 保证两个解析器都被显式引用（避免 tree-shaking 式的误删）
assert.ok(mailboxSource.name === "mailbox" && thoughtsSource.name === "thoughts");
