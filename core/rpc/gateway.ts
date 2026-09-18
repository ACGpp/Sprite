/**
 * 能力网关的服务端：接收来自 pi 扩展的能力请求。
 *
 * 与外壳 RPC 分开两条 socket，是因为它们面对的是不同的调用方：
 *   core.sock    —— 外壳（受信任的本地 UI），可以把状态全量读出去
 *   gateway.sock —— agent 扩展（跑在 pi 进程里），只能请求"做一件事"，不能读状态
 *
 * 协议刻意保持最小：`{kind, ...}` 进，`{ok, ...}` 出。agent 不需要、也不应该拿到更多。
 */

import fs from "node:fs";
import { createServer, type Server } from "node:net";

export type GatewayRequest = { kind: string; [key: string]: unknown };
export type GatewayResponse = { ok: boolean; [key: string]: unknown };

export type GatewayServer = {
	start(): Promise<void>;
	close(): void;
};

export function createGatewayServer(options: {
	socketPath: string;
	handle(request: GatewayRequest): GatewayResponse | Promise<GatewayResponse>;
	log?: (message: string) => void;
}): GatewayServer {
	const { socketPath, handle, log = () => {} } = options;
	let server: Server | null = null;

	return {
		start() {
			return new Promise((resolve, reject) => {
				try {
					fs.unlinkSync(socketPath);
				} catch {
					// 旧 socket 不存在
				}
				fs.mkdirSync(socketPath.slice(0, socketPath.lastIndexOf("/")), { recursive: true });
				server = createServer((socket) => {
					let buffer = "";
					socket.setEncoding("utf8");
					socket.on("data", (chunk) => {
						buffer += chunk;
						let index: number;
						while ((index = buffer.indexOf("\n")) >= 0) {
							const line = buffer.slice(0, index);
							buffer = buffer.slice(index + 1);
							if (!line.trim()) continue;
							let request: GatewayRequest;
							try {
								request = JSON.parse(line) as GatewayRequest;
							} catch {
								socket.write(`${JSON.stringify({ ok: false, error: "请求不是合法 JSON" })}\n`);
								continue;
							}
							void Promise.resolve()
								.then(() => handle(request))
								.catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
								.then((response) => socket.write(`${JSON.stringify(response)}\n`));
						}
					});
					socket.on("error", () => {});
				});
				server.once("error", reject);
				server.listen(socketPath, () => {
					try {
						fs.chmodSync(socketPath, 0o600);
					} catch {
						// 权限设置失败不阻塞启动
					}
					log(`[gateway] 监听 ${socketPath} (0600)`);
					resolve();
				});
			});
		},

		close() {
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
