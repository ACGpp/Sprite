/**
 * 从 identity.md 里读出它叫什么。
 *
 * 为什么必须有这个：内核往 mailbox.md 投影对话时需要用说话人的名字。
 * 早期实现用了一个占位名"守护灵"——那会**以错误的名字写进用户的记忆**。
 * 它的名字在 identity.md 里，必须读出来。
 */

import fs from "node:fs";
import path from "node:path";

const FALLBACK = "守护灵";

export function readCompanionName(homeDir: string): string {
	let raw = "";
	try {
		raw = fs.readFileSync(path.join(homeDir, "identity.md"), "utf8");
	} catch {
		raw = ""; // 没有 identity 不代表没有名字——继续往下从 mailbox 推断
	}

	if (raw) {
		// 1) 最明确的自述：「我叫零号」「我的名字是零号」
		const selfIntro = /我(?:的名字)?叫\s*([^\s，。,.、：:（(]{1,12})/.exec(raw);
		if (selfIntro) return selfIntro[1].trim();

		// 2) 退一步：第一个一级标题（# 我是谁 → 不是名字；# 零号 → 是名字）
		for (const line of raw.split("\n")) {
			const heading = /^#\s+(.+?)\s*$/.exec(line);
			if (!heading) continue;
			const title = heading[1].trim();
			// 「我是谁」这类是栏目名，不是名字
			if (/^(我是谁|关于我|自我介绍|identity|who am i)$/i.test(title)) continue;
			if (title.length <= 12) return title;
		}
	}

	// 3) 再退一步：文件里出现最多的人名前缀（mailbox 里的说话人）
	try {
		const mailbox = fs.readFileSync(path.join(homeDir, "conversations", "mailbox.md"), "utf8");
		const counts = new Map<string, number>();
		for (const line of mailbox.split("\n")) {
			const match = /^\[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}\]\s*([^:]{1,30}):/.exec(line);
			if (!match) continue;
			const speaker = match[1].trim();
			if (speaker === "用户") continue;
			counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
		}
		let best: string | null = null;
		for (const [name, count] of counts) if (!best || count > (counts.get(best) ?? 0)) best = name;
		if (best) return best;
	} catch {
		// 没有 mailbox 就算了
	}

	return FALLBACK;
}
