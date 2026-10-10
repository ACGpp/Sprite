// Per-user installation for the downloadable app. No sudo and no network downloads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const xml = text => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export function servicePlist({ release, home }) {
    const environment = {
        HOME: home,
        SPRITE_HOME: path.join(home, ".claude-memory"),
        SPRITE_PI_BIN: path.join(release, "bin/pi"),
        PATH: `${release}/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`,
    };
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.sprite.core</string>
<key>ProgramArguments</key><array><string>${xml(path.join(release, "bin/node"))}</string><string>${xml(path.join(release, "core/main.ts"))}</string></array>
<key>WorkingDirectory</key><string>${xml(release)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(path.join(home, "Library/Logs/sprite-core.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(home, "Library/Logs/sprite-core.err.log"))}</string>
</dict></plist>
`;
}

export async function rpcReady(socketPath, timeout = 1500) {
    return new Promise(resolve => {
        const socket = net.connect(socketPath);
        let data = "", done = false;
        const finish = value => { if (!done) { done = true; socket.destroy(); resolve(value); } };
        socket.setTimeout(timeout, () => finish(false));
        socket.on("error", () => finish(false));
        socket.on("connect", () => socket.write(JSON.stringify({ id: "bundle-ready", type: "query.diagnostics" }) + "\n"));
        socket.on("data", chunk => {
            data += chunk;
            if (data.length > 1024 * 1024) return finish(false);
            if (!data.includes("\n")) return;
            try { const response = JSON.parse(data.split("\n")[0]); finish(response.id === "bundle-ready" && response.ok === true); }
            catch { finish(false); }
        });
        socket.on("close", () => finish(false));
    });
}

async function waitWriterStopped(lock, timeout) {
    const deadline = Date.now() + timeout;
    while (true) {
        let pid;
        try { pid = Number(fs.readFileSync(lock, "utf8").trim()); }
        catch (error) { if (error.code === "ENOENT") return; throw error; }
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("The memory writer lock is invalid. No runtime files were replaced.");
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === "ESRCH") return; throw error; }
        if (Date.now() >= deadline) throw new Error("The previous kernel is still running. Stop it before upgrading Sprite.");
        await pause(100);
    }
}

function atomicWrite(file, content) {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

function acquireInstallationLock(support) {
    const lock = path.join(support, "installation.lock");
    let lockFd;
    try { lockFd = fs.openSync(lock, "wx", 0o600); }
    catch (error) {
        if (error.code !== "EEXIST") throw error;
        const pid = Number(fs.readFileSync(lock, "utf8").trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`An interrupted installation needs attention. Remove ${lock} only when no Sprite installation is running.`);
        try { process.kill(pid, 0); throw new Error("Another Sprite installation is running. Please reopen the app when it finishes."); }
        catch (probe) { if (probe.code !== "ESRCH") throw probe; }
        fs.unlinkSync(lock);
        lockFd = fs.openSync(lock, "wx", 0o600);
    }
    fs.writeFileSync(lockFd, String(process.pid));
    return () => { fs.closeSync(lockFd); fs.rmSync(lock, { force: true }); };
}

export async function installRuntime({ resources, home = os.homedir(), uid = process.getuid(),
    launchctl = args => exec("/bin/launchctl", args, { timeout: 15000 }),
    ready = rpcReady, stopTimeout = 15000, readyTimeout = 180000 } = {}) {
    const manifest = JSON.parse(fs.readFileSync(path.join(resources, "runtime-manifest.json"), "utf8"));
    if (!/^[a-zA-Z0-9._-]+$/.test(manifest.deploymentId ?? "") || !["arm64", "x64"].includes(manifest.arch)) throw new Error("Invalid bundled runtime manifest.");
    if (manifest.arch !== process.arch) throw new Error("Download the Sprite installer matching this Mac's processor.");
    const payload = path.join(resources, "runtime");
    for (const file of ["bin/node", "bin/pi", "core/main.ts", "package.json", "node_modules/@mariozechner/pi-coding-agent/dist/cli.js"]) {
        if (!fs.statSync(path.join(payload, file)).isFile()) throw new Error(`Incomplete bundled runtime: ${file}`);
    }
    const support = path.join(home, "Library/Application Support/Sprite");
    fs.mkdirSync(support, { recursive: true, mode: 0o700 });
    const releaseLock = acquireInstallationLock(support);
    const release = path.join(support, "releases", manifest.deploymentId);
    const staging = `${release}.staging-${process.pid}`;
    const plist = path.join(home, "Library/LaunchAgents/com.sprite.core.plist");
    const desired = servicePlist({ release, home });
    const service = `gui/${uid}/com.sprite.core`;
    const domain = `gui/${uid}`;
    const socket = path.join(home, ".claude-memory/runtime/core.sock");
    const oldPlist = fs.existsSync(plist) ? fs.readFileSync(plist, "utf8") : null;
    let serviceChanged = false;
    const bootstrap = async () => {
        for (let attempt = 0; ; attempt++) {
            try { await launchctl(["bootstrap", domain, plist]); return; }
            catch (error) { if (attempt >= 4) throw error; await pause(300); }
        }
    };
    try {
        const marker = path.join(release, ".sprite-deployment");
        const installed = fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === manifest.deploymentId;
        if (installed && oldPlist === desired) {
            try { await launchctl(["print", service]); if (await ready(socket)) return { changed: false, release }; }
            catch { /* Re-register a stopped or missing service below. */ }
        }
        // Prepare completely before stopping the current writer. Never overwrite a live release.
        if (!installed) {
            if (fs.existsSync(release)) throw new Error("An incomplete runtime occupies this release path. No active files were replaced.");
            fs.mkdirSync(path.dirname(release), { recursive: true });
            fs.cpSync(payload, staging, { recursive: true, dereference: false });
            fs.writeFileSync(path.join(staging, ".sprite-deployment"), manifest.deploymentId);
            fs.renameSync(staging, release);
        }
        fs.mkdirSync(path.dirname(plist), { recursive: true });
        fs.mkdirSync(path.join(home, "Library/Logs"), { recursive: true });
        try { await launchctl(["bootout", service]); }
        catch (error) {
            // A missing service is expected on first install; a still-loaded one is not.
            let loaded = true;
            try { await launchctl(["print", service]); } catch { loaded = false; }
            if (loaded) throw error;
        }
        serviceChanged = true;
        await waitWriterStopped(path.join(home, ".claude-memory/journal/journal.lock"), stopTimeout);
        atomicWrite(plist, desired);
        await bootstrap();
        const deadline = Date.now() + readyTimeout;
        while (!await ready(socket)) {
            if (Date.now() >= deadline) throw new Error("Sprite could not start. See ~/Library/Logs/sprite-core.err.log.");
            await pause(200);
        }
        return { changed: true, release };
    } catch (error) {
        if (serviceChanged) {
            try {
                await launchctl(["bootout", service]).catch(() => {});
                await waitWriterStopped(path.join(home, ".claude-memory/journal/journal.lock"), stopTimeout);
                if (oldPlist !== null) { atomicWrite(plist, oldPlist); await bootstrap(); }
                else fs.rmSync(plist, { force: true });
            } catch (rollback) {
                throw new Error(`${error.message} Previous service could not be restored: ${rollback.message}`);
            }
        }
        throw error;
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
        releaseLock();
    }
}

export async function uninstallRuntime({ home = os.homedir(), uid = process.getuid(),
    launchctl = args => exec("/bin/launchctl", args, { timeout: 15000 }), stopTimeout = 15000 } = {}) {
    const support = path.join(home, "Library/Application Support/Sprite");
    fs.mkdirSync(support, { recursive: true, mode: 0o700 });
    const releaseLock = acquireInstallationLock(support);
    try {
        const service = `gui/${uid}/com.sprite.core`;
        try { await launchctl(["bootout", service]); }
        catch (error) {
            let loaded = true;
            try { await launchctl(["print", service]); } catch { loaded = false; }
            if (loaded) throw error;
        }
        await waitWriterStopped(path.join(home, ".claude-memory/journal/journal.lock"), stopTimeout);
        fs.rmSync(path.join(home, "Library/LaunchAgents/com.sprite.core.plist"), { force: true });
        fs.rmSync(support, { recursive: true, force: true });
        // Authored memory and voice originals are deliberately outside support.
    } finally { releaseLock(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv[2] === "--uninstall") { await uninstallRuntime(); console.log("Background service removed; memories retained."); }
        else console.log(JSON.stringify(await installRuntime({ resources: path.dirname(fileURLToPath(import.meta.url)) })));
    }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
