/** Independent post-implementation acceptance; isolated durable-prefix crash cases. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { command, reviewFixture, stateOf } from "./__test__/review-fixture.ts";
import { openJournal } from "./journal.ts";
import { readJournalEvents } from "./record-store.ts";
import { shanghaiStamp } from "./projections.ts";
import { createProjector } from "./projector.ts";

test("acceptance: crash after answer effect still delivers answer once after restart", async t => {
	const f = reviewFixture(t, "accept-answer-crash");
	let kernel = await f.start({ disableAgent: true });
	await command(kernel, { type: "breath.pause", until: "manual" });
	kernel.journal.append("question.asked", { questionId: "q-crash", question: "选择哪一个？", options: ["A", "B"] });
	// The first fsynced effect of question.answer, before message.in/command.applied.
	kernel.journal.append("question.answered", { questionId: "q-crash", answer: "A" }, "answer-crash");
	kernel = await f.start({ disableAgent: true });
	await command(kernel, { id: "answer-crash", type: "question.answer", questionId: "q-crash", answer: "A" });
	assert.equal(stateOf(kernel).questions.some(q => q.questionId === "q-crash"), false);
	assert.equal(stateOf(kernel).pendingMessages.filter(m => m.id === "answer-crash").length, 1);
	assert.match(stateOf(kernel).pendingMessages.find(m => m.id === "answer-crash")!.text, /A/);
	kernel = await f.start({ disableAgent: true });
	assert.equal(stateOf(kernel).messages.filter(m => m.id === "answer-crash").length, 1, "migration must be idempotent without another user retry");
});

test("acceptance: crash after message effect does not duplicate stable message ID", async t => {
	const f = reviewFixture(t, "accept-send-crash");
	let kernel = await f.start({ disableAgent: true });
	await command(kernel, { type: "breath.pause", until: "manual" });
	// message.send's durable effect exists, but its command.applied marker does not.
	kernel.journal.append("message.in", { id: "send-crash", text: "ONE_USER_INTENT", source: "text" }, "send-crash");
	kernel = await f.start({ disableAgent: true });
	await command(kernel, { id: "send-crash", type: "message.send", text: "ONE_USER_INTENT" });
	assert.equal(stateOf(kernel).pendingMessages.filter(m => m.id === "send-crash").length, 1);
	assert.equal(stateOf(kernel).messages.filter(m => m.id === "send-crash").length, 1);
});

test("acceptance: startup-rebuilt projection never reimports itself on next restart", async t => {
	const f = reviewFixture(t, "accept-rebuild-own");
	// Durable message followed by a crash before projection and ownership handoff.
	const journal = openJournal({ dir: f.homeDir, fsync: false });
	journal.append("message.out", { text: "ORIGINAL_ARCHIVE_REPLY", channel: "bubble" });
	journal.close();
	await f.start({ disableAgent: true });
	await f.start({ disableAgent: true });
	const replies = [...readJournalEvents(f.homeDir)].filter(e => e.type === "message.out" && e.data.text === "ORIGINAL_ARCHIVE_REPLY");
	assert.equal(replies.length, 1, "a restored kernel projection is not new user legacy input");
});

test("acceptance: adopting original mailbox keeps unprojected durable replies", async t => {
	const f = reviewFixture(t, "accept-original");
	const mailbox = path.join(f.homeDir, "conversations/mailbox.md");
	fs.mkdirSync(path.dirname(mailbox), { recursive: true });
	const original = "手写标题\n[2026-09-18 12:00:00] 用户: ORIGINAL_USER_LINE\n";
	fs.writeFileSync(mailbox, original);
	// First native reply is committed; the old mailbox exists, but projector state
	// and ownership handoff have not been committed at the interruption point.
	const journal = openJournal({ dir: f.homeDir, fsync: false });
	journal.append("message.out", { text: "UNPROJECTED_REPLY", channel: "bubble" });
	journal.close();
	await f.start({ disableAgent: true });
	const recovered = fs.readFileSync(mailbox, "utf8");
	assert.ok(recovered.startsWith(original), "adoption must preserve original bytes");
	assert.match(recovered, /UNPROJECTED_REPLY/);
	await f.start({ disableAgent: true });
	assert.equal(fs.readFileSync(mailbox, "utf8"), recovered);
});

test("acceptance: adopting existing native projection does not duplicate represented replies", async t => {
	const f = reviewFixture(t, "accept-existing");
	const journal = openJournal({ dir: f.homeDir, fsync: false });
	const event = journal.append("message.out", { text: "REPRESENTED_REPLY", channel: "bubble" });
	journal.close();
	const mailbox = path.join(f.homeDir, "conversations/mailbox.md");
	fs.mkdirSync(path.dirname(mailbox), { recursive: true });
	const original = `手写标题\n[${shanghaiStamp(new Date(event.at))}] 验收精灵: REPRESENTED_REPLY\n`;
	fs.writeFileSync(mailbox, original);
	await f.start({ disableAgent: true, companionName: "验收精灵" });
	assert.equal(fs.readFileSync(mailbox, "utf8"), original);
	assert.equal([...readJournalEvents(f.homeDir)].filter(e => e.type === "message.out" && e.data.text === "REPRESENTED_REPLY").length, 1,
		"a crash after projection but before ownership handoff must not reimport the native reply");
});

test("acceptance: committed projection before handoff is not imported twice", async t => {
	const f = reviewFixture(t, "accept-project-crash");
	const journal = openJournal({ dir: f.homeDir, fsync: false });
	const event = journal.append("message.out", { text: "COMMITTED_PROJECTION", channel: "bubble" });
	const projector = createProjector({ homeDir: f.homeDir, companionName: "验收精灵", fsync: false });
	assert.equal(projector.project(event).ok, true);
	journal.close(); // interruption before main's next ownershipHandoffEvent append
	await f.start({ disableAgent: true, companionName: "验收精灵" });
	assert.equal([...readJournalEvents(f.homeDir)].filter(e => e.type === "message.out" && e.data.text === "COMMITTED_PROJECTION").length, 1);
});
