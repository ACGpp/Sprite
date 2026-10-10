import type { JournalEvent } from "../contracts/events.ts";
import type { Journal } from "./journal.ts";

/** 兼容旧的两事件回答：已登记回答但未生成留言时，补齐持久交付，不要求用户重新回答。 */
export function recoverLegacyAnswers(journal: Journal, events: Iterable<JournalEvent>): void {
	const questions = new Map<string, string>();
	const answers = new Map<string, { questionId: string; answer: string; question: string }>();
	const delivered = new Set<string>();
	for (const event of events) {
		if (event.type === "question.asked") questions.set(String(event.data.questionId ?? `question-${event.seq}`), String(event.data.question ?? ""));
		if (event.type === "question.answered" && event.causeId) {
			const questionId = String(event.data.questionId ?? "");
			answers.set(event.causeId, { questionId, answer: String(event.data.answer ?? ""), question: questions.get(questionId) ?? questionId });
		}
		if (event.type === "message.in") {
			const id = typeof event.data.id === "string" ? event.data.id : event.causeId;
			if (id) delivered.add(id);
		}
	}
	for (const [id, answer] of answers) {
		if (delivered.has(id)) continue;
		journal.applyCommand({ id, produce: () => [{ type: "message.in", data: { id, ...answer, source: "text", text: `关于「${answer.question}」的回答：${answer.answer}` } }] });
	}
}
