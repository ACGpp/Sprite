// 审查回归专用离线 provider：只使用夹具数据，不发网络请求。
import fs from "node:fs";
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

let reviewAttempt = 0;

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
			const mode = process.env.SPRITE_REVIEW_MODE;
			fs.writeFileSync(process.env.SPRITE_REVIEW_CAPTURE!, JSON.stringify(context));
			if (mode === "retry-success" || mode === "retry-fail") {
				reviewAttempt += 1;
				fs.writeFileSync(`${process.env.SPRITE_REVIEW_CAPTURE!}.attempts`, String(reviewAttempt));
				if (mode === "retry-fail" || reviewAttempt === 1) {
					output.stopReason = "error";
					output.errorMessage = "HTTP 503 service unavailable TEST_ONLY";
					stream.push({ type: "error", reason: "error", error: output }); stream.end(); return;
				}
				emitText("REAL_PI_RETRY_COMPLETED");
				stream.push({ type: "done", reason: "stop", message: output }); stream.end(); return;
			}
			if (mode === "error") {
				output.stopReason = "error";
				output.errorMessage = "HTTP 401 TEST_ONLY";
				stream.push({ type: "error", reason: "error", error: output }); stream.end(); return;
			}
			if (mode === "inspect") {
				emitText("inspection complete");
				stream.push({ type: "done", reason: "stop", message: output }); stream.end(); return;
			}
			if (mode === "secrets") {
				if (!context.messages.some(message => message.role === "assistant")) {
					emitToolCall("allowed", "read", {path:"notes/allowed.txt"});
					emitToolCall("link", "read", {path:"notes/link.txt"});
					emitToolCall("recursive", "grep", {path:"config",pattern:"TEST_ONLY_SECRET",ignoreCase:false});
					output.stopReason="toolUse";
				} else { emitText("secret path probe complete"); }
				stream.push({type:"done",reason:output.stopReason as "stop" | "toolUse",message:output});stream.end();return;
			}

			throw new Error("Unknown review mode");
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
