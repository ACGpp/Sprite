/** Bounded, disposable journal indexes. The journal remains the complete source of truth. */
import fs from "node:fs";
import path from "node:path";
import { parseJournalEvent, type JournalEvent } from "../contracts/events.ts";
import { dayInShanghai } from "./text.ts";
import { safeHistoryData } from "./history-projection.ts";

const INDEX_LIMIT = 16 * 1024 * 1024;
const CONTENT_LIMIT = 32 * 1024 * 1024;
const BLOOM_BYTES = 8192;
export interface JournalArchiveFile {
	path: string;
	signature: string;
	minSeq: number;
	maxSeq: number;
	historyDays: Set<string>;
	conversationDays: Map<string, number>;
	conversationCount: number;
	bloom: Uint8Array;
}
const indexes = new Map<string, { value: JournalArchiveFile; bytes: number }>();
const contents = new Map<string, { signature: string; events: JournalEvent[]; bytes: number }>();
let indexBytes = 0, contentBytes = 0;
function drop(file: string) {
	const index = indexes.get(file); if (index) { indexBytes -= index.bytes; indexes.delete(file); }
	const content = contents.get(file); if (content) { contentBytes -= content.bytes; contents.delete(file); }
}
export function clearJournalArchiveCache() { indexes.clear(); contents.clear(); indexBytes = 0; contentBytes = 0; }
export function journalArchiveCacheStats() { return { indexBytes, contentBytes, indexLimit: INDEX_LIMIT, contentLimit: CONTENT_LIMIT, indexedFiles: indexes.size, cachedFiles: contents.size }; }
const signature = (stat: fs.BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
function safeStat(file: string): fs.BigIntStats | null {
	let stat: fs.BigIntStats;
	try { stat = fs.lstatSync(file, { bigint: true }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || fs.realpathSync(file) !== file) return null;
	return stat;
}
function readEvents(file: string, expected: string): { events: JournalEvent[]; bytes: number } {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = fs.fstatSync(fd, { bigint: true });
		if (!stat.isFile() || stat.nlink !== 1n || signature(stat) !== expected || fs.realpathSync(file) !== file) throw new Error("事件历史读取期间路径变化。");
		const raw = fs.readFileSync(fd, "utf8");
		const after = safeStat(file);
		if (!after || signature(after) !== expected || signature(fs.fstatSync(fd, { bigint: true })) !== expected) throw new Error("事件历史读取期间内容变化，请重试。");
		const events: JournalEvent[] = [];
		for (const line of raw.slice(0, raw.lastIndexOf("\n") + 1).split("\n")) {
			try { const event = parseJournalEvent(JSON.parse(line)); if (event) events.push(event); } catch { /* Ignore malformed lines and uncommitted tails. */ }
		}
		return { events, bytes: Buffer.byteLength(raw) * 3 + events.length * 512 };
	} finally { fs.closeSync(fd); }
}
function cacheContent(file: string, stamp: string, value: { events: JournalEvent[]; bytes: number }) {
	const previous = contents.get(file); if (previous) { contentBytes -= previous.bytes; contents.delete(file); }
	if (value.bytes > CONTENT_LIMIT) return;
	while (contentBytes + value.bytes > CONTENT_LIMIT && contents.size) {
		const oldest = contents.keys().next().value!;
		contentBytes -= contents.get(oldest)!.bytes; contents.delete(oldest);
	}
	contents.set(file, { signature: stamp, ...value }); contentBytes += value.bytes;
}
export function historyAt(event: JournalEvent): string {
	const legacyAt = event.type === "thought.recorded" ? event.data.legacyTime : event.data.legacyAt;
	return typeof legacyAt === "string" && Number.isFinite(Date.parse(legacyAt)) ? legacyAt : event.at;
}
export function conversationAt(event: JournalEvent): string { return typeof event.data.legacyAt === "string" ? event.data.legacyAt : event.at; }
export function archiveDay(at: string): string { return Number.isFinite(Date.parse(at)) ? dayInShanghai(new Date(at)) : ""; }
function trigram(text: string, index: number): number {
	return Math.imul(text.charCodeAt(index) * 961 + text.charCodeAt(index + 1) * 31 + text.charCodeAt(index + 2), 0x9e3779b1) >>> 16;
}
function addSearch(bloom: Uint8Array, text: string) {
	for (let i = 0; i + 2 < text.length; i++) { const bit = trigram(text, i); bloom[bit >>> 3] |= 1 << (bit & 7); }
}
export function mayMatchArchive(file: JournalArchiveFile, query: string): boolean {
	for (let i = 0; i + 2 < query.length; i++) { const bit = trigram(query, i); if (!(file.bloom[bit >>> 3]! & (1 << (bit & 7)))) return false; }
	return true;
}
function indexFile(file: string, stamp: string): JournalArchiveFile {
	const hit = indexes.get(file);
	if (hit?.value.signature === stamp) { indexes.delete(file); indexes.set(file, hit); return hit.value; }
	drop(file);
	const loaded = readEvents(file, stamp);
	const value: JournalArchiveFile = { path: file, signature: stamp, minSeq: Infinity, maxSeq: 0,
		historyDays: new Set(), conversationDays: new Map(), conversationCount: 0, bloom: new Uint8Array(BLOOM_BYTES) };
	for (const event of loaded.events) {
		value.minSeq = Math.min(value.minSeq, event.seq); value.maxSeq = Math.max(value.maxSeq, event.seq);
		const data = safeHistoryData(event);
		if (data) { value.historyDays.add(archiveDay(historyAt(event))); addSearch(value.bloom, JSON.stringify(data).toLocaleLowerCase()); }
		if (event.type === "message.in" || event.type === "message.out") {
			const date = archiveDay(conversationAt(event));
			value.conversationDays.set(date, (value.conversationDays.get(date) ?? 0) + 1); value.conversationCount++;
		}
	}
	const bytes = BLOOM_BYTES + file.length * 2 + (value.historyDays.size + value.conversationDays.size) * 128 + 512;
	if (bytes <= INDEX_LIMIT) {
		while (indexBytes + bytes > INDEX_LIMIT && indexes.size) {
			const oldest = indexes.keys().next().value!; indexBytes -= indexes.get(oldest)!.bytes; indexes.delete(oldest);
		}
		indexes.set(file, { value, bytes }); indexBytes += bytes;
	}
	cacheContent(file, stamp, loaded); return value;
}
/** Inspect every filename and signature on each query; no date or sequence is inferred from names. */
export function* iterateJournalArchiveFiles(homeDir: string): Generator<JournalArchiveFile> {
	const directory = path.join(fs.realpathSync(homeDir), "journal");
	try {
		if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error("unsafe journal path");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			for (const file of [...indexes.keys(), ...contents.keys()]) if (path.dirname(file) === directory) drop(file);
			return;
		}
		throw new Error("事件历史路径不安全或无法读取。");
	}
	const present = new Set<string>();
	for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".jsonl")).sort()) {
		const file = path.join(directory, name); const stat = safeStat(file);
		if (!stat) { drop(file); continue; }
		present.add(file); yield indexFile(file, signature(stat));
	}
	for (const file of [...indexes.keys(), ...contents.keys()]) if (path.dirname(file) === directory && !present.has(file)) drop(file);
}
export function journalArchiveFiles(homeDir: string): JournalArchiveFile[] { return [...iterateJournalArchiveFiles(homeDir)]; }
export function journalArchiveEvents(file: JournalArchiveFile): readonly JournalEvent[] {
	const stat = safeStat(file.path);
	if (!stat || signature(stat) !== file.signature) { drop(file.path); throw new Error("事件历史查询期间文件变化，请重试。"); }
	const hit = contents.get(file.path);
	if (hit?.signature === file.signature) { contents.delete(file.path); contents.set(file.path, hit); return hit.events; }
	const loaded = readEvents(file.path, file.signature); cacheContent(file.path, file.signature, loaded); return loaded.events;
}
