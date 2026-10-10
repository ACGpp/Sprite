/** Persistent pi RPC; each process owns its buffers, requests and callbacks. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type PiEvent = { type: string; [key: string]: unknown };
type Response = { success?: boolean; [key: string]: unknown };
export type PiClient = {
	start(): void;
	send(command: Record<string, unknown>, timeoutMs?: number): Promise<Response>;
	onEvent(handler: (event: PiEvent) => void): void;
	readonly alive: boolean;
	/** Flush events already emitted by pi before evaluating a terminal event. */
	flushEvents(): Promise<void>;
	/** Resolve only after the process has stopped; escalates if SIGTERM is ignored. */
	terminate(): Promise<void>;
	stop(): void;
};
export type PiAgent = Pick<PiClient, "send" | "onEvent"> & Partial<Pick<PiClient, "terminate" | "flushEvents">>;

type ProcessState = {
	child: ChildProcessWithoutNullStreams;
	buffer: string;
	pending: Map<string, { resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
	exited: Promise<void>;
	closed: boolean;
	groupKilled?: boolean;
	terminating?: Promise<void>;
};

export function createPiRpc(options: {
	bin: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
	onExit?: (info: { code: number | null; signal: string | null }) => void;
}): PiClient {
	let current: ProcessState | null = null;
	let handler: ((event: PiEvent) => void) | null = null;
	let requestSerial = 0;

	function rejectPending(state: ProcessState, reason: string) {
		for (const entry of state.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error(reason));
		}
		state.pending.clear();
	}
	function killProcess(state: ProcessState, signal: NodeJS.Signals) {
		if (state.closed && signal !== "SIGKILL") return;
		// Kill a detached group only once, while handling its owner's exit. Later
		// repeated cleanup must not target a PID that the OS could have reused.
		if (signal === "SIGKILL") {
			if (state.groupKilled) return;
			state.groupKilled = true;
		}
		// pi's shell children share this isolated process group. Stopping only pi
		// would allow a timed-out shell command to continue modifying files.
		try {
			if (process.platform !== "win32" && state.child.pid) process.kill(-state.child.pid, signal);
			else state.child.kill(signal);
		} catch { state.child.kill(signal); }
	}
	function terminate(state: ProcessState): Promise<void> {
		if (state.terminating) return state.terminating;
		state.terminating = (async () => {
			if (state.closed) return;
			rejectPending(state, "pi 正在停止");
			killProcess(state, "SIGTERM");
			const timer = setTimeout(() => killProcess(state, "SIGKILL"), 500);
			try { await state.exited; } finally {
				clearTimeout(timer);
				// A shell descendant may ignore TERM even when pi has exited.
				killProcess(state, "SIGKILL");
			}
		})();
		return state.terminating;
	}
	const client: PiClient = {
		get alive() { return current !== null && !current.closed && !current.terminating; },
		start() {
			if (current && !current.closed) throw new Error("pi 旧进程尚未退出");
			const child = spawn(options.bin, options.args, {
				cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) },
				stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
			});
			let exited!: () => void;
			const state: ProcessState = { child, buffer: "", pending: new Map(), closed: false, exited: new Promise(resolve => { exited = resolve; }) };
			current = state;
			let reported = false;
			const finish = (code: number | null, signal: string | null) => {
				if (reported) return;
				reported = true;
				state.closed = true;
				// A crashed pi can leave descendants alive even though its own PID is
				// gone. Revoke the entire group before reporting exit/replacing pi.
				killProcess(state, "SIGKILL");
				rejectPending(state, `pi 已退出 (code=${code})`);
				exited();
				if (current === state) {
					handler?.({ type: "_process_exit", code, signal });
					options.onExit?.({ code, signal });
				}
			};
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				if (current !== state || state.closed || state.terminating) return;
				state.buffer += chunk;
				let index: number;
				while ((index = state.buffer.indexOf("\n")) >= 0) {
					const line = state.buffer.slice(0, index).replace(/\r$/, "");
					state.buffer = state.buffer.slice(index + 1);
					if (!line.trim()) continue;
					let message: PiEvent;
					try { message = JSON.parse(line) as PiEvent; }
					catch { handler?.({ type: "_unparsed", raw: line }); continue; }
					if (message.type === "response" && typeof message.id === "string") {
						const pending = state.pending.get(message.id);
						if (pending) { clearTimeout(pending.timer); state.pending.delete(message.id); pending.resolve(message); }
						continue;
					}
					handler?.(message);
				}
			});
			// Drain stderr without exposing provider diagnostics containing credentials.
			child.stderr.resume();
			child.on("exit", finish);
			child.on("error", () => finish(null, "spawn-error"));
			child.stdin.on("error", () => rejectPending(state, "pi 输入管道已关闭"));
		},
		onEvent(next) { handler = next; },
		// pi acknowledges prompts only after preflight, which can include an actual
		// model compaction call. The breath controller still enforces its own deadline.
		send(command, timeoutMs = command.type === "prompt" ? 120_000 : 20_000) {
			return new Promise((resolve, reject) => {
				const state = current;
				if (!state || state.closed || state.terminating) { reject(new Error("pi 未启动或正在停止")); return; }
				const id = String(command.id ?? `rpc-${++requestSerial}`);
				if (state.pending.has(id)) { reject(new Error("pi 请求 ID 已在使用")); return; }
				const timer = setTimeout(() => { state.pending.delete(id); reject(new Error(`pi 响应超时: ${String(command.type)}`)); }, timeoutMs);
				state.pending.set(id, { resolve, reject, timer });
				state.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
			});
		},
		async flushEvents() { await client.send({ type: "get_state" }); },
		async terminate() { if (current) await terminate(current); },
		stop() {
			// Synchronous callers may close journal immediately after stop().
			handler = null;
			if (current) void terminate(current);
		},
	};
	return client;
}
