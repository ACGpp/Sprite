import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import path from "node:path";
import { reviewFixture } from "./__test__/review-fixture.ts";
import { rpcCall } from "./rpc/server.ts";
import { createMemoryStore } from "./memory-store.ts";

function gateway(home: string, request: object) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.connect(path.join(home, "runtime/gateway.sock")); let buffer = "";
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) { socket.destroy(); resolve(JSON.parse(buffer.split("\n")[0]!)); } });
    socket.on("error", reject);
  });
}

test("user memory RPC restores identity and tracks agreements; Agent cannot invoke management", async t => {
  const f = reviewFixture(t, "management-rpc");
  const store = createMemoryStore({ homeDir: f.homeDir, fsync: false });
  const old = store.write("identity.md", "我叫初名。", "missing", "first");
  const current = store.write("identity.md", "我叫新名。", old.version, "second");
  let kernel = await f.start({ disableAgent: true });
  const manage = async (request: object) => {
    const response = await rpcCall(kernel.socketPath, { type: "memory.manage", id: crypto.randomUUID(), ...request }) as { ok: boolean; error?: string; result: any };
    assert.equal(response.ok, true, response.error); return response.result;
  };
  const versions = await manage({ action: "versions", path: "identity.md" });
  assert.equal(versions.versions.length, 2);
  const restore = { action: "restore", path: "identity.md", version: old.version, baseVersion: current.version, commandId: "restore-from-ui" };
  assert.equal((await manage(restore)).verified, true);
  assert.equal((kernel.status() as { companionName: string }).companionName, "初名");
  assert.equal((await manage(restore)).verified, true);
  const initial = await manage({ action: "agreements" });
  const add = { action: "agreement.add", text: "USER_CONFIRMED_PREFERENCE", agreementKind: "preference", status: "active", baseRevision: initial.revision, commandId: "ui-agreement" };
  const added = await manage(add);
  assert.equal(added.items.length, 1);
  assert.equal((await manage(add)).items.length, 1, "Changing RPC transport id must not duplicate or fail the same command");
  assert.equal((await gateway(f.homeDir, { ...add, kind: "memory.manage" })).ok, false);
  const context = await gateway(f.homeDir, { kind: "memory.context", contextWindow: 128000, outputReserve: 16000, historyTokens: 0 });
  assert.equal(context.ok, true); assert.match(String(context.text), /USER_CONFIRMED_PREFERENCE/);
  await manage({ action: "agreement.revoke", agreementId: added.items[0].id, baseRevision: added.revision, commandId: "revoke" });
  kernel = await f.start({ disableAgent: true });
  assert.equal((await manage({ action: "agreements" })).items[0].status, "revoked");
});
