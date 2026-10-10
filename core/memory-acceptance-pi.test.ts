/** Independent acceptance: actual pi CLI, fake provider, isolated homes only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { reviewFixture } from "./__test__/review-fixture.ts";
import { piBin, skipWithoutPi } from "./__test__/pi-available.ts";
import { patchSettings } from "./settings.ts";
import { memoryTools } from "../contracts/memory-policy.ts";
import { startKernel } from "./main.ts";

const skip = skipWithoutPi();
const provider = path.resolve("core/__test__/memory-provider.ts");
type Capture = { tools?: { name: string }[]; messages: unknown[] };

for (const mode of ["readonly", "off"] as const) test(`独立验收：真实pi ${mode} 工具与能力一致且仍含必要背景`, { skip, timeout: 30000 }, async t => {
	const f = reviewFixture(t, `accept-mode-${mode}`);
	fs.mkdirSync(path.join(f.homeDir, "context"));
	fs.writeFileSync(path.join(f.homeDir, "identity.md"), "ACCEPT_IDENTITY");
	fs.writeFileSync(path.join(f.homeDir, "context/constraints.md"), "ACCEPT_CONSTRAINT_END");
	patchSettings(f.homeDir, { model: { mode: "provider", provider: "memory-test", model: "memory-1", apiKey: "TEST_ONLY" }, security: { agentShell: mode } });
	const kernel = await f.start({ piBin: piBin(), piExtensions: [provider], piEnv: { MEMORY_TEST_KEY: "TEST_ONLY", SPRITE_MEMORY_CAPTURE: path.join(f.homeDir, "captures.jsonl"), SPRITE_MEMORY_MODE: "inspect" } });
	t.after(() => kernel.shutdown());
	assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true);
	const captures = f.readLines<Capture>("captures.jsonl");
	assert.equal(captures.length, 1);
	assert.deepEqual(captures[0]!.tools!.map(tool => tool.name).sort(), memoryTools(mode).sort());
	assert.ok(!captures[0]!.tools!.some(tool => ["bash", "write", "edit", "memory_propose"].includes(tool.name)));
	const context = JSON.stringify(captures[0]!.messages);
	assert.match(context, new RegExp(`档位 ${mode}`));
	assert.match(context, /ACCEPT_IDENTITY/); assert.match(context, /ACCEPT_CONSTRAINT_END/);
});

test("独立验收：继承pi用户配置不得执行auth.json里的shell密钥命令", { skip, timeout: 30000 }, async t => {
	const f = reviewFixture(t, "accept-auth-isolation");
	const legacyAgentDir = path.join(f.homeDir, "pi-home/.pi/agent");
	fs.mkdirSync(legacyAgentDir, { recursive: true });
	const marker = path.join(f.homeDir, "unapproved-shell-ran");
	// Real pi supports !command credentials. The command only creates a fixture marker.
	const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	fs.writeFileSync(path.join(legacyAgentDir, "auth.json"), JSON.stringify({ "memory-test": { type: "api_key", key: `!touch ${shellQuote(marker)}; printf TEST_ONLY` } }));
	patchSettings(f.homeDir, { model: { mode: "provider", provider: "memory-test", model: "memory-1", apiKey: "TEST_ONLY" }, security: { agentShell: "on" } });
	// Exercise the production default, without the fixture's intentional agentDir override.
	const kernel = await startKernel({ ...f.config, piBin: piBin(), piExtensions: [provider], piEnv: { HOME: path.join(f.homeDir, "pi-home"), MEMORY_TEST_KEY: "TEST_ONLY", SPRITE_MEMORY_CAPTURE: path.join(f.homeDir, "captures.jsonl"), SPRITE_MEMORY_MODE: "inspect" } });
	t.after(() => kernel.shutdown());
	assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true, "隔离后仍须能正常调用明确配置的provider");
	assert.equal(f.readLines<Capture>("captures.jsonl").length, 1);
	assert.equal(fs.existsSync(marker), false, "禁用bash工具仍不应执行继承的pi配置命令");
});
