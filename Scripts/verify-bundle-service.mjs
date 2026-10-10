// Exercise real launchd using a unique test label and an empty temporary user home.
// Never loads/unloads the user's com.sprite.core service.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);
const app = path.resolve(process.argv[2]);
const resources = path.join(app, "Contents/Resources");
const { installRuntime, uninstallRuntime } = await import(pathToFileURL(path.join(resources, "bootstrap-runtime.mjs")));
const home = fs.mkdtempSync("/tmp/sprite-launchd-test-");
const label = `com.sprite.package-test.${process.pid}`;
const service = `gui/${process.getuid()}/${label}`;
const testPlist = path.join(home, "test-service.plist");
const launchctl = async args => {
    const safe = args.map(arg => arg.replace(/\/com\.sprite\.core$/, `/${label}`));
    if (args[0] === "bootstrap") {
        const source = fs.readFileSync(args[2], "utf8");
        assert.ok(source.includes("<string>com.sprite.core</string>"));
        fs.writeFileSync(testPlist, source.replace("<string>com.sprite.core</string>", `<string>${label}</string>`));
        safe[2] = testPlist;
    }
    return exec("/bin/launchctl", safe, { timeout: 15000 });
};
try {
    const options = { resources, home, launchctl, readyTimeout: 30000 };
    assert.equal((await installRuntime(options)).changed, true);
    assert.equal((await installRuntime(options)).changed, false);
    const identity = path.join(home, ".claude-memory/identity.md");
    fs.writeFileSync(identity, "Synthetic memory retained after uninstall.");
    await uninstallRuntime(options);
    assert.equal(fs.readFileSync(identity, "utf8"), "Synthetic memory retained after uninstall.");
    assert.equal(fs.existsSync(path.join(home, "Library/Application Support/Sprite")), false);
    console.log("Launchd smoke PASS: first install, reopen without restart, RPC readiness, uninstall retaining memory; isolated service label and home.");
} catch (error) {
    for (const name of ["sprite-core.log", "sprite-core.err.log"]) {
        const log = path.join(home, "Library/Logs", name);
        if (fs.existsSync(log)) console.error(name, fs.readFileSync(log, "utf8").slice(-4000));
    }
    throw error;
} finally {
    await exec("/bin/launchctl", ["bootout", service]).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
}
