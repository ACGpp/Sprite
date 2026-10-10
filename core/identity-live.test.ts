import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import net from "node:net";
import { reviewFixture } from "./__test__/review-fixture.ts";

const gateway = (home: string, request: object) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const socket = net.connect(path.join(home, "runtime/gateway.sock"));
  let buffer = "";
  socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
  socket.on("data", data => { buffer += data; if (buffer.includes("\n")) { socket.destroy(); resolve(JSON.parse(buffer.split("\n")[0]!)); } });
  socket.on("error", reject);
});

test("identity rename updates snapshots and future replies without relabelling old history", async t => {
  const f = reviewFixture(t, "identity-live");
  fs.writeFileSync(path.join(f.homeDir, "identity.md"), "我叫旧名。");
  const kernel = await f.start({ disableAgent: true });
  await gateway(f.homeDir, { kind: "capability.leave_message", text: "BEFORE_RENAME" });
  const before = await gateway(f.homeDir, { kind: "memory.read", path: "identity.md" });
  const written = await gateway(f.homeDir, { kind: "memory.write", path: "identity.md", baseVersion: before.version, content: "我叫新名。", requestId: "rename" });
  assert.equal(written.ok, true);
  assert.equal((kernel.status() as { companionName: string }).companionName, "新名");
  assert.equal(kernel.journal.events.filter(event => event.type === "identity.changed").length, 1);
  await gateway(f.homeDir, { kind: "capability.leave_message", text: "AFTER_RENAME" });
  const mailbox = fs.readFileSync(path.join(f.homeDir, "conversations/mailbox.md"), "utf8");
  assert.match(mailbox, /旧名: BEFORE_RENAME/);
  assert.match(mailbox, /新名: AFTER_RENAME/);
  const reopened = await f.start({ disableAgent: true });
  assert.equal((reopened.status() as { companionName: string }).companionName, "新名");
  assert.equal(fs.readFileSync(path.join(f.homeDir, "conversations/mailbox.md"), "utf8"), mailbox);
});
