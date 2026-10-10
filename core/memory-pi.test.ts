/** Real pi, production memory extension, isolated filesystem, deterministic offline provider. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { piBin, skipWithoutPi } from "./__test__/pi-available.ts";
import { reviewFixture, stateOf } from "./__test__/review-fixture.ts";
import { patchSettings } from "./settings.ts";
import { createPiRpc, type PiEvent } from "./agent/pi-rpc.ts";
import { dayInShanghai } from "./text.ts";

const skip = skipWithoutPi();
const provider = path.resolve("core/__test__/memory-provider.ts");
type Captured = { invocation: number; systemPrompt?: string; tools?: { name: string }[]; messages: Array<{ role: string; toolCallId?: string; isError?: boolean; content: unknown }> };
function fixture(t: TestContext, mode: string) {
	const f = reviewFixture(t, `memory-real-${mode}`);
	fs.mkdirSync(path.join(f.homeDir, "context")); fs.mkdirSync(path.join(f.homeDir, "notes"));
	fs.writeFileSync(path.join(f.homeDir, "identity.md"), "ORIGINAL_IDENTITY");
	fs.writeFileSync(path.join(f.homeDir, "context/constraints.md"), "INITIAL_CONSTRAINT");
	fs.writeFileSync(path.join(f.homeDir, "notes/existing.md"), "ORIGINAL_NOTE");
	patchSettings(f.homeDir, { model: { mode: "provider", provider: "memory-test", model: "memory-1", apiKey: "TEST_ONLY" }, security: { agentShell: "on" } });
	const env = { MEMORY_TEST_KEY: "TEST_ONLY", SPRITE_MEMORY_CAPTURE: path.join(f.homeDir, "memory-capture.jsonl"), SPRITE_MEMORY_MODE: mode, SPRITE_MEMORY_HOME: f.homeDir };
	return { ...f, env, captures: () => f.readLines<Captured>("memory-capture.jsonl"), startPi: () => f.start({ piBin: piBin(), piExtensions: [provider], piEnv: env }) };
}
function result(call: Captured, id: string): Record<string, unknown> {
	const value = call.messages.find(message => message.role === "toolResult" && message.toolCallId === id);
	assert.ok(value, `actual tool result ${id} must exist`);
	return JSON.parse((value.content as Array<{ type: string; text?: string }>).filter(c => c.type === "text").map(c => c.text).join("\n"));
}

test("真实 pi：身份自主写入可回退，约定拒写且提案成为待确认卡，工具无 bash", { skip, timeout: 30000 }, async t => {
	const f = fixture(t, "tools"); const kernel = await f.startPi();
	assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true);
	const calls = f.captures(); assert.equal(calls.length, 3);
	assert.match(calls[0]!.systemPrompt ?? "", /自主形成/);
	assert.match(calls[0]!.systemPrompt ?? "", /初识提示词帮助你建立认知，不预设固定个性/);
	const tools = calls[0]!.tools!.map(tool => tool.name);
	assert.ok(tools.includes("read") && tools.includes("write") && tools.includes("memory_propose"));
	assert.ok(!tools.includes("bash"), "模型实际收到的工具集不能含通用 shell");
	assert.equal(result(calls[2]!, "write-note").verified, true);
	assert.equal(fs.readFileSync(path.join(f.homeDir, "notes/existing.md"), "utf8"), "UPDATED_NOTE");
	const hash = createHash("sha256").update("ORIGINAL_NOTE").digest("hex");
	assert.equal(fs.readFileSync(path.join(f.homeDir, "runtime/memory/versions", `${hash}.txt`), "utf8"), "ORIGINAL_NOTE");
	assert.equal(result(calls[2]!, "write-identity").ok, true);
	assert.equal(result(calls[2]!, "write-identity").verified, true);
	assert.equal(fs.readFileSync(path.join(f.homeDir, "identity.md"), "utf8"), "SELF_AUTHORED_IDENTITY");
	const identityHash = createHash("sha256").update("ORIGINAL_IDENTITY").digest("hex");
	assert.equal(fs.readFileSync(path.join(f.homeDir, "runtime/memory/versions", `${identityHash}.txt`), "utf8"), "ORIGINAL_IDENTITY");
	const freshContext = calls[2]!.messages.find(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith("内核记忆快照："));
	assert.ok(freshContext, "本次调用必须有最新内核快照");
	assert.match(freshContext.content as string, /SELF_AUTHORED_IDENTITY/);
	assert.doesNotMatch(freshContext.content as string, /ORIGINAL_IDENTITY/);
	assert.equal(result(calls[2]!, "write-constraints").ok, false);
	const facts = kernel.status() as { today: { writes: number } };
	assert.equal(facts.today.writes, 2, "只计实际核验的便签与身份写入，不计失败的约定写入");
	const receipts = kernel.journal.events.filter(event => event.type === "tool.finished");
	assert.equal(receipts.filter(event => event.data.verified === true).length, 2);
	assert.equal(fs.readFileSync(path.join(f.homeDir, "context/constraints.md"), "utf8"), "INITIAL_CONSTRAINT");
	const proposal = result(calls[2]!, "propose-constraints"); assert.equal(proposal.status, "pending");
	assert.equal(stateOf(kernel).questions.length, 1, "自主身份写入不生成审批卡");
	assert.ok(stateOf(kernel).questions.some(question => question.questionId === proposal.questionId && question.question.includes("PROPOSED_CONSTRAINT")), "约定具体前后内容进入用户待确认卡");
	await kernel.shutdown();
});

test("真实 pi：工具后与同 session 下一轮刷新完整长约定，临时快照不堆积", { skip, timeout: 30000 }, async t => {
	const f = fixture(t, "refresh"); const kernel = await f.startPi();
	assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true);
	let calls = f.captures(); assert.equal(calls.length, 2);
	assert.match(JSON.stringify(calls[0]!), /INITIAL_CONSTRAINT/);
	assert.match(JSON.stringify(calls[1]!), /TOOL_UPDATED_TAIL/);
	assert.doesNotMatch(JSON.stringify(calls[1]!), /INITIAL_CONSTRAINT/);
	fs.writeFileSync(path.join(f.homeDir, "context/constraints.md"), "SECOND_ROUND_START\n" + "y".repeat(5000) + "\nSECOND_ROUND_TAIL");
	assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true);
	calls = f.captures(); assert.equal(calls.length, 3, "同一 provider 进程应保留 invocation 计数");
	assert.equal(calls[2]!.invocation, 2);
	assert.match(JSON.stringify(calls[2]!), /SECOND_ROUND_TAIL/);
	assert.doesNotMatch(JSON.stringify(calls[2]!), /TOOL_UPDATED_TAIL/);
	for (const call of calls) assert.equal(JSON.stringify(call.messages).split("内核记忆快照：").length - 1, 1);
	assert.equal(calls[1]!.messages.at(-1)!.role, "toolResult", "工具后不能追加伪用户回合");
	const snapshotIndex = calls[1]!.messages.findIndex(message => typeof message.content === "string" && message.content.startsWith("内核记忆快照："));
	assert.equal(calls[1]!.messages[snapshotIndex + 1]!.role, "user", "背景附着到本轮原始输入之前");
	assert.match(calls[1]!.messages[snapshotIndex]!.content as string, /同一次唤醒的工具后续推/);
	const session = fs.readFileSync(path.join(f.homeDir, "sessions/memory-v1", `${dayInShanghai(new Date())}.jsonl`), "utf8");
	assert.doesNotMatch(session, /内核记忆快照：|调用阶段：/, "背景只在模型调用临时注入，不污染持久会话");
	await kernel.shutdown();
});

test("真实 pi：设置节奏后仍是同一轮，快照给出已请求间隔且不诱发再次调度", { skip, timeout: 30000 }, async t => {
	const f = fixture(t, "schedule"); const kernel = await f.startPi();
	try {
		assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true);
		const calls = f.captures();
		assert.equal(calls.length, 2);
		assert.equal(calls[1]!.messages.at(-1)!.role, "toolResult");
		const snapshots = calls.map(call => call.messages.find(m => typeof m.content === "string" && m.content.startsWith("内核记忆快照："))!.content as string);
		assert.equal(/当前运行：(run-\d+)/.exec(snapshots[0]!)![1], /当前运行：(run-\d+)/.exec(snapshots[1]!)![1]);
		assert.match(snapshots[0]!, /尚未请求下次唤醒间隔/);
		assert.match(snapshots[1]!, /已请求下次唤醒间隔 3600 秒/);
		assert.equal(kernel.journal.events.filter(e => e.type === "run.activity" && e.data.tool === "set_next_breath").length, 1);
		assert.equal((kernel.status() as { idleStreak: number }).idleStreak, 1);
	} finally { await kernel.shutdown(); }
});

for (const invalid of ["oversize", "symlink"] as const) test(`真实 pi：${invalid} 必要背景在 provider 调用前停止`, { skip, timeout: 30000 }, async t => {
	const f = fixture(t, invalid); const file = path.join(f.homeDir, "context/constraints.md");
	if (invalid === "oversize") fs.writeFileSync(file, "oversize".repeat(20000));
	else { fs.unlinkSync(file); fs.symlinkSync("/nonexistent-sprite-memory-research", file); }
	const kernel = await f.startPi();
	assert.equal((await kernel.breathNow() as { ok: boolean }).ok, false);
	assert.equal(f.captures().length, 0, "不合作 provider 也不能被调用，不能依赖 throw 被吞后的表现");
	assert.ok(kernel.journal.events.some(e => e.type === "system.problem" && e.data.code === "memory.context.failed"));
	await kernel.shutdown();
});

test("真实 pi：工具后必要记忆变坏时不得再次调用 provider", { skip, timeout: 30000 }, async t => {
	const f = fixture(t, "corrupt-next"); const kernel = await f.startPi();
	assert.equal((await kernel.breathNow() as { ok: boolean }).ok, false);
	assert.equal(f.captures().length, 1, "首轮成功调用后，下一次模型调用必须被阻止");
	assert.ok(kernel.journal.events.some(e => e.type === "system.problem" && e.data.code === "memory.context.failed"));
	await kernel.shutdown();
});

test("真实 pi：工作目录和 agentDir 的指令/扩展/skills 均不自动发现", { skip, timeout: 30000 }, async t => {
	const f = fixture(t, "inspect"); const marker = "UNAPPROVED_RESOURCE_SENTINEL";
	for (const directory of [path.join(f.homeDir, ".pi"), path.join(f.homeDir, "pi-home/.pi/agent")]) {
		fs.mkdirSync(path.join(directory, "extensions"), { recursive: true });
		fs.mkdirSync(path.join(directory, "skills/unapproved"), { recursive: true });
		for (const file of ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"]) fs.writeFileSync(path.join(directory, file), marker);
		fs.writeFileSync(path.join(directory, "extensions/forbidden.ts"), `import fs from 'node:fs'; export default () => fs.writeFileSync(${JSON.stringify(path.join(f.homeDir, "extension-loaded"))}, 'bad');`);
		fs.writeFileSync(path.join(directory, "skills/unapproved/SKILL.md"), `---\nname: unapproved\ndescription: ${marker}\n---\n${marker}`);
	}
	fs.writeFileSync(path.join(f.homeDir, "AGENTS.md"), marker);
	const kernel = await f.startPi();
	assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true);
	assert.equal(f.captures().length, 1); assert.doesNotMatch(JSON.stringify(f.captures()), new RegExp(marker));
	assert.equal(fs.existsSync(path.join(f.homeDir, "extension-loaded")), false);
	await kernel.shutdown();
});

test("真实 pi RPC compact 后恢复完整约定与内核未决问题", { skip, timeout: 30000 }, async t => {
	const f = fixture(t, "compact");
	const kernel = await f.start({ disableAgent: true });
	kernel.journal.append("question.asked", { questionId: "memory-unresolved", question: "UNRESOLVED_QUESTION_AFTER_COMPACT", options: ["稍后"] });
	const agentDir = path.join(f.homeDir, "pi-home/.pi/agent"); fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 32, reserveTokens: 512 } }));
	const session = path.join(f.homeDir, "compact-session.jsonl");
	const events: PiEvent[] = [];
	const pi = createPiRpc({ bin: piBin(), cwd: f.homeDir, env: { ...f.config.piEnv, ...f.env, SPRITE_GATEWAY_SOCK: path.join(f.homeDir, "runtime/gateway.sock"), SPRITE_HOME: f.homeDir, SPRITE_AGENT_SHELL: "on" }, args: [
		"--mode", "rpc", "--provider", "memory-test", "--model", "memory-1", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--system-prompt", "Memory test runtime", "--append-system-prompt", " ", "--tools", "read,write,edit,memory_propose,memory_history", "-e", path.resolve("pi-extension/sprite.ts"), "-e", provider, "--session", session,
	] });
	pi.onEvent(e => events.push(e)); pi.start(); t.after(async () => { await pi.terminate(); await kernel.shutdown(); });
	const prompt = async (message: string) => {
		const before = events.filter(e => e.type === "agent_end").length;
		assert.equal((await pi.send({ type: "prompt", message })).success, true);
		const until = Date.now() + 10000;
		while (events.filter(e => e.type === "agent_end").length === before) { assert.ok(Date.now() < until, "等待真实 pi 完成本轮"); await new Promise(resolve => setTimeout(resolve, 10)); }
	};
	await prompt("PRE_COMPACT_HISTORY ".repeat(500)); await prompt("Finish this round.");
	const compact = await pi.send({ type: "compact" }); assert.equal(compact.success, true, JSON.stringify(compact));
	assert.ok(fs.readFileSync(session, "utf8").split("\n").some(line => line && JSON.parse(line).type === "compaction"), "必须真正写入 pi compaction entry");
	assert.match(fs.readFileSync(session, "utf8"), /PRE_COMPACT_HISTORY/, "压缩保留原始持久记录");
	assert.equal(fs.readFileSync(path.join(f.homeDir, "context/constraints.md"), "utf8"), "INITIAL_CONSTRAINT", "pi 压缩不得重写长期约定");
	assert.equal(f.captures().length, 3, "两轮对话加一次真实压缩模型调用");
	assert.equal(f.captures()[2]!.tools?.length ?? 0, 0, "摘要经过独立的无工具模型调用");
	fs.writeFileSync(path.join(f.homeDir, "context/constraints.md"), "AFTER_COMPACT_START\n" + "z".repeat(5000) + "\nAFTER_COMPACT_TAIL");
	await prompt("Continue after compaction.");
	const last = f.captures().at(-1)!;
	assert.match(JSON.stringify(last), /AFTER_COMPACT_TAIL/);
	assert.match(JSON.stringify(last), /UNRESOLVED_QUESTION_AFTER_COMPACT/);
	assert.match(JSON.stringify(last), /ORIGINAL_IDENTITY/);
	assert.equal(JSON.stringify(last.messages).split("内核记忆快照：").length - 1, 1);
	assert.equal(fs.readFileSync(path.join(f.homeDir, "identity.md"), "utf8"), "ORIGINAL_IDENTITY");
});
