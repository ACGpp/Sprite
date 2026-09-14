/**
 * 思考引擎（pi）在不在本机。
 *
 * 有些测试必须真的起 pi（能力网关、会话连续、端到端、全新安装、模型清单回退）——
 * 它们验的是"pi 加载我们的扩展之后"的行为，假引擎替代不了。
 * 本机没装 pi 时**如实跳过**（skip 并说明原因），不算通过——这是这个项目的规矩
 * （和语音链路在无声环境里的处理一样）。
 */
import { spawnSync } from "node:child_process";

export function piBin(): string {
	return process.env.PI_BIN ?? "pi";
}

/** 装了 pi 返回 null（可以跑）；没装返回跳过的理由。 */
export function skipWithoutPi(): string | false {
	try {
		const probe = spawnSync(piBin(), ["--version"], { encoding: "utf8", timeout: 15_000 });
		if (probe.status === 0) return false;
		return `本机没有可用的 pi（${piBin()} --version 退出码 ${probe.status ?? "null"}）：这条测试不算通过`;
	} catch (error) {
		return `本机没有可用的 pi（${piBin()}）：${error instanceof Error ? error.message : String(error)}`;
	}
}
