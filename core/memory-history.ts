/** A deliberately narrow journal projection. Raw tool payloads and failures never leave this boundary. */
import type { JournalEvent } from "../contracts/events.ts";
import { safeHistoryData } from "./history-projection.ts";
import { archiveDay, historyAt, journalArchiveFiles, journalArchiveEvents, mayMatchArchive } from "./journal-archive.ts";

export type MemoryHistoryOptions = { seq?: number; beforeSeq?: number; date?: string; query?: string; limit?: number };
export type MemoryHistoryEntry = { path: string; seq: number; at: string; type: JournalEvent["type"]; data: Record<string, unknown> };


export function queryMemoryHistory(homeDir: string, options: MemoryHistoryOptions = {}): { entries: MemoryHistoryEntry[]; nextCursor: number | null } {
	for (const value of [options.seq, options.beforeSeq]) if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error("历史序号必须是正整数。");
	if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new Error("历史查询 limit 必须是正整数。");
	if (options.date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(options.date) || new Date(`${options.date}T00:00:00Z`).toISOString().slice(0, 10) !== options.date)) throw new Error("历史日期必须是有效的 YYYY-MM-DD。");
	if (options.query !== undefined && (typeof options.query !== "string" || options.query.length > 1000)) throw new Error("历史关键词过长或无效。");
	const limit = Math.min(options.limit ?? 20, 100);
	const query = options.query?.toLocaleLowerCase();
	const files = journalArchiveFiles(homeDir).filter(file =>
		(options.seq === undefined || (file.minSeq <= options.seq && file.maxSeq >= options.seq))
		&& (options.beforeSeq === undefined || file.minSeq < options.beforeSeq)
		&& (options.date === undefined || file.historyDays.has(options.date))
		&& (!query || mayMatchArchive(file, query)))
		.sort((a, b) => b.maxSeq - a.maxSeq || a.path.localeCompare(b.path));
	const entries: MemoryHistoryEntry[] = [];
	for (const file of files) {
		if (entries.length === limit + 1 && file.maxSeq < entries.at(-1)!.seq) break;
		for (const event of journalArchiveEvents(file)) {
			if ((options.seq !== undefined && event.seq !== options.seq) || (options.beforeSeq !== undefined && event.seq >= options.beforeSeq)
				|| (entries.length === limit + 1 && event.seq < entries.at(-1)!.seq)) continue;
			const data = safeHistoryData(event);
			if (!data) continue;
			const at = historyAt(event);
			if (options.date !== undefined && archiveDay(at) !== options.date) continue;
			if (query && !JSON.stringify(data).toLocaleLowerCase().includes(query)) continue;
			const duplicate = entries.findIndex(item => item.seq === event.seq);
			// Keep the same earliest-filename winner as the pre-index scan, including query filters.
			if (duplicate >= 0) {
				if (entries[duplicate]!.path <= file.path) continue;
				entries.splice(duplicate, 1);
			}
			entries.push({ path: file.path, seq: event.seq, at, type: event.type, data });
			entries.sort((a, b) => b.seq - a.seq);
			if (entries.length > limit + 1) entries.pop();
		}
	}
	const hasMore = entries.length > limit;
	if (hasMore) entries.pop();
	return { entries, nextCursor: hasMore ? entries.at(-1)!.seq : null };
}
