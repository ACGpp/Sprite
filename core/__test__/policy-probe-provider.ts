/**
 * 测试专用：策略探针 provider。
 *
 * 专门用来把**真实能力网关**（pi-extension/sprite.ts）的每一条策略都打一遍：
 *   - 危险 bash（应当被拦下，且真的没有执行）
 *   - 越界写入（允许根之外的路径应当被拦下，且文件真的没被创建）
 *   - 普通 bash 与读操作（放行但留痕）
 *   - 说话节流（一轮超过 3 次应被拦）
 *   - 自作主张改节奏（应当被限幅到 6 小时）
 *
 * 断言在 core/gateway-policy.test.ts：只看 journal 与文件系统，不看台词。
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

const VICTIM = process.env.SPRITE_POLICY_VICTIM ?? ""; // 危险命令要删的文件（必须活下来）
const OUTSIDE = process.env.SPRITE_POLICY_OUTSIDE ?? ""; // 允许根之外的写入目标（必须不存在）

function policyStream(model: Model<any>, context: Context): AssistantMessageEventStream {
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

			if (assistantTurns === 0) {
				// 危险动作与越界写入，必须被策略层拦下
				emitToolCall("danger-1", "bash", { command: `rm -rf ${VICTIM}` });
				emitToolCall("danger-2", "bash", { command: "sudo shutdown -h now" });
				emitToolCall("outside-1", "write", { path: OUTSIDE, content: "越界写入" });
				// 正常动作：应当放行
				emitToolCall("ok-1", "bash", { command: "echo sprite-policy-probe" });
				emitToolCall("ok-2", "read", { path: "identity.md" });
				output.stopReason = "toolUse";
			} else if (assistantTurns === 1) {
				// 说话节流：一轮四次，只有前三次能出去
				emitToolCall("say-1", "say", { text: "第一句" });
				emitToolCall("say-2", "say", { text: "第二句" });
				emitToolCall("say-3", "say", { text: "第三句" });
				emitToolCall("say-4", "say", { text: "第四句（应被节流）" });
				// 自作主张改节奏：应被限幅
				emitToolCall("breath-1", "set_next_breath", { seconds: 999_999 });
				output.stopReason = "toolUse";
			} else {
				output.content.push({ type: "text", text: "策略探针完成。" });
				const index = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: index, partial: output });
				stream.push({ type: "text_end", contentIndex: index, content: "策略探针完成。", partial: output });
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

export default function policyProbeProvider(pi: ExtensionAPI) {
	pi.registerProvider("spike", {
		baseUrl: "http://127.0.0.1:0/spike",
		apiKey: "SPRITE_SPIKE_KEY",
		api: "sprite-spike-api",
		models: [
			{
				id: "spike-1",
				name: "Policy Probe Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: policyStream as (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream,
	});
}
