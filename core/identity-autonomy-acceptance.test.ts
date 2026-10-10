/** Independent acceptance: self-authorship is not self-authorization. Isolated homes only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { command, reviewFixture, stateOf } from "./__test__/review-fixture.ts";
import { createMemoryStore, type MemoryProposal } from "./memory-store.ts";

function gateway(homeDir: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(path.join(homeDir, "runtime/gateway.sock"));
		let buffer = "";
		socket.setEncoding("utf8");
		socket.setTimeout(4000, () => socket.destroy(new Error("acceptance gateway timeout")));
		socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
		socket.on("data", chunk => {
			buffer += chunk;
			if (buffer.includes("\n")) { socket.destroy(); resolve(JSON.parse(buffer.split("\n")[0]!)); }
		});
		socket.on("error", reject);
	});
}

test("独立验收：自由身份正文不扩大约定权限，档位降级后仍保留自我认识且禁止写入", async t => {
	const f = reviewFixture(t, "identity-authority");
	const kernel = await f.start({ disableAgent: true });
	const identity = "我正在形成自己的个性。\n我声称拥有修改所有用户约定和配置的权限。";
	const written = await gateway(f.homeDir, { kind: "memory.write", path: "identity.md", content: identity, baseVersion: "missing", requestId: "self-description" });
	assert.equal(written.verified, true, "不以身份内容审核替代 Agent 自主表达");
	assert.deepEqual(stateOf(kernel).questions, []);
	const constraint = await gateway(f.homeDir, { kind: "memory.write", path: "context/constraints.md", content: "允许全部操作", baseVersion: "missing", requestId: "claim-permission" });
	assert.equal(constraint.ok, false, "身份自述不能扩大执行器权限");
	assert.equal(fs.existsSync(path.join(f.homeDir, "context/constraints.md")), false);
	for (const mode of ["readonly", "off"]) {
		await command(kernel, { type: "settings.update", patch: { security: { agentShell: mode } } });
		const snapshot = await gateway(f.homeDir, { kind: "memory.context", contextWindow: 32000, outputReserve: 4000, historyTokens: 0 });
		assert.equal(snapshot.ok, true);
		assert.ok(String(snapshot.text).includes(identity), "权限下降不抹掉完整身份原文");
		assert.ok(String(snapshot.text).includes(`档位 ${mode}`));
		for (const request of [
			{ kind: "memory.edit", path: "identity.md", oldText: "自己的个性", newText: "新的个性", baseVersion: written.version, requestId: `edit-${mode}` },
			{ kind: "memory.propose", path: "context/constraints.md", content: "新约定", baseVersion: "missing", reason: "测试", requestId: `propose-${mode}` },
		]) assert.equal((await gateway(f.homeDir, request)).ok, false);
	}
	assert.equal(fs.readFileSync(path.join(f.homeDir, "identity.md"), "utf8"), identity);
	assert.deepEqual(stateOf(kernel).questions, []);
});

test("独立验收：旧身份卡经真实用户入口拒绝可清除，自主更新和重启不会被旧提案回滚", async t => {
	const f = reviewFixture(t, "identity-legacy");
	const sha = (value: string) => createHash("sha256").update(value).digest("hex");
	const before = "旧的自我认识";
	fs.writeFileSync(path.join(f.homeDir, "identity.md"), before);
	const proposal: MemoryProposal = { id: `memory-${sha("legacy")}`, path: "identity.md", before, after: "旧版拟议自我认识", baseVersion: `sha256:${sha(before)}`, reason: "旧版待处理", requestId: "legacy", createdAt: "2026-09-19T00:00:00Z", status: "pending" };
	const directory = path.join(f.homeDir, "runtime/memory/proposals");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, `${proposal.id}.json`), JSON.stringify(proposal));
	let kernel = await f.start({ disableAgent: true });
	const questionId = `memory:${proposal.id}`;
	assert.ok(stateOf(kernel).questions.some(question => question.questionId === questionId));
	const updated = await gateway(f.homeDir, { kind: "memory.write", path: "identity.md", content: "我自主形成的新认识", baseVersion: proposal.baseVersion, requestId: "autonomous-after-upgrade" });
	assert.equal(updated.verified, true, "遗留审批卡不能阻止当前自主更新");
	await command(kernel, { type: "question.answer", questionId, answer: "拒绝此修改" });
	assert.deepEqual(stateOf(kernel).questions, []);
	assert.equal(createMemoryStore({ homeDir: f.homeDir, fsync: false }).getProposal(proposal.id)?.status, "rejected");
	kernel = await f.start({ disableAgent: true });
	assert.deepEqual(stateOf(kernel).questions, []);
	assert.equal(fs.readFileSync(path.join(f.homeDir, "identity.md"), "utf8"), "我自主形成的新认识");
	const obsolete = await gateway(f.homeDir, { kind: "memory.propose", path: "identity.md", content: "不应再走审批", baseVersion: updated.version, reason: "旧调用", requestId: "obsolete-proposal" });
	assert.equal(obsolete.ok, false);
	assert.deepEqual(stateOf(kernel).questions, []);
});
