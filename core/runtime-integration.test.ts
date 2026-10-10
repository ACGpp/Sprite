import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { command, reviewFixture, stateOf, waitFor } from "./__test__/review-fixture.ts";
import { rpcCall } from "./rpc/server.ts";

const realSetTimeout = globalThis.setTimeout;
type Start = { generation: string; pid: number; previousAlive: boolean; args: string[] };
type Probe = { kind: string; ok: boolean; error?: string };

for (const change of ["permissions", "model", "timeout"] as const) {
	test(`main ${change}: retire generation before gateway access and replacement`, { timeout: 10000 }, async t => {
		const f = reviewFixture(t, `generation-${change}`);
		const kernel = await f.start({ piBin: path.resolve("core/__test__/generation-pi.mjs") });
		await waitFor(() => f.readLines<Start>("generation-starts.jsonl").length === 1, "first instance started");
		if (change === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
		const running = kernel.breathNow();
		// Preserve the real timer while advancing only the kernel's 120s run deadline.
		for (let attempt = 0; f.readLines("generation-prompts.jsonl").length === 0; attempt++) {
			assert.ok(attempt < 200, "first prompt must reach the process");
			await new Promise(resolve => realSetTimeout(resolve, 10));
		}
		let update: Promise<unknown> = Promise.resolve();
		if (change === "timeout") {
			t.mock.timers.tick(120_001);
			t.mock.timers.reset();
		} else {
			update = command(kernel, { type: "settings.update", patch: change === "permissions" ? { security: { agentShell: "readonly" } } : { model: { model: "replacement-model" } } });
		}
		await waitFor(() => f.readLines<Probe>("gateway-during-abort.jsonl").length === 2, "cancelled generation probes");
		// Await cleanup before assertions so failures cannot leave running fixture engines.
		const outcome = await running as { ok: boolean };
		await update;
		await waitFor(() => f.readLines<Start>("generation-starts.jsonl").length === 2, "replacement instance started");
		const starts = f.readLines<Start>("generation-starts.jsonl");
		assert.notEqual(starts[0]!.generation, starts[1]!.generation);
		assert.equal(starts[1]!.previousAlive, false, "replacement must never overlap the old process");
		assert.equal(outcome.ok, false, "cancelled run cannot be marked completed");
		for (const probe of f.readLines<Probe>("gateway-during-abort.jsonl")) assert.equal(probe.ok, false, `${probe.kind} must reject during cancellation`);
		const stale = await rpcCall(path.join(f.homeDir, "runtime/gateway.sock"), { kind: "capability.say", generation: starts[0]!.generation, text: "STALE_AFTER_REPLACEMENT" }) as { ok: boolean };
		assert.equal(stale.ok, false);
		assert.equal((await kernel.breathNow() as { ok: boolean }).ok, true, "the new process remains usable");
		await new Promise(resolve => realSetTimeout(resolve, 1000));
		assert.equal(fs.existsSync(path.join(f.homeDir, "OLD_GENERATION_SIDE_EFFECT")), false);
		assert.equal(stateOf(kernel).outgoing.some(message => message.text.includes("GENERATION_GATEWAY_SIDE_EFFECT") || message.text.includes("STALE_AFTER")), false);
	});
}

test("main checkpoint recovery exposes only exact orphan batch as unsettled", async t => {
	const f = reviewFixture(t, "orphan-batch");
	let kernel = await f.start({ disableAgent: true });
	await command(kernel, { type: "breath.pause", until: "manual" });
	kernel.journal.append("message.in", { text: "ALREADY_DONE" });
	kernel.journal.append("run.started", { runId: "done" });
	kernel.journal.append("run.finished", { runId: "done" });
	const claimed = Array.from({ length: 210 }, (_, i) => kernel.journal.append("message.in", { text: `ORPHAN_${i}` }).seq);
	kernel.journal.append("run.started", { runId: "orphan", claimedMessageSeqs: claimed });
	kernel.journal.append("message.in", { text: "ARRIVED_LATER" });
	assert.equal(kernel.journal.writeCheckpoint(), true);
	kernel = await f.start();
	assert.equal(kernel.journal.usedCheckpoint, true);
	const response = await rpcCall(kernel.socketPath, { id: "visible-orphan", type: "query.status" }) as { ok: boolean; result: ReturnType<typeof stateOf> };
	assert.equal(response.ok, true);
	assert.equal(response.result.danglingRun, false);
	assert.deepEqual(response.result.unsettledMessages.map(batch => ({ runId: batch.runId, seqs: batch.messages.map(message => message.seq) })), [{ runId: "orphan", seqs: claimed }]);
	assert.deepEqual(response.result.pendingMessages.map(message => message.text), ["ARRIVED_LATER"]);
	assert.equal(response.result.presence, "paused");
	kernel = await f.start();
	assert.equal(stateOf(kernel).unsettledMessages.length, 1, "repeated recovery must not duplicate unknown outcomes");
});
