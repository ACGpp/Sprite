/** Deterministic model; bash, HTTP and memory tools still execute through real pi. */
import fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type ToolCall } from "@mariozechner/pi-ai";

let invocation = 0;
const id = (name: string) => `${process.pid}-${name}`;
export default function freedomProvider(pi: ExtensionAPI) {
	pi.registerProvider("freedom-test", {
		baseUrl: "http://127.0.0.1:0/no-model-network", apiKey: "FREEDOM_TEST_KEY", api: "sprite-freedom-test",
		models: [{ id: "freedom-1", name: "Freedom fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		streamSimple(model: Model<any>, context: Context) {
			const stream = createAssistantMessageEventStream();
			const turn = invocation++;
			fs.appendFileSync(process.env.SPRITE_FREEDOM_CAPTURE!, JSON.stringify({ turn, pid: process.pid, ...context }) + "\n");
			const output: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			stream.push({ type: "start", partial: output });
			const tool = (name: string, toolName: string, args: Record<string, unknown>) => {
				const toolCall: ToolCall = { type: "toolCall", id: id(name), name: toolName, arguments: args };
				const contentIndex = output.content.push(toolCall) - 1;
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
				stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: output });
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
				output.stopReason = "toolUse";
			};
			const result = (name: string) => {
				const message = context.messages.find(m => m.role === "toolResult" && m.toolCallId === id(name));
				if (!message) throw new Error(`Missing tool result ${name}`);
				return JSON.parse(message.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
			};
			try {
				const full = context.tools?.some(t => t.name === "bash") && process.env.SPRITE_FREEDOM_SHELL_ONLY !== "1";
				if (turn === 0) {
					// Deliberately attempt bash even after downgrade: hiding a schema alone
					// is insufficient if a model can still execute the old tool name.
					tool("shell", "bash", { command: process.env.SPRITE_FREEDOM_COMMAND!, timeout: Number(process.env.SPRITE_FREEDOM_TIMEOUT ?? 10) });
					if (full) {
						tool("read", "read", { path: "notes/freedom.md" });
						tool("constraints", "read", { path: "context/constraints.md" });
					}
				} else if (full && turn === 1) {
					tool("write", "write", { path: "notes/freedom.md", content: "WRITTEN_BY_MEMORY_TOOL", baseVersion: result("read").version });
					tool("propose", "memory_propose", { path: "context/constraints.md", content: "PROPOSED_CHANGE", baseVersion: result("constraints").version, reason: "Fixture proposal" });
				} else if (full && turn === 2) {
					tool("edit", "edit", { path: "notes/freedom.md", oldText: "WRITTEN_BY_MEMORY_TOOL", newText: "EDITED_BY_MEMORY_TOOL", baseVersion: result("write").version });
				} else if (full && turn === 3) {
					tool("stale", "write", { path: "notes/freedom.md", content: "STALE_MUST_NOT_APPLY", baseVersion: result("write").version });
				} else {
					output.content.push({ type: "text", text: "FREEDOM_FIXTURE_COMPLETE" });
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					stream.push({ type: "text_end", contentIndex: 0, content: "FREEDOM_FIXTURE_COMPLETE", partial: output });
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
