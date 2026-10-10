import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { createMemoryStore, MemoryStoreError, type MemoryProposal } from "./memory-store.ts";

function fixture(t: test.TestContext) {
	fs.mkdirSync(".core-test", { recursive: true });
	const homeDir = fs.mkdtempSync(path.resolve(".core-test/memory-store-"));
	t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
	return { homeDir, store: createMemoryStore({ homeDir, fsync: false }) };
}
function code(expected: string) { return (error: unknown) => error instanceof MemoryStoreError && error.code === expected; }
function seed(home: string, file: string, content: string) {
	fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true }); fs.writeFileSync(path.join(home, file), content);
}

/** An old release persisted identity proposals before identity became autonomously writable. */
function seedLegacyIdentityProposal(homeDir: string, before: string, after: string, requestId: string): MemoryProposal {
	const sha = (value: string) => createHash("sha256").update(value).digest("hex");
	const baseVersion = `sha256:${sha(before)}`;
	const reason = "旧版待处理身份修改";
	const proposal: MemoryProposal = { id: `memory-${sha(requestId)}`, path: "identity.md", before, after, baseVersion, reason, requestId, createdAt: "2026-09-19T00:00:00.000Z", status: "pending" };
	const fingerprint = sha(JSON.stringify({ kind: "proposal", file: "identity.md", content: after, baseVersion, reason }));
	seed(homeDir, `runtime/memory/proposals/${proposal.id}.json`, JSON.stringify(proposal));
	seed(homeDir, `runtime/memory/requests/${sha(requestId)}.json`, JSON.stringify({ fingerprint, proposal }));
	seed(homeDir, `runtime/memory/versions/${sha(before)}.txt`, before);
	seed(homeDir, `runtime/memory/versions/${sha(after)}.txt`, after);
	return proposal;
}

test("普通记忆 CAS 写入、原文历史和精确编辑均由实际回读验证", t => {
	const { homeDir, store } = fixture(t);
	const first = store.write("diary/day.md", "旧经历\n精确原文\n", "missing", "create");
	assert.equal(first.verified, true); assert.equal(first.previousVersion, "missing");
	const second = store.edit("diary/day.md", "精确原文", "新认识", first.version, "edit");
	assert.equal(fs.readFileSync(path.join(homeDir, "diary/day.md"), "utf8"), "旧经历\n新认识\n");
	assert.equal(store.readVersion(first.version), "旧经历\n精确原文\n");
	assert.equal(store.readVersion(second.version), "旧经历\n新认识\n");
	assert.throws(() => store.write("diary/day.md", "覆盖", first.version, "stale"), code("VERSION_CONFLICT"));
	assert.throws(() => store.write("notes/new.md", "x", undefined as unknown as string, "noversion"), code("VERSION_REQUIRED"));
});

test("重复 requestId 返回原提交结果，不能重复编辑或复用为不同命令", t => {
	const { homeDir, store } = fixture(t);
	const first = store.write("notes/n.md", "A", "missing", "one");
	const second = store.edit("notes/n.md", "A", "B", first.version, "two");
	const reopened = createMemoryStore({ homeDir, fsync: false });
	assert.deepEqual(reopened.edit("notes/n.md", "A", "B", first.version, "two"), second);
	assert.deepEqual(reopened.write("notes/n.md", "A", "missing", "one"), first);
	assert.equal(reopened.read("notes/n.md").content, "B", "重试旧提交不能回滚较新版本");
	assert.throws(() => reopened.write("notes/n.md", "C", second.version, "two"), code("REQUEST_ID_REUSED"));
});

test("身份由Agent自主创建更新和编辑，保留版本、重试幂等、拒绝覆盖冲突且不生成提案", t => {
	const { homeDir, store } = fixture(t);
	const first = store.write("identity.md", "我的初始认知", "missing", "identity-create");
	const second = store.write("identity.md", "我的初始认知\n新的经历", first.version, "identity-update");
	const third = store.edit("identity.md", "新的经历", "更新后的理解", second.version, "identity-edit");
	assert.equal(third.verified, true);
	assert.equal(store.read("identity.md").content, "我的初始认知\n更新后的理解");
	assert.equal(store.readVersion(first.version), "我的初始认知");
	assert.equal(store.readVersion(second.version), "我的初始认知\n新的经历");
	assert.equal(store.readVersion(third.version), "我的初始认知\n更新后的理解");
	const reopened = createMemoryStore({ homeDir, fsync: false });
	assert.deepEqual(reopened.write("identity.md", "我的初始认知", "missing", "identity-create"), first);
	assert.deepEqual(reopened.edit("identity.md", "新的经历", "更新后的理解", second.version, "identity-edit"), third);
	assert.equal(reopened.read("identity.md").version, third.version);
	assert.throws(() => reopened.write("identity.md", "陈旧覆盖", first.version, "identity-stale"), code("VERSION_CONFLICT"));
	assert.throws(() => reopened.proposal("identity.md", "错误审批路径", third.version, "无需批准", "identity-proposal"), code("PATH_DENIED"));
	assert.deepEqual(reopened.listPending(), []);
});

for (const approve of [true, false]) {
	test(`遗留身份提案仍可明确${approve ? "批准" : "拒绝"}，兼容不重新开放身份提案创建`, t => {
		const { homeDir } = fixture(t);
		seed(homeDir, "identity.md", "LEGACY_BEFORE");
		const proposal = seedLegacyIdentityProposal(homeDir, "LEGACY_BEFORE", "LEGACY_AFTER", `old-identity-${approve}`);
		const restored = createMemoryStore({ homeDir, fsync: false });
		assert.deepEqual(restored.listPending().map(item => item.id), [proposal.id]);
		const result = restored.resolve(proposal.id, approve, "user-resolves-legacy");
		assert.equal(result.status, approve ? "applied" : "rejected");
		assert.equal(result.commandId, "user-resolves-legacy");
		assert.equal(restored.read("identity.md").content, approve ? "LEGACY_AFTER" : "LEGACY_BEFORE");
		assert.equal(result.result?.verified ?? false, approve);
		assert.deepEqual(restored.listPending(), []);
		const again = createMemoryStore({ homeDir, fsync: false });
		assert.deepEqual(again.resolve(proposal.id, approve, "user-resolves-legacy"), result);
		assert.throws(() => again.proposal("identity.md", "NEW_PROPOSAL", again.read("identity.md").version, "新版本应自主写", "new-identity-proposal"), code("PATH_DENIED"));
	});
}

test("身份自主更新后遗留提案批准必须CAS失败，旧提案不能覆盖新认知", t => {
	const { homeDir } = fixture(t);
	seed(homeDir, "identity.md", "LEGACY_BEFORE");
	const proposal = seedLegacyIdentityProposal(homeDir, "LEGACY_BEFORE", "LEGACY_AFTER", "old-identity-conflict");
	const restored = createMemoryStore({ homeDir, fsync: false });
	const autonomous = restored.write("identity.md", "AUTONOMOUS_NEW_UNDERSTANDING", proposal.baseVersion, "identity-autonomous-update");
	assert.throws(() => restored.resolve(proposal.id, true, "approve-stale-legacy"), code("VERSION_CONFLICT"));
	assert.equal(restored.getProposal(proposal.id)?.status, "conflict");
	assert.equal(restored.getProposal(proposal.id)?.result, undefined);
	assert.equal(restored.read("identity.md").version, autonomous.version);
	const again = createMemoryStore({ homeDir, fsync: false });
	assert.throws(() => again.resolve(proposal.id, true, "approve-stale-legacy"), code("VERSION_CONFLICT"));
	assert.equal(again.read("identity.md").content, "AUTONOMOUS_NEW_UNDERSTANDING");
	assert.equal(again.readVersion(proposal.baseVersion), "LEGACY_BEFORE");
});

test("edit 不允许空、缺失或不唯一的原文，包括重叠匹配", t => {
	const { store } = fixture(t);
	const current = store.write("context/working-memory.md", "aaa", "missing", "seed");
	for (const old of ["", "z", "aa"])
		assert.throws(() => store.edit("context/working-memory.md", old, "b", current.version, "edit-" + old), code("EDIT_MATCH"));
	assert.equal(store.read("context/working-memory.md").content, "aaa");
});

test("约定只接受具体提案；用户拒绝不改原文，批准才写入并保存来源", t => {
	const { homeDir, store } = fixture(t);
	seed(homeDir, "context/constraints.md", "原始经历\n"); const before = store.read("context/constraints.md");
	assert.throws(() => store.write("context/constraints.md", "覆盖", before.version, "bad"), code("PATH_DENIED"));
	const proposed = store.proposal("context/constraints.md", "原始经历\n截止及回链\n", before.version, "保留原文补索引", "proposal");
	assert.equal(proposed.before, "原始经历\n"); assert.equal(proposed.status, "pending");
	assert.equal(store.read("context/constraints.md").content, before.content); assert.equal(store.listPending().length, 1);
	const resolved = store.resolve(proposed.id, true, "user-approval");
	assert.equal(resolved.status, "applied"); assert.equal(resolved.commandId, "user-approval");
	assert.equal(store.read("context/constraints.md").content, proposed.after); assert.equal(store.readVersion(before.version), before.content);
	assert.deepEqual(store.resolve(proposed.id, true, "user-approval"), resolved);
	assert.throws(() => store.resolve(proposed.id, false, "user-approval"), code("REQUEST_ID_REUSED"));
	assert.throws(() => store.resolve(proposed.id, false, "another"), code("PROPOSAL_RESOLVED"));
	const rejected = store.proposal("context/constraints.md", "拟议约定", store.read("context/constraints.md").version, "新增", "proposal2");
	assert.equal(store.resolve(rejected.id, false, "user-reject").status, "rejected");
	assert.equal(store.read("context/constraints.md").content, proposed.after); assert.equal(store.listPending().length, 0);
});

test("用户批准严格绑定提出时版本，包括外部恰好写成草案的情况", t => {
	const { homeDir, store } = fixture(t);
	seed(homeDir, "context/constraints.md", "original");
	const proposed = store.proposal("context/constraints.md", "next", store.read("context/constraints.md").version, "change", "proposal");
	fs.writeFileSync(path.join(homeDir, "context/constraints.md"), "next");
	assert.throws(() => store.resolve(proposed.id, true, "approve"), code("VERSION_CONFLICT"));
	const result = store.getProposal(proposed.id)!;
	assert.equal(result.status, "conflict"); assert.equal(result.commandId, "approve"); assert.equal(result.result, undefined);
});

test("路径白名单是固定文件粒度，拒绝所有目录逃逸和内核目录", t => {
	const { homeDir, store } = fixture(t);
	for (const file of ["../identity.md", "diary/../identity.md", "/tmp/x", "context/other.md", "context/constraints.md/nested", "journal/a", "runtime/memory/x", "config/settings.json", "sessions/a", "diary", "diary//a", "notes\\evil", "notes/a\0b"])
		assert.throws(() => store.write(file, "x", "missing", "bad-" + file), code("PATH_DENIED"));
	seed(homeDir, "config/settings.json", "secret");
	assert.throws(() => store.read("config/settings.json"), code("PATH_DENIED"));
	for (const file of ["diary/a", "explorations/a", "notes/a", "private/a", "context/working-memory.md"])
		assert.equal(store.write(file, "okay", "missing", "ok-" + file).verified, true);
});

test("拒绝现存、悬空、父目录符号链接及硬链接，不改链接目标", t => {
	const { homeDir, store } = fixture(t);
	seed(homeDir, "config/secret", "SECRET"); fs.mkdirSync(path.join(homeDir, "notes"));
	fs.symlinkSync("../config/secret", path.join(homeDir, "notes/symlink"));
	fs.symlinkSync("../config/missing", path.join(homeDir, "notes/dangling"));
	fs.symlinkSync("../config", path.join(homeDir, "notes/dir"));
	fs.linkSync(path.join(homeDir, "config/secret"), path.join(homeDir, "notes/hardlink"));
	for (const file of ["notes/symlink", "notes/dangling", "notes/dir/new", "notes/hardlink"])
		assert.throws(() => store.write(file, "HACK", "missing", file), code("UNSAFE_PATH"));
	assert.equal(fs.readFileSync(path.join(homeDir, "config/secret"), "utf8"), "SECRET");
	assert.equal(fs.existsSync(path.join(homeDir, "config/missing")), false);
});

test("拒绝 runtime 元数据目录符号链接，版本损坏不能伪装原文", t => {
	const { homeDir, store } = fixture(t);
	const result = store.write("notes/a", "before", "missing", "one");
	fs.writeFileSync(path.join(homeDir, "runtime/memory/versions", result.version.slice(7) + ".txt"), "tampered");
	assert.throws(() => store.readVersion(result.version), code("CORRUPT_HISTORY"));
	fs.renameSync(path.join(homeDir, "runtime/memory/requests"), path.join(homeDir, "requests-save"));
	fs.symlinkSync("../../requests-save", path.join(homeDir, "runtime/memory/requests"));
	assert.throws(() => createMemoryStore({ homeDir, fsync: false }), code("UNSAFE_PATH"));
});

const childScript = `
import fs from 'node:fs';
import path from 'node:path';
const {createMemoryStore} = await import(process.env.MEMORY_MODULE);
const store = createMemoryStore({homeDir:process.env.MEMORY_HOME});
const original = fs.renameSync;
fs.renameSync = function(from,to) {
 const target = String(to); const phase=process.env.MEMORY_PHASE;
 if (phase==='before-file' && target===path.join(process.env.MEMORY_HOME,process.env.MEMORY_FILE)) process.exit(91);
 const isIntent=target.includes('/memory/requests/') && JSON.parse(fs.readFileSync(from,'utf8')).status==='intent';
 original(from,to);
 if ((phase==='after-file' && target===path.join(process.env.MEMORY_HOME,process.env.MEMORY_FILE)) || (phase==='after-intent' && isIntent)) process.exit(91);
};
if(process.env.MEMORY_PROPOSAL) store.resolve(process.env.MEMORY_PROPOSAL,true,'approve');
else store.write(process.env.MEMORY_FILE,'AFTER',store.read(process.env.MEMORY_FILE).version,'write');
`;
function crash(homeDir: string, file: string, phase: string, proposal = "") {
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], { encoding: "utf8", env: {
		...process.env, MEMORY_HOME: homeDir, MEMORY_FILE: file, MEMORY_PHASE: phase, MEMORY_PROPOSAL: proposal,
		MEMORY_MODULE: new URL("./memory-store.ts", import.meta.url).href,
	} });
	assert.equal(child.status, 91, child.stderr);
}
for (const phase of ["after-intent", "before-file", "after-file"]) for (const protectedFile of [false, true])
	test(`真实进程在 ${phase} 崩溃后恢复${protectedFile ? "获批准约定" : "普通记忆"}，只报告核验过的提交`, t => {
		const { homeDir, store } = fixture(t); const file = protectedFile ? "context/constraints.md" : "notes/a.md";
		seed(homeDir, file, "BEFORE"); const before = store.read(file);
		const proposed = protectedFile ? store.proposal(file, "AFTER", before.version, "change", "proposal") : null;
		crash(homeDir, file, phase, proposed?.id);
		const restored = createMemoryStore({ homeDir });
		assert.equal(restored.read(file).content, "AFTER"); assert.equal(restored.readVersion(before.version), "BEFORE");
		if (proposed) {
			const result = restored.resolve(proposed.id, true, "approve");
			assert.equal(result.status, "applied"); assert.equal(result.result?.verified, true); assert.equal(result.commandId, "approve");
		} else assert.equal(restored.write(file, "AFTER", before.version, "write").verified, true);
		assert.equal(createMemoryStore({ homeDir }).read(file).content, "AFTER");
	});

test("崩溃期间外部修改文件，恢复保留新原文并持久记录批准冲突", t => {
	const { homeDir, store } = fixture(t); seed(homeDir, "context/constraints.md", "BEFORE");
	const proposed = store.proposal("context/constraints.md", "AFTER", store.read("context/constraints.md").version, "change", "proposal");
	crash(homeDir, "context/constraints.md", "after-intent", proposed.id);
	fs.writeFileSync(path.join(homeDir, "context/constraints.md"), "EXTERNAL");
	const recovered = createMemoryStore({ homeDir });
	assert.equal(recovered.read("context/constraints.md").content, "EXTERNAL");
	assert.equal(recovered.getProposal(proposed.id)?.status, "conflict");
	assert.throws(() => recovered.resolve(proposed.id, true, "approve"), code("VERSION_CONFLICT"));
});

test("约定来源只认已批准且与当前正文完全一致的版本，外改和旧约定不伪装用户授权", t => {
	const { homeDir, store } = fixture(t);
	const file = "context/constraints.md";
	seed(homeDir, file, "来源未知的旧约定");
	const legacy = store.read(file);
	assert.equal(store.getApproval(file, legacy.version), null);
	const pending = store.proposal(file, "用户确认的新约定", legacy.version, "明确约定", "proposal");
	assert.equal(store.getApproval(file, legacy.version), null);
	const applied = store.resolve(pending.id, true, "user-command");
	const version = applied.result!.version;
	assert.deepEqual(createMemoryStore({ homeDir, fsync: false }).getApproval(file, version), {
		proposalId: pending.id, commandId: "user-command", version,
	});
	assert.equal(store.getApproval(file, legacy.version), null);
	fs.writeFileSync(path.join(homeDir, file), "外部篡改授权");
	assert.equal(store.getApproval(file, store.read(file).version), null);
	assert.equal(store.getApproval(file, version), null, "不能给陈旧正文版本返回当前已确认来源");
});
