/**
 * 一次呼吸。
 *
 * 呼吸 = 一次观察 + 一次 agent turn + 事件落库。这里把 spike 里验证过的语义
 * （§13.4）写成产品代码：
 *   - 观察在开跑前构建 → 之后到达的留言属于下一拍（state.ts 的 pending 语义）
 *   - 工具调用实时落 run.activity —— 这是"它在做什么"的唯一真实来源
 *   - 失败如实记 run.failed，不假装成功、不吞异常
 *   - 单次呼吸不并发：正在跑时新的触发被拒绝，由调用方排队
 */

import type { PiAgent, PiEvent } from "./agent/pi-rpc.ts";
import { shanghaiClock } from "./projections.ts";
import type { Journal } from "./journal.ts";
import { deriveState, type KernelState } from "./state.ts";
import { truncate } from "./text.ts";
import { failureDiagnostic, type FailureCode } from "./failure-diagnostics.ts";

export type BreathTrigger = "timer" | "message" | "wake" | "recovered-queue" | "manual";

export type BreathOutcome = {
	runId: string | null;
	ok: boolean;
	busy?: boolean;
	restartRequired?: boolean;
	reason?: string;
	durationMs: number;
	activities: number;
	thought: string | null;
};

export type BreathDeps = {
	journal: Journal;
	getState?: () => KernelState;
	cancelTimeoutMs?: number;
	sanitizeError?: (text: string) => string;
	pi: PiAgent;
	isQuiet: () => boolean;
	/** 内核补的"时间感与由头"（它自己不知道过了多久、今天说过几句） */
	observationExtras?: () => Partial<ObservationInput>;
	timeoutMs?: number;
	now?: () => Date;
	log?: (message: string) => void;
};

export type BreathRunner = {
	readonly running: boolean;
	readonly retired: boolean;
	cancel(reason?: string): Promise<void>;
	run(trigger: BreathTrigger): Promise<BreathOutcome>;
};

export type ObservationInput = {
	pending: string[];
	bootstrap?: string;
	quiet: boolean;
	at: Date;
	/** 距离它上一次开口过了多久（小时）——它自己不知道时间，就得由内核告诉它 */
	silenceHours?: number;
	/** 今天已经主动说过几次、上限几次（内核层面限流，不是靠它自觉） */
	proactiveToday?: number;
	proactivePerDay?: number;
	/** 这一拍有没有由头（安静时段刚结束、很久没说话、上一次写了东西……） */
	nudge?: string;
	/**
	 * 安静时段里它想说、被内核收着的那些话。
	 *
	 * 工具的说明里写着"安静时段内核会替你收着，明早再说"——如果早上不把这些话
	 * 摆回它面前，那句承诺就是空的（评审 M7：Swift 侧连 digest 这个词都没出现过）。
	 */
	heldBack?: string[];
	/**
	 * 事实（不是命令）。
	 *
	 * 产品决定（2026-09-14，用户选 A）：**只补事实，不给指令**——
	 * 它醒来时应该知道"自己有什么、记忆里有什么、上次和今天做过什么"，
	 * 但"要不要做事"仍然是它自己的选择，内核不推。
	 *
	 * 为什么必须补：真实事故里它在醒来时收到的全部内容是"醒来。你想做什么？"，
	 * 于是小模型三天里只会回一句"继续休息"，一次文件都没写过。
	 */
	/**
	 * 它的工作记忆（`context/working-memory.md` 的当前内容）。
	 * 压缩的口径（2026-09-18 重新定过）：真相层（`journal/`）与它自己写的东西
	 * （`diary/` 等）不允许被替换；能"驱逐"的只有**工作视野**——
	 * 也就是这里放的东西。原文永远还在，用文件路径就能读回去。
	 */
	workingMemory?: { path: string; text: string; truncated: boolean };
	/**
	 * 它的操作件（`context/constraints.md`）：有操作力的话——校准、闹钟、禁令、边界。
	 *
	 * 单独一层、**不参与任何总结**：摘要保留的是话题，弄丢的是约束
	 * （"提到过"不等于"还算数"）。约定每条写清四件事：
	 * 前提 / 谁授权 / 兜底 / 不遵守会怎样。
	 */
	constraints?: { path: string; text: string; truncated: boolean };
	facts?: {
		/** 它的能力与边界（由内核按当前设置生成，不夸大） */
		capabilities?: string;
		/** 它的记忆现状（日记几篇、最后一篇多久以前……） */
		memory?: string;
		/** 上次醒来做了什么（事实，不含评价） */
		lastRun?: string;
		/** 今天（上海日）的活动计数 */
		today?: string;
	};
};

export function buildObservation(observationInput: ObservationInput): string {
	const clock = shanghaiClock(observationInput.at);
	const recent = observationInput.pending.length > 0 ? observationInput.pending.join("\n") : "（没有新留言）";
	const context: string[] = [];
	if (typeof observationInput.silenceHours === "number" && observationInput.pending.length === 0) {
		context.push(`你上一次跟用户说话是 ${observationInput.silenceHours.toFixed(1)} 小时前。`);
	}
	if (typeof observationInput.proactiveToday === "number" && typeof observationInput.proactivePerDay === "number") {
		context.push(`今天你已经主动开口 ${observationInput.proactiveToday} 次（上限 ${observationInput.proactivePerDay} 次）。`);
	}
	if (observationInput.nudge) context.push(observationInput.nudge);
	const heldBack = observationInput.heldBack ?? [];
	const heldBackBlock =
		heldBack.length > 0 && !observationInput.quiet
			? `\n安静时段里你收着这几句（现在可以决定要不要说给他）：\n${heldBack.map((text) => `- ${text}`).join("\n")}\n`
			: "";
	// 工作视野：工作记忆 + 操作件。都在文件里（可回读），这里只放当前需要看见的部分。
	const working = observationInput.workingMemory;
	const constraints = observationInput.constraints;
	const viewBlock = [
		working
			? `\n你的工作记忆（${working.path}）：\n${working.text.trim() || "（空）"}${working.truncated ? `\n（太长，只放了开头；完整内容自己读 ${working.path}）` : ""}\n`
			: "",
		constraints
			? `\n你的操作件（${constraints.path}）——有操作力的话写在这里（约定：前提 / 谁授权 / 兜底 / 不遵守会怎样）。这一层不参与任何总结，不会因为压缩而消失：\n${constraints.text.trim() || "（空——还没有写下来的操作件）"}${constraints.truncated ? `\n（太长，只放了开头；完整内容自己读 ${constraints.path}）` : ""}\n`
			: "",
	].join("");
	const facts = observationInput.facts ?? {};
	const factLines = [facts.capabilities, facts.memory, facts.lastRun, facts.today].filter(
		(line): line is string => typeof line === "string" && line.trim().length > 0,
	);
	const factsBlock = factLines.length > 0 ? `\n${factLines.join("\n")}\n` : "";
	// 安静时段**只**影响说话：读写想都不受限制。这句话必须由内核说清楚——
	// 否则模型会把"安静"理解成"什么都别做"（真实事故里它的原话就是"安静时段……继续休息"）。
	const quietNote = observationInput.quiet
		? "\n（安静时段只影响说话：你说的会被内核收着、早上交回你面前；读、写、想都不受限制。）"
		: "";
	return `[${clock}] 醒来。${observationInput.quiet ? "（安静时段）" : ""}

最近用户留言（空表示没有新留言，今天的对话上下文 session 里已有，无需重读）：
${recent}
${heldBackBlock}${observationInput.bootstrap ? `\n${observationInput.bootstrap}\n` : ""}${viewBlock}${factsBlock}${context.length > 0 ? `\n${context.join("\n")}` : ""}
${quietNote}
你想做什么？`;
}

export function createBreathRunner(deps: BreathDeps): BreathRunner {
	const { journal, pi, isQuiet, observationExtras, timeoutMs = 120_000, cancelTimeoutMs = 2_000,
		now = () => new Date(), log = () => {}, sanitizeError = (text: string) => text } = deps;
	type Terminal = "agent_end" | "timeout" | "cancelled" | "exited";
	type Active = {
		runId: string; activities: number; thought: string | null; error: string | null;
		substantiveActivities: number;
		tools: Map<string, { tool: string; path?: string }>;
		retrying: boolean; ended: boolean; cancelled: string | null;
		exitCode?: number | null;
		settle: (terminal: Terminal) => void; endedPromise: Promise<void>; end: () => void;
	};
	let running = false;
	let retired = false;
	let active: Active | null = null;
	let finished: Promise<void> = Promise.resolve();
	let finish: () => void = () => {};

	const record = (type: Parameters<typeof journal.append>[0], data: Record<string, unknown>) => {
		try { return journal.append(type, data); }
		catch (error) { log(`[breath] 丢弃在途事件（${type}）: ${sanitizeError(String(error))}`); return null; }
	};
	function assistantResult(message: unknown, current: Active) {
		const value = message as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string } | undefined;
		if (value?.role !== "assistant") return;
		current.error = value.stopReason === "error" || value.stopReason === "aborted"
			? sanitizeError(`模型 ${value.stopReason}: ${value.errorMessage ?? "没有完成本轮"}`) : null;
		if (!Array.isArray(value.content)) return;
		const text = value.content.filter((block): block is { type: string; text: string } =>
			block?.type === "text" && typeof block.text === "string").map(block => block.text).join("").trim();
		if (text && current.thought !== text) {
			current.thought = text;
			record("thought.recorded", { text, runId: current.runId });
		}
	}
	pi.onEvent(event => {
		const current = active;
		if (!current) return;
		if (event.type === "_process_exit") {
			current.exitCode = typeof event.code === "number" ? event.code : null;
			current.end(); current.settle("exited"); return;
		}
		if (event.type === "agent_end") {
			current.ended = true;
			current.end();
			if (Array.isArray(event.messages)) {
				const last = [...event.messages].reverse().find(message => message?.role === "assistant");
				if (last) assistantResult(last, current);
			}
			// pi emits agent_end before auto_retry_start. An RPC round trip is a
			// stream barrier, so retries emitted in the same processing pass are
			// observed before treating this event as terminal (no timing heuristic).
			void (pi.flushEvents?.() ?? Promise.resolve()).then(() => {
				if (active === current && !current.retrying) current.settle("agent_end");
			}, () => { if (active === current) current.settle("exited"); });
			return;
		}
		if (current.cancelled) return;
		switch (event.type) {
			case "auto_retry_start": current.retrying = true; current.ended = false; return;
			case "auto_retry_end":
				current.retrying = false;
				if (event.success === false) {
					current.error = sanitizeError(`模型重试失败: ${String(event.finalError ?? "unknown")}`);
					current.settle("agent_end");
				}
				return;
			case "tool_execution_start":
				current.activities += 1;
				if (event.toolName !== "set_next_breath") current.substantiveActivities += 1;
				if (typeof event.toolCallId === "string") {
					const args = event.args as { path?: unknown } | undefined;
					current.tools.set(event.toolCallId, { tool: String(event.toolName ?? "unknown"),
						...(typeof args?.path === "string" ? { path: args.path } : {}) });
				}
				record("run.activity", { kind: "tool", tool: String(event.toolName ?? "unknown"),
					summary: truncate(JSON.stringify(event.args ?? {}), 200), runId: current.runId,
					...(typeof event.toolCallId === "string" ? { toolCallId: event.toolCallId } : {}) });
				return;
			case "tool_execution_end": {
				const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
				const tool = current.tools.get(id);
				if (!tool) return; // Ignore duplicates and results from another run.
				current.tools.delete(id);
				const result = event.result as { details?: { ok?: unknown; verified?: unknown } } | undefined;
				const success = event.isError === false && result?.details?.ok !== false;
				// Persist outcome metadata, never raw tool output (which may contain secrets).
				record("tool.finished", { ...tool, toolCallId: id, runId: current.runId, success,
					verified: success && result?.details?.verified === true });
				return;
			}
			case "message_end": assistantResult(event.message, current); return;
		}
	});

	async function stopCurrent(current: Active) {
		retired = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, cancelTimeoutMs); });
			const abort = pi.send({ id: `${current.runId}-abort`, type: "abort" }, cancelTimeoutMs).then(() => current.endedPromise, () => {});
			await Promise.race([abort, deadline]);
		} finally { if (timer) clearTimeout(timer); }
		// A new process is required even after a cooperative abort: pi's events
		// have no runId, so an old event cannot safely be assigned to a new turn.
		await pi.terminate?.();
	}
	return {
		get running() { return running; },
		get retired() { return retired; },
		async cancel(reason = "运行已取消") {
			retired = true;
			if (active) { active.cancelled = reason; active.settle("cancelled"); await finished; }
			else await pi.terminate?.();
		},
		async run(trigger) {
			if (running || retired) return { runId: null, ok: false, busy: running, restartRequired: retired,
				reason: retired ? "引擎已停止，需要重建" : "已有呼吸在跑", durationMs: 0, activities: 0, thought: null };
			running = true;
			finished = new Promise(resolve => { finish = resolve; });
			const startedAt = Date.now();
			const runId = `run-${journal.seq + 1}`;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let started = false;
			let delivered = false;
			let outcomeUnknown = false;
			let failureCode: FailureCode | undefined;
			try {
				const state = deps.getState?.() ?? deriveState(journal.events);
				const pending = [...state.pendingMessages];
				const quiet = isQuiet();
				const extras = observationExtras?.() ?? {};
				const observation = buildObservation({ ...extras, pending: pending.map(message => message.text), quiet, at: now() });
				journal.append("run.started", { trigger, runId, quiet, claimedMessageSeqs: pending.map(message => message.seq),
					nudge: extras.nudge ?? null, heldBack: extras.heldBack?.length ?? 0,
					silenceHours: extras.silenceHours ?? null, proactiveToday: extras.proactiveToday ?? null });
				started = true;
				journal.append("presence.changed", { state: "thinking", runId });
				let resolveTerminal!: (terminal: Terminal) => void;
				let interrupt!: (terminal: Terminal) => void;
				const settled = new Promise<Terminal>(resolve => { resolveTerminal = resolve; });
				const interrupted = new Promise<Terminal>(resolve => { interrupt = resolve; });
				const settle = (terminal: Terminal) => {
					resolveTerminal(terminal);
					if (terminal !== "agent_end") interrupt(terminal);
				};
				let end!: () => void;
				const endedPromise = new Promise<void>(resolve => { end = resolve; });
				const current: Active = { runId, activities: 0, thought: null, error: null,
					substantiveActivities: 0, tools: new Map(),
					retrying: false, ended: false, cancelled: null, settle, endedPromise, end };
				active = current;
				timer = setTimeout(() => settle("timeout"), timeoutMs);
				// Race prompt acknowledgement too: a hung RPC must not outlive the run deadline.
				outcomeUnknown = true;
				const acknowledgement = pi.send({ id: runId, type: "prompt", message: observation }).then(response => ({ response }));
				const accepted = await Promise.race([acknowledgement, interrupted.then(terminal => ({ terminal }))]);
				let terminal: Terminal;
				if ("response" in accepted) {
					if (accepted.response.success === false) {
						outcomeUnknown = false;
						throw new Error(`prompt 被拒绝: ${sanitizeError(String(accepted.response.error ?? "unknown"))}`);
					}
					delivered = true;
					outcomeUnknown = false;
					terminal = await settled;
				} else {
					terminal = accepted.terminal;
					outcomeUnknown = true;
				}
				if (terminal === "timeout" || terminal === "cancelled") {
					failureCode = terminal === "cancelled" ? "run_cancelled" : "run_timeout";
					current.cancelled ??= terminal === "timeout" ? `呼吸超时（${timeoutMs}ms）` : "运行已取消";
					outcomeUnknown = true;
					await stopCurrent(current);
					throw new Error(current.cancelled);
				}
				if (terminal === "exited") { retired = true; outcomeUnknown = true; throw new Error("思考引擎在运行完成前退出"); }
				if (current.error) throw new Error(current.error);
				journal.append("run.finished", { runId, durationMs: Date.now() - startedAt, activities: current.activities,
					substantiveActivities: current.substantiveActivities });
				return { runId, ok: true, durationMs: Date.now() - startedAt, activities: current.activities, thought: current.thought };
			} catch (error) {
				const reason = sanitizeError(error instanceof Error ? error.message : String(error));
				// Capture the original exit before cancellation itself terminates pi.
				failureCode ??= active?.exitCode !== undefined
					? active.exitCode === 78 ? "memory_context_failed" : "pi_exited"
					: failureDiagnostic({ reason, outcomeUnknown }).failureCode;
				if (outcomeUnknown && active && !retired) {
					active.cancelled = reason;
					await stopCurrent(active);
				}
				if (started) {
					record("run.failed", { runId, reason, failureCode, durationMs: Date.now() - startedAt, delivered, outcomeUnknown });
				}
				else record("system.problem", { code: "breath.prepare", userMessage: `这一拍没能开始：${reason}` });
				log(`[breath] 失败: ${reason}`);
				return { runId, ok: false, reason, restartRequired: retired, durationMs: Date.now() - startedAt,
					activities: active?.activities ?? 0, thought: active?.thought ?? null };
			} finally {
				if (timer) clearTimeout(timer);
				active = null;
				running = false;
				finish();
			}
		},
	};
}
