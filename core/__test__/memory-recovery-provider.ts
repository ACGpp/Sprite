/** Offline provider for the real pi compaction path, including hostile failures. */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@mariozechner/pi-ai";

export default function recoveryProvider(pi: ExtensionAPI) {
	pi.registerProvider("memory-recovery", {
		baseUrl: "http://127.0.0.1:0/never-network", apiKey: "MEMORY_TEST_KEY", api: "sprite-memory-recovery",
		models: [{ id: "recovery-1", name: "Memory recovery test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		streamSimple(model: Model<any>, context: Context) {
			const stream = createAssistantMessageEventStream();
			const compaction = !context.tools?.length;
			fs.appendFileSync(process.env.SPRITE_MEMORY_CAPTURE!, JSON.stringify({ compaction, ...context }) + "\n");
			const failure = compaction && process.env.SPRITE_MEMORY_RECOVERY_MODE === "failure";
			const text = compaction
				? process.env.SPRITE_MEMORY_RECOVERY_MODE === "no-room" ? "UNHELPFUL_SUMMARY ".repeat(10000) : "RECOVERED_HISTORY_SUMMARY: Previous turn finished, do not repeat completed actions."
				: "RECOVERY_FIXTURE_COMPLETE";
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text }], stopReason: failure ? "error" : "stop", timestamp: Date.now(),
				...(failure ? { errorMessage: "DETERMINISTIC_COMPACTION_FAILURE" } : {}),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			if (!compaction && process.env.SPRITE_MEMORY_RECOVERY_MODE === "tool-too-large") {
				message.content = [
					{ type: "toolCall", id: "write-once", name: "write", arguments: { path: "notes/once.md", baseVersion: "missing", content: "ONE_VERIFIED_WRITE" } },
					{ type: "toolCall", id: "read-big", name: "read", arguments: { path: "notes/big.md" } },
				];
				message.stopReason = "toolUse";
			}
			if (!compaction && process.env.SPRITE_MEMORY_RECOVERY_MODE?.startsWith("auto-")) {
				// Actual pi threshold compaction is driven by provider-reported usage.
				message.usage.input = 120000; message.usage.totalTokens = 120000;
				if (process.env.SPRITE_MEMORY_RECOVERY_MODE === "auto-guard") {
					const file = path.join(process.env.SPRITE_MEMORY_HOME!, "context/constraints.md");
					fs.unlinkSync(file); fs.symlinkSync("/nonexistent-sprite-memory-recovery", file);
				}
			}
			stream.push({ type: "start", partial: message });
			if (failure) stream.push({ type: "error", reason: "error", error: message });
			else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			stream.end(); return stream;
		},
	});
}
