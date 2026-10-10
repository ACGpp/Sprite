import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createManagedBashOperations } from "../pi-extension/shell.ts";
import { reviewFixture, waitFor } from "./__test__/review-fixture.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
test("shell AbortSignal：收回该命令的后代，不误杀并行命令或当前进程", { timeout: 10000 }, async t => {
	const f = reviewFixture(t, "shell-abort");
	const begun = path.join(f.homeDir, "begun"); const late = path.join(f.homeDir, "late");
	const abort = new AbortController(); const operations = createManagedBashOperations();
	const nested = `echo $$ > ${quote(begun)}; sleep 1; printf LATE > ${quote(late)}`;
	const cancelled = operations.exec(`bash -c ${quote(nested)} & wait`, f.homeDir, { signal: abort.signal, onData() {} });
	// Attach rejection handling before abort: node:test checks unhandled rejections.
	const cancelledResult = assert.rejects(cancelled, /aborted/);
	let siblingOutput = "";
	const sibling = operations.exec("sleep 0.3; printf SIBLING_SURVIVED", f.homeDir, { onData: data => { siblingOutput += data; } });
	await waitFor(() => fs.existsSync(begun), "被取消 shell 的子进程启动");
	abort.abort();
	await cancelledResult;
	assert.equal((await sibling).exitCode, 0); assert.equal(siblingOutput, "SIBLING_SURVIVED");
	await new Promise(resolve => setTimeout(resolve, 1100));
	assert.equal(fs.existsSync(late), false);
});

test("shell 已取消的请求不启动进程；spawn 失败明确返回", { timeout: 5000 }, async t => {
	const f = reviewFixture(t, "shell-preabort"); const marker = path.join(f.homeDir, "must-not-exist");
	const abort = new AbortController(); abort.abort();
	const operations = createManagedBashOperations();
	await assert.rejects(operations.exec(`touch ${quote(marker)}`, f.homeDir, { signal: abort.signal, onData() {} }), /aborted/);
	assert.equal(fs.existsSync(marker), false);
	await assert.rejects(operations.exec("echo unreachable", path.join(f.homeDir, "missing"), { onData() {} }), /ENOENT/);
});
