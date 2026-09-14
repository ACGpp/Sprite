/**
 * 读模型：把事件序列折叠成内核状态。
 *
 * UI 只消费这里的结果，绝不解析 markdown、绝不猜测状态。
 * 关键语义：**在上一拍开始之后到达的留言，这一拍没被看到** → 属于待处理队列。
 */

import type { JournalEvent, PresenceState } from "../contracts/events.ts";

export type IncomingMessage = { text: string; source: "text" | "voice"; seq: number; at: string; imported: boolean };
export type OutgoingMessage = { text: string; channel: "bubble" | "digest"; seq: number; at: string; imported: boolean };
export type RunActivity = { kind: string; tool?: string; summary?: string; runId?: string; seq: number; at: string };
export type PendingQuestion = { question: string; options: string[]; seq: number; at: string };

/**
 * 读模型的滑动窗口大小。
 *
 * 为什么必须有窗口：事件日志按"年"增长（5 分钟一拍 ≈ 每天 2000 条）。
 * 若把全部 messages/thoughts/activities 都留在内存里，一个跑了两年的守护灵会吃掉几百 MB。
 * 界面只需要"最近几条"，完整历史在 journal 与 markdown 里——内存里只留窗口。
 */
export const DEFAULT_WINDOW = 200;

export type KernelState = {
	presence: PresenceState;
	nextBreathAt: string | null;
	messages: IncomingMessage[];
	pendingMessages: IncomingMessage[];
	outgoing: OutgoingMessage[];
	thoughts: string[];
	/** 思维流的时间线（与 thoughts 同窗口，但带时间与序号——记录按天聚合要用） */
	thoughtTimeline: Array<{ text: string; at: string; seq: number }>;
	activities: RunActivity[];
	questions: PendingQuestion[];
	toolDecisions: number;
	deferrals: number;
	runs: number;
	danglingRun: boolean;
	lastRunStartSeq: number;
	/** 还没结算的 run.started 的 seq 栈：提示词没送达时要把留言退回待处理 */
	runStartSeqs: number[];
	failures: string[];
	problems: string[];
	importedLines: number;
	/** 被窗口丢弃的旧条目数（用于诊断：内存里不是全部历史） */
	trimmed: number;
};

export function emptyState(): KernelState {
	return {
		presence: "asleep",
		nextBreathAt: null,
		messages: [],
		pendingMessages: [],
		outgoing: [],
		thoughts: [],
		thoughtTimeline: [],
		activities: [],
		questions: [],
		toolDecisions: 0,
		deferrals: 0,
		runs: 0,
		danglingRun: false,
		lastRunStartSeq: 0,
		runStartSeqs: [],
		failures: [],
		problems: [],
		importedLines: 0,
		trimmed: 0,
	};
}

/** 只保留最近的 window 条，返回被丢弃的数量。 */
function trim<T>(list: T[], window: number): number {
	if (list.length <= window) return 0;
	const dropped = list.length - window;
	list.splice(0, dropped);
	return dropped;
}

/** 把一个事件折叠进状态（增量）。窗口之外的旧条目会被丢弃，但计数器保持累计。 */
export function applyEvent(state: KernelState, event: JournalEvent, window: number = DEFAULT_WINDOW): void {
	const data = event.data;
	switch (event.type) {
		case "presence.changed":
			if (typeof data.state === "string") state.presence = data.state as PresenceState;
			break;
		case "breath.scheduled":
			state.nextBreathAt = typeof data.nextBreathAt === "string" ? data.nextBreathAt : null;
			break;
		case "message.in": {
			const message: IncomingMessage = {
				text: String(data.text ?? ""),
				source: data.source === "voice" ? "voice" : "text",
				seq: event.seq,
				// 导入的历史要用**它原本的时间**：用导入时刻会让几个月的对话全挤在今天
				at: typeof data.legacyAt === "string" ? String(data.legacyAt) : event.at,
				// 从 v1 记忆导入的历史：属于谈话记录，但**绝不是待处理队列**，
				// 否则内核一启动就会对几个月前的旧对话呼吸一拍。
				imported: typeof data.legacyAt === "string",
			};
			state.messages.push(message);
			// 待处理队列单独维护：它必须精确，不能被窗口丢掉
			// （用户可能在暂停期间连发很多条，那些一条都不能忘）。
			if (!message.imported) state.pendingMessages.push(message);
			state.trimmed += trim(state.messages, window);
			break;
		}
		case "message.out":
			state.outgoing.push({
				text: String(data.text ?? ""),
				channel: data.channel === "digest" ? "digest" : "bubble",
				seq: event.seq,
				at: typeof data.legacyAt === "string" ? String(data.legacyAt) : event.at,
				imported: typeof data.legacyAt === "string",
			});
			state.trimmed += trim(state.outgoing, window);
			break;
		case "thought.recorded": {
			const text = String(data.text ?? "");
			state.thoughts.push(text);
			const at = typeof data.legacyTime === "string" && data.legacyTime ? data.legacyTime : event.at;
			state.thoughtTimeline.push({ text, at, seq: event.seq });
			state.trimmed += trim(state.thoughts, window);
			state.trimmed += trim(state.thoughtTimeline, window);
			break;
		}
		case "run.activity":
			// 规范形状：可选字段为空时**不建这个键**，而不是建一个值为 undefined 的键。
			// 否则"折叠出来的状态"与"从检查点恢复的状态"在 deepEqual 下不相等
			// （JSON 序列化会把 undefined 的键丢掉），检查点等价性就无从验证。
			state.activities.push({
				kind: String(data.kind ?? "activity"),
				...(typeof data.tool === "string" ? { tool: data.tool } : {}),
				...(typeof data.summary === "string" ? { summary: data.summary } : {}),
				...(typeof data.runId === "string" ? { runId: data.runId } : {}),
				seq: event.seq,
				at: event.at,
			});
			state.trimmed += trim(state.activities, window);
			break;
		case "tool.decided":
			state.toolDecisions += 1;
			break;
		case "question.asked":
			state.questions.push({
				question: String(data.question ?? ""),
				options: Array.isArray(data.options) ? data.options.map(String) : [],
				seq: event.seq,
				at: event.at,
			});
			state.trimmed += trim(state.questions, 20);
			break;
		case "wake.deferred":
			state.deferrals += 1;
			break;
		case "run.started": {
			state.runs += 1;
			state.danglingRun = true;
			state.lastRunStartSeq = event.seq;
			// 这一拍开始之前到达的留言先按"已被看到"处理；但如果提示词**根本没送到**引擎，
			// 紧接着的 run.failed(delivered:false) 会把它们放回待处理（见下）。
			state.runStartSeqs.push(event.seq);
			state.pendingMessages = state.pendingMessages.filter((message) => message.seq > event.seq);
			break;
		}
		case "run.finished":
			state.danglingRun = false;
			state.runStartSeqs.pop();
			break;
		case "run.failed":
			state.danglingRun = false;
			// 引擎根本没收到这句话（prompt 被拒/发送失败）→ 留言不算被看到，放回待处理。
			// 否则用户的话会被静默吞掉：它没看到，而队列已经清了。
			if (data.delivered === false) {
				state.runStartSeqs.pop();
				const backTo = state.runStartSeqs.length > 0 ? state.runStartSeqs[state.runStartSeqs.length - 1]! : 0;
				state.lastRunStartSeq = backTo;
				for (const message of state.messages) {
					if (message.imported) continue;
					if (message.seq > backTo && !state.pendingMessages.some((existing) => existing.seq === message.seq)) {
						state.pendingMessages.push(message);
					}
				}
			} else {
				state.runStartSeqs.pop();
			}
			state.failures.push(String(data.reason ?? "unknown"));
			state.trimmed += trim(state.failures, window);
			break;
		case "system.problem":
			state.problems.push(String(data.userMessage ?? data.code ?? "unknown"));
			state.trimmed += trim(state.problems, window);
			break;
		case "legacy.imported":
			state.importedLines += Number(data.lines ?? 0);
			break;
		default:
			break;
	}
}

/**
 * 增量读模型追踪器：内核每次 append 时喂一条事件，状态就地更新。
 *
 * 为什么不能每次查询都重放全部事件：实测 20 万条事件时，
 * 一次 `query.status` 要 **1387ms**（O(n) 折叠），而外壳每次呼吸都会查一次。
 * 现在查询是 O(1)。
 */
export function createStateTracker(window: number = DEFAULT_WINDOW) {
	let state = emptyState();
	return {
		get state(): KernelState {
			return state;
		},
		apply(event: JournalEvent): void {
			applyEvent(state, event, window);
		},
		/**
		 * 从检查点恢复。**字段结构变了就要拒收**——旧快照缺新字段时，
		 * 合并出来的读模型会"看起来正常但少了东西"（真实事故：思维流整段消失）。
		 */
		restore(snapshot: unknown): boolean {
			if (typeof snapshot !== "object" || snapshot === null) return false;
			const candidate = snapshot as Partial<KernelState>;
			const requiredArrays: Array<keyof KernelState> = [
				"messages", "pendingMessages", "outgoing", "thoughts", "thoughtTimeline", "activities", "questions", "failures", "problems",
			];
			for (const key of requiredArrays) {
				if (!Array.isArray(candidate[key])) return false;   // 结构不符 → 让调用方重扫
			}
			if (typeof candidate.presence !== "string") return false;
			if (candidate.runStartSeqs !== undefined && !Array.isArray(candidate.runStartSeqs)) return false;
			state = { ...emptyState(), ...candidate } as KernelState;
			return true;
		},
		/** 快照（供检查点序列化）。 */
		snapshot(): KernelState {
			return state;
		},
	};
}

/**
 * 一次性折叠：导入与启动恢复时用。
 * 常态运行请用 createStateTracker 增量维护——每次查询重放全量事件是 O(n)，
 * 实测 20 万条事件时单次查询要 1.4 秒。
 */
export function deriveState(events: readonly JournalEvent[], window: number = DEFAULT_WINDOW): KernelState {
	const tracker = createStateTracker(window);
	for (const event of events) tracker.apply(event);
	return tracker.state;
}
