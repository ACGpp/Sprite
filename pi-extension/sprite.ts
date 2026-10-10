/**
 * Sprite 能力网关（跑在 pi 进程内的扩展）。
 *
 * 它为 pi 的工具提供内核鉴权与审计：
 *   - 每一次工具调用都留痕（tool.decided），按当前档位鉴权
 *   - 专用记忆工具经版本存储；full 模式另提供 pi 的 bash，可联网和操作本地文件
 *   - 它想说话/留话/改节奏/提问，都必须经内核决定，不能自己直接动 UI 或文件
 *
 * 专用记忆写入由内核处理；full 模式的 bash 是独立的通用执行能力，不受记忆路径白名单约束。
 * 通信：Unix socket（内核的 gateway.sock），行分隔 JSON。
 */

import { connect } from "node:net";
import path from "node:path";
import fs from "node:fs";
import { createBashToolDefinition, createGrepToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MEMORY_HOME, MAX_SAYS_PER_RUN, isReadableMemoryPath, isSecretPath, readableSearchFiles } from "./policy.ts";
import { registerMemory } from "./memory.ts";
import { createManagedBashOperations } from "./shell.ts";

const GATEWAY_SOCK = process.env.SPRITE_GATEWAY_SOCK ?? "";

/** 一次能力请求：发给内核，由内核决定后果。 */
function askCore(payload: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		if (!GATEWAY_SOCK) {
			resolve({ ok: false, error: "能力网关未连接（SPRITE_GATEWAY_SOCK 未设置）" });
			return;
		}
		const socket = connect(GATEWAY_SOCK);
		let buffer = "";
		let settled = false;
		const done = (value: Record<string, unknown>) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		socket.setEncoding("utf8");
		socket.setTimeout(timeoutMs);
		socket.on("connect", () => socket.write(`${JSON.stringify({ ...payload, ...(process.env.SPRITE_AGENT_GENERATION ? { generation: process.env.SPRITE_AGENT_GENERATION } : {}) })}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const index = buffer.indexOf("\n");
			if (index < 0) return;
			try {
				done(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
			} catch {
				done({ ok: false, error: "内核返回了无法解析的响应" });
			}
		});
		socket.on("timeout", () => done({ ok: false, error: "能力网关超时" }));
		socket.on("error", (error) => done({ ok: false, error: `能力网关不可达: ${error.message}` }));
	});
}

export default function spriteGateway(pi: ExtensionAPI) {
	registerMemory(pi, askCore);
	if (process.env.SPRITE_AGENT_SHELL === "full") pi.registerTool(createBashToolDefinition(process.cwd(), { operations: createManagedBashOperations() }));
	// Built-in grep follows links and searches settings beneath a permitted parent.
	// Keep pi's matcher/formatting, but enumerate only policy-approved regular files.
	const grep = createGrepToolDefinition(MEMORY_HOME);
	if (process.env.SPRITE_AGENT_SHELL !== "off") pi.registerTool({
		...grep,
		async execute(id, params, signal, onUpdate, ctx) {
			const files = readableSearchFiles(params.path ?? ".", MEMORY_HOME, params.glob);
			const chunks: string[] = [];
			const limit = Math.max(1, Math.min(1000, params.limit ?? 100));
			let lines = 0;
			for (const file of files) {
				if (signal?.aborted) throw new Error("Operation aborted");
				// Recheck immediately before each actual read, including realpath.
				if (isSecretPath(file) || fs.lstatSync(file).isSymbolicLink()) continue;
				const result = await grep.execute(id, { ...params, path: file, glob: undefined, limit: limit - lines }, signal, undefined, ctx);
				const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
				if (!text || text === "No matches found") continue;
				chunks.push(`${path.relative(MEMORY_HOME, file)}:\n${text}`);
				lines += text.split("\n").length;
				if (lines >= limit || chunks.join("\n").length >= 50_000) break;
			}
			return { content: [{ type: "text", text: chunks.join("\n").slice(0, 50_000) || "No matches found" }], details: undefined };
		},
	});
	let saysThisRun = 0;
	pi.on("before_agent_start", () => {
		saysThisRun = 0;
	});

	// ─── 它自己的"手" ───

	pi.registerTool({
		name: "say",
		label: "Say",
		description:
			"说一句话给用户听。**回话时该说就说**；定时醒来时，如果有由头（很久没说话、刚写完东西、安静时段刚结束）也可以说一句——" +
			"内核会按每天的额度限流，超了自动记成留言不打扰他。别用它汇报进度或刷存在感。",
		promptSnippet: "say(text): 说一句想对用户说的话",
		promptGuidelines: [
			"When the user just wrote to you, answering with say is normal.",
			"On a scheduled wake, say something only when there is a reason (long silence, you just wrote something, quiet hours just ended).",
			"Do not use say to report progress or to fill silence; the kernel rate-limits it per day.",
		],
		parameters: Type.Object({ text: Type.String({ description: "要说的话，一到两句" }) }),
		async execute(_toolCallId, params) {
			const result = await askCore({ kind: "capability.say", text: params.text });
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "leave_message",
		label: "Leave Message",
		description: "给用户留一条话，写进对话记录。适合「想说的不用马上看到」的内容。",
		parameters: Type.Object({ text: Type.String({ description: "留言内容" }) }),
		async execute(_toolCallId, params) {
			const result = await askCore({ kind: "capability.leave_message", text: params.text });
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "set_next_breath",
		label: "Set Next Breath",
		description: "决定自己下一次什么时候醒来（秒）。内核会限幅在 30 秒到 6 小时之间。想多休息一会儿时用。",
		parameters: Type.Object({ seconds: Type.Number({ description: "距离下次醒来多少秒" }) }),
		async execute(_toolCallId, params) {
			const result = await askCore({ kind: "capability.set_next_breath", seconds: params.seconds });
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: "有一个必须由用户决定的问题时用。不会阻塞你，问题会出现在它的面板上。",
		parameters: Type.Object({
			question: Type.String({ description: "要问的问题" }),
			options: Type.Optional(Type.Array(Type.String(), { description: "可选项，最多四个" })),
		}),
		async execute(_toolCallId, params) {
			const result = await askCore({
				kind: "capability.ask_user",
				question: params.question,
				options: params.options ?? [],
			});
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	// ─── 策略层：每一次工具调用都留痕，越界与危险动作拒绝 ───

	pi.on("tool_call", async (event) => {
		const input = event.input as Record<string, unknown>;
		const authorization = await askCore({ kind: "tool.authorize", tool: event.toolName, input: String(input.path ?? input.command ?? "").slice(0, 200) });
		if (authorization.ok !== true) return { block: true, reason: String(authorization.error ?? "当前权限不允许执行工具") };

		// 说话节流放在这里而不是 execute 里：pi 的 tool_call 是**顺序预检**，
		// 而 execute 是并发执行——在 execute 里计数会有竞态。
		if (event.toolName === "say") {
			if (saysThisRun >= MAX_SAYS_PER_RUN) {
				await askCore({
					kind: "tool.decided",
					tool: "say",
					decision: "block",
					reason: `本轮已说过 ${MAX_SAYS_PER_RUN} 次`,
				});
				return { block: true, reason: "这一轮已经说过话了。把想说的留到下次醒来，别刷屏。" };
			}
			saysThisRun += 1;
			await askCore({ kind: "tool.decided", tool: "say", decision: "allow" });
			return undefined;
		}

		// write/edit are overrides implemented by the kernel's versioned memory store.

		// 密钥文件（config/settings.json、llm.conf）与内核运行时：读也不许。
		// 没有哪条正当理由需要它读自己的 API key——这一条是"不主动递钥匙"。
		const candidate = String(input.path ?? input.file_path ?? input.command ?? "");
		if (["read", "grep", "find", "ls", "write", "edit", "memory_propose"].includes(event.toolName) && !isReadableMemoryPath(candidate || ".")) {
			await askCore({ kind: "tool.decided", tool: event.toolName, decision: "block", reason: "路径越界或受保护文件", input: candidate.slice(0, 200) });
			return { block: true, reason: "这个文件里是它自己的密钥或内核运行时数据，不能读。" };
		}

		// 其余读操作放行但留痕：它需要能翻世界，但每一步都要可解释
		const summary = String(input.path ?? input.command ?? input.pattern ?? "").slice(0, 200);
		await askCore({ kind: "tool.decided", tool: event.toolName, decision: "allow", input: summary });
		return undefined;
	});
}
