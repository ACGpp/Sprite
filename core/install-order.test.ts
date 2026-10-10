import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("安装器必须在替换代码前等旧内核退出，活锁和坏锁不得放行", t => {
 const source = fs.readFileSync("install.sh", "utf8");
 const begin = source.indexOf("<<'STOPPED'");
 const end = source.indexOf("\nSTOPPED", begin);
 assert.ok(begin > 0 && end > begin);
 assert.ok(end < source.indexOf('rm -rf "$TARGET_DIR/Sprite.app"'));
 assert.ok(end < source.indexOf('rm -rf "$KERNEL_DIR/core"'));
 assert.ok(source.lastIndexOf('launchctl bootout', begin) < begin);
 const code = source.slice(source.indexOf("\n", begin) + 1, end).replace("+ 15000", "+ 40");
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-install-lock-"));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const lock = path.join(dir, "journal.lock");
 const run = () => spawnSync(process.execPath, ["--input-type=module", "-", lock], { input: code, timeout: 3000 });
 assert.equal(run().status, 0, "没有持有者可安装");
 fs.writeFileSync(lock, String(process.pid));
 assert.equal(run().status, 1, "活进程必须停止后才能覆盖代码");
 fs.writeFileSync(lock, "invalid");
 assert.equal(run().status, 1, "锁损坏不可猜测为安全");
});
