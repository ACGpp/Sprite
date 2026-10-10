import { execFileSync, spawn } from "node:child_process";

/** Kill only this command's tree; its process group also contains pi and other tools. */
function killCommandTree(root: number): void {
	const kill = (pid: number, signal: NodeJS.Signals) => {
		if (pid === process.pid || pid <= 1) return;
		try { process.kill(pid, signal); } catch { /* Already exited. */ }
	};
	// Stop the shell before enumerating so it cannot fork between discovery and kill.
	kill(root, "SIGSTOP");
	const known = new Set([root]);
	try {
		// Freeze newly discovered descendants before rescanning their children.
		for (let pass = 0; pass < 16; pass++) {
			const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 1000 }).trim().split("\n")
				.map(row => row.trim().split(/\s+/).map(Number));
			let added = false;
			for (const [pid, parent] of rows) {
				if (!pid || !parent || pid === process.pid || !known.has(parent) || known.has(pid)) continue;
				known.add(pid); kill(pid, "SIGSTOP"); added = true;
			}
			if (!added) break;
		}
	} finally {
		for (const pid of [...known].reverse()) kill(pid, "SIGKILL");
	}
}

/** pi's schema/output handling is retained, but commands inherit its revocable group. */
export function createManagedBashOperations() {
	return {
		exec(command: string, cwd: string, { onData, signal, timeout, env }: {
			onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv;
		}): Promise<{ exitCode: number | null }> {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) { reject(new Error("aborted")); return; }
				const child = spawn("/bin/bash", ["-c", command], { cwd, env: env ?? process.env, detached: false, stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				let finished = false;
				let exited = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				let drainHandle: NodeJS.Timeout | undefined;
				const stopCommand = () => {
					if (exited || !child.pid) return;
					try { killCommandTree(child.pid); } catch { child.kill("SIGKILL"); }
				};
				const cleanup = () => {
					clearTimeout(timeoutHandle); clearTimeout(drainHandle);
					signal?.removeEventListener("abort", stopCommand);
					child.stdout.removeListener("data", onData); child.stderr.removeListener("data", onData);
					child.stdout.destroy(); child.stderr.destroy();
				};
				const finish = (exitCode: number | null, error?: Error) => {
					if (finished) return;
					finished = true; cleanup();
					if (error) reject(error);
					else if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode });
				};
				child.stdout.on("data", onData); child.stderr.on("data", onData);
				child.once("error", error => finish(null, error));
				child.once("exit", code => {
					exited = true; clearTimeout(timeoutHandle); signal?.removeEventListener("abort", stopCommand);
					// Background descendants can retain the pipes; do not wait forever for close.
					drainHandle = setTimeout(() => finish(code), 100);
				});
				child.once("close", code => finish(code));
				signal?.addEventListener("abort", stopCommand, { once: true });
				if (signal?.aborted) stopCommand();
				if (timeout !== undefined && timeout > 0) timeoutHandle = setTimeout(() => { timedOut = true; stopCommand(); }, timeout * 1000);
			});
		},
	};
}
