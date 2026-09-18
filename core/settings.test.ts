/**
 * 设置与"主动说话"的端到端验证。
 *
 * 这里验的是三条硬规则：
 *   1. **密钥绝不回显**：界面拿到的只有 hasApiKey，原始响应里不许出现密钥字符串；
 *   2. **额度由内核管**：不是靠提示词自觉——超了就把话记成留言，不弹到用户眼前；
 *   3. **改设置立刻生效**：安静时段改完马上按新的判断，并留下可查的记录。
 *
 * 运行：node --test core/settings.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { skipWithoutPi } from "./__test__/pi-available.ts";
import { startKernel, type Kernel } from "./main.ts";
import { rpcCall } from "./rpc/server.ts";
import { hourInShanghai } from "./text.ts";
import { customProviderSource, piArgsFor, readSettings, validatePatch, patchSettings, allowedToolsFor, CUSTOM_KEY_ENV } from "./settings.ts";

const ROOT = path.join(process.cwd(), ".core-test");
const SECRET = "sk-should-never-appear-anywhere";

/** 当前这一小时之外的"安静时段"——保证测试运行时不是安静时段 */
function notQuietNow(): { start: number; end: number } {
	// 必须用**上海**小时（产品语义）。曾经这里写的是 `new Date().getHours()`：
	// 作者的机器恰好是 UTC+8，于是本地一直掩盖着——CI（UTC）上这条测试必然红。
	const hour = hourInShanghai(new Date());
	return { start: (hour + 1) % 24, end: hour };
}

/** 直连能力网关（pi 扩展走的就是这条路） */
function gatewayCall(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.includes("\n")) {
				socket.destroy();
				resolve(JSON.parse(buffer.split("\n")[0]!) as Record<string, unknown>);
			}
		});
		socket.on("error", reject);
	});
}

function makeHome(name: string): string {
	const home = path.join(ROOT, name);
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(home, "thoughts"), { recursive: true });
	fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), "");
	fs.writeFileSync(path.join(home, "thoughts", "stream.jsonl"), "");
	return home;
}

test("设置：校验、落盘 0600、自定义端点生成、密钥绝不出现在产物里", () => {
	// ─── 校验：坏输入要被人话拒绝 ───
	assert.equal(validatePatch({ model: { mode: "custom", baseUrl: "不是地址", model: "x" } }).ok, false, "坏地址必须被拒");
	assert.equal(validatePatch({ model: { mode: "custom", baseUrl: "https://api.x.com/v1", model: "" } }).ok, false, "缺模型名必须被拒");
	assert.equal(
		validatePatch({ model: { mode: "custom", baseUrl: "https://api.x.com/v1", model: "x", apiFormat: "不存在的格式" } }).ok,
		false,
		"不认识的格式必须被拒",
	);
	assert.equal(validatePatch({ model: { mode: "provider", provider: "deepseek", model: "deepseek-chat" } }).ok, true);
	assert.equal(validatePatch({ proactive: { perDay: 99 } }).ok, true, "上限放宽到 999：用户想让它多说就多说");
	assert.equal(validatePatch({ proactive: { perDay: 1000 } }).ok, false, "荒谬的值仍然要拒");
	assert.equal(validatePatch({ proactive: { perDay: -1 } }).ok, false, "负数要拒");
	assert.equal(validatePatch({ quietHours: { start: 30, end: 7 } }).ok, true, "小时会被夹到 0–23");

	// ─── 落盘与权限 ───
	const home = makeHome("settings-files");
	const saved = patchSettings(home, {
		model: { mode: "provider", provider: "deepseek", model: "deepseek-chat", apiKey: SECRET },
		quietHours: { start: 22, end: 8 },
		proactive: { enabled: true, perDay: 3 },
	});
	assert.equal(saved.model.provider, "deepseek");
	const file = path.join(home, "config", "settings.json");
	assert.ok(fs.existsSync(file));
	const mode = fs.statSync(file).mode & 0o777;
	assert.equal(mode, 0o600, `settings.json 里有密钥，必须 0600，实际 ${mode.toString(8)}`);
	assert.equal(readSettings(home).quietHours.start, 22, "读回来必须是改过的值");
	assert.equal(readSettings(home).model.apiKey, SECRET, "内核自己要能读到密钥（只给子进程用）");

	// ─── 加密钥不进日志用的描述 ───
	const described = JSON.stringify({ ...saved, source: undefined });
	assert.equal(described.includes(SECRET), true, "（说明：设置对象本身含密钥，所以它绝不能被打日志）");

	// ─── 自定义端点（OpenAI 格式）生成的扩展源码 ───
	const custom = patchSettings(home, {
		model: { mode: "custom", baseUrl: "https://api.example.com/v1", model: "gpt-4o-mini", apiFormat: "openai-completions", modelName: "示例模型" },
	});
	assert.equal(custom.model.mode, "custom");
	assert.equal(custom.model.apiKey, SECRET, "换成自定义端点后密钥要留着");
	const source = customProviderSource(custom)!;
	assert.match(source, /registerProvider/);
	assert.match(source, /https:\/\/api\.example\.com\/v1/);
	assert.match(source, /openai-completions/);
	assert.match(source, /gpt-4o-mini/);
	assert.equal(source.includes(SECRET), false, "生成的扩展里**不许**出现密钥：密钥走环境变量");
	assert.ok(source.includes(CUSTOM_KEY_ENV), "要写上环境变量名");
	const args = piArgsFor(custom);
	assert.deepEqual(args.slice(0, 2), ["--provider", "sprite-custom"], "自定义端点注册成固定 provider");

	// provider 模式不该残留自定义字段
	const back = patchSettings(home, { model: { mode: "provider", provider: "openai", model: "gpt-4o" } });
	assert.equal(back.model.baseUrl, undefined, "换回内置供应商后不该留着自定义地址");
	assert.equal(customProviderSource(back), null);

	// 清空密钥
	const cleared = patchSettings(home, { model: { clearApiKey: true } });
	assert.equal(cleared.model.apiKey, undefined);
});

test("设置：界面拿到的东西里没有密钥，改了安静时段立刻生效", { timeout: 60_000 }, async () => {
	const home = makeHome("settings-live");
	fs.mkdirSync(path.join(home, "config"), { recursive: true });
	fs.writeFileSync(
		path.join(home, "config", "settings.json"),
		JSON.stringify({
			model: { mode: "provider", provider: "deepseek", model: "deepseek-chat", apiKey: SECRET },
			quietHours: { start: 1, end: 2 },
			proactive: { enabled: true, perDay: 1 },
		}),
	);

	const kernel: Kernel = await startKernel({
		homeDir: home,
		disableAgent: true,
		intervalMs: 3_600_000,
		quietHours: { start: 1, end: 2 },
		fsync: false,
		log: () => {},
	});
	try {
		// ─── 1. 原始响应里不许出现密钥 ───
		const raw = JSON.stringify(await rpcCall(kernel.socketPath, { id: "q1", type: "query.settings" }));
		assert.equal(raw.includes(SECRET), false, "查询设置的响应里出现了密钥——这是绝不许可的");
		const settings = JSON.parse(raw) as {
			result: {
				model: { mode: string; provider: string | null; model: string | null; hasApiKey: boolean };
				providers: Array<{ id: string; label: string }>;
				apiFormats: Array<{ id: string }>;
				quietHours: { start: number; end: number };
				proactive: { enabled: boolean; perDay: number };
				source: string;
			};
		};
		assert.equal(settings.result.model.hasApiKey, true, "要如实告诉界面：密钥已经配了");
		assert.equal(settings.result.model.provider, "deepseek");
		assert.ok(settings.result.providers.length >= 10, "供应商列表要够选");
		assert.ok(settings.result.apiFormats.some((format) => format.id === "openai-completions"), "必须能选 OpenAI 格式");
		assert.equal(settings.result.source, "settings.json");
		assert.equal(settings.result.proactive.perDay, 1);

		// ─── 2. 改安静时段：立刻生效 + 留下可查记录 ───
		const updated = (await rpcCall(kernel.socketPath, {
			id: "u1",
			type: "command",
			command: { id: "set-1", type: "settings.update", patch: { quietHours: { start: 3, end: 5 }, proactive: { perDay: 2 } } },
		})) as { ok: boolean; result: { applied: boolean; quietHours: { start: number; end: number } } };
		assert.equal(updated.ok, true);
		assert.equal(updated.result.quietHours.start, 3, "改完要立刻按新的安静时段判断");
		const after = (await rpcCall(kernel.socketPath, { id: "q2", type: "query.settings" })) as {
			result: { quietHours: { start: number; end: number }; proactive: { perDay: number } };
		};
		assert.equal(after.result.quietHours.end, 5);
		assert.equal(after.result.proactive.perDay, 2);
		assert.equal(readSettings(home).quietHours.start, 3, "改动必须落到磁盘上（重启后还在）");
		assert.ok(
			kernel.journal.events.some((event) => event.type === "settings.changed" && event.data.quietHours),
			"改设置要在日志里留痕（用 settings.changed，不能复用 breath.paused——评审 B3）",
		);

		// ─── 3. 坏设置必须被拒，且不落盘 ───
		const bad = (await rpcCall(kernel.socketPath, {
			id: "u2",
			type: "command",
			command: { id: "set-2", type: "settings.update", patch: { model: { mode: "custom", baseUrl: "不是地址", model: "x" } } },
		})) as { ok: boolean; error?: string };
		assert.equal(bad.ok, false, "坏设置必须被拒绝");
		assert.match(String(bad.error), /http/, "错误要说人话");
		assert.equal(readSettings(home).model.mode, "provider", "被拒的设置不得写进磁盘");
	} finally {
		await kernel.stop();
	}
});

test("主动说话：额度由内核管——超了就记成留言，不弹到眼前", { timeout: 60_000 }, async () => {
	const home = makeHome("proactive-cap");
	fs.mkdirSync(path.join(home, "config"), { recursive: true });
	fs.writeFileSync(
		path.join(home, "config", "settings.json"),
		JSON.stringify({
			model: { mode: "provider", provider: "deepseek", model: "deepseek-chat" },
			quietHours: notQuietNow(),
			proactive: { enabled: true, perDay: 1 },
		}),
	);
	const quiet = notQuietNow();
	const kernel: Kernel = await startKernel({
		homeDir: home,
		disableAgent: true,
		intervalMs: 3_600_000,
		quietHours: quiet,
		fsync: false,
		log: () => {},
	});
	try {
		const gateway = path.join(home, "runtime", "gateway.sock");
		// 第一句：额度内 → 弹到眼前
		const first = await gatewayCall(gateway, { kind: "capability.say", text: "第一句主动的话" });
		assert.equal(first.ok, true);
		assert.equal(first.delivered, "bubble", `第一句应该在额度内：${JSON.stringify(first)}`);
		// 第二句：超额度 → 记成留言
		const second = await gatewayCall(gateway, { kind: "capability.say", text: "第二句主动的话" });
		assert.equal(second.ok, true, "超额度不是错误，是要如实降级");
		assert.equal(second.delivered, "digest", "超额度必须降级成留言，不能弹窗");
		assert.match(String(second.reason), /额度/, "要说明为什么降级");

		const bubbles = kernel.journal.events.filter((event) => event.type === "message.out" && event.data.channel === "bubble");
		const digests = kernel.journal.events.filter((event) => event.type === "message.out" && event.data.channel === "digest");
		assert.equal(bubbles.length, 1, "只允许一句进弹窗");
		assert.equal(digests.length, 1, "超出的那句要留在记录里");
		assert.equal(digests[0]!.data.cappedBy, "proactive", "日志要写清是被额度挡下来的");

		// 关掉主动说话：下一句也必须是留言
		await rpcCall(kernel.socketPath, {
			id: "u1",
			type: "command",
			command: { id: "set-3", type: "settings.update", patch: { proactive: { enabled: false } } },
		});
		const third = await gatewayCall(gateway, { kind: "capability.say", text: "第三句" });
		assert.equal(third.delivered, "digest", "关掉主动说话后不许再弹窗");
		assert.match(String(third.reason), /关闭/);

		// 回话不受额度限制（currentTrigger=message 时才放行，这里没有 run，走的是"非回话"路径）
		const reply = await gatewayCall(gateway, { kind: "capability.leave_message", text: "留个言" });
		assert.equal(reply.ok, true);
	} finally {
		await kernel.stop();
	}
});

test("换模型：旧引擎的退出不得被报成崩溃（认身份，不靠时间差）", { timeout: 60_000 }, async () => {
	// 用假引擎（sleep）当思考引擎：它会响应 SIGTERM 退出，模拟"换模型时被换掉的那一个"
	const home = makeHome("model-switch");
	fs.mkdirSync(path.join(home, "config"), { recursive: true });
	fs.writeFileSync(
		path.join(home, "config", "settings.json"),
		JSON.stringify({
			model: { mode: "provider", provider: "deepseek", model: "deepseek-chat" },
			quietHours: notQuietNow(),
			proactive: { enabled: true, perDay: 2 },
		}),
	);
	const kernel: Kernel = await startKernel({
		homeDir: home,
		// 一个"能起来、能被杀、不会自己退"的假 pi：够用来验证退出归属
		piArgs: ["-e", "setTimeout(() => {}, 60_000)"],
		piBin: process.execPath,
		intervalMs: 3_600_000,
		quietHours: notQuietNow(),
		fsync: false,
		log: () => {},
	});
	try {
		const before = kernel.journal.events.filter((event) => event.type === "system.problem" && event.data.code === "pi.exited").length;
		const switched = (await rpcCall(kernel.socketPath, {
			id: "sw",
			type: "command",
			command: { id: "switch-1", type: "settings.update", patch: { model: { mode: "provider", provider: "deepseek", model: "deepseek-reasoner" } } },
		})) as { ok: boolean; result: { piRestarted: boolean } };
		assert.equal(switched.ok, true);
		assert.equal(switched.result.piRestarted, true, "换模型必须重启引擎");
		// 等旧引擎的退出信号到达（它是异步的，这正是 bug 的现场）
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const after = kernel.journal.events.filter((event) => event.type === "system.problem" && event.data.code === "pi.exited").length;
		assert.equal(after, before, "换模型时旧引擎的退出**不是**崩溃，不许写 pi.exited");
		assert.equal(readSettings(home).model.model, "deepseek-reasoner", "新模型要落盘");
	} finally {
		await kernel.stop();
	}
});

test("列出模型：pi 把表打到 stderr 也要认（实测就是这样）", { timeout: 60_000 }, async () => {
	const home = makeHome("models-list");
	// 假的 pi：把清单写到 **stderr**，模拟真实 pi 在真实 HOME 下的行为
	const fakePi = path.join(home, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		[
			"#!/usr/bin/env node",
			'process.stderr.write("Warning: 一些无关的告警\\n");',
			'process.stderr.write("provider  model        context  max-out  thinking  images\\n");',
			'process.stderr.write("deepseek  deepseek-v4-flash  1M  384K  yes  no\\n");',
			'process.stderr.write("deepseek  deepseek-v4-pro    1M  384K  yes  no\\n");',
		].join("\n"),
		{ mode: 0o755 },
	);
	const kernel: Kernel = await startKernel({
		homeDir: home,
		disableAgent: true,
		piBin: fakePi,
		intervalMs: 3_600_000,
		quietHours: notQuietNow(),
		fsync: false,
		log: () => {},
	});
	try {
		const listed = (await rpcCall(kernel.socketPath, { id: "m1", type: "query.models", provider: "deepseek" })) as {
			ok: boolean;
			result: { models: Array<{ id: string; note: string }> };
		};
		assert.equal(listed.ok, true, `列模型失败：${JSON.stringify(listed)}`);
		assert.deepEqual(
			listed.result.models.map((model) => model.id),
			["deepseek-v4-flash", "deepseek-v4-pro"],
			"必须从 stderr 里把模型名读出来，且不能把表头和告警当成模型",
		);
		assert.match(listed.result.models[0]!.note, /1M/, "要带上上下文长度这类信息");

		// 没有 provider 时必须明确报错，不能返回空列表假装成功
		const empty = (await rpcCall(kernel.socketPath, { id: "m2", type: "query.models", provider: "" })) as { ok: boolean };
		assert.equal(empty.ok, false, "没给供应商就该报错");
	} finally {
		await kernel.stop();
	}
});

test("仓库里不许写死任何人的家目录（隐私：源码会跟着分发）", () => {
	// 针要拼出来：否则这个测试文件自己就含那个字面量，等于自己抓自己
	const needle = ["", "Users", ""].join("/");
	// **以 git 跟踪的文件为准**，不再手写目录白名单：
	// 老版本的守卫只走 core/contracts/pi-extension/shell/Sources/Scripts 五个目录，
	// 于是 `.spike/`、`home/index.html`、`docs/` 里的绝对家目录一路溜了过去
	// （连 `shell/.build-release/` 的构建缓存都被提交了）。会被分发的内容 = git 跟踪的内容。
	const tracked = execFileSync("git", ["ls-files"], { cwd: process.cwd(), encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	assert.ok(tracked.length > 50, "读不到跟踪文件列表（不在 git 仓库里？）");
	const textFiles = tracked.filter((name) => /\.(ts|swift|sh|mjs|js|json|md|ya?ml|html|plist|txt|py)$/.test(name));
	const offenders: string[] = [];
	for (const name of textFiles) {
		let text = "";
		try {
			text = fs.readFileSync(path.join(process.cwd(), name), "utf8");
		} catch {
			continue; // 跟踪了但本地没有（罕见），跳过
		}
		if (text.includes(needle)) offenders.push(name);
	}
	assert.deepEqual(offenders, [], `这些文件里写死了绝对路径（应该用家目录/环境变量）：\n${offenders.join("\n")}`);

	// 构建产物不许进仓库：它们是本机缓存，里面全是绝对路径，而且体积大
	const buildArtifacts = tracked.filter((name) => /^(shell\/\.build|\.core-test\/|\.demo\/|node_modules\/)/.test(name));
	assert.deepEqual(buildArtifacts, [], `构建产物不该被跟踪（加进 .gitignore 并 git rm --cached）：\n${buildArtifacts.join("\n")}`);
});

test("shell 脚本里的变量后面紧跟非 ASCII 字符时必须用 ${}（这个坑踩过三次）", () => {
	// `echo "$VAR：…"` 在 bash 里会把全角冒号的字节并进变量名 → unbound variable，
	// 脚本半路死掉，而且报错信息看起来像灵异事件（实测踩过三次，最近一次在发布钩子里）。
	const tracked = execFileSync("git", ["ls-files"], { cwd: process.cwd(), encoding: "utf8" })
		.split("\n")
		.filter((name) => name.endsWith(".sh") || name.endsWith("/pre-push"));
	const offenders: string[] = [];
	for (const name of tracked) {
		let text = "";
		try {
			text = fs.readFileSync(path.join(process.cwd(), name), "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line)) offenders.push(`${name}: ${line.trim().slice(0, 60)}`);
		}
	}
	assert.deepEqual(offenders, [], `这些行里的变量名会被 bash 和非 ASCII 字符并在一起（改用 \${VAR}）：\n${offenders.join("\n")}`);
});

test("改设置必须留审计：谁改的、改成了什么（密钥只记「变没变」）", { timeout: 60_000 }, async () => {
	const home = makeHome("settings-audit");
	const kernel: Kernel = await startKernel({
		homeDir: home,
		disableAgent: true,
		intervalMs: 3_600_000,
		quietHours: notQuietNow(),
		fsync: false,
		log: () => {},
	});
	try {
		await rpcCall(kernel.socketPath, {
			id: "a1",
			type: "command",
			command: {
				id: "audit-1",
				type: "settings.update",
				source: "ui",
				patch: { model: { mode: "provider", provider: "deepseek", model: "deepseek-chat", apiKey: SECRET }, proactive: { perDay: 42 } },
			},
		});
		const audited = kernel.journal.events.filter((event) => event.type === "settings.changed");
		assert.equal(audited.length, 1, "改一次设置要留一条审计");
		const data = audited[0]!.data;
		assert.equal(data.source, "ui", "要记下是谁改的（界面/脚本/测试）");
		assert.equal((data.proactive as { perDay: number }).perDay, 42, "改成什么值要记清");
		const auditedPatch = data.patch as { model: { apiKeyChanged: boolean; apiKey?: string } };
		assert.equal(auditedPatch.model.apiKeyChanged, true, "密钥只记「变没变」");
		assert.equal(auditedPatch.model.apiKey, undefined, "审计里的补丁不许带密钥值");
		assert.equal(JSON.stringify(data).includes(SECRET), false, "审计里绝对不能出现密钥值");
		assert.ok(kernel.journal.events.some((event) => event.type === "settings.changed" && (event.data.model as { hasApiKey: boolean }).hasApiKey));
	} finally {
		await kernel.stop();
	}
});

test("模型清单：优先实时问服务商，问不到才退回 pi 目录，并且如实标明来源", { timeout: 60_000, skip: skipWithoutPi() }, async () => {
	const home = makeHome("models-source");
	// 一个假的"服务商"：本地 HTTP 服务，返回 OpenAI 格式的 /models
	const server = http.createServer((request, response) => {
		if (request.url?.endsWith("/models")) {
			if (request.headers.authorization !== "Bearer test-key") {
				response.writeHead(401).end("{}");
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ object: "list", data: [{ id: "官方-模型-A", owned_by: "test" }, { id: "official-model-b", context_length: 128000 }] }));
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as { port: number }).port;

	fs.mkdirSync(path.join(home, "config"), { recursive: true });
	fs.writeFileSync(
		path.join(home, "config", "settings.json"),
		JSON.stringify({
			model: { mode: "custom", baseUrl: `http://127.0.0.1:${port}/v1`, model: "official-model-b", apiKey: "test-key", apiFormat: "openai-completions" },
			quietHours: notQuietNow(),
			proactive: { enabled: true, perDay: 2 },
		}),
	);
	const kernel: Kernel = await startKernel({ homeDir: home, disableAgent: true, intervalMs: 3_600_000, quietHours: notQuietNow(), fsync: false, log: () => {} });
	try {
		const live = (await rpcCall(kernel.socketPath, { id: "m1", type: "query.models", provider: "sprite-custom" })) as {
			ok: boolean;
			result: { models: Array<{ id: string; note: string }>; source: string; endpoint: string | null };
		};
		assert.equal(live.ok, true, `实时查询失败：${JSON.stringify(live)}`);
		assert.equal(live.result.source, "provider-api", "能问到服务商就必须用实时清单");
		assert.deepEqual(live.result.models.map((model) => model.id), ["官方-模型-A", "official-model-b"], "要原样返回服务商的清单");
		assert.match(live.result.models[1]!.note, /128K/, "带上上下文长度");
		assert.match(String(live.result.endpoint), /127\.0\.0\.1/, "要如实说这份清单是从哪个地址问来的");

		// 服务商挂了 → 退回 pi 目录，并且**标明不是实时的**
		server.close();
		await new Promise((resolve) => setTimeout(resolve, 200));
		const fallback = (await rpcCall(kernel.socketPath, { id: "m2", type: "query.models", provider: "sprite-custom" })) as {
			ok: boolean;
			result: { source: string; fallbackReason: string | null; models: unknown[] };
		};
		assert.equal(fallback.ok, true, "退回目录也要给结果，不能报错");
		assert.equal(fallback.result.source, "pi-catalog", "退回时必须标明来源是目录");
		assert.ok(fallback.result.fallbackReason, "要说清为什么没用实时清单");
	} finally {
		await kernel.stop();
	}
});

test("同一个模型重复保存：不该反复重启引擎（真实发生：3 秒点 4 次 = 重启 4 次）", { timeout: 60_000 }, async () => {
	const home = makeHome("model-idempotent");
	const kernel: Kernel = await startKernel({
		homeDir: home,
		piBin: process.execPath,
		piArgs: ["-e", "setTimeout(() => {}, 60_000)"],
		intervalMs: 3_600_000,
		quietHours: notQuietNow(),
		fsync: false,
		log: () => {},
	});
	try {
		const save = async (id: string) =>
			(await rpcCall(kernel.socketPath, {
				id,
				type: "command",
				command: { id, type: "settings.update", source: "ui", patch: { model: { mode: "provider", provider: "deepseek", model: "deepseek-flash" } } },
			})) as { ok: boolean; result: { piRestarted: boolean; modelChanged: boolean } };

		const first = await save("s1");
		assert.equal(first.result.modelChanged, true, "第一次换成新模型必须重启");
		assert.equal(first.result.piRestarted, true);
		const second = await save("s2");
		assert.equal(second.result.modelChanged, false, "值没变就不算换模型");
		assert.equal(second.result.piRestarted, false, "值没变就**不许**重启引擎");
		const restarts = kernel.journal.events.filter((event) => event.type === "system.problem" && event.data.code === "model.changed");
		assert.equal(restarts.length, 1, "日志里只该有一条换模型记录");
	} finally {
		await kernel.stop();
	}
});

test("手脚档位：on 用默认工具集，readonly / off 明确收窄，且能落盘", () => {
	const home = makeHome("settings-shell");
	const allowed = validatePatch({ security: { agentShell: "readonly" } });
	assert.equal(allowed.ok, true);
	const bad = validatePatch({ security: { agentShell: "随便写的" } });
	assert.equal(bad.ok, false, "认不出的档位必须被拒");

	const saved = patchSettings(home, { security: { agentShell: "off" } });
	assert.equal(saved.security.agentShell, "off");
	assert.equal(readSettings(home).security.agentShell, "off", "档位要落盘（重启后还在）");
	assert.equal(allowedToolsFor("on"), null, "on = 不传 --tools，用 pi 的默认工具集");
	const readonly = allowedToolsFor("readonly")!;
	assert.ok(readonly.includes("read") && readonly.includes("grep"), "只读档要保留读与搜索");
	assert.equal(readonly.includes("bash") || readonly.includes("write") || readonly.includes("edit"), false, "只读档不能有 bash/write/edit");
	const off = allowedToolsFor("off")!;
	assert.deepEqual(off, ["say", "leave_message", "set_next_breath", "ask_user"], "只剩说话档只保留能力工具");
});

test("手脚档位真的传给了引擎：readonly / off 时 pi 收到 --tools", { timeout: 60_000 }, async () => {
	const home = makeHome("shell-tools");
	// 假 pi：把自己的参数写进文件，然后什么都不做（这样我们能断言内核到底传了什么）
	const fakePi = path.join(home, "record-args.mjs");
	const argsFile = path.join(home, "args.json");
	fs.writeFileSync(
		fakePi,
		[
			"#!/usr/bin/env node",
			'import fs from "node:fs";',
			`fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
			"setTimeout(() => {}, 60_000);",
		].join("\n"),
		{ mode: 0o755 },
	);

	const runWith = async (access: "on" | "readonly" | "off") => {
		fs.rmSync(argsFile, { force: true });
		fs.mkdirSync(path.join(home, "config"), { recursive: true });
		fs.writeFileSync(
			path.join(home, "config", "settings.json"),
			JSON.stringify({
				model: { mode: "provider", provider: "deepseek", model: "deepseek-chat" },
				quietHours: notQuietNow(),
				proactive: { enabled: true, perDay: 2 },
				security: { agentShell: access },
			}),
		);
		const kernel = await startKernel({
			homeDir: home,
			piBin: fakePi,
			// 注意：**不能**传 piArgs: []——空数组是 truthy，会短路掉内核自己拼参数那条路径，
			// 于是 --tools 永远测不到（这个坑我自己先踩了一次）
			intervalMs: 3_600_000,
			quietHours: notQuietNow(),
			fsync: false,
			log: () => {},
		});
		// 等假引擎把参数写下来
		for (let i = 0; i < 40 && !fs.existsSync(argsFile); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
		await kernel.stop();
		return args;
	};

	const on = await runWith("on");
	assert.equal(on.includes("--tools"), false, "全开档不该传 --tools（用 pi 的默认工具集）");

	const readonly = await runWith("readonly");
	const readonlyIndex = readonly.indexOf("--tools");
	assert.ok(readonlyIndex >= 0, "只读档必须传 --tools");
	const readonlyTools = readonly[readonlyIndex + 1]!.split(",");
	assert.ok(readonlyTools.includes("read") && readonlyTools.includes("grep"), "只读档保留读与搜索");
	assert.equal(readonlyTools.some((tool) => tool === "bash" || tool === "write" || tool === "edit"), false, "只读档不能有 bash/write/edit");

	const off = await runWith("off");
	const offTools = off[off.indexOf("--tools") + 1]!.split(",");
	assert.deepEqual(offTools.sort(), ["ask_user", "leave_message", "say", "set_next_breath"], "只剩说话档只保留能力工具");
});
