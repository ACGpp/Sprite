import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createMemoryStore, MemoryStoreError } from "./memory-store.ts";
import { createMemoryManagement } from "./memory-management.ts";
import { buildMemoryContext } from "./memory-context.ts";
import { emptyState } from "./state.ts";
import type { MemoryAgreementSnapshot, MemoryManagementRequest } from "../contracts/memory-management.ts";

function fixture(t: test.TestContext) {
	fs.mkdirSync(".core-test", { recursive: true });
	const homeDir = fs.mkdtempSync(path.resolve(".core-test/memory-management-"));
	t.after(() => fs.rmSync(homeDir, { force: true, recursive: true }));
	const store = createMemoryStore({ homeDir, fsync: false });
	return { homeDir, store, management: createMemoryManagement({ store }) };
}
const code = (expected: string) => (error: unknown) => error instanceof MemoryStoreError && error.code === expected;
const sha = (content: string) => createHash("sha256").update(content).digest("hex");
function seed(home: string, file: string, content: string) {
	fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
	fs.writeFileSync(path.join(home, file), content);
}

test("management inventories current files and deleted historical files, binding previews to the selected path", t => {
	const { homeDir, store } = fixture(t);
	const first = store.write("identity.md", "我自己选择的身份", "missing", "identity-first");
	store.write("identity.md", "我改变后的身份", first.version, "identity-second");
	const secret = store.write("private/note.md", "不属于身份的笔记", "missing", "private-first");
	seed(homeDir, "notes/manual.md", "历史系统接入前的笔记");
	fs.unlinkSync(path.join(homeDir, "private/note.md"));
	const files = store.listFiles().files;
	assert.deepEqual(files.map(file => file.path), ["identity.md", "notes/manual.md", "private/note.md"]);
	assert.equal(files.find(file => file.path === "private/note.md")?.version, "missing");
	assert.equal(store.versions("identity.md").versions.length, 2);
	assert.equal(store.preview("identity.md", first.version).content, "我自己选择的身份");
	assert.throws(() => store.preview("identity.md", secret.version), code("VERSION_NOT_FOUND"));
	assert.equal(store.preview("private/note.md", "missing").content, null);
});

test("restore is a new audited CAS write and stale retries do not roll back subsequent Agent edits", t => {
	const { homeDir, store } = fixture(t);
	const one = store.write("identity.md", "one", "missing", "one");
	const two = store.write("identity.md", "two", one.version, "two");
	assert.throws(() => store.restore("identity.md", one.version, one.version, "stale"), code("VERSION_CONFLICT"));
	const restored = store.restore("identity.md", one.version, two.version, "user-restore");
	assert.equal(restored.verified, true);
	assert.equal(restored.previousVersion, two.version);
	const entry = store.versions("identity.md").versions.find(item => item.version === restored.version)!;
	assert.equal(entry.kind, "restore"); assert.equal(entry.requestId, "user-restore");
	assert.ok(entry.recordedAt);
	store.write("identity.md", "three", restored.version, "three");
	const reopened = createMemoryStore({ homeDir, fsync: false });
	assert.deepEqual(reopened.restore("identity.md", one.version, two.version, "user-restore"), restored);
	assert.equal(reopened.read("identity.md").content, "three");
	assert.throws(() => reopened.restore("identity.md", two.version, two.version, "user-restore"), code("REQUEST_ID_REUSED"));
	assert.deepEqual(reopened.listPending(), []);
});

test("explicit user restoration supports protected constraints without permitting Agent writes", t => {
	const { homeDir, store } = fixture(t);
	seed(homeDir, "context/constraints.md", "legacy constraint");
	const old = store.read("context/constraints.md");
	const proposal = store.proposal(old.path, "confirmed constraint", old.version, "用户检查具体差异", "proposal");
	const approved = store.resolve(proposal.id, true, "approve");
	const result = store.restore(old.path, old.version, approved.result!.version, "user-restores-legacy");
	assert.equal(store.read(old.path).content, "legacy constraint");
	assert.equal(result.verified, true);
	assert.equal(store.getApproval(old.path, result.version), null, "未确认的legacy内容不能借恢复自动变成确认授权");
	assert.throws(() => store.write(old.path, "扩大权限", result.version, "agent-write"), code("PATH_DENIED"));
});

test("restore recovers a durable interrupted intent and retains the original history", t => {
	const { homeDir, store } = fixture(t);
	const one = store.write("notes/n.md", "one", "missing", "one");
	const two = store.write("notes/n.md", "two", one.version, "two");
	const id = "interrupted-restore";
	const fingerprint = sha(JSON.stringify({ kind: "restore", file: "notes/n.md", version: one.version, baseVersion: two.version }));
	seed(homeDir, `runtime/memory/requests/${sha(id)}.json`, JSON.stringify({ id, fingerprint, kind: "restore", path: "notes/n.md", before: "two", after: "one", baseVersion: two.version, status: "intent", createdAt: new Date().toISOString() }));
	const reopened = createMemoryStore({ homeDir, fsync: false });
	assert.equal(reopened.read("notes/n.md").content, "one");
	assert.equal(reopened.restore("notes/n.md", one.version, two.version, id).verified, true);
	assert.equal(reopened.readVersion(two.version), "two");
});

test("agreement drafts, activation and revocation are user sourced, versioned and preserve legacy bytes", t => {
	const { homeDir, store, management } = fixture(t);
	const legacy = "\uFEFF# 历史约定\r\n尚未核实的原文\r\n";
	seed(homeDir, "context/constraints.md", legacy);
	const initial = store.agreements();
	const added = store.changeAgreement({ kind: "memory.manage", action: "agreement.add", text: "发送前先问我", agreementKind: "restriction", status: "draft", baseRevision: initial.revision, commandId: "draft" });
	assert.equal(added.items[0].status, "draft");
	assert.doesNotMatch(management.agreementContext(), /发送前先问我/);
	const active = store.changeAgreement({ kind: "memory.manage", action: "agreement.activate", agreementId: added.items[0].id, baseRevision: added.revision, commandId: "activate" });
	assert.equal(active.items[0].status, "active");
	assert.equal(active.items[0].activationCommandId, "activate");
	assert.deepEqual(active.items[0].source, { type: "user", commandId: "draft" });
	assert.match(management.agreementContext(), /发送前先问我/);
	const revoked = store.changeAgreement({ kind: "memory.manage", action: "agreement.revoke", agreementId: active.items[0].id, baseRevision: active.revision, commandId: "revoke" });
	assert.equal(revoked.items[0].status, "revoked");
	assert.equal(revoked.items[0].revocationCommandId, "revoke");
	assert.equal(fs.readFileSync(path.join(homeDir, "context/constraints.md"), "utf8"), legacy);
	assert.equal(revoked.legacy.content, legacy);
	assert.match(management.agreementContext(), /到期或撤销限制不代表用户授权/);
});

test("agreement commands use CAS and persisted deduplication, including retries after newer user actions", t => {
	const { homeDir, store } = fixture(t);
	const initial = store.agreements();
	const request: MemoryManagementRequest = { kind: "memory.manage", action: "agreement.add", text: "简洁回答", agreementKind: "preference", status: "active", baseRevision: initial.revision, commandId: "add" };
	const added = store.changeAgreement(request);
	assert.throws(() => store.changeAgreement({ ...request, commandId: "other" }), code("VERSION_CONFLICT"));
	const revoked = store.changeAgreement({ kind: "memory.manage", action: "agreement.revoke", agreementId: added.items[0].id, baseRevision: added.revision, commandId: "revoke" });
	const reopened = createMemoryStore({ homeDir, fsync: false });
	assert.deepEqual(reopened.changeAgreement(request), revoked, "重试只返回最新列表，不重新生效或添加");
	assert.throws(() => reopened.changeAgreement({ ...request, text: "不同操作" }), code("REQUEST_ID_REUSED"));
	const ledger = JSON.parse(fs.readFileSync(path.join(homeDir, "runtime/memory/agreements.json"), "utf8"));
	assert.equal(ledger.actions.length, 2);
	assert.equal(ledger.actions[1].action, "agreement.revoke");
});

test("expiration is computed per read; expired grants leave effective context and restrictions do not imply permission", t => {
	const { store, management } = fixture(t);
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-21T00:00:00Z") });
	let snapshot = store.agreements();
	for (const kind of ["authorization", "restriction"] as const) {
		snapshot = store.changeAgreement({ kind: "memory.manage", action: "agreement.add", agreementKind: kind, text: `${kind}正文`, status: "active", expiresAt: "2026-09-21T01:00:00Z", baseRevision: snapshot.revision, commandId: kind });
	}
	assert.ok(snapshot.items.every(item => item.status === "active"));
	t.mock.timers.setTime(new Date("2026-09-21T01:00:00Z").valueOf());
	const expired = store.agreements();
	assert.ok(expired.items.every(item => item.status === "expired"));
	assert.equal(expired.revision, snapshot.revision, "到期投影不虚构新的用户写入");
	const context = management.agreementContext();
	assert.match(context, /有效约定：\[\]/);
	assert.match(context, /到期或撤销的授权立即失效/);
	assert.match(context, /到期或撤销限制不代表用户授权/);
	assert.doesNotMatch(context, /authorization正文|restriction正文/);
	assert.match(context, /已结束约定：2 条（撤销 0 条，到期 2 条）/);
	assert.equal(expired.items[0].text, "authorization正文", "完整审计内容仍可从管理界面查询");
});

test("revoked agreement history cannot exhaust future model context, while active agreements remain complete", t => {
	const { homeDir, store, management } = fixture(t);
	let snapshot = store.agreements();
	const endedText = "已撤销历史".repeat(2600);
	for (let index = 0; index < 8; index++) {
		snapshot = store.changeAgreement({ kind: "memory.manage", action: "agreement.add", text: endedText,
			agreementKind: "authorization", status: "active", baseRevision: snapshot.revision, commandId: `add-ended-${index}` });
		snapshot = store.changeAgreement({ kind: "memory.manage", action: "agreement.revoke", agreementId: snapshot.items.at(-1)!.id,
			baseRevision: snapshot.revision, commandId: `revoke-ended-${index}` });
	}
	const activeText = "仍然生效的完整限制".repeat(1000);
	store.changeAgreement({ kind: "memory.manage", action: "agreement.add", text: activeText, agreementKind: "restriction",
		status: "active", baseRevision: snapshot.revision, commandId: "active-current" });
	const agreementsContext = management.agreementContext();
	assert.doesNotMatch(agreementsContext, /已撤销历史/);
	assert.ok(agreementsContext.includes(activeText));
	assert.match(agreementsContext, /已结束约定：8 条/);
	const context = buildMemoryContext({ homeDir, state: emptyState(), capabilities: "test", contextWindow: 131072,
		outputReserve: 32768, agreementsContext });
	assert.ok(context.text.includes(activeText));
	assert.ok(context.budget.remainingTokens > 0);
	assert.equal(store.agreements().items.filter(item => item.text === endedText).length, 8, "归档正文仍完整保留");
});

test("invalid expiry, stale expired drafts and unsupported mutations cannot silently become authority", t => {
	const { store, management } = fixture(t);
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-21T00:00:00Z") });
	const request = { kind: "memory.manage", action: "agreement.add", agreementKind: "restriction", text: "draft", status: "draft", baseRevision: store.agreements().revision, commandId: "draft" } as const;
	for (const expiresAt of ["yesterday", "2026-09-20T00:00:00Z", "2026-09-22T00:00:00+00:00", "2026-09-31T00:00:00Z"]) {
		assert.throws(() => store.changeAgreement({ ...request, expiresAt }), code("INVALID_EXPIRY"));
	}
	const added = store.changeAgreement({ ...request, expiresAt: "2026-09-21T01:00:00Z" });
	t.mock.timers.setTime(new Date("2026-09-21T02:00:00Z").valueOf());
	assert.throws(() => store.changeAgreement({ kind: "memory.manage", action: "agreement.activate", agreementId: added.items[0].id, baseRevision: added.revision, commandId: "activate" }), code("INVALID_EXPIRY"));
	assert.throws(() => management.handle({ kind: "memory.manage", action: "agreement.approve" }), code("INVALID_REQUEST"));
	assert.throws(() => management.handle({ kind: "memory.write", action: "agreements" }), code("INVALID_REQUEST"));
});

test("management rejects linked ledger and linked history instead of following them", t => {
	const { homeDir, store } = fixture(t);
	const first = store.write("identity.md", "one", "missing", "one");
	store.write("identity.md", "two", first.version, "two");
	const history = path.join(homeDir, `runtime/memory/versions/${first.version.slice(7)}.txt`);
	fs.unlinkSync(history); fs.symlinkSync(path.join(homeDir, "identity.md"), history);
	assert.throws(() => store.preview("identity.md", first.version), code("UNSAFE_PATH"));
	fs.symlinkSync(path.join(homeDir, "identity.md"), path.join(homeDir, "runtime/memory/agreements.json"));
	assert.throws(() => store.agreements(), code("UNSAFE_PATH"));
});

test("user dispatcher returns current contract shapes without mutating real memory", t => {
	const { management } = fixture(t);
	assert.deepEqual(management.handle({ kind: "memory.manage", action: "listFiles" }), { files: [] });
	const snapshot = management.handle({ kind: "memory.manage", action: "agreements" }) as MemoryAgreementSnapshot;
	assert.deepEqual(snapshot.items, []);
	assert.equal(snapshot.legacy.version, "missing");
	assert.throws(() => management.handle({ kind: "memory.manage", action: "preview", path: "../identity.md", version: "missing" }), code("PATH_DENIED"));
});
