/**
 * 测试专用：离线假 provider。
 *
 * 让端到端测试能用真实 pi 进程、真实扩展、真实内核，但不联网、不用真实 API key。
 * 行为是确定的，便于断言：
 *   第 1 轮：调 say（走能力网关回内核）
 *   第 2 轮：说一句话，结束
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@mariozechner/pi-ai";

function fakeStream(model: Model<any>, context: Context): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const emitText = (text: string) => {
			output.content.push({ type: "text", text });
			const index = output.content.length - 1;
			stream.push({ type: "text_start", contentIndex: index, partial: output });
			stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
			stream.push({ type: "text_end", contentIndex: index, content: text, partial: output });
		};

		const emitToolCall = (id: string, name: string, args: Record<string, unknown>) => {
			const toolCall: ToolCall = { type: "toolCall", id, name, arguments: args };
			output.content.push(toolCall);
			const index = output.content.length - 1;
			stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
			stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(args), partial: output });
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
		};

		try {
			stream.push({ type: "start", partial: output });
			const assistantTurns = context.messages.filter((message) => message.role === "assistant").length;
			// 汇报它看到多少历史——用来验证"重启后还记得"（会话连续性）
			const history = context.messages.length;

			if (assistantTurns === 0) {
				emitText(`看完了 9 号的日记。（历史 ${history} 条）`);
				emitToolCall("call_say_1", "say", { text: "我在，今天想读点东西。" });
				// 第二个工具调用：验证 ask_user 这条能力通路（问题要能落到内核并显示出来）
				emitToolCall("call_ask_1", "ask_user", {
					question: "今天想让我读点什么？",
					options: ["潮汐那篇", "随便读读", "先不用"],
				});
				output.stopReason = "toolUse";
			} else {
				emitText(`今天先待着。（历史 ${history} 条）`);
				output.stopReason = "stop";
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: "error", error: output });
			stream.end();
		}
	})();

	return stream;
}

export default function fakeProvider(pi: ExtensionAPI) {
	pi.registerProvider("spike", {
		baseUrl: "http://127.0.0.1:0/spike",
		apiKey: "SPRITE_SPIKE_KEY",
		api: "sprite-spike-api",
		models: [
			{
				id: "spike-1",
				name: "Spike Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: fakeStream as (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream,
	});
}
