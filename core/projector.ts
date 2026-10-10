/** Append-only projections with a durable commit offset and replayable write intent. */
import fs from "node:fs";
import path from "node:path";
import type { JournalEvent } from "../contracts/events.ts";
import { shanghaiStamp, MAILBOX_RELATIVE, THOUGHTS_RELATIVE } from "./projections.ts";

export type ProjectionResult = { ok: true; file: string } | { ok: false; error: string };
export type ProjectorDeps = { homeDir: string; companionName: string; currentCompanionName?: () => string; userSpeaker?: string; fsync?: boolean; log?: (message: string) => void };
export type Projector = { project(event: JournalEvent): ProjectionResult; recover(events: Iterable<JournalEvent>): ProjectionResult[]; supported(type: string): boolean };
type FileState = { seq: number; bytes: number; mtimeMs: number; baseSeq: number; migrating?: boolean };
type Baseline = { seq: number; content: string; migrating?: boolean };
type Pending = { file: string; before: FileState; seq: number; line: string };
const FILES = [MAILBOX_RELATIVE, THOUGHTS_RELATIVE];
const SUPPORTED = new Set(["message.in", "message.out", "thought.recorded"]);

export function createProjector(deps: ProjectorDeps): Projector {
	const { homeDir, companionName, userSpeaker = "用户", fsync = true, log = () => {} } = deps;
	const stateDir = path.join(homeDir, "runtime", "projections");
	const states = new Map<string, FileState>();
	const target = (file: string) => path.join(homeDir, file);
	const statePath = (file: string) => path.join(stateDir, path.basename(file) + ".json");
	const basePath = (file: string) => path.join(stateDir, path.basename(file) + ".base");
	const pendingPath = path.join(stateDir, "pending.json");
	function atomic(file: string, content: string | Buffer) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const temp = `${file}.tmp`;
		const fd = fs.openSync(temp, "w", 0o600);
		try { fs.writeFileSync(fd, content); if (fsync) fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		fs.renameSync(temp, file);
		if (fsync) { const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
	}
	function stat(file: string) {
		try { return fs.statSync(target(file)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	}
	function save(file: string, state: FileState) { atomic(statePath(file), JSON.stringify(state)); states.set(file, state); }
	function load(file: string): FileState | undefined {
		if (states.has(file)) return states.get(file);
		try {
			const value = JSON.parse(fs.readFileSync(statePath(file), "utf8")) as FileState;
			if (!Number.isInteger(value.seq) || !Number.isInteger(value.bytes) || !Number.isInteger(value.baseSeq)) throw new Error("无效投影水位");
			states.set(file, value); return value;
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	}
	/** Originals are backed up only at adoption or when somebody changes the file. */
	function adopt(file: string, seq: number, migrating = false): FileState {
		atomic(basePath(file), JSON.stringify({ seq, migrating, content: fs.existsSync(target(file)) ? fs.readFileSync(target(file)).toString("base64") : "" }));
		const info = stat(file);
		const state = { seq, baseSeq: seq, migrating, bytes: info?.size ?? 0, mtimeMs: info?.mtimeMs ?? 0 };
		save(file, state); return state;
	}
	function suffix(file: string, offset: number, length: number): Buffer {
		const fd = fs.openSync(target(file), "r");
		try { const buffer = Buffer.alloc(length); const count = fs.readSync(fd, buffer, 0, length, offset); return buffer.subarray(0, count); }
		finally { fs.closeSync(fd); }
	}
	function finish(pending: Pending) {
		const { file, before, seq, line } = pending;
		fs.mkdirSync(path.dirname(target(file)), { recursive: true });
		const info = stat(file);
		const expected = Buffer.from(line);
		const tail = info && info.size >= before.bytes ? suffix(file, before.bytes, info.size - before.bytes) : Buffer.alloc(0);
		if (info && info.size >= before.bytes && expected.subarray(0, tail.length).equals(tail) && tail.length <= expected.length) {
			// A torn append belongs to this exact intent, so replacing just that suffix is safe.
			const fd = fs.openSync(target(file), "r+");
			try { fs.ftruncateSync(fd, before.bytes); fs.writeSync(fd, expected, 0, expected.length, before.bytes); if (fsync) fs.fsyncSync(fd); }
			finally { fs.closeSync(fd); }
		} else if (!info && before.bytes === 0) {
			atomic(target(file), expected);
		} else {
			throw new Error(`投影 ${file} 在提交期间被外部修改，保留原文件与恢复事务`);
		}
		const after = fs.statSync(target(file));
		save(file, { ...before, seq, bytes: after.size, mtimeMs: after.mtimeMs });
		fs.unlinkSync(pendingPath);
	}
	function settlePending() {
		if (!fs.existsSync(pendingPath)) return;
		const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8")) as Pending;
		if (!FILES.includes(pending.file) || typeof pending.line !== "string") throw new Error("无效投影事务");
		finish(pending);
	}
	function fileFor(event: JournalEvent) { return event.type === "thought.recorded" ? THOUGHTS_RELATIVE : MAILBOX_RELATIVE; }
	function lineFor(event: JournalEvent) {
		const rawAt = typeof event.data.legacyAt === "string" ? event.data.legacyAt : event.at;
		const at = new Date(Number.isFinite(Date.parse(rawAt)) ? rawAt : event.at);
		const text = String(event.data.text ?? "");
		if (event.type === "thought.recorded") return JSON.stringify({ time: at.toISOString().replace(/\.\d{3}Z$/, "Z"), type: event.data.legacyType ?? "breath", content: text });
		const oneLine = text.replace(/\r?\n[ \t]*\r?\n/g, " ⏎  ⏎ ").replace(/\r?\n/g, " ⏎ ").trim();
		const speaker = typeof event.data.companionName === "string" ? event.data.companionName : deps.currentCompanionName?.() ?? companionName;
		return `[${shanghaiStamp(at)}] ${event.type === "message.in" ? userSpeaker : speaker}: ${oneLine}`;
	}
	function representedKey(file: string, line: string): string {
		if (file === THOUGHTS_RELATIVE) {
			try {
				const item = JSON.parse(line) as { time?: string; type?: string; content?: string };
				return JSON.stringify([item.time, item.type, item.content]);
			} catch { return line; }
		}
		// Companion renames must not duplicate old native replies. User/agent role,
		// timestamp and body are stable; consume counts for identical repeated lines.
		const match = /^\[([^\]]+)\] ([^:]+): (.*)$/.exec(line);
		return match ? JSON.stringify([match[1], match[2] === userSpeaker ? "in" : "out", match[3]]) : line;
	}
	function failed(error: unknown): ProjectionResult { const message = error instanceof Error ? error.message : String(error); log(`[projector] ${message}`); return { ok: false, error: message }; }
	function project(event: JournalEvent): ProjectionResult {
		if (!SUPPORTED.has(event.type)) return { ok: true, file: "" };
		try {
			settlePending();
			const file = fileFor(event);
			let prior = load(file) ?? adopt(file, 0);
			if (event.seq <= prior.seq) return { ok: true, file };
			const actual = stat(file);
			if (!actual && prior.bytes > 0) throw new Error(`投影 ${file} 缺失，需要日志恢复`);
			if (actual && (actual.size !== prior.bytes || actual.mtimeMs !== prior.mtimeMs)) prior = adopt(file, prior.seq);
			const newline = prior.bytes && suffix(file, prior.bytes - 1, 1)[0] !== 10 ? "\n" : "";
			const pending = { file, before: prior, seq: event.seq, line: `${newline}${lineFor(event)}\n` };
			atomic(pendingPath, JSON.stringify(pending)); finish(pending);
			return { ok: true, file };
		} catch (error) { return failed(error); }
	}
	return {
		project, supported: type => SUPPORTED.has(type),
		recover(events) {
			try {
				settlePending();
				const migrating = new Map<string, Map<string, number>>();
				for (const file of FILES) {
					let state = load(file); const actual = stat(file);
					// Persist original bytes before advancing any event watermark. A migration
					// interrupted halfway must still know which lines predated the kernel.
					if (!state && actual) state = adopt(file, 0, true);
					if (!state) continue;
					const baseline = !actual || state.migrating ? JSON.parse(fs.readFileSync(basePath(file), "utf8")) as Baseline : undefined;
					if (!actual) {
						atomic(target(file), Buffer.from(baseline!.content, "base64"));
						const restored = fs.statSync(target(file));
						save(file, { ...state, seq: baseline!.seq, baseSeq: baseline!.seq, migrating: baseline!.migrating, bytes: restored.size, mtimeMs: restored.mtimeMs });
					} else if (actual.size !== state.bytes || actual.mtimeMs !== state.mtimeMs) {
						if (baseline?.migrating) throw new Error(`投影 ${file} 在首次迁移期间被外部修改，保留原文件`);
						adopt(file, state.seq);
					}
					if (baseline?.migrating) {
						const counts = new Map<string, number>();
						for (const line of Buffer.from(baseline!.content, "base64").toString("utf8").split("\n")) {
							const key = representedKey(file, line); counts.set(key, (counts.get(key) ?? 0) + 1);
						}
						migrating.set(file, counts);
					}
				}
				for (const event of events) {
					if (!SUPPORTED.has(event.type)) continue;
					const file = fileFor(event);
					const counts = migrating.get(file);
					if (counts) {
						const key = representedKey(file, lineFor(event));
						const count = counts.get(key) ?? 0;
						if (count > 0) counts.set(key, count - 1);
						const originalSource = file === MAILBOX_RELATIVE ? "mailbox" : "thoughts";
						if (event.data.importSource === originalSource || count > 0) {
							const state = load(file)!;
							if (event.seq > state.seq) save(file, { ...state, seq: event.seq });
							continue;
						}
					}
					const result = project(event); if (!result.ok) return [result];
				}
				// Once every source event is represented, consolidate the baseline once.
				// Steady-state appends remain constant-size writes.
				for (const file of migrating.keys()) adopt(file, load(file)!.seq);
				return [];
			} catch (error) { return [failed(error)]; }
		},
	};
}
