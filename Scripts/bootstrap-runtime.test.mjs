import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installRuntime, servicePlist } from "./bootstrap-runtime.mjs";

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-installer-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, "user & space");
    const resources = path.join(root, "Sprite.app/Contents/Resources");
    const support = path.join(home, "Library/Application Support/Sprite");
    const plist = path.join(home, "Library/LaunchAgents/com.sprite.core.plist");
    const original = path.join(home, ".claude-memory/identity.md");
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(original, "PRIVATE ORIGINAL — must survive installation");
    for (const file of ["bin/node", "bin/pi", "core/main.ts", "package.json", "node_modules/@mariozechner/pi-coding-agent/dist/cli.js"]) {
        const target = path.join(resources, "runtime", file);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `payload ${file}`);
    }
    const deploymentId = "0.3.4-test";
    fs.writeFileSync(path.join(resources, "runtime-manifest.json"), JSON.stringify({ deploymentId, arch: process.arch }));
    const calls = [];
    const launchctl = async args => { calls.push(args); };
    const options = { resources, home, uid: 123, launchctl, ready: async () => true, readyTimeout: 1, stopTimeout: 1 };
    const setOld = () => { fs.mkdirSync(path.dirname(plist), { recursive: true }); fs.writeFileSync(plist, "PREVIOUS SERVICE"); };
    return { root, home, resources, support, plist, original, calls, options, setOld, deploymentId };
}

test("first launch installs an independent runtime, escapes paths and preserves original memory", async t => {
    const f = fixture(t);
    const result = await installRuntime(f.options);
    assert.equal(result.changed, true);
    assert.equal(fs.readFileSync(path.join(result.release, "core/main.ts"), "utf8"), "payload core/main.ts");
    const text = fs.readFileSync(f.plist, "utf8");
    assert.match(text, /user &amp; space/);
    assert.match(text, /SPRITE_PI_BIN/);
    assert.ok(!text.includes(f.resources), "service must survive ejecting the DMG or moving the app");
    assert.equal(fs.statSync(f.plist).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(f.original, "utf8"), /PRIVATE ORIGINAL/);
    assert.deepEqual(f.calls.map(args => args[0]), ["bootout", "bootstrap"]);
    assert.equal(fs.existsSync(path.join(f.support, "installation.lock")), false);
    f.calls.length = 0;
    assert.equal((await installRuntime(f.options)).changed, false);
    assert.deepEqual(f.calls.map(args => args[0]), ["print"], "reopening must not restart a healthy kernel");
});

test("failed new startup restores previous launch service and retains memory and previous files", async t => {
    const f = fixture(t); f.setOld();
    const previous = path.join(f.support, "kernel/old.ts");
    fs.mkdirSync(path.dirname(previous), { recursive: true }); fs.writeFileSync(previous, "old runtime");
    await assert.rejects(installRuntime({ ...f.options, ready: async () => false }), /could not start/);
    assert.equal(fs.readFileSync(f.plist, "utf8"), "PREVIOUS SERVICE");
    assert.equal(fs.readFileSync(previous, "utf8"), "old runtime");
    assert.match(fs.readFileSync(f.original, "utf8"), /PRIVATE ORIGINAL/);
    assert.deepEqual(f.calls.map(args => args[0]), ["bootout", "bootstrap", "bootout", "bootstrap"]);
});

test("first install failure removes its new service definition", async t => {
    const f = fixture(t);
    await assert.rejects(installRuntime({ ...f.options, ready: async () => false }), /could not start/);
    assert.equal(fs.existsSync(f.plist), false);
    assert.match(fs.readFileSync(f.original, "utf8"), /PRIVATE ORIGINAL/);
});

test("an active memory writer prevents replacement or competing startup", async t => {
    const f = fixture(t); f.setOld();
    const lock = path.join(f.home, ".claude-memory/journal/journal.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, String(process.pid));
    await assert.rejects(installRuntime(f.options), /still running/);
    assert.equal(fs.readFileSync(f.plist, "utf8"), "PREVIOUS SERVICE");
    assert.ok(!f.calls.some(args => args[0] === "bootstrap"));
});

test("missing service is normal on first launch, but a failed stop of a loaded service is fatal", async t => {
    const f = fixture(t);
    const missing = async args => { if (["bootout", "print"].includes(args[0])) throw new Error("not loaded"); };
    assert.equal((await installRuntime({ ...f.options, launchctl: missing })).changed, true);
    const before = fs.readFileSync(f.plist, "utf8");
    await assert.rejects(installRuntime({ ...f.options, ready: async () => false,
        launchctl: async args => { if (args[0] === "bootout") throw new Error("cannot stop"); } }), /cannot stop/);
    assert.equal(fs.readFileSync(f.plist, "utf8"), before);
});

test("concurrent installation and invalid manifests fail before stopping services", async t => {
    const f = fixture(t);
    fs.mkdirSync(f.support, { recursive: true });
    fs.writeFileSync(path.join(f.support, "installation.lock"), String(process.pid));
    await assert.rejects(installRuntime(f.options), /Another Sprite installation/);
    assert.equal(f.calls.length, 0);
    fs.writeFileSync(path.join(f.resources, "runtime-manifest.json"), JSON.stringify({ deploymentId: "../escape", arch: process.arch }));
    await assert.rejects(installRuntime(f.options), /Invalid bundled runtime/);
    assert.equal(f.calls.length, 0);
});

test("service XML safely represents quotes and brackets in a user directory", () => {
    const text = servicePlist({ release: '/tmp/a<&"b', home: '/tmp/a<&"b' });
    assert.match(text, /a&lt;&amp;&quot;b/);
    assert.ok(!text.includes('/tmp/a<&"b'));
});

test("uninstall stops the service and removes runtime files while retaining memory", async t => {
    const { uninstallRuntime } = await import("./bootstrap-runtime.mjs");
    const f = fixture(t);
    await installRuntime(f.options);
    f.calls.length = 0;
    await uninstallRuntime(f.options);
    assert.deepEqual(f.calls.map(args => args[0]), ["bootout"]);
    assert.equal(fs.existsSync(f.plist), false);
    assert.equal(fs.existsSync(f.support), false);
    assert.match(fs.readFileSync(f.original, "utf8"), /PRIVATE ORIGINAL/);
});

test("uninstall refuses to remove runtime files while a memory writer is still alive", async t => {
    const { uninstallRuntime } = await import("./bootstrap-runtime.mjs");
    const f = fixture(t); await installRuntime(f.options);
    const lock = path.join(f.home, ".claude-memory/journal/journal.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, String(process.pid));
    await assert.rejects(uninstallRuntime(f.options), /still running/);
    assert.equal(fs.existsSync(f.plist), true);
    assert.equal(fs.existsSync(path.join(f.support, "releases", f.deploymentId, "core/main.ts")), true);
});
