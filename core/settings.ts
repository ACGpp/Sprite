/**
 * 设置：一份给人填、给界面改的配置。
 *
 * 为什么要有它：v1/v2 的模型配置要用户自己新建文件并手写字段，容易写错、也容易把
 * 密钥落到日志里。v3 把它收成一个由界面维护的 settings.json（0600）。
 * `PI_PROVIDER=... PI_API_KEY=...`——对不懂 AI、不懂命令行的人是道墙。
 * 现在设置住在 `config/settings.json`，**界面直接填**，内核负责校验与落盘。
 *
 * 两条硬规则：
 *   1. **密钥只进子进程环境变量，绝不回显**：`readSettingsForUi()` 返回的永远只有
 *      "配没配"（`hasApiKey`），不返回值；产物文件 0600。
 */

import fs from "node:fs";
import path from "node:path";

/** pi 支持的 API 格式（自定义端点用哪套协议说话） */
export const API_FORMATS = [
	{ id: "openai-completions", label: "OpenAI 兼容（Chat Completions，最常用）" },
	{ id: "openai-responses", label: "OpenAI Responses" },
	{ id: "anthropic-messages", label: "Anthropic Messages（Claude 兼容）" },
	{ id: "azure-openai-responses", label: "Azure OpenAI Responses" },
	{ id: "mistral-conversations", label: "Mistral Conversations" },
] as const;

/** pi 内置的供应商（选这些只需要填模型名和 Key） */
export const KNOWN_PROVIDERS = [
	{ id: "deepseek", label: "DeepSeek（深度求索）", hint: "国内可直连，便宜" },
	{ id: "zai", label: "Z.ai / 智谱 GLM", hint: "国内可直连" },
	{ id: "minimax-cn", label: "MiniMax（中国站）", hint: "国内可直连" },
	{ id: "kimi-coding", label: "Kimi For Coding（月之暗面）", hint: "国内可直连" },
	{ id: "openrouter", label: "OpenRouter（一个 Key 用很多模型）", hint: "需要外网" },
	{ id: "anthropic", label: "Anthropic Claude", hint: "需要外网" },
	{ id: "openai", label: "OpenAI", hint: "需要外网" },
	{ id: "google", label: "Google Gemini", hint: "需要外网" },
	{ id: "xai", label: "xAI Grok", hint: "需要外网" },
	{ id: "groq", label: "Groq", hint: "需要外网" },
	{ id: "mistral", label: "Mistral", hint: "需要外网" },
	{ id: "cerebras", label: "Cerebras", hint: "需要外网" },
	{ id: "fireworks", label: "Fireworks", hint: "需要外网" },
	{ id: "huggingface", label: "Hugging Face", hint: "需要外网" },
	{ id: "vercel-ai-gateway", label: "Vercel AI Gateway", hint: "需要外网" },
	{ id: "opencode", label: "OpenCode Zen", hint: "需要外网" },
	{ id: "minimax", label: "MiniMax（国际站）", hint: "需要外网" },
	{ id: "azure-openai-responses", label: "Azure OpenAI", hint: "企业账号" },
] as const;

/** pi 认的密钥环境变量名：列模型清单时要把它塞进去 */
export const PROVIDER_KEY_ENV: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	google: "GEMINI_API_KEY",
	mistral: "MISTRAL_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	zai: "ZAI_API_KEY",
	opencode: "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	huggingface: "HF_TOKEN",
	fireworks: "FIREWORKS_API_KEY",
	"kimi-coding": "KIMI_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
};

/**
 * 各家的 OpenAI 兼容 /models 地址（用来**实时**问服务商要模型清单）。
 *
 * 为什么不只靠 pi：pi 带的是**静态目录**（`models.generated.js`，随 pi 版本生成一次），
 * 实测它会过时——DeepSeek 官方接口给的是 `deepseek-flash`，pi 目录里却写着 `deepseek-v4-flash`。
 * 所以：能问官方就问官方，问不到再退回 pi 目录，并且**在界面上说清楚这份清单是从哪儿来的**。
 */
export const PROVIDER_MODELS_URL: Record<string, string> = {
	deepseek: "https://api.deepseek.com",
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
	groq: "https://api.groq.com/openai/v1",
	xai: "https://api.x.ai/v1",
	mistral: "https://api.mistral.ai/v1",
	cerebras: "https://api.cerebras.ai/v1",
	fireworks: "https://api.fireworks.ai/inference/v1",
	anthropic: "https://api.anthropic.com/v1",
};

/** 这几家的 /models 不认 Bearer，要用自家的头 */
export const PROVIDER_AUTH_STYLE: Record<string, "bearer" | "anthropic" | "x-api-key"> = {
	anthropic: "anthropic",
};

export type ModelSettings = {
	/** provider = pi 内置供应商；custom = 自己填地址（OpenAI 格式等） */
	mode: "provider" | "custom";
	provider?: string;
	apiFormat?: string;
	baseUrl?: string;
	model?: string;
	modelName?: string;
	contextWindow?: number;
	maxTokens?: number;
	/** 只在构造子进程参数/环境时使用。**不要打印、不要序列化给界面。** */
	apiKey?: string;
};

/**
 * agent 能用哪些"手脚"。
 *
 * `on`（默认）：bash + 读写文件都可用——这是设计决策 A 的选择（"它有手有脚"），
 *   但要老实说：**bash 不是权限边界**，同 UID 下它能读任何 0600 文件（评审 C3/C4）。
 * `readonly`：只读文件 + 搜索 + 它的能力工具，没有 bash、不能写。
 * `off`：只剩"说话"那几个能力工具（say / leave_message / set_next_breath / ask_user）。
 *
 * 这是给用户的**可选边界**：想要真边界还得靠独立 UID / 沙箱，但至少现在有一个开关。
 */
export type ShellAccess = "on" | "readonly" | "off";

export type SecuritySettings = {
	agentShell: ShellAccess;
};

export type ProactiveSettings = {
	/** 允许它主动开口吗 */
	enabled: boolean;
	/** 每天最多主动说几句 */
	perDay: number;
};

export type Settings = {
	model: ModelSettings;
	quietHours: { start: number; end: number };
	proactive: ProactiveSettings;
	security: SecuritySettings;
	/** 这些值是从哪儿读来的（如实告诉用户） */
	source: "settings.json" | "default";
};

export const DEFAULT_SETTINGS: Settings = {
	model: { mode: "provider" },
	quietHours: { start: 23, end: 7 },
	proactive: { enabled: true, perDay: 2 },
	security: { agentShell: "on" },
	source: "default",
};

/** 各档位允许 pi 使用哪些工具（能力工具始终保留——它得能说话、能提问） */
export const CAPABILITY_TOOLS = ["say", "leave_message", "set_next_breath", "ask_user"];
export const READONLY_TOOLS = [...CAPABILITY_TOOLS, "read", "grep", "find", "ls"];

export function allowedToolsFor(access: ShellAccess): string[] | null {
	if (access === "readonly") return READONLY_TOOLS;
	if (access === "off") return CAPABILITY_TOOLS;
	return null; // on = 不传 --tools，用 pi 的默认工具集
}

export function settingsPath(homeDir: string): string {
	return path.join(homeDir, "config", "settings.json");
}

function clampHour(value: unknown, fallback: number): number {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.max(0, Math.min(23, Math.round(number)));
}

/** 读设置：`config/settings.json`，坏了就用内置默认（并如实标明来源）。 */
export function readSettings(homeDir: string): Settings {
	let raw = "";
	try {
		raw = fs.readFileSync(settingsPath(homeDir), "utf8");
	} catch {
		raw = "";
	}
	if (raw.trim()) {
		try {
			const parsed = JSON.parse(raw) as Partial<Settings> & { model?: Partial<ModelSettings> };
			const model: Partial<ModelSettings> = parsed.model ?? {};
			return {
				model: {
					mode: model.mode === "custom" ? "custom" : "provider",
					provider: typeof model.provider === "string" && model.provider ? model.provider : undefined,
					apiFormat: typeof model.apiFormat === "string" && model.apiFormat ? model.apiFormat : undefined,
					baseUrl: typeof model.baseUrl === "string" && model.baseUrl ? model.baseUrl : undefined,
					model: typeof model.model === "string" && model.model ? model.model : undefined,
					modelName: typeof model.modelName === "string" && model.modelName ? model.modelName : undefined,
					contextWindow: Number.isFinite(model.contextWindow) ? Number(model.contextWindow) : undefined,
					maxTokens: Number.isFinite(model.maxTokens) ? Number(model.maxTokens) : undefined,
					apiKey: typeof model.apiKey === "string" && model.apiKey ? model.apiKey : undefined,
				},
				quietHours: {
					start: clampHour(parsed.quietHours?.start, DEFAULT_SETTINGS.quietHours.start),
					end: clampHour(parsed.quietHours?.end, DEFAULT_SETTINGS.quietHours.end),
				},
				proactive: {
					enabled: parsed.proactive?.enabled !== false,
					perDay: Math.max(0, Math.min(999, Math.round(Number(parsed.proactive?.perDay ?? DEFAULT_SETTINGS.proactive.perDay)))),
				},
				security: {
					agentShell: parsed.security?.agentShell === "readonly" || parsed.security?.agentShell === "off" ? parsed.security.agentShell : "on",
				},
				source: "settings.json",
			};
		} catch {
			// 坏文件不猜：退回旧配置，并在界面上如实说明"settings.json 读不了"
		}
	}

	return {
		...DEFAULT_SETTINGS,
		model: { ...DEFAULT_SETTINGS.model },
		quietHours: { ...DEFAULT_SETTINGS.quietHours },
		proactive: { ...DEFAULT_SETTINGS.proactive },
		security: { ...DEFAULT_SETTINGS.security },
	};
}

export type SettingsPatch = {
	model?: Partial<ModelSettings> & { mode?: "provider" | "custom"; clearApiKey?: boolean };
	quietHours?: { start?: number; end?: number };
	proactive?: Partial<ProactiveSettings>;
	security?: Partial<SecuritySettings>;
};

/** 校验一个补丁：要么返回人话的错误，要么返回干净的补丁。 */
export function validatePatch(patch: unknown): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
	if (typeof patch !== "object" || patch === null) return { ok: false, error: "设置必须是一个对象" };
	const candidate = patch as SettingsPatch;
	const clean: SettingsPatch = {};

	if (candidate.model) {
		const model = candidate.model;
		const mode = model.mode === "custom" ? "custom" : model.mode === "provider" ? "provider" : undefined;
		const apiKey = typeof model.apiKey === "string" && model.apiKey.trim() ? model.apiKey.trim() : undefined;
		if (mode === "custom") {
			const baseUrl = String(model.baseUrl ?? "").trim();
			if (!/^https?:\/\/\S+$/i.test(baseUrl)) return { ok: false, error: "自定义地址必须是 http(s):// 开头的完整地址" };
			const modelId = String(model.model ?? "").trim();
			if (!modelId) return { ok: false, error: "请填模型名（例如 gpt-4o-mini、deepseek-chat）" };
			const apiFormat = String(model.apiFormat ?? "openai-completions");
			if (!API_FORMATS.some((format) => format.id === apiFormat)) return { ok: false, error: `不认识的接口格式：${apiFormat}` };
			clean.model = {
				mode: "custom",
				baseUrl,
				model: modelId,
				apiFormat,
				modelName: String(model.modelName ?? "").trim() || modelId,
				contextWindow: Number.isFinite(model.contextWindow) ? Math.max(1000, Number(model.contextWindow)) : 128000,
				maxTokens: Number.isFinite(model.maxTokens) ? Math.max(256, Number(model.maxTokens)) : 8192,
			};
		} else if (mode === "provider") {
			const provider = String(model.provider ?? "").trim();
			if (!provider) return { ok: false, error: "请选择模型供应商" };
			const modelId = String(model.model ?? "").trim();
			if (!modelId) return { ok: false, error: "请填模型 ID（例如 deepseek-chat）" };
			clean.model = { mode: "provider", provider, model: modelId };
		} else {
			// 只改一部分（例如只换模型名）
			const partial: Partial<ModelSettings> = {};
			if (model.provider) partial.provider = String(model.provider).trim();
			if (model.model) partial.model = String(model.model).trim();
			if (model.apiFormat) partial.apiFormat = String(model.apiFormat).trim();
			if (model.baseUrl) partial.baseUrl = String(model.baseUrl).trim();
			clean.model = partial;
		}
		if (apiKey) clean.model.apiKey = apiKey;
		if (model.clearApiKey === true) clean.model.clearApiKey = true;
	}

	if (candidate.quietHours) {
		const start = clampHour(candidate.quietHours.start, DEFAULT_SETTINGS.quietHours.start);
		const end = clampHour(candidate.quietHours.end, DEFAULT_SETTINGS.quietHours.end);
		clean.quietHours = { start, end };
	}

	if (candidate.security) {
		const access = candidate.security.agentShell;
		if (access !== undefined && access !== "on" && access !== "readonly" && access !== "off") {
			return { ok: false, error: "手脚的档位只能是 on / readonly / off" };
		}
		clean.security = {};
		if (access) clean.security.agentShell = access;
	}

	if (candidate.proactive) {
		clean.proactive = {};
		if (typeof candidate.proactive.enabled === "boolean") clean.proactive.enabled = candidate.proactive.enabled;
		if (candidate.proactive.perDay !== undefined) {
			const perDay = Number(candidate.proactive.perDay);
			if (!Number.isFinite(perDay) || perDay < 0 || perDay > 999) return { ok: false, error: "每天主动说话的条数要在 0–999 之间（0 表示不主动说话）" };
			clean.proactive.perDay = Math.round(perDay);
		}
	}

	return { ok: true, patch: clean };
}

/** 原子写设置（0600：里面可能有密钥）。返回写好的完整设置。 */
export function patchSettings(homeDir: string, patch: SettingsPatch): Settings {
	const current = readSettings(homeDir);
	const next: Settings = {
		model: { ...current.model, ...(patch.model ?? {}) },
		quietHours: { ...current.quietHours, ...(patch.quietHours ?? {}) },
		proactive: { ...current.proactive, ...(patch.proactive ?? {}) },
		security: { ...current.security, ...(patch.security ?? {}) },
		source: "settings.json",
	};
	if (patch.model?.clearApiKey) delete next.model.apiKey;
	// provider 模式不该残留自定义字段；custom 模式不该残留 provider
	if (next.model.mode === "provider") {
		delete next.model.baseUrl;
		delete next.model.apiFormat;
		delete next.model.modelName;
	}
	const file = settingsPath(homeDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// 权限设置失败不致命：文件仍在用户目录下
	}
	return next;
}

/** 给 pi 的命令行参数。**调用方不得把返回值写进日志。** */
export function piArgsFor(settings: Settings): string[] {
	const args: string[] = [];
	if (settings.model.mode === "custom") {
		// 自定义端点注册成 pi 的一个 provider，名字固定
		args.push("--provider", CUSTOM_PROVIDER_ID, "--model", settings.model.model ?? "");
		return args;
	}
	if (settings.model.provider) args.push("--provider", settings.model.provider);
	if (settings.model.model) args.push("--model", settings.model.model);
	return args;
}

export const CUSTOM_PROVIDER_ID = "sprite-custom";
/** 自定义端点密钥走环境变量，避免密钥被写进任何文件 */
export const CUSTOM_KEY_ENV = "SPRITE_CUSTOM_API_KEY";

/**
 * 生成"自定义端点"的 pi 扩展源码。
 *
 * 这是"OpenAI 格式"这类第三方/中转/本地端点的落地方式：pi 本身只认它内置的供应商，
 * 自定义地址要通过 `registerProvider` 注册。界面填表 → 内核生成这个文件 → pi 加载它。
 */
export function customProviderSource(settings: Settings): string | null {
	if (settings.model.mode !== "custom") return null;
	const { baseUrl, apiFormat, model, modelName, contextWindow, maxTokens } = settings.model;
	const safe = (value: string) => JSON.stringify(value);
	return `// 由 Sprite 自动生成（界面上填的"自定义模型"）——不要手改，改设置即可。
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider(${safe(CUSTOM_PROVIDER_ID)}, {
		baseUrl: ${safe(baseUrl ?? "")},
		apiKey: ${safe(CUSTOM_KEY_ENV)},
		api: ${safe(apiFormat ?? "openai-completions")},
		models: [
			{
				id: ${safe(model ?? "")},
				name: ${safe(modelName ?? model ?? "")},
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: ${Number(contextWindow ?? 128000)},
				maxTokens: ${Number(maxTokens ?? 8192)},
			},
		],
	});
}
`;
}

/** 可以安全显示给界面的版本（**不含密钥值**）。 */
export function describeSettings(settings: Settings): string {
	const parts = [`来源=${settings.source}`, `模式=${settings.model.mode}`];
	if (settings.model.mode === "custom") {
		parts.push(`格式=${settings.model.apiFormat ?? "-"}`, `地址=${settings.model.baseUrl ? "已配置" : "未配置"}`);
	} else {
		parts.push(`供应商=${settings.model.provider ?? "未配置"}`);
	}
	parts.push(`模型=${settings.model.model ?? "未配置"}`, `密钥=${settings.model.apiKey ? "已配置" : "未配置"}`, `手脚=${settings.security.agentShell}`);
	return parts.join(" ");
}
