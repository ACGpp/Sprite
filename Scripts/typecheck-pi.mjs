// Validate the extension against the actual installed pi API, without adding runtime dependencies.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const pi = path.join(globalModules, "@mariozechner/pi-coding-agent");
function types(directory) {
	const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
	return path.resolve(directory, manifest.types);
}
fs.mkdirSync(path.join(root, ".core-test"), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, ".core-test/pi-typecheck-"));
try {
	const config = path.join(directory, "tsconfig.json");
	fs.writeFileSync(config, JSON.stringify({
		extends: path.join(root, "core/tsconfig.json"),
		compilerOptions: { paths: {
			"@mariozechner/pi-coding-agent": [types(pi)],
			"typebox": [types(path.join(pi, "node_modules/typebox"))],
		} },
		include: [path.join(root, "pi-extension/**/*.ts"), path.join(root, "contracts/memory-policy.ts")], exclude: [],
	}));
	execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", config], { cwd: root, stdio: "inherit" });
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
