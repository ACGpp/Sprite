// Read-only source, disposable private copy. Never logs original memory or credentials.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { startKernel } from "../core/main.ts";
import { rpcCall } from "../core/rpc/server.ts";
import { queryConversationRecords } from "../core/record-store.ts";
import { queryMemoryHistory } from "../core/memory-history.ts";

const source = path.resolve(process.argv[2] ?? path.join(os.homedir(), ".claude-memory"));
const root = path.resolve(".core-test");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const work = fs.mkdtempSync(path.join(root, "upgrade-private-"));
fs.chmodSync(work, 0o700);
let kernel;
const authored = ["identity.md", "context", "diary", "explorations", "notes", "private", "voice", "sessions"];
function manifest(home) {
  const files = {};
  function visit(relative) {
    const full = path.join(home, relative);
    if (!fs.existsSync(full)) return;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) { files[relative] = `link:${fs.readlinkSync(full)}`; return; }
    if (stat.isDirectory()) for (const child of fs.readdirSync(full).sort()) visit(path.join(relative, child));
    else if (stat.isFile()) files[relative] = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
  }
  authored.forEach(visit);
  return files;
}
try {
  const sourceBefore = manifest(source);
  fs.cpSync(source, work, { recursive: true, dereference: false, filter: file => {
    const relative = path.relative(source, file);
    const stat = fs.lstatSync(file);
    return !stat.isSocket() && relative !== "journal/journal.lock" && !relative.startsWith("runtime/pi-agent/");
  }});
  const original = manifest(work);
  assert.deepEqual(original, sourceBefore, "Source changed while copying; retry with a stable source");
  const options = { homeDir: work, disableAgent: true, intervalMs: 3600000, quietHours: { start: 0, end: 0 }, log: () => {} };
  const begun = performance.now();
  kernel = await startKernel(options);
  const bootMs = Math.round(performance.now() - begun);
  const records = queryConversationRecords(work, "", { limit: 365 });
  const history = queryMemoryHistory(work, { limit: 100 });
  const manage = await rpcCall(kernel.socketPath, { id: "files", type: "memory.manage", action: "listFiles" });
  assert.equal(manage.ok, true, manage.error);
  assert.deepEqual(manifest(work), original, "Upgrade changed authored files or old sessions");
  await kernel.shutdown(); kernel = undefined;
  kernel = await startKernel(options);
  const again = queryConversationRecords(work, "", { limit: 365 });
  assert.deepEqual(again, records, "Restart duplicated or changed conversations");
  assert.deepEqual(manifest(work), original, "Restart changed authored files or sessions");
  assert.deepEqual(manifest(source), sourceBefore, "Live authored files changed during verification; inspect before proceeding");
  console.log(JSON.stringify({ ok: true, authoredFiles: Object.keys(original).length, bootMs, conversationDays: records.entries.length, conversationMessages: records.total, historyResults: history.entries.length, twoBootsPreservedOriginals: true }));
} finally {
  await kernel?.shutdown();
  fs.rmSync(work, { recursive: true, force: true });
}
