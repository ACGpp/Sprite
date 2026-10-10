// 隔离 RPC 夹具：可控延迟、丢失回执、重试与问题回答，不调用 Agent。
import fs from "node:fs";
import path from "node:path";
import { createRpcServer } from "../../../core/rpc/server.ts";
import { emptyState } from "../../../core/state.ts";
import { PROTOCOL_VERSION } from "../../../contracts/events.ts";
import { createMemoryStore } from "../../../core/memory-store.ts";
import { createMemoryManagement } from "../../../core/memory-management.ts";

const [socketPath, readyPath, mode = "reject"] = process.argv.slice(2);
const state = emptyState();
let seq = 0;
const events = [];
const attempts = new Map();
const accepted = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let management;
if (mode === "memory-management") {
	const homeDir = path.join(path.dirname(readyPath), "memory-home");
	fs.mkdirSync(homeDir);
	const store = createMemoryStore({ homeDir, fsync: false });
	const first = store.write("identity.md", "OLD_IDENTITY", "missing", "first");
	store.write("identity.md", "CURRENT_IDENTITY", first.version, "second");
	management = createMemoryManagement({ store });
}
if (mode === "identity-change") state.companionName = "Old name";
if (mode === "question" || mode === "question-reject") state.questions = [{ questionId: "test-question", question: "Choose or explain", options: ["Yes", "No"], seq: 0, at: new Date().toISOString() }];
if (mode === "memory-proposal") state.questions = [{ questionId: "memory:acceptance-fixture", question: "修改 identity.md\n原因：追加经历截止与回链\n\n修改前：\nBEFORE_IDENTITY 原身份保持不变。\n\n修改后：\nAFTER_IDENTITY 原身份保持不变。经历截至 2026-05-07，后续见 diary/。\n\n仅批准这份具体修改；文件版本变化后必须重新确认。", options: ["批准此修改", "拒绝此修改"], seq: 0, at: new Date().toISOString() }];
const server = createRpcServer({ socketPath, handlers: {
	status: () => state,
	snapshot: () => ({ protocolVersion: PROTOCOL_VERSION, seq, state, piAvailable: false }),
	memoryManage: request => management.handle(request),
	records: (kind, limit, beforeDate) => {
		fs.appendFileSync(`${readyPath}.commands`, `${JSON.stringify({ type: "query.records", kind, limit, beforeDate })}\n`);
		if (mode === "records-error") throw new Error("TEST_RECORDS_UNAVAILABLE");
		return { entries: [{ date: beforeDate ? "2020-01-01" : "2026-09-19", text: beforeDate ? "OLDER" : "NEWER" }], nextCursor: beforeDate ? null : "2026-09-19" };
	},
	document: path => {
		if (mode === "document-error") throw new Error("TEST_DOCUMENT_UNAVAILABLE");
		return { text: `DOCUMENT:${path}` };
	},
	eventsSince: fromSeq => events.filter(event => event.seq > fromSeq),
	command: async command => {
		fs.appendFileSync(`${readyPath}.commands`, `${JSON.stringify(command)}\n`);
		if (command.type === "question.answer") {
			await delay(100);
			if (mode === "question-reject") throw new Error("TEST_OLD_CORE_UNSUPPORTED_QUESTION");
			state.questions = state.questions.filter(question => question.questionId !== command.questionId);
			const event = { seq: ++seq, at: new Date().toISOString(), type: "question.answered", data: { questionId: command.questionId, answer: command.answer } };
			events.push(event);
			server.publish(event);
			return { answered: true };
		}
		if (command.type !== "message.send") return {};
		if (mode === "identity-change") {
			state.companionName = command.text === "clear" ? null : "New name";
			const event = { seq: ++seq, at: new Date().toISOString(), type: "identity.changed", data: { companionName: state.companionName } };
			events.push(event); server.publish(event);
			return { seq };
		}
		const attempt = (attempts.get(command.id) ?? 0) + 1;
		attempts.set(command.id, attempt);
		if (mode === "reject" || (mode === "retry" && attempt === 1)) {
			await delay(mode === "reject" ? 1500 : 100);
			throw new Error("TEST_ONLY_DELAYED_REJECTION");
		}
		// 两条相同文本独立确认，第二条延迟，用来观察第一条回显不能消掉第二条。
		if (mode === "duplicate") await delay(accepted.size === 0 ? 100 : 900);
		if (!accepted.has(command.id)) {
			accepted.add(command.id);
			const event = { seq: ++seq, at: new Date().toISOString(), type: "message.in", data: { id: command.id, text: command.text, source: "text" } };
			state.messages.push({ ...event.data, seq: event.seq, at: event.at });
			events.push(event);
			if (mode !== "disconnect") server.publish(event);
		}
		if (mode === "disconnect" && attempt === 1) {
			// 消息落库、回执丢失。断开订阅使客户端重新拉快照对账。
			server.close();
			await delay(100);
			await server.start();
			await delay(100);
		}
		return { seq };
	},
} });
await server.start();
fs.writeFileSync(readyPath, "ready");
process.on("SIGTERM", () => { server.close(); process.exit(0); });
