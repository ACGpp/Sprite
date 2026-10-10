// Uses only the saved model configuration; real personal memory is never sent by this probe.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readSettings, patchSettings } from "../core/settings.ts";

const source = path.resolve(process.argv[2] ?? path.join(os.homedir(), ".claude-memory"));
const { startKernel } = process.env.SPRITE_VERIFY_KERNEL
  ? await import(pathToFileURL(path.resolve(process.env.SPRITE_VERIFY_KERNEL, "core/main.ts")).href)
  : await import("../core/main.ts");
const settings = readSettings(source);
assert.ok(settings.model.model, "No saved model configured");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-provider-"));
fs.chmodSync(work, 0o700);
let kernel;
try {
  patchSettings(work, { model: settings.model, security: { agentShell: "on" }, quietHours: { start: 0, end: 0 }, proactive: { enabled: false } });
  kernel = await startKernel({ homeDir: work, intervalMs: 3600000, quietHours: { start: 0, end: 0 }, log: () => {} });
  kernel.journal.append("message.in", { id: "release-provider-probe", source: "text", text: "这是隔离测试环境，不含真实用户记忆。请完成一次小型工具联调：read notes/connectivity.md 获取版本，再 write 内容 SPRITE_PROVIDER_OK，最后 leave_message 内容 SPRITE_PROVIDER_OK。不要修改其他文件，也不要安排其他任务。" });
  const outcome = await kernel.breathNow("manual");
  assert.equal(outcome.ok, true, outcome.reason);
  assert.equal(fs.readFileSync(path.join(work, "notes/connectivity.md"), "utf8").trim(), "SPRITE_PROVIDER_OK");
  const state = kernel.status();
  assert.ok(state.outgoing.some(item => item.text.includes("SPRITE_PROVIDER_OK")), "Provider did not complete the message tool");
  const sessions = fs.readdirSync(path.join(work, "sessions/memory-v1")).filter(file => file.endsWith(".jsonl"));
  assert.ok(sessions.length > 0);
  console.log(JSON.stringify({ ok: true, provider: settings.model.provider ?? "custom", model: settings.model.model, durationMs: outcome.durationMs, activities: outcome.activities, verifiedWrite: true, messageDelivered: true, sessionPersisted: true }));
} finally {
  await kernel?.shutdown();
  fs.rmSync(work, { recursive: true, force: true });
}
