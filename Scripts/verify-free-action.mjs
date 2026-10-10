// Isolated real-model check: never loads the companion's identity or memories.
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-free-action-"));
fs.chmodSync(work, 0o700);
const home = path.join(work, "memory");
const output = path.join(work, "shell-output.txt");
const page = path.join(work, "public-page.html");
let kernel;
try {
  patchSettings(home, { model: settings.model, security: { agentShell: "full" }, quietHours: { start: 0, end: 0 }, proactive: { enabled: false } });
  kernel = await startKernel({ homeDir: home, intervalMs: 3600000, quietHours: { start: 0, end: 0 }, log: () => {} });
  kernel.journal.append("message.in", { id: "free-action-probe", source: "text", text:
    `这是隔离的能力联调，不含真实个人记忆。请实际使用 bash 完成两项：1）编写并运行一个小程序，将 6 * 7 的结果写入 ${output}（文件只包含数字 42 和可选末尾换行，不要表达式或说明文字）；2）使用 curl --fail --location --max-time 20 https://example.com/ -o ${page} 获取公开网页，再检查网页含 Example Domain。只操作这个临时目录。请使用工具完成，不要只说明步骤。不要发消息或改排程。` });
  const outcome = await kernel.breathNow("manual");
  assert.equal(outcome.ok, true, outcome.reason);
  assert.equal(fs.readFileSync(output, "utf8").trim(), "42");
  assert.match(fs.readFileSync(page, "utf8"), /Example Domain/);
  assert.ok(kernel.journal.events.some(e => e.type === "tool.decided" && e.data.tool === "bash" && e.data.decision === "allow"));
  console.log(JSON.stringify({ ok: true, mode: "full", shellExecuted: true, programOutput: 42, externalFileWritten: true, publicHttpsFetched: true, durationMs: outcome.durationMs }));
} finally {
  await kernel?.shutdown();
  fs.rmSync(work, { recursive: true, force: true });
}
