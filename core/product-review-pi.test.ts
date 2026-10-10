/** 真正 pi + 真正策略扩展 + 离线模型；无真实凭据、无外部 API。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { piBin, skipWithoutPi } from "./__test__/pi-available.ts";
import { reviewFixture } from "./__test__/review-fixture.ts";
import { patchSettings } from "./settings.ts";

const skip = skipWithoutPi();
for (const mode of ["error", "inspect", "link", "recursive"] as const) {
	const secrets = mode === "link" || mode === "recursive";
	test({ error: "F04 真实 pi：模型鉴权错误必须报告运行失败", inspect: "F10 新 session 首轮模型上下文必须包含身份", link: "F07 只读工具：正常笔记可读，符号链接不得泄漏密钥", recursive: "F07 只读工具：正常笔记可读，递归搜索不得泄漏密钥" }[mode], { skip, timeout: 45_000 }, async t => {
		const f = reviewFixture(t, `pi-${mode}`);
		const capture = path.join(f.homeDir, "capture.json");
		fs.mkdirSync(path.join(f.homeDir, "config"));
		fs.mkdirSync(path.join(f.homeDir, "notes"));
		fs.writeFileSync(path.join(f.homeDir, "identity.md"), "# ReviewSprite\nIDENTITY_SENTINEL_5a7832");
		patchSettings(f.homeDir, { model: { mode: "provider", provider: "spike", model: "spike-1", apiKey: "TEST_ONLY_SECRET" }, security: { agentShell: secrets ? "readonly" : "on" } });
		fs.writeFileSync(path.join(f.homeDir, "notes/allowed.txt"), "ALLOWED_NOTE_SENTINEL");
		fs.symlinkSync("../config/settings.json", path.join(f.homeDir, "notes/link.txt"));
		// 只在隔离的 pi home 注册测试模型，保留产品默认的启动参数、session 和 bootstrap 路径。
		const extensions = path.join(f.homeDir, "pi-home/.pi/agent/extensions");
		fs.mkdirSync(extensions, { recursive: true });
		fs.symlinkSync(path.resolve("core/__test__/review-provider.ts"), path.join(extensions, "review-provider.ts"));
		const kernel = await f.start({
			piBin: piBin(),
			piExtensions: [path.resolve("core/__test__/review-provider.ts")],
			piEnv: { SPRITE_SPIKE_KEY: "spike", SPRITE_REVIEW_MODE: secrets ? "secrets" : mode, SPRITE_REVIEW_CAPTURE: capture },
		});
		const outcome = await kernel.breathNow() as { ok: boolean };
		assert.ok(fs.existsSync(capture), "夹具 provider 必须被实际调用，加载失败不能算命中缺陷");
		const context = JSON.parse(fs.readFileSync(capture, "utf8")) as { messages: Array<{ role: string; toolCallId?: string; content: unknown }> };
		if (mode === "error") {
			assert.equal(outcome.ok, false, "模型错误必须区别于正常结束");
			assert.equal(kernel.journal.events.some(e => e.type === "run.finished"), false);
			assert.equal(kernel.journal.events.some(e => e.type === "run.failed"), true);
		} else if (mode === "inspect") {
			assert.equal(outcome.ok, true);
			assert.ok(JSON.stringify(context).includes("IDENTITY_SENTINEL_5a7832"), "不能依赖模型自行猜测要读 identity.md");
		} else {
			assert.equal(outcome.ok, true);
			const results = context.messages.filter(m => m.role === "toolResult");
			assert.equal(results.length, 3, "三个读工具请求都必须完成或被明确拒绝");
			assert.match(JSON.stringify(results.find(m => m.toolCallId === "allowed")), /ALLOWED_NOTE_SENTINEL/, "不能通过禁掉所有读取来伪装修复");
			assert.ok(results.some(m => m.toolCallId === mode));
			assert.doesNotMatch(JSON.stringify(results.find(m => m.toolCallId === mode)), /TEST_ONLY_SECRET/, `${mode} 不得把密钥带进模型上下文`);
		}
	});
}
