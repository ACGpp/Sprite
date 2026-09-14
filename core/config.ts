/**
 * 模型配置：读 `config/llm.conf`，转成给 pi 的参数。
 *
 * 与 v1 的 `lib/llm.sh` 语义一致（bash 的 KEY=value 格式），但有一条硬规则：
 * **密钥只在这里出现一次，直接进子进程参数——不进日志、不进读模型、不进界面。**
 * 有专门的测试断言这一点（写入 sk-should-never-appear 后，快照与诊断里都不得出现）。
 */

import fs from "node:fs";
import path from "node:path";

export type LlmConfig = {
	tool: string;
	provider?: string;
	model?: string;
	/** 只在构造 pi 参数时使用；不要打印、不要序列化。 */
	apiKey?: string;
	quietStart?: number;
	quietEnd?: number;
};

const VALUED_KEYS = new Set(["PI_PROVIDER", "PI_MODEL", "PI_API_KEY", "LLM_TOOL", "QUIET_START", "QUIET_END"]);

export function readLlmConfig(homeDir: string): LlmConfig {
	const configPath = path.join(homeDir, "config", "llm.conf");
	const config: LlmConfig = { tool: "pi" };
	let raw = "";
	try {
		raw = fs.readFileSync(configPath, "utf8");
	} catch {
		return config;
	}
	for (const line of raw.split("\n")) {
		const match = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim());
		if (!match || !VALUED_KEYS.has(match[1])) continue;
		const value = match[2].trim().replace(/^["']|["']$/g, "");
		if (!value) continue;
		switch (match[1]) {
			case "LLM_TOOL":
				config.tool = value;
				break;
			case "PI_PROVIDER":
				config.provider = value;
				break;
			case "PI_MODEL":
				config.model = value;
				break;
			case "PI_API_KEY":
				config.apiKey = value;
				break;
			case "QUIET_START":
				config.quietStart = Number(value);
				break;
			case "QUIET_END":
				config.quietEnd = Number(value);
				break;
		}
	}
	return config;
}

/** 把配置转成 pi 的命令行参数。**调用方不得把返回值写进日志。** */
export function piModelArgs(config: LlmConfig): string[] {
	const args: string[] = [];
	if (config.provider) args.push("--provider", config.provider);
	if (config.model) args.push("--model", config.model);
	if (config.apiKey) args.push("--api-key", config.apiKey);
	return args;
}

/** 可以安全打印的版本（用于诊断：只说明"配置了什么"，不暴露值）。 */
export function describeLlmConfig(config: LlmConfig): string {
	return [
		`tool=${config.tool}`,
		`provider=${config.provider ? "已配置" : "未配置"}`,
		`model=${config.model ? "已配置" : "未配置"}`,
		`apiKey=${config.apiKey ? "已配置" : "未配置"}`,
	].join(" ");
}
