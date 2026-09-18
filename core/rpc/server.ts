/**
 * RPC 服务：外壳与内核之间唯一的接口。
 *
 * 契约（§4.4）：
 *   query.status / query.snapshot —— 读模型，而不是原始存储记录
 *   command                       —— 幂等命令，只返回确认结果
 *   events.subscribe {fromSeq}     —— 按 seq 续传；断线重连不丢事件
 *
 * 传输：Unix domain socket（0600），行分隔 JSON，不监听 TCP。
 * 业务语义由 main.ts 注入（handlers），本模块只管协议、订阅与断线。
 */

import fs from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { PROTOCOL_VERSION, type JournalEvent, type RpcResponse } from "../../contracts/events.ts";
import { sanitizeDeep } from "../text.ts";

export type RpcHandlers = {
	status(): unknown;
	/** 进程级诊断（内存、运行时长、日志体积）——长跑泄漏只能靠它观察 */
	diagnostics?(): unknown;
	/** 只读记录：日记 / 探索笔记 / 对话 / 思维流（外壳不读文件，由内核交出来） */
	records?(kind: string, limit: number): unknown;
	/** 只读文档：记录里的一篇正文 */
	document?(relativePath: string): unknown;
	/** 读回一段录音（base64）——外壳不碰记忆目录，播放必须经由内核 */
	audio?(relativePath: string): unknown;
	/** 界面可改的设置（不含密钥值） */
	settings?(): unknown;
	/** 某家供应商能用哪些模型（问 pi 要，界面给下拉，省得用户猜模型名） */
	models?(provider: string): unknown;
	snapshot(): unknown;
	command(raw: unknown): unknown | Promise<unknown>;
	eventsSince(seq: number): readonly JournalEvent[];
};

export type RpcServer = {
	start(): Promise<void>;
	/** 广播一条新事件给所有订阅者（按 seq 续传的依据）。 */
	publish(event: JournalEvent): void;
	close(): void;
	readonly subscriberCount: number;
};

export function createRpcServer(options: {
	socketPath: string;
	handlers: RpcHandlers;
	log?: (message: string) => void;
}): RpcServer {
	const { socketPath, handlers, log = () => {} } = options;
	const subscribers = new Set<Socket>();
	let server: Server | null = null;

	function send(socket: Socket, payload: RpcResponse | JournalEvent) {
		if (socket.destroyed) return;
		try {
			// 出口净化：旧记忆里存在**孤立代理项**（不成对的 UTF-16），
			// 它们会以 \udXXX 转义写进 JSON，而 Swift 的 JSONDecoder 会因此
			// **拒收整个响应**——一个坏字符就让整窗记录变空白（真实用户反馈："思维流空了"）。
			// 净化放在出口这一处，任何路径的字符串都跑不掉。
			socket.write(`${JSON.stringify(sanitizeDeep(payload))}\n`);
		} catch (error) {
			log(`[rpc] 写入失败: ${String(error)}`);
		}
	}

	/** 处理器抛错不允许让调用方干等——要么有结果，要么有一条明确的错误。 */
	function safeSend(socket: Socket, id: string, type: string, run: () => unknown) {
		// 处理器允许返回 Promise（例如"问 pi 要模型清单"要起子进程）：
		// 无论同步还是异步，都必须**要么给结果、要么给一条明确的错误**，绝不让调用方干等。
		Promise.resolve()
			.then(run)
			.then((result) => send(socket, { id, ok: true, result }))
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				log(`[rpc] 处理器抛错 (${type}): ${message}`);
				send(socket, { id, ok: false, error: `内核处理失败: ${message}` });
			});
	}

	async function handle(socket: Socket, request: Record<string, unknown>) {
		const id = typeof request.id === "string" ? request.id : "";
		if (request.protocolVersion !== undefined && request.protocolVersion !== PROTOCOL_VERSION) {
			send(socket, {
				id,
				ok: false,
				error: `协议版本不匹配：内核 v${PROTOCOL_VERSION}，调用方 v${String(request.protocolVersion)}`,
			});
			return;
		}

		switch (request.type) {
			case "query.status":
				safeSend(socket, id, "query.status", () => handlers.status());
				return;
			case "query.snapshot":
				safeSend(socket, id, "query.snapshot", () => handlers.snapshot());
				return;
			case "query.records":
				if (!handlers.records) {
					send(socket, { id, ok: false, error: "内核不支持记录查询" });
					return;
				}
				safeSend(socket, id, "query.records", () =>
					handlers.records?.(String(request.kind ?? "diary"), Number(request.limit ?? 50)),
				);
				return;
			case "query.models":
				if (!handlers.models) {
					safeSend(socket, id, "query.models", () => {
						throw new Error("这个内核不支持列出模型");
					});
					break;
				}
				safeSend(socket, id, "query.models", () => handlers.models?.(String(request.provider ?? "")));
				break;
			case "query.settings":
				if (!handlers.settings) {
					safeSend(socket, id, "query.settings", () => {
						throw new Error("这个内核不支持读取设置");
					});
					break;
				}
				safeSend(socket, id, "query.settings", () => handlers.settings?.());
				break;
			case "query.audio":
				if (!handlers.audio) {
					safeSend(socket, id, "query.audio", () => {
						throw new Error("这个内核不支持读取音频");
					});
					break;
				}
				safeSend(socket, id, "query.audio", () => handlers.audio?.(String(request.path ?? "")));
				break;
			case "query.document":
				if (!handlers.document) {
					send(socket, { id, ok: false, error: "内核不支持文档读取" });
					return;
				}
				safeSend(socket, id, "query.document", () => handlers.document?.(String(request.path ?? "")));
				return;
			case "query.diagnostics":
				if (!handlers.diagnostics) {
					send(socket, { id, ok: false, error: "内核不支持诊断查询" });
					return;
				}
				safeSend(socket, id, "query.diagnostics", () => handlers.diagnostics?.());
				return;
			case "command":
				try {
					send(socket, { id, ok: true, result: await handlers.command(request.command) });
				} catch (error) {
					send(socket, { id, ok: false, error: error instanceof Error ? error.message : String(error) });
				}
				return;
			case "events.subscribe": {
				const fromSeq = Number.isInteger(request.fromSeq) ? Number(request.fromSeq) : 0;
				subscribers.add(socket);
				log(`[rpc] 新订阅者 fromSeq=${fromSeq}（当前 ${subscribers.size} 个）`);
				for (const event of handlers.eventsSince(fromSeq)) send(socket, event);
				return;
			}
			default:
				send(socket, { id, ok: false, error: `未知请求类型: ${String(request.type)}` });
		}
	}

	return {
		get subscriberCount() {
			return subscribers.size;
		},

		start() {
			return new Promise((resolve, reject) => {
				try {
					fs.unlinkSync(socketPath);
				} catch {
					// 不存在的旧 socket 直接忽略
				}
				fs.mkdirSync(socketPath.slice(0, socketPath.lastIndexOf("/")), { recursive: true });
				server = createServer((socket) => {
					let buffer = "";
					socket.setEncoding("utf8");
					socket.on("data", (chunk) => {
						buffer += chunk;
						let index;
						while ((index = buffer.indexOf("\n")) >= 0) {
							const line = buffer.slice(0, index);
							buffer = buffer.slice(index + 1);
							if (!line.trim()) continue;
							let request: Record<string, unknown>;
							try {
								request = JSON.parse(line) as Record<string, unknown>;
							} catch {
								send(socket, { id: "", ok: false, error: "请求不是合法 JSON" });
								continue;
							}
							void handle(socket, request);
						}
					});
					const drop = () => subscribers.delete(socket);
					socket.on("close", drop);
					socket.on("error", drop);
				});
				server.once("error", reject);
				server.listen(socketPath, () => {
					try {
						fs.chmodSync(socketPath, 0o600);
					} catch {
						// 权限设置失败不阻塞启动，但值得记录
					}
					log(`[rpc] 监听 ${socketPath} (0600)`);
					resolve();
				});
			});
		},

		publish(event) {
			for (const socket of subscribers) send(socket, event);
		},

		close() {
			for (const socket of subscribers) socket.destroy();
			subscribers.clear();
			server?.close();
			server = null;
			try {
				fs.unlinkSync(socketPath);
			} catch {
				// 已删除
			}
		},
	};
}

/** 测试与 CLI 用的一次性客户端。 */
export function rpcCall(socketPath: string, request: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		// 延迟 import 避免循环依赖噪音
		void import("node:net").then(({ connect }) => {
			const socket = connect(socketPath);
			let buffer = "";
			let settled = false;
			const done = (error: Error | null, value?: unknown) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				error ? reject(error) : resolve(value);
			};
			socket.setEncoding("utf8");
			socket.setTimeout(timeoutMs);
			socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
			socket.on("data", (chunk) => {
				buffer += chunk;
				const index = buffer.indexOf("\n");
				if (index < 0) return;
				try {
					done(null, JSON.parse(buffer.slice(0, index)));
				} catch (error) {
					done(error as Error);
				}
			});
			socket.on("timeout", () => done(new Error("rpc 超时")));
			socket.on("error", (error) => done(error));
		});
	});
}
