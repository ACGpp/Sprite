import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { TestContext } from "node:test";
import { startKernel, type Kernel, type KernelConfig } from "../main.ts";
import { rpcCall } from "../rpc/server.ts";
import type { KernelState } from "../state.ts";

export type PromptCapture = { message: string; tools: string[]; providerKeyMatches: boolean; customKeyMatches: boolean; providerNextKeyMatches: boolean; customNextKeyMatches: boolean };

/** 每条用例独立目录/进程/socket；从不接触用户的 ~/.claude-memory。失败也会收尾。 */
export function reviewFixture(t: TestContext, label: string) {
	const root = path.join(process.cwd(), ".core-test");
	fs.mkdirSync(root, { recursive: true });
	const homeDir = fs.mkdtempSync(path.join(root, `review-${label}-`));
	const piHome = path.join(homeDir, "pi-home");
	fs.mkdirSync(piHome);
	const config: KernelConfig = {
		homeDir,
		piBin: path.resolve("core/__test__/review-pi.mjs"),
		piEnv: { HOME: piHome, PI_CODING_AGENT_DIR: path.join(piHome, ".pi", "agent") },
		intervalMs: 3_600_000,
		quietHours: { start: 0, end: 0 },
		fsync: false,
		log: () => {},
	};
	let current: Kernel | undefined;
	const stop = () => { current?.stop(); current = undefined; };
	t.after(stop);
	return {
		homeDir,
		config,
		stop,
		async start(overrides: KernelConfig = {}): Promise<Kernel> {
			stop();
			current = await startKernel({ ...config, ...overrides, piEnv: { ...config.piEnv, ...overrides.piEnv } });
			return current;
		},
		readLines<T>(name: string): T[] {
			const file = path.join(homeDir, name);
			return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as T) : [];
		},
	};
}

export function stateOf(kernel: Kernel): KernelState { return kernel.status() as KernelState; }

export async function command(kernel: Kernel, value: Record<string, unknown>): Promise<Record<string, unknown>> {
	const response = await rpcCall(kernel.socketPath, {
		id: crypto.randomUUID(), type: "command", command: { id: crypto.randomUUID(), ...value },
	}) as { ok: boolean; result: Record<string, unknown>; error?: string };
	assert.equal(response.ok, true, response.error);
	return response.result;
}

export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
	// performance 不受用例里的 Date mock 影响，失败也有可靠的真实时间上限。
	const deadline = performance.now() + timeoutMs;
	while (!predicate()) {
		assert.ok(performance.now() < deadline, `等待超时：${label}`);
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}
