import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ORDINARY_MEMORY_DIRS, ORDINARY_MEMORY_FILES, REVIEWED_MEMORY_FILES } from "../contracts/memory-policy.ts";
import type { MemoryAgreement, MemoryAgreementSnapshot, MemoryFileSummary, MemoryManagementRequest, MemoryVersionSummary } from "../contracts/memory-management.ts";

export type MemoryVersion = string;
export interface MemorySnapshot { path: string; content: string | null; version: MemoryVersion }
export interface MemoryWriteResult {
	path: string; version: MemoryVersion; previousVersion: MemoryVersion; requestId: string; verified: true;
}
export interface MemoryProposal {
	id: string; path: string; before: string | null; after: string; baseVersion: MemoryVersion;
	reason: string; requestId: string; createdAt: string;
	status: "pending" | "applied" | "rejected" | "conflict";
	commandId?: string; resolvedAt?: string; result?: MemoryWriteResult; error?: string;
}
export class MemoryStoreError extends Error {
	code: string;
	constructor(code: string, message: string) { super(message); this.code = code; this.name = "MemoryStoreError"; }
}
interface Transaction {
	id: string; fingerprint: string; kind: "write" | "edit" | "resolve" | "restore";
	path: string; before: string | null; after: string; baseVersion: string;
	createdAt?: string;
	proposalId?: string; approve?: boolean;
	status: "intent" | "committed" | "conflict"; result?: MemoryWriteResult; error?: string;
}
interface ProposalReceipt { fingerprint: string; proposal: MemoryProposal }
interface AgreementLedger {
	items: MemoryAgreement[];
	/** Receipts and entries commit atomically, so interrupted retries never duplicate a user action. */
	actions: { commandId: string; fingerprint: string; at: string; action: string; agreementId: string }[];
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const versionOf = (content: string | null) => content === null ? "missing" : `sha256:${sha(content)}`;
function fail(code: string, message: string): never { throw new MemoryStoreError(code, message); }

/** Single-kernel synchronous writer. Runtime permissions are checked by the caller on every request.
 * This is not an OS sandbox: another process with this user's credentials can still alter files.
 */
export function createMemoryStore(options: { homeDir: string; fsync?: boolean }) {
	const home = fs.realpathSync(options.homeDir);
	const durable = options.fsync !== false;
	const metadata = "runtime/memory";

	function relative(input: string): string {
		if (typeof input !== "string" || !input || input.includes("\0") || input.includes("\\") || path.isAbsolute(input)
			|| input.split("/").some(p => !p || p === "." || p === "..")) fail("PATH_DENIED", "记忆路径必须是没有跳转的相对文件路径");
		return input;
	}
	function permitted(input: string, mode: "ordinary" | "protected" | "read") {
		const file = relative(input);
		const ordinary = ORDINARY_MEMORY_FILES.some(name => file === name) || ORDINARY_MEMORY_DIRS.some(dir => file.startsWith(`${dir}/`));
		const protectedFile = REVIEWED_MEMORY_FILES.some(name => file === name);
		if (!(mode === "ordinary" ? ordinary : mode === "protected" ? protectedFile : ordinary || protectedFile))
			fail("PATH_DENIED", mode === "ordinary" && protectedFile ? "此文件必须提交具体修改提案并由用户批准" : "此路径不属于记忆接口允许范围");
		return file;
	}
	/** Check each component, including dangling symlinks. mkdir is intentionally not recursive. */
	function checked(file: string, makeParents = false): string {
		const parts = relative(file).split("/");
		let current = home;
		for (let i = 0; i < parts.length; i++) {
			current = path.join(current, parts[i]!);
			const parent = i < parts.length - 1;
			let stat: fs.Stats;
			try { stat = fs.lstatSync(current); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				if (parent && makeParents) { fs.mkdirSync(current, { mode: 0o700 }); syncDirectory(path.dirname(current)); stat = fs.lstatSync(current); }
				else if (parent) continue;
				else return current;
			}
			if (stat.isSymbolicLink()) fail("UNSAFE_PATH", "不允许通过符号链接访问记忆文件");
			if (parent && !stat.isDirectory()) fail("UNSAFE_PATH", "记忆路径的父级不是目录");
			if (!parent && (!stat.isFile() || stat.nlink !== 1)) fail("UNSAFE_PATH", "记忆文件必须是没有硬链接的普通文件");
			if (fs.realpathSync(current) !== current) fail("UNSAFE_PATH", "记忆路径解析发生变化");
		}
		return current;
	}
	function syncDirectory(directory: string) {
		if (!durable) return;
		const fd = fs.openSync(directory, fs.constants.O_RDONLY);
		try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	}
	function readText(file: string): string | null {
		const target = checked(file);
		let fd: number;
		try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
		try {
			const stat = fs.fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1) fail("UNSAFE_PATH", "记忆文件不是独立普通文件");
			try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(fd)); }
			catch (error) {
				if (error instanceof TypeError) fail("INVALID_ENCODING", "记忆文件不是有效 UTF-8；原始字节保留，拒绝读取或改写");
				throw error;
			}
		} finally { fs.closeSync(fd); }
	}
	function atomic(file: string, text: string) {
		const target = checked(file, true);
		const temp = `${target}.memory-${randomUUID()}.tmp`;
		let fd: number | undefined;
		try {
			fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
			fs.writeFileSync(fd, text, "utf8"); if (durable) fs.fsyncSync(fd);
			fs.closeSync(fd); fd = undefined;
			checked(file); fs.renameSync(temp, target); syncDirectory(path.dirname(target));
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
			try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	}
	function json<T>(file: string): T | null {
		const text = readText(file); return text === null ? null : JSON.parse(text) as T;
	}
	const txFile = (id: string) => `${metadata}/requests/${sha(id)}.json`;
	const proposalFile = (id: string) => {
		if (!/^memory-[a-f0-9]{64}$/.test(id)) fail("INVALID_PROPOSAL", "无效的记忆提案 ID");
		return `${metadata}/proposals/${id}.json`;
	};
	function saveTx(tx: Transaction) { atomic(txFile(tx.id), JSON.stringify(tx)); }
	function saveProposal(proposal: MemoryProposal) { atomic(proposalFile(proposal.id), JSON.stringify(proposal)); }
	function retain(content: string | null) {
		if (content === null) return;
		const file = `${metadata}/versions/${sha(content)}.txt`;
		const existing = readText(file);
		if (existing === null) atomic(file, content);
		else if (existing !== content) fail("CORRUPT_HISTORY", "记忆历史版本校验失败");
	}
	function read(file: string): MemorySnapshot {
		file = permitted(file, "read");
		const content = readText(file); return { path: file, content, version: versionOf(content) };
	}
	function args(baseVersion: string, requestId: string) {
		if (typeof baseVersion !== "string" || !/^(missing|sha256:[a-f0-9]{64})$/.test(baseVersion)) fail("VERSION_REQUIRED", "必须提供读取时得到的 baseVersion；不存在的文件使用 missing");
		if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 512) fail("REQUEST_ID_REQUIRED", "必须提供稳定 requestId");
	}
	function contentArg(content: string) {
		if (typeof content !== "string") fail("INVALID_CONTENT", "文件内容必须是字符串");
		if (Buffer.from(content, "utf8").toString("utf8") !== content) fail("INVALID_ENCODING", "记忆内容含无效 Unicode 字符；拒绝静默替换后保存");
	}
	function getProposal(id: string): MemoryProposal | null { return json<MemoryProposal>(proposalFile(id)); }
	function settleProposal(tx: Transaction) {
		if (!tx.proposalId) return;
		const proposal = getProposal(tx.proposalId);
		if (!proposal) fail("INVALID_PROPOSAL", "记忆提案不存在");
		const previous = JSON.stringify(proposal);
		proposal.commandId = tx.id; proposal.resolvedAt ??= new Date().toISOString();
		if (tx.status === "conflict") { proposal.status = "conflict"; proposal.error = tx.error; }
		else { proposal.status = tx.approve ? "applied" : "rejected"; if (tx.result) proposal.result = tx.result; }
		if (JSON.stringify(proposal) !== previous) saveProposal(proposal);
	}
	function finish(tx: Transaction): MemoryWriteResult | undefined {
		if (tx.status === "conflict") { settleProposal(tx); fail("VERSION_CONFLICT", tx.error ?? "记忆版本冲突"); }
		if (tx.status === "committed") { settleProposal(tx); return tx.result; }
		if (tx.kind === "resolve" && !tx.approve) {
			tx.status = "committed"; saveTx(tx); settleProposal(tx); return undefined;
		}
		const current = read(tx.path);
		const nextVersion = versionOf(tx.after);
		// The intent is durable before any destination rename. Recovery recognizes either complete side.
		if (current.version !== nextVersion && current.version !== tx.baseVersion) {
			tx.status = "conflict"; tx.error = "文件已被其他操作修改，原提案或写请求不能覆盖新版本";
			saveTx(tx); settleProposal(tx); fail("VERSION_CONFLICT", tx.error);
		}
		if (current.version !== nextVersion) {
			retain(tx.before); retain(tx.after);
			if (read(tx.path).version !== tx.baseVersion) fail("VERSION_CONFLICT", "写入前文件版本发生变化");
			atomic(tx.path, tx.after);
		}
		if (read(tx.path).version !== nextVersion) fail("VERIFY_FAILED", "写入后的内容校验失败，未报告成功");
		tx.result = { path: tx.path, version: nextVersion, previousVersion: tx.baseVersion, requestId: tx.id, verified: true };
		tx.status = "committed"; saveTx(tx); settleProposal(tx); return tx.result;
	}
	function reuse(id: string, fingerprint: string): Transaction | null {
		const receipt = json<Transaction | ProposalReceipt>(txFile(id));
		if (!receipt) {
			if (getProposal(`memory-${sha(id)}`)) fail("REQUEST_ID_REUSED", "requestId 已用于记忆提案");
			return null;
		}
		if (receipt.fingerprint !== fingerprint || !("kind" in receipt)) fail("REQUEST_ID_REUSED", "requestId 已用于不同操作");
		return receipt;
	}
	function change(kind: "write" | "edit", file: string, text: string, replacement: string | undefined, baseVersion: string, requestId: string) {
		file = permitted(file, "ordinary"); args(baseVersion, requestId); contentArg(text);
		if (kind === "edit") contentArg(replacement!);
		const fingerprint = sha(JSON.stringify({ kind, file, text, replacement, baseVersion }));
		const previous = reuse(requestId, fingerprint); if (previous) return finish(previous)!;
		const before = read(file);
		if (before.version !== baseVersion) fail("VERSION_CONFLICT", "文件版本已变化，请重新读取并检查修改");
		let after = text;
		if (kind === "edit") {
			if (!text || before.content === null) fail("EDIT_MATCH", "精确替换需要非空原文和现存文件");
			const index = before.content.indexOf(text);
			if (index < 0 || before.content.indexOf(text, index + 1) >= 0) fail("EDIT_MATCH", "待替换原文必须精确且唯一匹配");
			after = before.content.slice(0, index) + replacement! + before.content.slice(index + text.length);
		}
		retain(before.content); retain(after);
		const tx: Transaction = { id: requestId, fingerprint, kind, path: file, before: before.content, after, baseVersion, status: "intent", createdAt: new Date().toISOString() };
		saveTx(tx); return finish(tx)!;
	}
	function proposal(file: string, content: string, baseVersion: string, reason: string, requestId: string): MemoryProposal {
		file = permitted(file, "protected"); args(baseVersion, requestId); contentArg(content);
		if (typeof reason !== "string" || !reason.trim()) fail("REASON_REQUIRED", "修改用户约定必须说明原因");
		const fingerprint = sha(JSON.stringify({ kind: "proposal", file, content, baseVersion, reason }));
		const receipt = json<ProposalReceipt | Transaction>(txFile(requestId));
		if (receipt) {
			if (receipt.fingerprint !== fingerprint || !("proposal" in receipt)) fail("REQUEST_ID_REUSED", "requestId 已用于不同操作");
			return getProposal(receipt.proposal.id) ?? receipt.proposal;
		}
		const id = `memory-${sha(requestId)}`;
		// A crash between proposal and request receipt is recoverable by the deterministic ID.
		const existing = getProposal(id);
		if (existing) {
			if (existing.path !== file || existing.after !== content || existing.baseVersion !== baseVersion || existing.reason !== reason)
				fail("REQUEST_ID_REUSED", "requestId 已用于不同提案");
			atomic(txFile(requestId), JSON.stringify({ fingerprint, proposal: existing })); return existing;
		}
		const before = read(file);
		if (before.version !== baseVersion) fail("VERSION_CONFLICT", "文件版本已变化，请基于新版本重新提案");
		const item: MemoryProposal = { id, path: file, before: before.content, after: content, baseVersion, reason, requestId, createdAt: new Date().toISOString(), status: "pending" };
		retain(before.content); retain(content); saveProposal(item);
		atomic(txFile(requestId), JSON.stringify({ fingerprint, proposal: item })); return item;
	}
	function resolve(id: string, approve: boolean, commandId: string): MemoryProposal {
		recover();
		args("missing", commandId); if (typeof approve !== "boolean") fail("INVALID_APPROVAL", "必须明确批准或拒绝提案");
		const fingerprint = sha(JSON.stringify({ kind: "resolve", id, approve }));
		const previous = reuse(commandId, fingerprint);
		if (previous) { finish(previous); return getProposal(id)!; }
		const item = getProposal(id); if (!item) fail("INVALID_PROPOSAL", "记忆提案不存在");
		if (item.status !== "pending") fail("PROPOSAL_RESOLVED", "提案已处理，不能用另一次操作改变结果");
		// Old policy versions required identity proposals. Let users settle existing cards;
		// new identity changes use ordinary write/edit and still invalidate a stale proposal.
		permitted(item.path, item.path === "identity.md" ? "ordinary" : "protected");
		const tx: Transaction = { id: commandId, fingerprint, kind: "resolve", path: item.path, before: item.before, after: item.after,
			baseVersion: item.baseVersion, proposalId: id, approve, status: "intent", createdAt: new Date().toISOString() };
		if (approve && read(item.path).version !== item.baseVersion) {
			tx.status = "conflict"; tx.error = "文件版本已变化，用户批准不能应用到另一个版本";
		}
		// Persist explicit user approval/rejection before applying anything, including for recovery.
		saveTx(tx); finish(tx); return getProposal(id)!;
	}
	function listProposals(): MemoryProposal[] {
		const directory = path.dirname(checked(`${metadata}/proposals/.probe`, true));
		return fs.readdirSync(directory).filter(name => /^memory-[a-f0-9]{64}\.json$/.test(name))
			.map(name => getProposal(name.slice(0, -5))!);
	}
	function listPending(): MemoryProposal[] {
		return listProposals().filter(item => item.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	function getApproval(file: string, version: string): { proposalId: string; commandId: string; version: string } | null {
		file = permitted(file, "protected"); args(version, "get-approval");
		if (version === "missing" || read(file).version !== version) return null;
		const proposal = listProposals().filter(item => item.path === file && item.status === "applied"
			&& item.commandId && item.result?.verified === true && item.result.version === version && versionOf(item.after) === version)
			.sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""))[0];
		return proposal ? { proposalId: proposal.id, commandId: proposal.commandId!, version } : null;
	}
	function recover() {
		const directory = path.dirname(checked(`${metadata}/requests/.probe`, true));
		for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
			const receipt = json<Transaction | ProposalReceipt>(`${metadata}/requests/${name}`)!;
			if (!("kind" in receipt)) continue;
			if (receipt.status === "committed" && !receipt.proposalId) continue;
			try { finish(receipt); }
			catch (error) { if (!(error instanceof MemoryStoreError && error.code === "VERSION_CONFLICT")) throw error; }
		}
	}
	function transactions(): Transaction[] {
		const directory = path.dirname(checked(`${metadata}/requests/.probe`, true));
		return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
			.map(name => json<Transaction | ProposalReceipt>(`${metadata}/requests/${name}`)!)
			.filter((item): item is Transaction => "kind" in item && item.status === "committed" && !!item.result);
	}
	function readVersion(version: string): string | null {
		args(version, "read-version"); if (version === "missing") return null;
		const content = readText(`${metadata}/versions/${version.slice(7)}.txt`);
		if (content === null) fail("VERSION_NOT_FOUND", "历史版本不存在");
		if (versionOf(content) !== version) fail("CORRUPT_HISTORY", "记忆历史版本校验失败");
		return content;
	}
	function listFiles(): { files: MemoryFileSummary[] } {
		const names = new Set<string>(transactions().map(tx => permitted(tx.path, "read")));
		for (const file of [...ORDINARY_MEMORY_FILES, ...REVIEWED_MEMORY_FILES]) if (read(file).content !== null) names.add(file);
		function walk(directory: string) {
			// Resolve a probe child so checked validates the directory itself as a parent.
			const absolute = path.dirname(checked(`${directory}/.probe`));
			let entries: fs.Dirent[];
			try { entries = fs.readdirSync(absolute, { withFileTypes: true }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
			for (const entry of entries) {
				const file = `${directory}/${entry.name}`;
				if (entry.isDirectory()) walk(file);
				else if (entry.isFile()) { read(file); names.add(file); }
				// Linked entries are deliberately excluded from the manageable inventory.
			}
		}
		for (const directory of ORDINARY_MEMORY_DIRS) walk(directory);
		return { files: [...names].sort().map(file => {
			const snapshot = read(file); return { path: file, version: snapshot.version, bytes: Buffer.byteLength(snapshot.content ?? "", "utf8") };
		}) };
	}
	function versions(file: string) {
		const current = read(file);
		const versions = new Map<string, MemoryVersionSummary>();
		const add = (content: string | null, tx?: Transaction, before = false) => {
			if (content === null) return;
			const version = versionOf(content);
			versions.set(version, { version, bytes: Buffer.byteLength(content, "utf8"), recordedAt: before ? null : tx?.createdAt ?? null,
				requestId: tx?.id ?? null, kind: before ? "previous" : tx?.kind ?? "current", current: version === current.version });
		};
		for (const tx of transactions().filter(tx => tx.path === current.path).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))) {
			if (!versions.has(versionOf(tx.before))) add(tx.before, tx, true);
			add(tx.after, tx);
		}
		if (!versions.has(current.version)) add(current.content);
		return { path: current.path, currentVersion: current.version,
			versions: [...versions.values()].sort((a, b) => Number(b.current) - Number(a.current) || (b.recordedAt ?? "").localeCompare(a.recordedAt ?? "")) };
	}
	function preview(file: string, version: string): MemorySnapshot {
		args(version, "preview"); const current = read(file);
		if (current.version === version) return current;
		if (!versions(file).versions.some(item => item.version === version)) fail("VERSION_NOT_FOUND", "这个历史版本不属于所选文件");
		return { path: current.path, version, content: readVersion(version) };
	}
	/** This method is intentionally separate from Agent write/edit; only the user RPC may call it. */
	function restore(file: string, version: string, baseVersion: string, commandId: string): MemoryWriteResult {
		file = permitted(file, "read"); args(baseVersion, commandId); args(version, commandId);
		const fingerprint = sha(JSON.stringify({ kind: "restore", file, version, baseVersion }));
		const prior = reuse(commandId, fingerprint); if (prior) return finish(prior)!;
		const before = read(file);
		if (before.version !== baseVersion) fail("VERSION_CONFLICT", "文件已经变化，请重新检查当前内容后恢复");
		const after = preview(file, version).content;
		if (after === null) fail("VERSION_NOT_FOUND", "请选择有内容的历史版本；恢复不删除文件");
		retain(before.content); retain(after);
		const tx: Transaction = { id: commandId, fingerprint, kind: "restore", path: file, before: before.content,
			after, baseVersion, status: "intent", createdAt: new Date().toISOString() };
		saveTx(tx); return finish(tx)!;
	}
	const agreementFile = `${metadata}/agreements.json`;
	function ledger(): AgreementLedger { return json<AgreementLedger>(agreementFile) ?? { items: [], actions: [] }; }
	const agreementRevision = (value: AgreementLedger) => `sha256:${sha(JSON.stringify(value))}`;
	function agreementSnapshot(value = ledger(), now = Date.now()): MemoryAgreementSnapshot {
		return { revision: agreementRevision(value), items: value.items.map(item => ({ ...item,
			status: item.status === "active" && item.expiresAt && Date.parse(item.expiresAt) <= now ? "expired" : item.status })),
			legacy: read("context/constraints.md") };
	}
	type AgreementMutation = Extract<MemoryManagementRequest, { action: "agreement.add" | "agreement.activate" | "agreement.revoke" }>;
	function changeAgreement(request: AgreementMutation): MemoryAgreementSnapshot {
		args(request.baseRevision, request.commandId);
		// Transport ids vary on retry; only the user action belongs to its idempotency key.
		const fingerprint = sha(JSON.stringify(request.action === "agreement.add"
			? { action: request.action, text: request.text, agreementKind: request.agreementKind, status: request.status, expiresAt: request.expiresAt, baseRevision: request.baseRevision }
			: { action: request.action, agreementId: request.agreementId, baseRevision: request.baseRevision }));
		const value = ledger();
		const previous = value.actions.find(item => item.commandId === request.commandId);
		if (previous) {
			if (previous.fingerprint !== fingerprint) fail("REQUEST_ID_REUSED", "commandId 已用于不同约定操作");
			return agreementSnapshot(value);
		}
		if (agreementRevision(value) !== request.baseRevision) fail("VERSION_CONFLICT", "约定列表已变化，请刷新后检查操作");
		const now = new Date().toISOString();
		let agreementId: string;
		if (request.action === "agreement.add") {
			contentArg(request.text);
			if (!request.text.trim() || request.text.length > 16_000) fail("INVALID_AGREEMENT", "约定正文不能为空且不得超过 16000 字符");
			if (!["preference", "restriction", "authorization"].includes(request.agreementKind) || !["draft", "active"].includes(request.status)) fail("INVALID_AGREEMENT", "约定类别或初始状态无效");
			if (request.expiresAt !== undefined && (typeof request.expiresAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(request.expiresAt)
				|| !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.parse(now)
				|| new Date(request.expiresAt).toISOString().slice(0, 19) !== request.expiresAt.slice(0, 19))) fail("INVALID_EXPIRY", "到期时间必须是未来的 UTC ISO8601 时间");
			agreementId = `agreement-${sha(request.commandId)}`;
			value.items.push({ id: agreementId, text: request.text, kind: request.agreementKind, status: request.status, createdAt: now,
				...(request.status === "active" ? { activatedAt: now, activationCommandId: request.commandId } : {}),
				...(request.expiresAt ? { expiresAt: request.expiresAt } : {}), source: { type: "user", commandId: request.commandId } });
		} else {
			if (typeof request.agreementId !== "string") fail("INVALID_AGREEMENT", "必须指定约定 ID");
			agreementId = request.agreementId;
			const item = value.items.find(item => item.id === agreementId);
			if (!item) fail("AGREEMENT_NOT_FOUND", "约定不存在");
			if (request.action === "agreement.activate") {
				if (item.status !== "draft") fail("AGREEMENT_STATE", "只有草稿约定可以生效");
				if (item.expiresAt && Date.parse(item.expiresAt) <= Date.parse(now)) fail("INVALID_EXPIRY", "已经到期的草稿不能生效，请创建新的约定");
				item.status = "active"; item.activatedAt = now; item.activationCommandId = request.commandId;
			} else {
				if (item.status === "revoked") fail("AGREEMENT_STATE", "约定已经撤销");
				item.status = "revoked"; item.revokedAt = now; item.revocationCommandId = request.commandId;
			}
		}
		value.actions.push({ commandId: request.commandId, fingerprint, at: now, action: request.action, agreementId });
		// Recheck immediately before the single atomic replacement, preserving CAS with external editors.
		if (agreementRevision(ledger()) !== request.baseRevision) fail("VERSION_CONFLICT", "保存前约定列表发生变化");
		const encoded = JSON.stringify(value); atomic(agreementFile, encoded);
		if (readText(agreementFile) !== encoded) fail("VERIFY_FAILED", "约定保存后核验失败");
		return agreementSnapshot(value);
	}
	recover();
	return {
		read,
		write: (file: string, content: string, baseVersion: string, requestId: string) => change("write", file, content, undefined, baseVersion, requestId),
		edit: (file: string, oldText: string, newText: string, baseVersion: string, requestId: string) => change("edit", file, oldText, newText, baseVersion, requestId),
		proposal, resolve, getProposal, listPending, getApproval, recover, readVersion,
		listFiles, versions, preview, restore, agreements: agreementSnapshot, changeAgreement,
	};
}
export type MemoryStore = ReturnType<typeof createMemoryStore>;
