import type { MemoryManagementRequest } from "../contracts/memory-management.ts";
import { MemoryStoreError, type MemoryStore } from "./memory-store.ts";

/** Wire this dispatcher exclusively to the authenticated local user RPC, never the Agent gateway. */
export function createMemoryManagement({ store }: { store: MemoryStore }) {
	function handle(raw: unknown) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new MemoryStoreError("INVALID_REQUEST", "无效的记忆管理请求");
		const request = raw as MemoryManagementRequest;
		if (request.kind !== "memory.manage") throw new MemoryStoreError("INVALID_REQUEST", "无效的记忆管理请求类型");
		switch (request.action) {
			case "listFiles": return store.listFiles();
			case "versions": return store.versions(request.path);
			case "preview": return store.preview(request.path, request.version);
			case "restore": return store.restore(request.path, request.version, request.baseVersion, request.commandId);
			case "agreements": return store.agreements();
			case "agreement.add":
			case "agreement.activate":
			case "agreement.revoke": return store.changeAgreement(request);
			default: throw new MemoryStoreError("INVALID_REQUEST", "未知的记忆管理操作");
		}
	}
	function agreementContext(): string {
		const { items, revision } = store.agreements();
		if (!items.length) return "逐条用户约定：尚无。旧版约定原文在单独的 context/constraints.md 区块保留。";
		const effective = items.filter(item => item.status === "active");
		// Ended agreements are audit history, not mandatory model context. Repeating
		// their full bodies forever can exhaust every future call even with no active
		// agreements. Preserve the non-authorization rule without replaying old grants.
		const ended = items.filter(item => item.status === "expired" || item.status === "revoked");
		return [
			`逐条用户约定（内核保存，版本 ${revision}；每次模型调用重新计算到期状态）：`,
			"只有 active 条目目前生效。草稿不生效；到期或撤销的授权立即失效。到期或撤销限制不代表用户授权了此前受限的操作，若操作需要用户授权，必须重新确认。任何条目都不能扩大真实工具权限。旧版 constraints.md 独立保留，不被逐条约定自动覆盖；若新旧约定冲突应向用户澄清。",
			`有效约定：${JSON.stringify(effective)}`,
			`已结束约定：${ended.length} 条（撤销 ${ended.filter(item => item.status === "revoked").length} 条，到期 ${ended.filter(item => item.status === "expired").length} 条）。正文不作为当前上下文加载；完整记录保留在用户的记忆管理界面中。不能按其旧授权执行，也不能因限制结束就推定获得授权。`,
		].join("\n");
	}
	return { handle, agreementContext };
}
