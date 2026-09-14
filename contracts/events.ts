/**
 * Sprite 契约层：事件、命令、RPC 的类型与运行时校验。
 *
 * 这里没有依赖（不引 zod/typebox）：内核要轻，校验逻辑要能被 Swift 侧照抄。
 * 事件是唯一的状态来源；任何 UI 状态都必须能由事件序列重放得出。
 */

export const PROTOCOL_VERSION = 1;

/** 所有时间戳均为 UTC ISO8601 字符串；展示层负责转 Asia/Shanghai。 */
export type IsoTime = string;

/**
 * 它的状态。**每一个都必须由内核事件发出来**——"契约里声明了但从不发出"
 * 等于给了界面一个永远为空的格子（评审指出 `speaking` 就是这样）。
 * "正在念给你听"是外壳自己的本地事实，不是它的状态，所以不在这里。
 */
export type PresenceState = "asleep" | "breathing" | "thinking" | "quiet" | "degraded" | "paused";

export type EventType =
	| "presence.changed"
	| "message.in"
	| "message.out"
	| "thought.recorded"
	| "run.started"
	| "run.activity"
	| "run.finished"
	| "run.failed"
	| "breath.scheduled"
	| "breath.paused"
	| "breath.resumed"
	| "wake.deferred"
	| "tool.decided"
	| "question.asked"
	| "voice.recorded"
	| "voice.transcribed"
	| "settings.changed"
	| "command.applied"
	| "legacy.imported"
	| "system.problem";

export type JournalEvent = {
	seq: number;
	at: IsoTime;
	type: EventType;
	data: Record<string, unknown>;
	causeId?: string;
};

const EVENT_TYPES = new Set<string>([
	"presence.changed",
	"message.in",
	"message.out",
	"thought.recorded",
	"run.started",
	"run.activity",
	"run.finished",
	"run.failed",
	"breath.scheduled",
	"breath.paused",
	"breath.resumed",
	"wake.deferred",
	"tool.decided",
	"question.asked",
	"voice.recorded",
	"voice.transcribed",
	"settings.changed",
	"command.applied",
	"legacy.imported",
	"system.problem",
]);

export function isEventType(value: unknown): value is EventType {
	return typeof value === "string" && EVENT_TYPES.has(value);
}

/** 运行时校验一条从磁盘读到的事件。非法记录返回 null（调用方决定丢弃还是隔离）。 */
export function parseJournalEvent(raw: unknown): JournalEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const candidate = raw as Record<string, unknown>;
	if (typeof candidate.seq !== "number" || !Number.isInteger(candidate.seq) || candidate.seq <= 0) return null;
	if (typeof candidate.at !== "string") return null;
	if (!isEventType(candidate.type)) return null;
	if (typeof candidate.data !== "object" || candidate.data === null || Array.isArray(candidate.data)) return null;
	const event: JournalEvent = {
		seq: candidate.seq,
		at: candidate.at,
		type: candidate.type,
		data: candidate.data as Record<string, unknown>,
	};
	if (typeof candidate.causeId === "string") event.causeId = candidate.causeId;
	return event;
}

// ─── 命令 ───

export type SendMessageCommand = {
	id: string;
	type: "message.send";
	text: string;
	source?: "text" | "voice";
};

export type WakeNowCommand = { id: string; type: "wake.now" };

/** 暂停：让它安静一段时间。`manual` 表示直到用户手动继续。 */
export type PauseCommand = { id: string; type: "breath.pause"; until: "hour" | "tonight" | "manual" };

export type ResumeCommand = { id: string; type: "breath.resume" };

/**
 * 一条语音留言：音频文件 + 转写文字。
 *
 * 两者**一起**入库：音频是原话，转写是机器的理解——用户要能回去听原话对不对。
 * `audioBase64` 可以缺省（录音太大或没录上），但那样就只有文字。
 */
export type VoiceCommitCommand = {
	id: string;
	type: "voice.commit";
	transcript: string;
	audioBase64?: string;
	/** audio/mp4（m4a）或 audio/x-caf */
	mimeType?: string;
	durationMs?: number;
};

/**
 * 给一段已存的语音补上/更正转写文字。
 *
 * 为什么需要它：设备端识别会**静默返回空**（同一个音频换系统通道就能识别出来），
 * 于是录音存下来了、文字却是空的。原话不能因为识别器失灵就永远没有文字。
 * 只允许改**已经存在于日志里**的语音文件——不能凭这个命令往记忆里塞任意文件。
 */
export type VoiceTranscriptCommand = {
	id: string;
	type: "voice.transcript";
	file: string;
	transcript: string;
};

/** 改设置（界面填表 → 内核校验并落盘；模型改动会让内核换一次思考引擎） */
export type SettingsUpdateCommand = {
	id: string;
	type: "settings.update";
	patch: Record<string, unknown>;
	/** 谁改的：ui（界面按钮）/ script / test——审计要能区分 */
	source?: string;
};

export type Command =
	| SendMessageCommand
	| WakeNowCommand
	| PauseCommand
	| ResumeCommand
	| VoiceCommitCommand
	| VoiceTranscriptCommand
	| SettingsUpdateCommand;

export function parseCommand(raw: unknown): Command | { error: string } {
	if (typeof raw !== "object" || raw === null) return { error: "命令必须是对象" };
	const candidate = raw as Record<string, unknown>;
	if (typeof candidate.id !== "string" || !candidate.id) return { error: "缺少幂等键 id" };
	switch (candidate.type) {
		case "message.send": {
			if (typeof candidate.text !== "string" || !candidate.text.trim()) return { error: "留言内容为空" };
			const source = candidate.source === "voice" ? "voice" : "text";
			return { id: candidate.id, type: "message.send", text: candidate.text.trim(), source };
		}
		case "wake.now":
			return { id: candidate.id, type: "wake.now" };
		case "voice.commit": {
			const transcript = typeof candidate.transcript === "string" ? candidate.transcript.trim() : "";
			const hasAudio = typeof candidate.audioBase64 === "string" && candidate.audioBase64.length > 0;
			if (!transcript && !hasAudio) return { error: "语音留言为空" };
			const mimeType = candidate.mimeType === "audio/x-caf" ? "audio/x-caf" : "audio/mp4";
			const durationMs =
				typeof candidate.durationMs === "number" && Number.isFinite(candidate.durationMs) && candidate.durationMs >= 0
					? Math.round(candidate.durationMs)
					: undefined;
			const command: VoiceCommitCommand = { id: candidate.id, type: "voice.commit", transcript };
			if (hasAudio) command.audioBase64 = candidate.audioBase64 as string;
			command.mimeType = mimeType;
			if (durationMs !== undefined) command.durationMs = durationMs;
			return command;
		}
		case "settings.update": {
			if (typeof candidate.patch !== "object" || candidate.patch === null) return { error: "设置补丁必须是对象" };
			const source = typeof candidate.source === "string" && candidate.source ? candidate.source.slice(0, 32) : "unknown";
			return { id: candidate.id, type: "settings.update", patch: candidate.patch as Record<string, unknown>, source };
		}
		case "voice.transcript": {
			const file = typeof candidate.file === "string" ? candidate.file : "";
			const transcript = typeof candidate.transcript === "string" ? candidate.transcript.trim() : "";
			if (!file.startsWith("voice/")) return { error: "只能补写 voice/ 下的语音" };
			if (!transcript) return { error: "补写的转写文字为空" };
			return { id: candidate.id, type: "voice.transcript", file, transcript };
		}
		case "breath.pause": {
			const until = candidate.until === "hour" || candidate.until === "tonight" ? candidate.until : "manual";
			return { id: candidate.id, type: "breath.pause", until };
		}
		case "breath.resume":
			return { id: candidate.id, type: "breath.resume" };
		default:
			return { error: `未知命令: ${String(candidate.type)}` };
	}
}

// ─── RPC 信封 ───

export type RpcRequest = {
	protocolVersion?: number;
	id: string;
	type:
		| "query.status"
		| "query.snapshot"
		| "query.diagnostics"
		| "query.records"
		| "query.document"
		| "query.audio"
		| "query.settings"
		| "command"
		| "events.subscribe";
	fromSeq?: number;
	command?: unknown;
};

export type RpcResponse =
	| { id: string; ok: true; result: unknown }
	| { id: string; ok: false; error: string };
