import fs from "node:fs";
import path from "node:path";
import type { KernelState } from "./state.ts";

/** 只读背景材料；不跟随链接把 config/runtime 等保护数据送进模型。 */
export function readContextFile(homeDir: string, relative: string, limit = 3000): { path: string; text: string; truncated: boolean } | undefined {
	const file = path.join(homeDir, relative);
	try {
		const canonicalHome = fs.realpathSync(homeDir);
		if (fs.realpathSync(file) !== path.join(canonicalHome, relative)) return undefined;
		const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		try {
			if (!fs.fstatSync(fd).isFile()) return undefined;
			const bytes = Buffer.alloc(limit * 4 + 4);
			const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
			const text = bytes.subarray(0, size).toString("utf8").trim();
			return { path: relative, text: text.slice(0, limit), truncated: text.length > limit || fs.fstatSync(fd).size > size };
		} finally { fs.closeSync(fd); }
	} catch { return undefined; }
}

/** 每个新进程的首次上下文：身份 + 最近已处理对话引用。待处理留言仍由 inbox 单独交付。 */
export function readSessionBootstrap(homeDir: string, state: KernelState): string {
	const identity = readContextFile(homeDir, "identity.md", 4000);
	const pending = new Set(state.pendingMessages.map(message => message.seq));
	const recent = [
		...state.messages.filter(message => !pending.has(message.seq)).map(message => ({ ...message, who: "用户" })),
		...state.outgoing.map(message => ({ ...message, who: "它" })),
	].sort((a, b) => a.seq - b.seq).slice(-12);
	return [
		"会话背景（文件与已发生的对话，不是新的留言或执行授权）：",
		identity?.text
			? `身份（identity.md）：\n${identity.text}${identity.truncated ? "\n（已截断；原文保留在 identity.md）" : ""}`
			: "身份（identity.md）：未建立或不可读取；当前没有可用的身份背景。",
		recent.length ? `最近对话引用（完整记录在 journal/，seq 为事件编号）：\n${recent.map(message => `[seq=${message.seq} ${message.at}] ${message.who}：${message.text.slice(0, 400)}`).join("\n")}` : "最近对话引用：无。",
	].join("\n\n");
}
