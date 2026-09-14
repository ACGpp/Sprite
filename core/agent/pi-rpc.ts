/**
 * 常驻 pi 的 RPC 客户端。
 *
 * 分帧必须严格按 LF 切分：pi 的协议明确要求不能用 readline 之类的通用行读取器
 * （它们会把 U+2028/U+2029 也当换行，而那在 JSON 字符串里是合法字符）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type PiEvent = { type: string; [key: string]: unknown };

export type PiClient = {
	start(): void;
	send(command: Record<string, unknown>, timeoutMs?: number): Promise<{ success?: boolean; [key: string]: unknown }>;
	onEvent(handler: (event: PiEvent) => void): void;
	readonly alive: boolean;
	stop(): void;
};

/** 只暴露呼吸循环需要的那部分接口，便于测试注入假实现。 */
export type PiAgent = Pick<PiClient, "send"> & { onEvent(handler: (event: PiEvent) => void): void };

export function createPiRpc(options: {
	bin: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
	onExit?: (info: { code: number | null; signal: string | null }) => void;
}): PiClient {
	let child: ChildProcessWithoutNullStreams | null = null;
	let stdoutBuffer = "";
	let stderr = "";
	let handler: ((event: PiEvent) => void) | null = null;
	const pending = new Map<string, (response: { success?: boolean; [key: string]: unknown }) => void>();

	function handleLine(line: string) {
		let message: PiEvent;
		try {
			message = JSON.parse(line) as PiEvent;
		} catch {
			handler?.({ type: "_unparsed", raw: line });
			return;
		}
		if (message.type === "response" && typeof message.id === "string" && pending.has(message.id)) {
			const resolve = pending.get(message.id);
			pending.delete(message.id);
			resolve?.(message);
			return;
		}
		handler?.(message);
	}

	return {
		get alive() {
			return child !== null && child.exitCode === null && !child.killed;
		},

		start() {
			child = spawn(options.bin, options.args, {
				cwd: options.cwd,
				env: { ...process.env, ...(options.env ?? {}) },
				stdio: ["pipe", "pipe", "pipe"],
			});
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdoutBuffer += chunk;
				let index: number;
				while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
					const line = stdoutBuffer.slice(0, index).replace(/\r$/, "");
					stdoutBuffer = stdoutBuffer.slice(index + 1);
					if (line.trim()) handleLine(line);
				}
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr = `${stderr}${chunk}`.slice(-4000);
			});
			child.on("exit", (code, signal) => {
				for (const [id, resolve] of pending) {
					pending.delete(id);
					resolve({ success: false, error: `pi 已退出 (code=${code})` });
				}
				options.onExit?.({ code, signal });
			});
		},

		onEvent(next) {
			handler = next;
		},

		send(command, timeoutMs = 20_000) {
			return new Promise((resolve, reject) => {
				if (!child) {
					reject(new Error("pi 未启动"));
					return;
				}
				const id = String(command.id ?? "");
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`pi 响应超时: ${String(command.type)}`));
				}, timeoutMs);
				pending.set(id, (response) => {
					clearTimeout(timer);
					resolve(response);
				});
				child.stdin.write(`${JSON.stringify(command)}\n`);
			});
		},

		stop() {
			// 先摘掉观察者再杀进程：否则关停途中仍在管道里的 stdout 会被继续分发，
			// 触发对已关闭 journal 的写入（EBADF）。
			handler = null;
			pending.clear();
			child?.kill("SIGTERM");
			child = null;
		},
	};
}
