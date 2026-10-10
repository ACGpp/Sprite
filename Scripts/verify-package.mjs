// Smoke-test the actual shipped Node + pi + kernel with an empty isolated home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const app = path.resolve(process.argv[2]);
const payload = path.join(app, "Contents/Resources/runtime");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-package-"));
const home = path.join(temporary, "memory");
const piHome = path.join(temporary, "user");
fs.mkdirSync(piHome);
const bin = path.join(payload, "bin");
const env = { ...process.env, HOME: piHome, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, PI_CODING_AGENT_DIR: path.join(piHome, ".pi/agent") };
const { startKernel } = await import(pathToFileURL(path.join(payload, "core/main.ts")));
const { patchSettings } = await import(pathToFileURL(path.join(payload, "core/settings.ts")));
const { rpcCall } = await import(pathToFileURL(path.join(payload, "core/rpc/server.ts")));
let kernel;
try {
    const pi = spawnSync(path.join(bin, "pi"), ["--version"], { env, encoding: "utf8", timeout: 30000 });
    assert.equal(pi.status, 0, pi.error?.message || `${pi.signal ?? ""} ${pi.stderr}`);
    assert.equal((pi.stdout + pi.stderr).trim(), "0.70.2");
    // This provider is a test-only local script, not packaged in the application.
    patchSettings(home, { model: { mode: "provider", provider: "freedom-test", model: "freedom-1", apiKey: "TEST_ONLY" }, security: { agentShell: "full" } });
    kernel = await startKernel({ homeDir: home, piBin: path.join(bin, "pi"),
        piExtensions: [path.resolve("core/__test__/freedom-provider.ts")],
        piEnv: { ...env, FREEDOM_TEST_KEY: "TEST_ONLY", SPRITE_FREEDOM_CAPTURE: path.join(temporary, "captures.jsonl"),
            SPRITE_FREEDOM_SHELL_ONLY: "1", SPRITE_FREEDOM_COMMAND: "printf BUNDLED_RUNTIME_OK" },
        quietHours: { start: 0, end: 0 }, intervalMs: 3600000, fsync: false, log: () => {} });
    const settings = await rpcCall(kernel.socketPath, { id: "package-settings", type: "query.settings" });
    assert.equal(settings.ok, true, "packaged kernel must answer the app's RPC");
    assert.equal((await kernel.breathNow()).ok, true, "bundled pi must load the real extensions and complete a run");
    const captures = fs.readFileSync(path.join(temporary, "captures.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const results = captures.at(-1).messages.filter(message => message.role === "toolResult");
    assert.ok(results.some(result => result.isError === false && JSON.stringify(result.content).includes("BUNDLED_RUNTIME_OK")));
    console.log("Package smoke PASS: bundled Node, pi, extension tools and kernel RPC; isolated home, no model API or global pi.");
} finally {
    await kernel?.shutdown();
    fs.rmSync(temporary, { recursive: true, force: true });
}
