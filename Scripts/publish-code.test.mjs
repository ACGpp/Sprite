import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = path.dirname(fileURLToPath(import.meta.url));
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-publish-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "repo");
    const remote = path.join(root, "origin.git");
    const memory = path.join(root, "memory");
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(memory, "config"), { recursive: true });
    const env = { ...process.env, SPRITE_REAL_HOME: memory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    delete env.GIT_INDEX_FILE;
    const command = (bin, args) => spawnSync(bin, args, { cwd: repo, env, encoding: "utf8", timeout: 30000 });
    const git = (...args) => {
        const result = command("git", args);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    const write = (name, text) => {
        fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
        fs.writeFileSync(path.join(repo, name), text);
    };
    git("init", "--bare", remote);
    git("init", "-b", "main");
    git("config", "user.name", "Release Test");
    git("config", "user.email", "release@example.invalid");
    git("config", "core.hooksPath", "/dev/null");
    git("remote", "add", "origin", remote);
    write("package.json", '{"name":"fixture","version":"0.3.4"}\n');
    write("source.txt", "public base\n");
    write("removed.txt", "remove in next version\n");
    git("add", "."); git("commit", "-qm", "public base");
    git("push", "-qu", "origin", "main");
    const parent = git("rev-parse", "HEAD");
    for (const file of ["publish-code.sh", "privacy-scan.py"]) {
        write(`Scripts/${file}`, fs.readFileSync(path.join(scripts, file)));
    }
    write("Scripts/privacy-allowlist.txt", "# No fixture exceptions\n");
    write(".gitignore", "ignored/\n.core-test/\nnode_modules/\n");
    write("docs/private.md", "Private development note\n");
    git("add", "."); git("commit", "-qm", "private development commit");
    const developerHead = git("rev-parse", "HEAD");
    const publish = (...args) => command("bash", ["Scripts/publish-code.sh", ...args]);
    return { root, repo, remote, memory, git, write, publish, parent, developerHead, command };
}

test("working-tree snapshot includes new files and deletions, excludes private paths, preserves index and public history", t => {
    const f = fixture(t);
    f.write("source.txt", "staged version\n"); f.git("add", "source.txt");
    f.write("source.txt", "unstaged version\n");
    f.write("new.ts", "export const updated = true;\n");
    f.write("docs/new-private.md", "not publishable\n");
    f.write(".core-test/probe.json", '{"private":true}\n');
    f.write("ignored/file.txt", "ignored data\n");
    fs.unlinkSync(path.join(f.repo, "removed.txt"));
    const index = fs.readFileSync(path.join(f.repo, ".git/index"));
    const before = f.git("status", "--porcelain");
    const result = f.publish("--source", "worktree");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const candidate = f.git("rev-parse", "publish/code-only");
    assert.equal(f.git("show", "-s", "--format=%P", candidate), f.parent);
    assert.equal(f.git("show", `${candidate}:source.txt`), "unstaged version");
    const files = f.git("ls-tree", "-r", "--name-only", candidate).split("\n");
    assert.ok(files.includes("new.ts"));
    assert.ok(!files.some(name => /^(docs|ignored|\.core-test)\//.test(name) || name === "removed.txt"));
    assert.equal(f.git("rev-parse", "HEAD"), f.developerHead);
    assert.equal(f.git("status", "--porcelain"), before);
    assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git/index")), index);
    assert.equal(f.git("--git-dir", f.remote, "rev-parse", "main"), f.parent, "dry run never pushes");
    f.write("new.ts", "new unreviewed changes\n");
    const pushed = f.publish("--source", "publish/code-only", "--push");
    assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr);
    assert.equal(f.git("--git-dir", f.remote, "rev-parse", "main"), candidate, "push exact reviewed commit");
    // A second update must append, never replace or erase the first public snapshot.
    assert.equal(f.publish("--source", "worktree").status, 0);
    assert.equal(f.git("show", "-s", "--format=%P", "publish/code-only"), candidate);
});

test("failed privacy scan cannot replace a candidate or change the remote", t => {
    const f = fixture(t);
    assert.equal(f.publish("--source", "worktree").status, 0);
    const candidate = f.git("rev-parse", "publish/code-only");
    const secret = "fixture-key-for-release-gate-123456";
    fs.writeFileSync(path.join(f.memory, "config/settings.json"), JSON.stringify({ apiKey: secret }));
    f.write("leak.txt", secret);
    const result = f.publish("--source", "worktree");
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes(secret), "do not print the secret");
    assert.equal(f.git("rev-parse", "publish/code-only"), candidate);
    assert.equal(f.git("--git-dir", f.remote, "rev-parse", "main"), f.parent);
});

test("stale reviewed snapshot and unreviewed worktree cannot be pushed", t => {
    const f = fixture(t);
    assert.equal(f.publish("--source", "worktree").status, 0);
    assert.notEqual(f.publish("--source", "worktree", "--push").status, 0);
    const tree = f.git("rev-parse", `${f.parent}^{tree}`);
    const other = f.git("commit-tree", tree, "-p", f.parent, "-m", "concurrent public change");
    f.git("push", "origin", `${other}:main`);
    const stale = f.publish("--source", "publish/code-only", "--push");
    assert.notEqual(stale.status, 0);
    assert.equal(f.git("--git-dir", f.remote, "rev-parse", "main"), other);
});

test("privacy scanner fails closed for an invalid Git reference", t => {
    const f = fixture(t);
    const result = f.command("python3", ["Scripts/privacy-scan.py", ".", "nonexistent-reference"]);
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes("PASS"));
});
