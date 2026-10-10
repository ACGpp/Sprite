/** Real pi, deterministic model, isolated files and loopback HTTP only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { memoryTools } from "../contracts/memory-policy.ts";
import { command, reviewFixture, waitFor } from "./__test__/review-fixture.ts";
import { piBin, skipWithoutPi } from "./__test__/pi-available.ts";
import { patchSettings, readSettings } from "./settings.ts";
import { rpcCall } from "./rpc/server.ts";

const skip = skipWithoutPi();
const provider = path.resolve("core/__test__/freedom-provider.ts");
type Capture = { pid: number; turn: number; systemPrompt?: string; tools?: { name: string }[]; messages: Array<{ role: string; toolCallId?: string; isError?: boolean; content: unknown }> };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t: TestContext, label: string) {
	const f = reviewFixture(t, `freedom-${label}`);
	// Sibling of memory home: full shell must really be able to write outside it.
	const outside = fs.mkdtempSync(path.join(path.dirname(f.homeDir), "freedom-outside-"));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.mkdirSync(path.join(f.homeDir, "notes")); fs.mkdirSync(path.join(f.homeDir, "context"));
	fs.writeFileSync(path.join(f.homeDir, "notes/freedom.md"), "ORIGINAL_NOTE");
	fs.writeFileSync(path.join(f.homeDir, "context/constraints.md"), "ORIGINAL_CONSTRAINT");
	fs.writeFileSync(path.join(f.homeDir, "identity.md"), "FREEDOM_IDENTITY_CONTEXT");
	let requests = 0;
	const server = http.createServer((req, res) => { requests++; assert.equal(req.url, "/proof"); res.end("LOOPBACK_NETWORK_WORKED"); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const marker = path.join(outside, "shell-result.txt");
	const script = path.join(outside, "explore.sh");
	fs.writeFileSync(script, `set -eu\nprintf 'SCRIPT_EXECUTED\\n' > ${quote(marker)}\ncurl --noproxy '*' --fail --silent --show-error --max-time 3 ${quote(`http://127.0.0.1:${address.port}/proof`)} >> ${quote(marker)}\ncat ${quote(marker)}\n`);
	patchSettings(f.homeDir, { model: { mode: "provider", provider: "freedom-test", model: "freedom-1", apiKey: "TEST_ONLY" }, security: { agentShell: "full" } });
	const overrides = { piBin: piBin(), piExtensions: [provider], piEnv: { FREEDOM_TEST_KEY: "TEST_ONLY", SPRITE_FREEDOM_CAPTURE: path.join(f.homeDir, "captures.jsonl"), SPRITE_FREEDOM_COMMAND: `bash ${quote(script)}` } };
	return { ...f, marker, requests: () => requests, captures: () => f.readLines<Capture>("captures.jsonl"), startPi: (shellCommand?: string, extraEnv: Record<string, string> = {}) => f.start({ ...overrides, piEnv: { ...overrides.piEnv, ...extraEnv, ...(shellCommand ? { SPRITE_FREEDOM_COMMAND: shellCommand } : {}) } }) };
}

function result(capture: Capture, name: string) {
	const message = capture.messages.find(m => m.role === "toolResult" && m.toolCallId === `${capture.pid}-${name}`);
	assert.ok(message, `实际 ${name} 工具结果必须返回给模型`);
	return { ...message, text: (message.content as Array<{ type: string; text?: string }>).filter(c => c.type === "text").map(c => c.text).join("\n") };
}

test("自由模式：真实 pi 执行脚本、目录外写入和 HTTP；记忆 CAS/提案保留，重启持久化", { skip, timeout: 45000 }, async t => {
	const f = await fixture(t, "full");
	let kernel = await f.startPi();
	t.after(() => kernel.shutdown());
	for (let restart = 0; restart < 2; restart++) {
		assert.equal(readSettings(f.homeDir).security.agentShell, "full");
		const settings = await rpcCall(kernel.socketPath, { id: `settings-${restart}`, type: "query.settings" }) as { result: { security: { agentShell: string } } };
		assert.equal(settings.result.security.agentShell, "full", "设置界面必须拿到实际档位，不能回落成 on");
		assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true);
		const calls = f.captures().slice(restart * 5); assert.equal(calls.length, 5);
		assert.deepEqual(calls[0]!.tools!.map(t => t.name).sort(), memoryTools("full").sort());
		const context = JSON.stringify(calls[0]);
		assert.match(context, /档位 full/); assert.match(context, /联网/); assert.match(context, /FREEDOM_IDENTITY_CONTEXT/);
		assert.doesNotMatch(calls[0]!.systemPrompt ?? "", /通用 shell 不开放/);
		assert.equal(result(calls[1]!, "shell").isError, false);
		assert.match(result(calls[1]!, "shell").text, /SCRIPT_EXECUTED\nLOOPBACK_NETWORK_WORKED/);
		assert.equal(fs.readFileSync(f.marker, "utf8"), "SCRIPT_EXECUTED\nLOOPBACK_NETWORK_WORKED");
		assert.equal(f.requests(), restart + 1);
		assert.equal(JSON.parse(result(calls[2]!, "write").text).verified, true);
		assert.equal(JSON.parse(result(calls[3]!, "edit").text).verified, true);
		assert.equal(JSON.parse(result(calls[4]!, "stale").text).ok, false);
		assert.equal(fs.readFileSync(path.join(f.homeDir, "notes/freedom.md"), "utf8"), "EDITED_BY_MEMORY_TOOL");
		assert.equal(JSON.parse(result(calls[2]!, "propose").text).status, "pending");
		assert.equal(fs.readFileSync(path.join(f.homeDir, "context/constraints.md"), "utf8"), "ORIGINAL_CONSTRAINT");
		if (restart === 0) { await kernel.shutdown(); kernel = await f.startPi(); }
	}
});

for (const mode of ["on", "readonly", "off"] as const) test(`自由模式下调 ${mode}：工具列表更新，旧 bash 请求不能继续执行`, { skip, timeout: 45000 }, async t => {
	const f = await fixture(t, `downgrade-${mode}`); const kernel = await f.startPi();
	t.after(() => kernel.shutdown());
	assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true);
	assert.equal(fs.existsSync(f.marker), true); fs.unlinkSync(f.marker);
	const count = f.captures().length;
	const switched = await command(kernel, { type: "settings.update", patch: { security: { agentShell: mode } } });
	assert.equal(switched.piRestarted, true);
	assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true);
	const calls = f.captures().slice(count); assert.equal(calls.length, 2);
	assert.deepEqual(calls[0]!.tools!.map(t => t.name).sort(), memoryTools(mode).sort());
	assert.match(JSON.stringify(calls[0]!.messages), new RegExp(`档位 ${mode}`));
	assert.equal(result(calls[1]!, "shell").isError, true);
	assert.equal(fs.existsSync(f.marker), false, "模型即便请求已撤销的 bash，也不能产生副作用");
	assert.equal(f.requests(), 1, "下调后不得再执行 curl");
	assert.equal(readSettings(f.homeDir).security.agentShell, mode);
	const settings = await rpcCall(kernel.socketPath, { id: `settings-${mode}`, type: "query.settings" }) as { result: { security: { agentShell: string } } };
	assert.equal(settings.result.security.agentShell, mode);
});

for (const action of ["crash", "revoke", "timeout"] as const) test(`真实 pi shell ${action}：在途后代必须被收回，不能继续延迟写入`, { skip, timeout: 20000 }, async t => {
	const f = await fixture(t, `lifecycle-${action}`);
	const begun = path.join(f.homeDir, "shell-begun"); const late = path.join(f.homeDir, "shell-late");
	const nested = `echo $$ > ${quote(begun)}; sleep 2; printf LATE > ${quote(late)}`;
	const kernel = await f.startPi(`bash -c ${quote(nested)} & wait`, { SPRITE_FREEDOM_SHELL_ONLY: "1", SPRITE_FREEDOM_TIMEOUT: action === "timeout" ? "0.25" : "10" });
	t.after(() => kernel.shutdown());
	const run = kernel.breathNow();
	// Cold pi startup under concurrent compilation can exceed four seconds.
	// This wait is separate from the tool timeout being tested (still 250 ms).
	await waitFor(() => fs.existsSync(begun), "实际 bash 子进程启动", 10000);
	if (action === "crash") process.kill(f.captures()[0]!.pid, "SIGKILL");
	else if (action === "revoke") await command(kernel, { type: "settings.update", patch: { security: { agentShell: "on" } } });
	const outcome = await run as { ok: boolean };
	assert.equal(outcome.ok, action === "timeout", "工具超时可返回给模型处理；pi 崩溃和撤权必须终止运行");
	if (action === "timeout") {
		const last = f.captures().at(-1)!;
		assert.equal(result(last, "shell").isError, true);
		assert.match(result(last, "shell").text, /timed out|timeout/i);
	}
	await new Promise(resolve => setTimeout(resolve, 2200));
	assert.equal(fs.existsSync(late), false, "被终止的 shell 后代不许在后台继续写文件");
});

test("真实 pi shell：后台进程持有 stdout 不挂住工具，内核停止时仍收回后台进程", { skip, timeout: 10000 }, async t => {
	const f = await fixture(t, "background-pipes"); const late = path.join(f.homeDir, "background-late");
	const background = `sleep 3; printf LATE > ${quote(late)}`;
	const kernel = await f.startPi(`bash -c ${quote(background)} & printf FOREGROUND_DONE`, { SPRITE_FREEDOM_SHELL_ONLY: "1" });
	t.after(() => kernel.shutdown());
	assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true);
	assert.match(result(f.captures().at(-1)!, "shell").text, /FOREGROUND_DONE/);
	assert.equal(fs.existsSync(late), false, "工具应在后台长任务完成前返回");
	await kernel.shutdown();
	await new Promise(resolve => setTimeout(resolve, 3200));
	assert.equal(fs.existsSync(late), false, "pi 退出后也不允许已返回的后台后代继续写入");
});
