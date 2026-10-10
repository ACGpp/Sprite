/** Agent-readable diagnostics contain only fixed text, never provider error payloads. */
const descriptions = {
	prompt_rejected: "思考引擎明确拒绝了本轮输入。",
	prompt_timeout: "等待思考引擎确认输入超时；不能据此认定模型未执行。",
	run_timeout: "本轮运行超过时限，已停止旧引擎。",
	pi_exited: "思考引擎在运行完成前退出。",
	memory_context_failed: "记忆上下文保护停止了引擎；必要背景无法安全装入。",
	run_cancelled: "本轮运行已取消。",
	model_failed: "模型未正常完成本轮运行。",
	outcome_unknown: "无法确认本轮是否完成，不会自动重放可能已执行的动作。",
	run_failed: "本轮运行失败，具体原因请查看内核诊断。",
} as const;

export type FailureCode = keyof typeof descriptions;

export function failureDiagnostic(data: Record<string, unknown>): { failureCode: FailureCode; reason: string } {
	let code: FailureCode;
	if (typeof data.failureCode === "string" && Object.hasOwn(descriptions, data.failureCode)) {
		code = data.failureCode as FailureCode;
	} else {
		// Old journals have no code. Only classify known prefixes; do not copy any
		// part of the original error (including bare secrets, JSON or request URLs).
		const reason = typeof data.reason === "string" ? data.reason : "";
		code = reason.startsWith("pi 响应超时: prompt") ? "prompt_timeout"
			: reason.startsWith("呼吸超时（") ? "run_timeout"
			: /^(pi 已退出|思考引擎在运行完成前退出)/.test(reason) ? "pi_exited"
			: reason.startsWith("prompt 被拒绝") ? "prompt_rejected"
			: /^(模型 error:|模型 aborted:|模型重试失败:)/.test(reason) ? "model_failed"
			: data.outcomeUnknown === true ? "outcome_unknown" : "run_failed";
	}
	return { failureCode: code, reason: descriptions[code] };
}
