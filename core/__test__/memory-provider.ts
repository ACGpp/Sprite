/** Actual pi provider fixture: deterministic in-process responses, never network. */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type ToolCall } from "@mariozechner/pi-ai";

let calls = 0;
export default function memoryProvider(pi: ExtensionAPI) {
	pi.registerProvider("memory-test", {
		baseUrl: "http://127.0.0.1:0/never-network", apiKey: "MEMORY_TEST_KEY", api: "sprite-memory-test",
		models: [{ id: "memory-1", name: "Memory test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		streamSimple(model: Model<any>, context: Context) {
			const stream = createAssistantMessageEventStream();
			const invocation = calls++;
			// Record before any behavior, including when signal is already aborted. A missing
			// capture proves the product stopped before this potentially uncooperative provider.
			fs.appendFileSync(process.env.SPRITE_MEMORY_CAPTURE!, JSON.stringify({ invocation, ...context }) + "\n");
			const output: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			stream.push({ type: "start", partial: output });
			const tool = (id: string, name: string, args: Record<string, unknown>) => {
				const toolCall: ToolCall = { type: "toolCall", id, name, arguments: args };
				const contentIndex = output.content.push(toolCall) - 1;
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
				stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: output });
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
				output.stopReason = "toolUse";
			};
			const result = (id: string) => {
				const message = context.messages.find(m => m.role === "toolResult" && m.toolCallId === id);
				if (!message) throw new Error(`Missing actual tool result: ${id}`);
				return JSON.parse(message.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
			};
			try {
				const mode = process.env.SPRITE_MEMORY_MODE;
				if (mode === "schedule" && (invocation === 0 || (invocation < 3 && String(context.messages.at(-1)?.content).startsWith("内核记忆快照：")))) {
					tool(`schedule-${invocation}`, "set_next_breath", { seconds: 3600 });
				} else if (mode === "tools" && invocation === 0) {
					tool("read-note", "read", { path: "notes/existing.md" });
					tool("read-identity", "read", { path: "identity.md" });
					tool("read-constraints", "read", { path: "context/constraints.md" });
				} else if (mode === "tools" && invocation === 1) {
					tool("write-note", "write", { path: "notes/existing.md", content: "UPDATED_NOTE", baseVersion: result("read-note").version });
					tool("write-identity", "write", { path: "identity.md", content: "SELF_AUTHORED_IDENTITY", baseVersion: result("read-identity").version });
					tool("write-constraints", "write", { path: "context/constraints.md", content: "UNAUTHORIZED_CONSTRAINT", baseVersion: result("read-constraints").version });
					tool("propose-constraints", "memory_propose", { path: "context/constraints.md", content: "PROPOSED_CONSTRAINT", baseVersion: result("read-constraints").version, reason: "Only a proposal; not applied" });
				} else if ((mode === "refresh" || mode === "corrupt-next") && invocation === 0) {
					const file = path.join(process.env.SPRITE_MEMORY_HOME!, "context/constraints.md");
					if (mode === "refresh") fs.writeFileSync(file, "TOOL_UPDATED_START\n" + "x".repeat(4000) + "\nTOOL_UPDATED_TAIL");
					else { fs.unlinkSync(file); fs.symlinkSync("/nonexistent-sprite-memory-research", file); }
					tool("refresh-read", "read", { path: "notes/existing.md" });
				} else {
					const text = "MEMORY_FIXTURE_COMPLETE";
					output.content.push({ type: "text", text });
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
				}
				stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
			} catch (error) {
				output.stopReason = "error"; output.errorMessage = String(error);
				stream.push({ type: "error", reason: "error", error: output });
			}
			stream.end(); return stream;
		},
	});
}
