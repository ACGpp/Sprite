/** User-only memory management. These actions are never exposed as Agent tools. */
export type AgreementKind = "preference" | "restriction" | "authorization";
export type AgreementStatus = "draft" | "active" | "revoked" | "expired";
export interface MemoryAgreement {
	id: string;
	text: string;
	kind: AgreementKind;
	status: AgreementStatus;
	createdAt: string;
	activatedAt?: string;
	expiresAt?: string;
	revokedAt?: string;
	source: { type: "user"; commandId: string };
	activationCommandId?: string;
	revocationCommandId?: string;
}
export type MemoryManagementRequest = { kind: "memory.manage" } & (
	| { action: "listFiles" }
	| { action: "versions"; path: string }
	| { action: "preview"; path: string; version: string }
	| { action: "restore"; path: string; version: string; baseVersion: string; commandId: string }
	| { action: "agreements" }
	| { action: "agreement.add"; text: string; agreementKind: AgreementKind; status: "draft" | "active"; expiresAt?: string; baseRevision: string; commandId: string }
	| { action: "agreement.activate" | "agreement.revoke"; agreementId: string; baseRevision: string; commandId: string }
);
export interface MemoryFileSummary { path: string; version: string; bytes: number }
export interface MemoryVersionSummary {
	version: string; bytes: number; recordedAt: string | null;
	requestId: string | null; kind: string; current: boolean;
}
export interface MemoryAgreementSnapshot {
	revision: string;
	items: MemoryAgreement[];
	legacy: { path: string; content: string | null; version: string };
}
