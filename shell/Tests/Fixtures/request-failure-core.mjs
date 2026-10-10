// Request-only failures deliberately leave the event subscription healthy.
// Production uses two sockets, so closing both cannot reproduce this regression.
import fs from "node:fs";
import net from "node:net";
const [socketPath, readyPath, mode] = process.argv.slice(2);
let failed = false;
const state = { presence: "breathing", questions: [{ questionId: "approval", question: "Confirm?", options: ["Yes"], seq: 0, at: new Date().toISOString() }] };
const agreements = { revision: "r1", items: [], legacy: { path: "context/constraints.md", content: null, version: "missing" } };
const server = net.createServer(socket => {
	let buffer = "";
	socket.on("error", () => {});
	socket.on("data", chunk => {
		buffer += chunk;
		while (buffer.includes("\n")) {
			const index = buffer.indexOf("\n");
			const request = JSON.parse(buffer.slice(0, index));
			buffer = buffer.slice(index + 1);
			fs.appendFileSync(`${readyPath}.requests`, `${JSON.stringify(request)}\n`);
			if (request.type === "events.subscribe") continue;
			const target = mode === "approval" ? request.command?.type === "question.answer"
				: mode === "memory" ? request.action === "agreement.add"
				: mode === "status" ? request.type === "query.status"
				: request.type === "query.document";
			if (target && !failed) {
				failed = true;
				if (mode === "rejection") socket.write(`${JSON.stringify({ id: request.id, ok: false, error: "BUSINESS_REJECTION" })}\n`);
				// CoreClient rejects a mismatched response and closes its request socket.
				else socket.write(`${JSON.stringify({ id: "wrong-id", ok: true, result: {} })}\n`);
				continue;
			}
			let result = {};
			if (request.type === "query.snapshot") result = { protocolVersion: 1, seq: 0, state, piAvailable: false };
			if (request.type === "query.status") result = state;
			if (request.type === "query.document") result = { text: "RECOVERED" };
			if (request.command?.type === "question.answer") { state.questions = []; result = { answered: true }; }
			if (request.type === "memory.manage") result = request.action === "listFiles" ? { files: [] } : agreements;
			socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
		}
	});
});
server.listen(socketPath, () => fs.writeFileSync(readyPath, "ready"));
