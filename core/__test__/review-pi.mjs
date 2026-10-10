#!/usr/bin/env node
// 离线 RPC 引擎：记录实际收到的提示词、工具列表和凭据匹配结果，不记录密钥值。
import fs from "node:fs";
import readline from "node:readline";
import net from "node:net";

// Test captures belong to the fixture, even when pi runs from isolated runtime cwd.
if (process.env.SPRITE_MEMORY_HOME) process.chdir(process.env.SPRITE_MEMORY_HOME);

const args = process.argv.slice(2);
const toolsIndex = args.indexOf("--tools");
let activeTools = toolsIndex >= 0 ? args[toolsIndex + 1].split(",") : ["read", "bash", "edit", "write"];
const expectedKey = process.env.SPRITE_REVIEW_EXPECTED_KEY;
const append = (name, entry) => fs.appendFileSync(name, `${JSON.stringify(entry)}\n`);
const emit = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);
append("starts.jsonl", { pid: process.pid, args, generation: process.env.SPRITE_AGENT_GENERATION });
for await (const line of readline.createInterface({ input: process.stdin })) {
	if (!line.trim()) continue;
	const request = JSON.parse(line);
	append("commands.jsonl", { type: request.type, id: request.id });
	if (request.type === "set_active_tools") activeTools = request.toolNames;
	emit({ type: "response", id: request.id, success: true });
	if (request.type !== "prompt") continue;
	append("prompts.jsonl", {
		message: request.message,
		tools: activeTools,
		providerKeyMatches: Boolean(expectedKey && process.env.DEEPSEEK_API_KEY === expectedKey),
		customKeyMatches: Boolean(expectedKey && process.env.SPRITE_CUSTOM_API_KEY === expectedKey),
		providerNextKeyMatches: Boolean(process.env.SPRITE_REVIEW_NEXT_KEY && process.env.DEEPSEEK_API_KEY === process.env.SPRITE_REVIEW_NEXT_KEY),
		customNextKeyMatches: Boolean(process.env.SPRITE_REVIEW_NEXT_KEY && process.env.SPRITE_CUSTOM_API_KEY === process.env.SPRITE_REVIEW_NEXT_KEY),
	});
	if (process.env.SPRITE_REVIEW_SAY) {
		await new Promise((resolve, reject) => {
			const socket = net.connect(process.env.SPRITE_GATEWAY_SOCK);
			socket.on("connect", () => socket.write(JSON.stringify({ kind: "capability.say", generation: process.env.SPRITE_AGENT_GENERATION, text: "EXPLICIT_WAKE_REPLY" }) + "\n"));
			socket.on("data", () => { socket.destroy(); resolve(); });
			socket.on("error", reject);
		});
	}
	emit({ type: "agent_end", messages: [] });
}
