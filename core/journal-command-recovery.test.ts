/** Actual process crashes after fsync, before command.applied. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { openJournal } from "./journal.ts";
import { deriveState } from "./state.ts";
import { reviewFixture } from "./__test__/review-fixture.ts";

function crashAfterEffect(dir: string, effects: number, crashIndex: number) {
	const script = `
import {openJournal} from ${JSON.stringify(new URL("./journal.ts", import.meta.url).href)};
const journal = openJournal({dir:${JSON.stringify(dir)},exclusive:true,fsync:true,onAppend(event){
 if(event.type==='message.in' && event.data.__commandEffect.index===${crashIndex}) process.exit(73);
}});
journal.applyCommand({id:'crash-command',produce:()=>Array.from({length:${effects}},(_,i)=>({type:'message.in',data:{id:'message-'+i,text:'DURABLE_'+i}}))});
process.exit(99);
`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
	assert.equal(result.status, 73, result.stderr || "must crash at the requested fsynced effect");
}

for (const effects of [1, 2]) {
	test(`journal: final durable effect commits ${effects}-effect command before marker`, t => {
		const f = reviewFixture(t, `commit-${effects}`);
		crashAfterEffect(f.homeDir, effects, effects - 1);
		const journal = openJournal({ dir: f.homeDir, exclusive: true, fsync: false });
		t.after(() => journal.close());
		assert.equal(journal.events.some(event => event.type === "command.applied"), false, "the commit marker really was never written");
		const result = journal.applyCommand({ id: "crash-command", produce: () => { throw new Error("must not re-execute committed command"); } });
		assert.equal(result.duplicate, true);
		assert.equal(result.result?.effects, effects);
		assert.equal(deriveState(journal.events).messages.length, effects);
	});
}

test("journal: first effect of a multiple-effect command cannot be mistaken for completion", t => {
	const f = reviewFixture(t, "partial-command");
	crashAfterEffect(f.homeDir, 2, 0);
	let journal = openJournal({ dir: f.homeDir, exclusive: true, fsync: false, checkpointPayload: () => ({}) });
	t.after(() => journal.close());
	assert.throws(() => journal.applyCommand({ id: "crash-command", produce: () => { throw new Error("produce must not repeat partial command"); } }), /命令仅部分落盘/);
	assert.equal(journal.events.filter(event => event.type === "message.in").length, 1);
	assert.equal(journal.writeCheckpoint(), true);
	journal.close();
	journal = openJournal({ dir: f.homeDir, exclusive: true, fsync: false });
	assert.equal(journal.usedCheckpoint, true);
	assert.throws(() => journal.applyCommand({ id: "crash-command", produce: () => [] }), /命令仅部分落盘/, "checkpoint cannot forget a partial command");
});

test("journal: legacy effect-only commands stay deduplicated beyond cache and checkpoint restart", t => {
	const f = reviewFixture(t, "legacy-prefix");
	let journal = openJournal({ dir: f.homeDir, eventWindow: 2, fsync: false, checkpointPayload: () => ({}) });
	for (const type of ["message.in", "voice.recorded", "voice.transcribed"] as const) journal.append(type, { text: type }, `legacy-${type}`);
	journal.append("presence.changed", { state: "paused" });
	journal.append("presence.changed", { state: "paused" });
	assert.equal(journal.writeCheckpoint(), true);
	journal.close();
	journal = openJournal({ dir: f.homeDir, eventWindow: 2, fsync: false });
	t.after(() => journal.close());
	assert.equal(journal.usedCheckpoint, true);
	for (const type of ["message.in", "voice.recorded", "voice.transcribed"]) {
		assert.equal(journal.applyCommand({ id: `legacy-${type}`, produce: () => { throw new Error("duplicate"); } }).duplicate, true);
	}
});

test("journal: old checkpoint without effect index is rebuilt rather than losing durable deduplication", t => {
	const f = reviewFixture(t, "old-command-index");
	let journal = openJournal({ dir: f.homeDir, fsync: false, checkpointPayload: () => ({}) });
	journal.append("message.in", { text: "OLD_DURABLE_MESSAGE" }, "old-message");
	assert.equal(journal.writeCheckpoint(), true);
	journal.close();
	const checkpointFile = path.join(f.homeDir, "journal/checkpoint.json");
	const snapshot = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
	delete snapshot.commandIndexVersion;
	snapshot.appliedCommands = [];
	delete snapshot.checksum;
	snapshot.checksum = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
	fs.writeFileSync(checkpointFile, JSON.stringify(snapshot));
	journal = openJournal({ dir: f.homeDir, fsync: false });
	t.after(() => journal.close());
	assert.equal(journal.usedCheckpoint, false);
	assert.equal(journal.applyCommand({ id: "old-message", produce: () => { throw new Error("already durable"); } }).duplicate, true);
});
