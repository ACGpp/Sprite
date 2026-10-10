import type { JournalEvent } from "../contracts/events.ts";
import { failureDiagnostic } from "./failure-diagnostics.ts";

export function safeHistoryData(event: JournalEvent): Record<string, unknown> | undefined {
	const allowed: Record<string, string[]> = {
		"message.in": ["text", "source", "questionId", "answer"],
		"message.out": ["text", "channel"],
		"thought.recorded": ["text"],
		"question.asked": ["questionId", "question", "options"],
		"question.answered": ["questionId", "answer"],
		"run.finished": ["runId", "durationMs"],
		"tool.finished": ["runId", "toolCallId", "tool", "success", "verified"],
		"run.failed": ["runId", "durationMs", "delivered", "outcomeUnknown"],
	};
	const keys = allowed[event.type];
	if (!keys) return undefined;
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const value = event.data[key];
		if (typeof value === "string") { result[key] = value.slice(0, 8000); if (value.length > 8000) result.truncated = true; }
		else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) result[key] = value;
		else if (key === "options" && Array.isArray(value)) result[key] = value.filter((item): item is string => typeof item === "string").slice(0, 30).map(item => item.slice(0, 1000));
	}
	return event.type === "run.failed" ? { ...result, ...failureDiagnostic(event.data) } : result;
}
