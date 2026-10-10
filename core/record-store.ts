/** Durable archive reads. The in-memory state window is never an archive. */
import type { JournalEvent } from "../contracts/events.ts";
import { sanitizeDeep } from "./text.ts";
import { archiveDay, conversationAt, journalArchiveFiles, journalArchiveEvents, iterateJournalArchiveFiles } from "./journal-archive.ts";

export function* readJournalEvents(homeDir: string): Generator<JournalEvent> {
	for (const file of iterateJournalArchiveFiles(homeDir)) {
		for (const event of journalArchiveEvents(file)) yield { ...event, data: sanitizeDeep(event.data) };
	}
}

export function queryConversationRecords(homeDir: string, _companionName: string, options: { limit: number; beforeDate?: string }) {
	const days = new Map<string, Array<{ seq: number; at: string; who: string; text: string }>>();
	let total = 0;
	const limit = Math.max(1, Math.min(365, options.limit));
	const files = journalArchiveFiles(homeDir);
	const eligibleDays = new Set<string>();
	for (const file of files) {
		total += file.conversationCount;
		for (const date of file.conversationDays.keys()) if (options.beforeDate === undefined || date < options.beforeDate) eligibleDays.add(date);
	}
	const selectedDays = new Set([...eligibleDays].sort().reverse().slice(0, limit));
	for (const file of files) {
		if (![...file.conversationDays.keys()].some(date => selectedDays.has(date))) continue;
		for (const event of journalArchiveEvents(file)) {
			if (event.type !== "message.in" && event.type !== "message.out") continue;
			const at = conversationAt(event);
			const date = archiveDay(at);
			if (!selectedDays.has(date)) continue;
			const items = days.get(date) ?? [];
			items.push({ seq: event.seq, at: date ? at : "", who: event.type === "message.in" ? "你" : "它", text: String(sanitizeDeep(event.data.text ?? "")) });
			days.set(date, items);
		}
	}
	const sorted = [...days.keys()].sort().reverse();
	const selected = sorted.slice(0, limit);
	const clock = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
	return {
		kind: "conversations", total,
		nextCursor: eligibleDays.size > selected.length ? selected.at(-1) : null,
		entries: selected.map(date => {
			const list = days.get(date)!.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
			return { id: `conversations:${date || "unknown"}`, date, title: date ? `${date} 的对话` : "未标日期的对话", count: list.length, preview: list[0]?.text.slice(0, 80) ?? "", text: list.map(item => `${item.at ? clock.format(new Date(item.at)) + " " : ""}${item.who}：${item.text}`).join("\n\n") };
		}),
	};
}
