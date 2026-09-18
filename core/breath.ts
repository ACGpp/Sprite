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
import { deriveState } from "./state.ts";
import { truncate } from "./text.ts";

export type BreathTrigger = "timer" | "message" | "wake" | "recovered-queue" | "manual";

export type BreathOutcome = {
	runId: string | null;
	ok: boolean;
	busy?: boolean;
	reason?: string;
	durationMs: number;
	activities: number;
	thought: string | null;
};

export type BreathDeps = {
	journal: Journal;
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
	run(trigger: BreathTrigger): Promise<BreathOutcome>;
};

export type ObservationInput = {
	pending: string[];
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
${heldBackBlock}${viewBlock}${factsBlock}${context.length > 0 ? `\n${context.join("\n")}` : ""}
${quietNote}
你想做什么？`;
}

export function createBreathRunner(deps: BreathDeps): BreathRunner {
	const { journal, pi, isQuiet, observationExtras, timeoutMs = 120_000, now = () => new Date(), log = () => {} } = deps;

	let running = false;
	let active: {
		runId: string;
		activities: number;
		thought: string | null;
		settle: (outcome: "agent_end" | "timeout") => void;
	} | null = null;

	pi.onEvent((event: PiEvent) => {
		if (!active) return;
		// 关停途中仍可能有在途事件到达（此时 journal 已关闭）：绝不能让它把进程带崩。
		const record = (type: Parameters<typeof journal.append>[0], data: Record<string, unknown>) => {
			try {
				return journal.append(type, data);
			} catch (error) {
				log(`[breath] 丢弃在途事件（${type}）: ${error instanceof Error ? error.message : String(error)}`);
				return null;
			}
		};
		switch (event.type) {
			case "tool_execution_start": {
				active.activities += 1;
				record("run.activity", {
					kind: "tool",
					tool: String(event.toolName ?? "unknown"),
					summary: truncate(JSON.stringify(event.args ?? {}), 200),
					runId: active.runId,
				});
				return;
			}
			case "message_end": {
				const message = event.message as { role?: string; content?: unknown } | undefined;
				if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
				const text = message.content
					.filter((block): block is { type: string; text: string } => {
						const candidate = block as { type?: string; text?: string };
						return candidate.type === "text" && typeof candidate.text === "string";
					})
					.map((block) => block.text)
					.join("")
					.trim();
				if (text) {
					active.thought = text;
					record("thought.recorded", { text, runId: active.runId });
				}
				return;
			}
			case "agent_end":
				active.settle("agent_end");
				return;
			default:
				return;
		}
	});

	return {
		get running() {
			return running;
		},

		async run(trigger) {
			if (running) {
				log(`[breath] 已有呼吸在跑，${trigger} 触发被拒绝`);
				return { runId: null, ok: false, busy: true, durationMs: 0, activities: 0, thought: null };
			}
			running = true;
			const startedAt = Date.now();
			const runId = `run-${journal.seq + 1}`;
			const quiet = isQuiet();

			// 顺序至关重要：观察必须在写 run.started **之前**取。
			// pendingMessages 的判据是"seq > 上一次 run.started"，若先写 run.started，
			// 这一拍刚到达的留言会被算成"上一拍已读"，观察就空了——留言被静默吞掉。
			//
			// try 必须**从取观察之前**就开始：老写法里 running=true 在 try 之外，
			// 只要取观察这一段抛一次错（例如 observationExtras 里的扫描），
			// running 会永远为真——它再也不呼吸，而且没有任何自愈。
			let state: ReturnType<typeof deriveState> | null = null;
			try {
				state = deriveState(journal.events);
				const extras = observationExtras?.() ?? {};
				const observation = buildObservation({
					pending: state.pendingMessages.map((message) => message.text),
					quiet,
					at: now(),
					...extras,
				});

				// 把"这一拍它被告知了什么"写进日志：提示词不是黑箱，事后能查
				journal.append("run.started", {
					trigger,
					runId,
					quiet,
					nudge: extras.nudge ?? null,
					// 安静时段收着几句：审计里要能看出这一拍被告知了什么
					heldBack: extras.heldBack?.length ?? 0,
					silenceHours: extras.silenceHours ?? null,
					proactiveToday: extras.proactiveToday ?? null,
				});
				journal.append("presence.changed", { state: "thinking", runId });

				// settle 必须在对象创建时就存在：靠"Promise 执行器恰好同步执行"来补字段
				// 是类型不安全的（类型检查器早就指出来了）。
				let settle!: (outcome: "agent_end" | "timeout") => void;
				const settled = new Promise<"agent_end" | "timeout">((resolve) => {
					settle = resolve;
				});
				const current = { runId, activities: 0, thought: null as string | null, settle };
				active = current;
				const timer = setTimeout(() => settle("timeout"), timeoutMs);

				// 送达与否要如实记录：被拒的 prompt 意味着**它根本没看到这句话**
				let delivered = false;
				try {
					const response = await pi.send({ id: runId, type: "prompt", message: observation });
					if (response.success === false) throw new Error(`prompt 被拒绝: ${JSON.stringify(response).slice(0, 200)}`);
					delivered = true;

					const how = await settled;
					if (how === "timeout") throw new Error(`呼吸超时（${timeoutMs}ms）`);

					journal.append("run.finished", { runId, durationMs: Date.now() - startedAt, activities: current.activities });
					return {
						runId,
						ok: true,
						durationMs: Date.now() - startedAt,
						activities: current.activities,
						thought: current.thought,
					};
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					// delivered=false 时读模型会把这一拍"看到的"留言退回待处理——
					// 否则用户的话被静默吞掉：它没看到，而队列已经清了。
					journal.append("run.failed", { runId, reason, durationMs: Date.now() - startedAt, delivered });
					log(`[breath] 失败: ${reason}`);
					return { runId, ok: false, reason, durationMs: Date.now() - startedAt, activities: current.activities, thought: current.thought };
				} finally {
					clearTimeout(timer);
					active = null;
				}
			} catch (error) {
				// 取观察/写 run.started 这一段抛错：如实记一条，然后**一定要让 running 归位**
				const reason = error instanceof Error ? error.message : String(error);
				log(`[breath] 呼吸准备阶段失败: ${reason}`);
				try {
					journal.append("system.problem", { code: "breath.prepare", userMessage: `这一拍没能开始：${reason}` });
				} catch {
					// 日志也写不进去就只能放弃记录，但 running 必须复位
				}
				return { runId, ok: false, reason, durationMs: Date.now() - startedAt, activities: 0, thought: null };
			} finally {
				running = false;
			}
		},
	};
}
