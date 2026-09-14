#!/usr/bin/env node
/**
 * sprite-core 组装根。
 *
 * 把已验证的部件接成一个真实进程：
 *   journal（唯一事实来源）→ 导入 v1 记忆 → RPC（外壳入口）→ 调度器 → 呼吸（常驻 pi）→ 投影
 *
 * 启动顺序的两条硬约束：
 *   1. 恢复必须发生在接受指令之前：先处理被打断的 run，再开门。
 *   2. 投影必须有水位线：导入进来的历史事件是从这些文件读出来的，不能再写回去。
 *
 * 没有 pi 时**诚实降级**（presence=degraded + system.problem），而不是假装在呼吸。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCommand, PROTOCOL_VERSION, type JournalEvent } from "../contracts/events.ts";
import { createPiRpc, type PiClient } from "./agent/pi-rpc.ts";
import { createBreathRunner } from "./breath.ts";
import {
	API_FORMATS,
	CUSTOM_KEY_ENV,
	KNOWN_PROVIDERS,
	PROVIDER_AUTH_STYLE,
	allowedToolsFor,
	PROVIDER_KEY_ENV,
	PROVIDER_MODELS_URL,
	customProviderSource,
	describeSettings,
	piArgsFor,
	patchSettings,
	readSettings,
	settingsPath,
	validatePatch,
	type Settings,
} from "./settings.ts";
import { readCompanionName } from "./identity.ts";
import { dayInShanghai } from "./text.ts";
import { execFile } from "node:child_process";
import { importLegacy, ownershipHandoffEvent, type ImportReport } from "./importer.ts";
import { openJournal, type Journal } from "./journal.ts";
import { createProjector } from "./projector.ts";
import { createRpcServer, type RpcServer } from "./rpc/server.ts";
import { createGatewayServer } from "./rpc/gateway.ts";
import { clampInterval, createScheduler, type Pause, type QuietHours } from "./scheduler.ts";
import { createStateTracker, deriveState } from "./state.ts";
import { truncate } from "./text.ts";

export type KernelConfig = {
	/** 记忆之家。产品默认 ~/.claude-memory；测试可指向夹具目录。 */
	homeDir?: string;
	companionName?: string;
	socketPath?: string;
	gatewaySocketPath?: string;
	piBin?: string;
	piArgs?: string[];
	piEnv?: Record<string, string>;
	/** 能力网关扩展路径（agent 的手与门）。 */
	gatewayExtension?: string;
	/** 写操作的允许根目录（默认只有记忆之家）。 */
	allowedRoots?: string[];
	/** 测试/只读场景：不启动 pi，仅提供数据与指令面。 */
	disableAgent?: boolean;
	/** 额外的观察上下文（测试用来注入异常/扩展字段）。抛错不得让它停止呼吸。 */
	observationExtras?: () => Record<string, unknown>;
	intervalMs?: number;
	quietIntervalMs?: number;
	quietHours?: QuietHours;
	fsync?: boolean;
	log?: (message: string) => void;
};

export type SetupReport = {
	homeDir: string;
	/** identity.md 是否存在（它是谁） */
	hasIdentity: boolean;
	/** 模型配置是否就绪（settings.json 或旧的 llm.conf 任一生效） */
	hasModelConfig: boolean;
	/** 设置文件路径（界面上要显示"存在哪儿"，但不需要用户去改） */
	configPath: string;
	/** 旧配置文件（老用户可能还在用，界面要认） */
	legacyConfigPath: string;
	/** 设置从哪儿读来的：settings.json / llm.conf / default */
	settingsSource: string;
	/** 常驻 pi 是否在跑（思考引擎） */
	piAvailable: boolean;
	piBin: string;
	quietHours: { start: number; end: number };
	/** 这是演示/测试环境（记忆之家里有 DEMO 标记），不是用户的真实配置 */
	isDemo: boolean;
};

export type Kernel = {
	readonly homeDir: string;
	readonly socketPath: string;
	readonly journal: Journal;
	readonly importReports: ImportReport[];
	status(): unknown;
	snapshot(): unknown;
	stop(): void;
	/** 跑一拍并返回结果（测试与 CLI 用；正常运行由调度器触发）。 */
	breathNow(trigger?: "manual" | "timer"): Promise<unknown>;
};

/**
 * 首次运行需要知道的事。**只看键在不在，绝不读值**——
 * API key 不进读模型、不进日志、不进界面。
 */
function inspectSetup(
	homeDir: string,
	piBin: string,
	piAvailable: boolean,
	quietHours: { start: number; end: number },
): SetupReport {
	const settings = readSettings(homeDir);
	const legacyPath = path.join(homeDir, "config", "llm.conf");
	// "配好了"的判据：有模型 ID，且（内置供应商有密钥 / 自定义端点有地址+密钥）
	const hasModel = Boolean(settings.model.model) &&
		(settings.model.mode === "custom" ? Boolean(settings.model.baseUrl && settings.model.apiKey) : Boolean(settings.model.apiKey));
	return {
		homeDir,
		hasIdentity: fs.existsSync(path.join(homeDir, "identity.md")),
		hasModelConfig: hasModel,
		configPath: settingsPath(homeDir),
		legacyConfigPath: legacyPath,
		piAvailable,
		piBin,
		quietHours,
		isDemo: fs.existsSync(path.join(homeDir, "DEMO")),
		// 设置从哪儿来的：界面要如实说（旧 llm.conf 也算数）
		settingsSource: settings.source,
	};
}

function resolveDefaults(config: KernelConfig) {
	const homeDir = config.homeDir ?? path.join(os.homedir(), ".claude-memory");
	const runtimeDir = path.join(homeDir, "runtime");
	return {
		homeDir,
		runtimeDir,
		socketPath: config.socketPath ?? path.join(runtimeDir, "core.sock"),
		gatewaySocketPath: config.gatewaySocketPath ?? path.join(runtimeDir, "gateway.sock"),
	};
}

export async function startKernel(config: KernelConfig = {}): Promise<Kernel> {
	const kernelStartedAt = Date.now();
	const { homeDir, runtimeDir, socketPath, gatewaySocketPath } = resolveDefaults(config);
	const log = config.log ?? ((message: string) => console.log(message));
	const fsync = config.fsync ?? true;
	fs.mkdirSync(runtimeDir, { recursive: true });

	const published: Array<(event: unknown) => void> = [];
	let eventsSinceCheckpoint = 0;
	let rpc: RpcServer | null = null;
	let projector: ReturnType<typeof createProjector> | null = null;
	let projectWatermark = 0;
	const handedOff = new Set<string>();

	// 读模型增量维护：每次查询重放全量事件是 O(n)，实测 20 万条时单次要 1.4 秒。
	const tracker = createStateTracker();

	const journal = openJournal({
		dir: homeDir,
		exclusive: true,
		fsync,
		// 恢复时逐条喂给读模型（历史不必留在内存里）
		onRecover: (event) => tracker.apply(event),
		// 检查点：把读模型快照存下来，下次启动只需折叠它之后的事件。
		// 注意：拿到快照后若校验不通过，journal 会整份重扫——那时 tracker 仍是空的。
		checkpointPayload: () => tracker.snapshot(),
		onCheckpoint: (payload) => tracker.restore(payload),
		onAppend: (event) => {
			tracker.apply(event);
			countActivity(event);
			// 每 2000 条落一次检查点：崩溃时最多重放这么多（启动时间可控又不频繁写盘）
			eventsSinceCheckpoint += 1;
			if (eventsSinceCheckpoint >= 2000) {
				eventsSinceCheckpoint = 0;
				journal.writeCheckpoint();
			}
			if (rpc) rpc.publish(event);
			if (event.type === "run.started") currentRunId = String(event.data.runId ?? "");
			if (event.type === "run.finished" || event.type === "run.failed" || event.type === "presence.changed") {
				if (event.type !== "presence.changed") currentRunId = null;
			}
			// 只投影"新内容"：导入水位线之前的事件来自文件本身，写回去就是自我复制
			if (projector && event.seq > projectWatermark && projector.supported(event.type)) {
				const result = projector.project(event);
				if (!result.ok) {
					journal.append("system.problem", {
						code: "projection.failed",
						userMessage: "记忆产物写入失败，事实已保存在事件日志中。",
						detail: result.error,
					});
				} else if (result.file && !handedOff.has(result.file)) {
					// 所有权交接：此后内核是这个文件的写入者，导入器不得再读它。
					// 否则新写的内容会在下次启动时被当成"外部新历史"再导入一遍（留言翻倍）。
					handedOff.add(result.file);
					const marker = ownershipHandoffEvent(result.file);
					journal.append(marker.type, marker.data);
				}
			}
		},
	});

	// ─── 1. 导入既有记忆（只读），并记住水位线 ───
	const importReports = importLegacy(homeDir, journal);
	projectWatermark = journal.seq;
	const imported = importReports.filter((report) => report.status === "imported");
	log(
		`[core] 导入：${imported.length > 0 ? imported.map((r) => `${r.source}+${r.events}`).join(" ") : "无新内容"}（水位线 seq=${projectWatermark}）`,
	);

	const companionName = config.companionName ?? readCompanionName(homeDir);
	log(`[core] 它的名字：${companionName}`);
	projector = createProjector({ homeDir, companionName, fsync, log });

	// ─── 2. 崩溃恢复：先收尾被打断的 run，再开门 ───
	const recovered = tracker.state;
	if (recovered.danglingRun) {
		journal.append("run.failed", { reason: "core restarted", runId: `orphan-${recovered.lastRunStartSeq}` });
		log("[core] 检测到被中断的呼吸，已标记 run.failed（不重复执行）");
	}

	// ─── 3. 常驻 pi ───
	// 模型配置来自 config/llm.conf（与 v1 同一份文件）。
	// 密钥只进子进程参数，绝不进日志/读模型/界面。
	let settings: Settings = readSettings(homeDir);
	if (!config.piArgs) log(`[core] 模型配置：${describeSettings(settings)}`);
	if (settings.security.agentShell !== "on") log(`[core] 手脚档位：${settings.security.agentShell}（bash${settings.security.agentShell === "off" ? " 与文件读写都不可用" : " 不可用，文件只读"}）`);

	// 安静时段优先级：显式配置（环境/代码）> 界面里填的设置 > 内置默认（23–7）
	const configuredQuiet = config.quietHours;
	const quietHours = configuredQuiet ?? (settings.source === "default" ? undefined : settings.quietHours);
	if (quietHours && !configuredQuiet) log(`[core] 安静时段（来自 ${settings.source}）：${quietHours.start}:00–${quietHours.end}:00`);

	/** 主动说话的限额（界面可改，改完立刻生效） */
	let proactive = { ...settings.proactive };

	/**
	 * 从日志恢复"暂停"。
	 *
	 * 老实现把 pause 只放在内存里：重启（崩溃、升级、重启 Mac）之后
	 * "直到我说继续"就失效了——而 journal 里明明记着 breath.paused。
	 * 更糟的是读模型仍重放出 presence=paused，于是**界面显示"已暂停"，它却在呼吸**。
	 */
	function restorePause(): Pause {
		// **必须扫日志文件，不能查 journal.events**：有检查点时重启只重放尾巴，
		// 昨天那条 breath.paused 根本不在内存窗口里（语音补写踩过同一个坑）。
		// 从最新的一天往回找，找到第一条暂停/继续事件就定了。
		const journalDir = path.join(homeDir, "journal");
		let names: string[] = [];
		try {
			names = fs.readdirSync(journalDir).filter((name) => name.endsWith(".jsonl")).sort().reverse();
		} catch {
			return null;
		}
		for (const name of names) {
			let raw = "";
			try {
				raw = fs.readFileSync(path.join(journalDir, name), "utf8");
			} catch {
				continue;
			}
			const lines = raw.split("\n");
			for (let index = lines.length - 1; index >= 0; index -= 1) {
				const line = lines[index]!;
				const paused = line.includes('"breath.paused"');
				const resumed = line.includes('"breath.resumed"');
				if (!paused && !resumed) continue;
				if (resumed) return null;
				try {
					const parsed = JSON.parse(line) as {
						data?: { until?: unknown; mode?: unknown; settingsChange?: unknown };
					};
					const data = parsed.data ?? {};
					// 旧实现（v3 之前）在**改安静时段**时也写 breath.paused{settingsChange:true}——
					// 那不是用户在暂停。它没有 `mode` 字段（新格式一定有）。
					// 真实事故：这条旧事件让每次重启都恢复成"无限期暂停"，
					// 于是它在 09-12 之后三天只睡觉、什么都不做（488 次空转）。
					if (data.settingsChange === true || data.mode === undefined) continue;
					const until = typeof data.until === "number" ? data.until : null;
					return { until };
				} catch {
					continue; // 坏行跳过，继续往回找
				}
			}
		}
		return null;
	}

	/**
	 * 安静时段里收着的留言（channel=digest），从 `since` 之后算起。
	 *
	 * **读日志文件，不查 tracker.state.outgoing**：读模型是有上限的缓存
	 * （每类 200 条，见 state.ts 的 DEFAULT_WINDOW），而"早上把这些话交回它面前"
	 * 是对用户的承诺，不该取决于缓存还留不留得住。
	 * 和 restorePause 同一个教训：durable 的事实只问真相来源。
	 */
	function digestsSince(since: string): string[] {
		const journalDir = path.join(homeDir, "journal");
		let names: string[] = [];
		try {
			names = fs.readdirSync(journalDir).filter((name) => name.endsWith(".jsonl"));
		} catch {
			return [];
		}
		const found: Array<{ at: string; text: string }> = [];
		for (const name of names) {
			let raw = "";
			try {
				raw = fs.readFileSync(path.join(journalDir, name), "utf8");
			} catch {
				continue;
			}
			for (const line of raw.split("\n")) {
				if (!line.includes('"message.out"')) continue;
				try {
					const event = JSON.parse(line) as { at?: unknown; data?: Record<string, unknown> };
					const data = event.data ?? {};
					if (data.channel !== "digest") continue;
					// 导入的历史（v1 记忆）不算"夜里收着的话"：那是几个月前的事
					if (typeof data.legacyAt === "string" && data.legacyAt) continue;
					const at = typeof event.at === "string" ? event.at : "";
					if (!at || at < since) continue;
					found.push({ at, text: String(data.text ?? "") });
				} catch {
					continue; // 坏行/半行跳过，不能让一行坏数据毁掉整晚的话
				}
			}
		}
		found.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
		return found.slice(-10).map((item) => item.text);
	}

	const scheduler = createScheduler({
		intervalMs: config.intervalMs,
		quietIntervalMs: config.quietIntervalMs,
		quietHours,
	});

	const piBin = config.piBin ?? "pi";
	const agentDisabled = config.disableAgent ?? false;
	let pi: PiClient | null = null;
	let breath: ReturnType<typeof createBreathRunner> | null = null;
	let consecutiveFailures = 0;
	/** 今天（上海日）它做了什么：给界面看读数，也给它自己看（"只补事实"的产品决定）。 */
	type TodayActivity = { day: string; wakes: number; actions: number; writes: number; reads: number; said: number };
	let todayActivity: TodayActivity = { day: dayInShanghai(new Date()), wakes: 0, actions: 0, writes: 0, reads: 0, said: 0 };
	/** 连续多少拍醒来后一个动作都没有（界面据此提示"它连续空转"）。 */
	let idleStreak = 0;

	/** 启动时先把今天已有的事件数进来（重启不该让读数归零）。 */
	function seedTodayActivity(): void {
		todayActivity = { day: dayInShanghai(new Date()), wakes: 0, actions: 0, writes: 0, reads: 0, said: 0 };
		const file = path.join(homeDir, "journal", `${todayActivity.day}.jsonl`);
		let raw = "";
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch {
			return; // 今天还没有文件
		}
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				countActivity(JSON.parse(line) as JournalEvent);
			} catch {
				// 半行跳过
			}
		}
	}

	/** 只数事实，不做评价。 */
	function countActivity(event: JournalEvent): void {
		const day = dayInShanghai(new Date(event.at));
		if (day !== todayActivity.day) todayActivity.day = day, (todayActivity = { day, wakes: 0, actions: 0, writes: 0, reads: 0, said: 0 });
		const data = event.data as Record<string, unknown>;
		switch (event.type) {
			case "run.started":
				todayActivity.wakes += 1;
				break;
			case "run.activity": {
				todayActivity.actions += 1;
				const tool = String(data.tool ?? "");
				if (tool === "write" || tool === "edit") todayActivity.writes += 1;
				if (tool === "read" || tool === "ls" || tool === "grep" || tool === "glob" || tool === "find") todayActivity.reads += 1;
				break;
			}
			case "message.out":
				todayActivity.said += 1;
				break;
			case "run.finished": {
				// 空手而归的醒来会累加；做了事就清零（连续空转是界面要提示的那件事）
				idleStreak = Number(data.activities ?? 0) > 0 ? 0 : idleStreak + 1;
				break;
			}
			default:
				break;
		}
	}

	function activityFacts(): { today: TodayActivity; idleStreak: number } {
		return { today: { ...todayActivity }, idleStreak };
	}

	let pause: Pause = restorePause();
	seedTodayActivity(); // 计数器声明之后才能 seeding（今天已有的事件要先数进来）
	let timer: NodeJS.Timeout | null = null;
	let waking = false;
	let stopped = false;
	/** 换模型时会主动重启 pi：这期间的退出不算"意外崩溃" */
	let restartingAgent = false;
	/** 它自己要求的下一次间隔（一次性，用完即清）。 */
	let requestedIntervalMs: number | undefined;
	/** 当前正在跑的 run（工具审计要挂到它身上）。 */
	let currentRunId: string | null = null;
	/** 当前这一拍的触发原因（主动说话限流要看它：回话不算主动） */
	let currentTrigger: string | null = null;
	/** 今天已经主动开口几次（启动时从日志数出来，之后内存累加） */
	let proactiveSaysToday = 0;
	/** 上面那个"今天"是哪一天（上海时区）。跨日要重置——老实现从不重置，
	 *  常驻进程用完额度后就**永远**不再主动说话。 */
	let proactiveDayKey = dayInShanghai(new Date());
	/** 上一拍是不是在安静时段里跑的（用来判断"安静时段刚结束"） */
	let lastBreathQuiet: boolean | null = null;
	/** 这一轮安静时段是从什么时候开始的（早上要把这段时间收着的话交回给它） */
	let quietStartedAt: string | null = null;

	const gatewayExtension = config.gatewayExtension ?? path.join(process.cwd(), "pi-extension", "sprite.ts");
	/**
	 * agent 能写的目录。
	 *
	 * 老默认是 `[homeDir]`——整栋房子都能写，包括 `config/`（存着 API key）、
	 * `journal/`（唯一事实来源）、`runtime/`（两个 socket）与 `sessions/`。
	 * 评审 C4 指出：同 UID 下 agent 本来就能读任何 0600 文件，但**至少不该由我们
	 * 把钥匙递到它手里**。现在只给内容目录：日记、探索、笔记、私人空间、工作记忆。
	 */
	const allowedRoots =
		config.allowedRoots ??
		["diary", "explorations", "notes", "private", "context"].map((name) => path.join(homeDir, name));
	const sessionDir = path.join(homeDir, "sessions");
	const customExtensionPath = path.join(homeDir, "config", "custom-provider.ts");
	fs.mkdirSync(sessionDir, { recursive: true });

	/** 自定义端点（OpenAI 格式等）：把界面里填的东西生成成 pi 的 provider 扩展 */
	function writeCustomProvider(): string | null {
		const source = customProviderSource(settings);
		if (!source) return null;
		fs.mkdirSync(path.dirname(customExtensionPath), { recursive: true });
		fs.writeFileSync(customExtensionPath, source, { mode: 0o600 });
		return customExtensionPath;
	}

	function agentArgs(): string[] {
		if (config.piArgs) return config.piArgs;
		const args = ["--mode", "rpc", ...piArgsFor(settings), "-e", gatewayExtension];
		// 可选边界：on 用 pi 的默认工具集（含 bash）；readonly / off 明确收窄
		const tools = allowedToolsFor(settings.security.agentShell);
		if (tools) args.push("--tools", tools.join(","));
		const custom = writeCustomProvider();
		if (custom) args.push("-e", custom);
		// 每天一个 session，与 v1 的 sessions/YYYY-MM-DD.jsonl 完全兼容
		args.push("--session", path.join(sessionDir, `${new Date().toISOString().slice(0, 10)}.jsonl`));
		return args;
	}

	function startAgent(): void {
		if (agentDisabled) {
			journal.append("presence.changed", { state: "degraded" });
			journal.append("system.problem", {
				code: "agent.disabled",
				userMessage: "思考引擎未启动（pi 不可用），它现在只能记录，不能自主呼吸。",
			});
			return;
		}
		// 换模型时会主动杀旧引擎：它的退出**晚到**也绝不能报成"意外崩溃"。
		// 靠时间差（restartingAgent 标志）不够——退出事件可能在新引擎起来之后才到，
		// 所以这里认**身份**：只有当前这个实例的退出才算数。
		const instance = createPiRpc({
			bin: piBin,
			args: agentArgs(),
			env: {
				SPRITE_GATEWAY_SOCK: gatewaySocketPath,
				SPRITE_ALLOWED_ROOTS: allowedRoots.join(":"),
				// 自定义端点的密钥走环境变量：**不落文件、不进日志**
				...(settings.model.mode === "custom" && settings.model.apiKey ? { [CUSTOM_KEY_ENV]: settings.model.apiKey } : {}),
				...(config.piEnv ?? {}),
			},
			cwd: homeDir,
			onExit: ({ code, signal }) => {
				if (stopped || restartingAgent || pi !== instance) return;
				journal.append("system.problem", {
					code: "pi.exited",
					userMessage: "思考引擎意外退出，它暂时不能自主呼吸。",
					exitCode: code,
					signal,
				});
				journal.append("presence.changed", { state: "degraded" });
			},
		});
		instance.start();
		pi = instance;
		breath = createBreathRunner({
			journal,
			pi: instance,
			isQuiet: () => scheduler.isQuiet(),
			observationExtras: () => {
				const state = tracker.state;
				const pending = state.pendingMessages.length;
				// 安静时段收着的话：安静刚结束的那一拍要把它们交回去（M7 的兑现机制）
				const quietJustEnded = lastBreathQuiet === true && !scheduler.isQuiet();
				const heldBack = quietJustEnded && quietStartedAt ? digestsSince(quietStartedAt) : [];
				if (quietJustEnded) quietStartedAt = null;
				const lastBubble = [...journal.events]
					.reverse()
					.find((event) => event.type === "message.out" && event.data.channel === "bubble");
				const silenceHours = lastBubble ? (Date.now() - Date.parse(lastBubble.at)) / 3_600_000 : undefined;
				// 由头（C）：安静时段刚结束、上一次写了东西、很久没说话——有由头时才提"可以说一句"
				let nudge: string | undefined;
				if (pending === 0) {
					if (quietJustEnded) {
						nudge = heldBack.length > 0
							? "安静时段刚结束。你昨夜收着的那几句在下面——想说就说，不想说也留着。"
							: "安静时段刚结束。如果这一觉让你想到什么，这个时候跟他说一句是合适的。";
					} else if (proactive.enabled && proactiveUsedToday() < proactive.perDay) {
						const wrote = lastRunWriteSummary();
						if (wrote) {
							nudge = `你上一次醒来写了东西（${wrote}）。如果那件事你想让他知道，可以说一句。`;
						} else if (silenceHours !== undefined && silenceHours >= 6) {
							nudge = `你已经 ${silenceHours.toFixed(0)} 小时没跟他说过话了。想说什么就说，不想说也没关系。`;
						}
					}
				}
				return {
					silenceHours,
					proactiveToday: proactiveUsedToday(),
					proactivePerDay: proactive.perDay,
					nudge,
					heldBack,
					// 只补事实：它自己有什么、记忆里有什么、上次和今天做过什么。
					// 要不要做事仍然是它的选择（用户选的产品方向 A）。
					facts: {
						capabilities: capabilitiesFact(),
						memory: memoryFact(),
						lastRun: lastRunFact() ?? undefined,
						today: todayFact(),
					},
					...(config.observationExtras?.() ?? {}),
				};
			},
			log,
		});
	}

	function stopAgent(): void {
		breath = null;
		pi?.stop();
		pi = null;
	}

	startAgent();

	/** 今天已经主动开口几次：扫日志（`origin` 不是回话的都算主动） */
	function countProactiveToday(): number {
		const today = dayInShanghai(new Date());
		let count = 0;
		for (const event of journal.events) {
			if (event.type !== "message.out") continue;
			if (dayInShanghai(new Date(event.at)) !== today) continue;
			if (event.data.channel !== "bubble") continue;
			const origin = typeof event.data.origin === "string" ? event.data.origin : "message";
			if (origin === "message" || origin === "recovered-queue") continue;
			count += 1;
		}
		return count;
	}
	proactiveSaysToday = countProactiveToday();

	/** 取"今天已主动几次"，跨日自动重置 */
	function proactiveUsedToday(): number {
		const today = dayInShanghai(new Date());
		if (today !== proactiveDayKey) {
			proactiveDayKey = today;
			proactiveSaysToday = countProactiveToday();
		}
		return proactiveSaysToday;
	}

	/**
	 * 它的能力与边界：按**当前设置**如实说，不夸大。
	 * 产品决定 A（只补事实）：告诉它有什么，但不命令它去用。
	 */
	function capabilitiesFact(): string {
		const roots = allowedRoots.map((root) => `${path.relative(homeDir, root) || root}/`).join(" ");
		switch (settings.security.agentShell) {
			case "off":
				return "你的手脚：现在只能说话、留话、定闹钟、提问——碰不到文件，也不能跑命令。";
			case "readonly":
				return `你的手脚：能读能搜 ${roots}，但不能写文件、不能跑命令。`;
			default:
				return `你的手脚：能读写 ${roots}，也能跑命令（命令不是沙箱；写东西请只写这些目录）。`;
		}
	}

	/** 它的记忆现状：只报事实（篇数、最近一篇多久以前）。 */
	function memoryFact(): string {
		const filesIn = (name: string): string[] => {
			try {
				return fs.readdirSync(path.join(homeDir, name)).filter((file) => file.endsWith(".md"));
			} catch {
				return [];
			}
		};
		const newestMs = (name: string): number | null => {
			const times = filesIn(name).map((file) => {
				try {
					return fs.statSync(path.join(homeDir, name, file)).mtimeMs;
				} catch {
					return 0;
				}
			});
			return times.length > 0 ? Math.max(...times) : null;
		};
		const diary = filesIn("diary");
		const diaryNewest = newestMs("diary");
		const days = diaryNewest === null ? null : Math.floor((Date.now() - diaryNewest) / 86_400_000);
		const parts = [`日记 ${diary.length} 篇`];
		if (days !== null) parts.push(days <= 0 ? "最近一篇是今天写的" : `最近一篇是 ${days} 天前写的`);
		parts.push(`探索笔记 ${filesIn("explorations").length} 篇`, `私人空间 ${filesIn("private").length} 篇`);
		return `你的记忆：${parts.join("，")}。`;
	}

	/** 上一次醒来做了什么（事实，不含评价） */
	function lastRunFact(): string | null {
		// 读模型只留窗口，所以从尾巴往回找最近一条 run.finished（找不到就如实不说）
		const events = journal.events;
		let finishedIndex = -1;
		for (let index = events.length - 1; index >= 0; index -= 1) {
			if (events[index]?.type === "run.finished") {
				finishedIndex = index;
				break;
			}
		}
		if (finishedIndex < 0) return null;
		const finished = events[finishedIndex]!;
		const runId = String(finished.data.runId ?? "");
		const at = Date.parse(finished.at);
		const hours = Number.isFinite(at) ? (Date.now() - at) / 3_600_000 : null;
		const when = hours === null ? "上一次醒来" : hours < 0.05 ? "刚刚那一次醒来" : `上一次醒来（${hours < 1 ? `${Math.round(hours * 60)} 分钟` : `${hours.toFixed(1)} 小时`}前）`;
		const tools: string[] = [];
		for (let index = finishedIndex - 1; index >= 0; index -= 1) {
			const event = events[index]!;
			if (event.type === "run.started") break;
			if (event.type !== "run.activity") continue;
			if (runId && String(event.data.runId ?? "") !== runId) continue;
			const tool = String(event.data.tool ?? "");
			if (tool && !tools.includes(tool)) tools.push(tool);
		}
		const count = Number(finished.data.activities ?? 0);
		if (count === 0) return `${when}，你一个动作都没做。`;
		return `${when}，你做了 ${count} 个动作（${tools.slice(0, 3).join("、") || "工具"}）。`;
	}

	/** 今天（上海日）做了什么——和界面上看到的是同一份读数 */
	function todayFact(): string {
		const today = todayActivity;
		return `今天（上海日）：醒来 ${today.wakes} 次，工具动作 ${today.actions} 次（写/改 ${today.writes}，读 ${today.reads}），说话 ${today.said} 次。`;
	}

	/** 上一次醒来做了什么（写/改文件才算"做了事"） */
	function lastRunWriteSummary(): string | null {
		const runs: number[] = [];
		for (let index = journal.events.length - 1; index >= 0 && runs.length < 2; index -= 1) {
			const event = journal.events[index];
			if (event?.type === "run.started") runs.push(index);
		}
		const previous = runs[1];
		if (previous === undefined) return null;
		for (let index = previous + 1; index < journal.events.length; index += 1) {
			const event = journal.events[index];
			if (event?.type !== "run.activity") continue;
			const tool = String(event.data.tool ?? "");
			if (tool !== "write" && tool !== "edit") continue;
			const summary = String(event.data.summary ?? "");
			const match = /"file_path":"([^"]+)"/.exec(summary) ?? /"path":"([^"]+)"/.exec(summary);
			return match ? match[1] : "一个文件";
		}
		return null;
	}

	function scheduleNext() {
		if (stopped) return;
		const plan = scheduler.next({ consecutiveFailures, pause, requestedIntervalMs });
		// 它自己要求的间隔只决定"下一次"，用完即清；否则会永久覆盖正常节奏
		requestedIntervalMs = undefined;
		journal.append("breath.scheduled", {
			nextBreathAt: plan.at,
			intervalMs: plan.intervalMs,
			quiet: plan.quiet,
			reason: plan.reason,
		});
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void runBreath("timer"), Math.max(0, plan.intervalMs));
	}

	async function runBreath(trigger: "timer" | "message" | "wake" | "recovered-queue" | "manual") {
		if (stopped) return null;
		if (!breath) {
			journal.append("run.failed", { reason: "pi 不可用，无法呼吸", trigger });
			journal.append("presence.changed", { state: "degraded" });
			return null;
		}
		currentTrigger = trigger;
		// 暂停中的定时拍：**直接跳过**，什么都不做。
		// 真实事故（2026-09-12~14）：一条旧的停写事件让内核以为自己在暂停，
		// 于是它每 5 分钟照常叫一次模型、说一句"安静。"，两天空转 488 拍——
		// 既烧钱，又把 presence 改写成 quiet，界面上完全看不出它被暂停了。
		// 用户主动说话（message）与显式叫醒（wake/manual）不受影响：那是他要的。
		if (trigger === "timer" && scheduler.activePause(pause)) {
			scheduleNext();
			return { runId: null, ok: true, durationMs: 0, activities: 0, thought: null, reason: "paused" };
		}
		// 「这一拍是不是安静时段里跑的」必须在**开始**时判定：
		// 一拍可能横跨安静时段的边界（实测：用户或设置在拍与拍之间翻转），
		// 结束时再看就会把"安静的一拍"记成不安静——早上交回收着的话就失效了。
		const quietAtStart = scheduler.isQuiet();
		// 安静时段的起点也要在开始前记：这一拍期间它想说的话会被降级成 digest，
		// 等结束才记的话那些话会落在窗口之外（M7 的内核级回归测试抓到的）。
		if (quietAtStart && quietStartedAt === null) quietStartedAt = new Date().toISOString();
		const outcome = await breath.run(trigger);
		// 被 busy 拒掉的那一拍**什么都没发生过**：安静簿记必须原封不动。
		// （实测竞态：唤醒在安静那一拍飞行途中到达 → 被拒的唤醒把 quietStartedAt
		// 抹成 null → 正在跑的那一拍收尾时"收着的话"已经找不到窗口，早上交不回去。）
		if (outcome.busy) {
			waking = true; // 由正在跑的那一拍结束后补跑
			return outcome;
		}
		if (!quietAtStart) quietStartedAt = null;
		lastBreathQuiet = quietAtStart;
		// 关停信号可能在 await 期间到达：此时日志已关闭，再写就是**未捕获异常**，
		// 直接把进程崩掉（实测：SIGTERM 时正好有呼吸在跑 → 崩）。
		// 收尾阶段允许写不进去，但不允许崩。
		if (stopped) return outcome;
		try {
			consecutiveFailures = outcome.ok ? 0 : consecutiveFailures + 1;
			// 暂停中（例如用户按了「安静一会儿」之后又被叫醒回了一句）：presence 必须如实是 paused。
			// 写成 quiet 的话界面看不出它在暂停——用户会以为它"只是在睡觉"（真实事故）。
			const pausedNow = scheduler.activePause(pause) !== null;
			journal.append("presence.changed", {
				state: pausedNow ? "paused" : outcome.ok ? (scheduler.isQuiet() ? "quiet" : "breathing") : "degraded",
			});
			const pending = tracker.state.pendingMessages.length;
			scheduleNext();
			if (waking || pending > 0) {
				waking = false;
				// 只有**成功**的那一拍才配"马上补跑"（用户按了唤醒，或有没送到的话）。
				// 失败时贴着重试会变成热循环：引擎整段拒绝（key 失效、provider 挂了）时
				// 实测 50ms 一轮、连日志都被刷爆；而消息本来就不会丢——scheduleNext()
				// 已经按指数退避（60s 起）排好下一拍，待处理队列在那一拍照常送出去。
				if (outcome.ok) setTimeout(() => void runBreath("recovered-queue"), 50);
			}
		} catch (error) {
			log(`[core] 收尾时跳过一拍的后处理：${error instanceof Error ? error.message : String(error)}`);
		}
		return outcome;
	}

	/** 「今晚」= 下一个早上 7 点（安静时段的结束），本地时区。 */
	function nextMorning(): Date {
		// 用**用户设的安静时段结束时刻**，不是硬编码的 7 点（他可能改成 8 点或 6 点）
		const now = new Date();
		const morning = new Date(now);
		morning.setHours(scheduler.quietHours.end, 0, 0, 0);
		if (morning.getTime() <= now.getTime()) morning.setDate(morning.getDate() + 1);
		return morning;
	}

	/**
	 * 暂停 / 继续：把它安静下来是用户的权力，必须立即生效、如实记录。
	 * 暂停期间新的留言仍然入库（不丢），只是不会立刻醒来——面板会如实说明。
	 */
	function applyPause(parsed: Extract<ReturnType<typeof parseCommand>, { type: "breath.pause" | "breath.resume" }>) {
		if (parsed.type === "breath.pause") {
			pause =
				parsed.until === "hour"
					? { until: Date.now() + 3_600_000 }
					: parsed.until === "tonight"
						? { until: nextMorning().getTime() }
						: { until: null };
			if (timer) clearTimeout(timer);
			journal.append("breath.paused", { until: pause.until, mode: parsed.until });
			journal.append("presence.changed", { state: "paused" });
			return { paused: true, until: pause.until, mode: parsed.until };
		}
		pause = null;
		journal.append("breath.resumed", {});
		journal.append("presence.changed", { state: scheduler.isQuiet() ? "quiet" : "breathing" });
		scheduleNext();
		return { paused: false };
	}

	// ─── 4. 能力网关（agent 唯一的门） ───
	const gateway = createGatewayServer({
		socketPath: gatewaySocketPath,
		log,
		handle: (request) => {
			switch (request.kind) {
				case "capability.say": {
					const quiet = scheduler.isQuiet();
					const text = String(request.text ?? "");
					// 回话不算"主动开口"；定时醒来主动说话才受额度限制
					const isReply = currentTrigger === "message" || currentTrigger === "recovered-queue";
					// 安静时段不打扰：收着，早上再说（channel=digest）
					if (quiet) {
						const event = journal.append("message.out", { text, channel: "digest", origin: currentTrigger ?? "unknown" });
						return { ok: true, delivered: "digest", reason: "安静时段：已经记成留言，明早再说", seq: event.seq };
					}
					const usedToday = proactiveUsedToday();
					if (!isReply && (!proactive.enabled || usedToday >= proactive.perDay)) {
						// 额度是**内核**在管，不是靠它自觉：超了就记成留言，不弹到你眼前
						const reason = proactive.enabled
							? `今天主动说话的额度用完了（${usedToday}/${proactive.perDay}）`
							: "主动说话已关闭";
						const event = journal.append("message.out", { text, channel: "digest", origin: currentTrigger ?? "unknown", cappedBy: "proactive" });
						return { ok: true, delivered: "digest", reason: `${reason}：已经记成留言，不进弹窗`, seq: event.seq };
					}
					const event = journal.append("message.out", { text, channel: "bubble", origin: currentTrigger ?? "unknown" });
					if (!isReply) proactiveSaysToday += 1;
					return { ok: true, delivered: "bubble", seq: event.seq };
				}
				case "capability.leave_message": {
					const event = journal.append("message.out", { text: String(request.text ?? ""), channel: "digest" });
					return { ok: true, delivered: "digest", seq: event.seq };
				}
				case "capability.set_next_breath": {
					const ms = clampInterval(Number(request.seconds ?? 0) * 1000);
					requestedIntervalMs = ms;
					return { ok: true, nextInSeconds: Math.round(ms / 1000), note: "只影响下一次醒来" };
				}
				case "capability.ask_user": {
					const options = Array.isArray(request.options) ? request.options.slice(0, 4).map(String) : [];
					const event = journal.append("question.asked", { question: String(request.question ?? ""), options });
					return { ok: true, seq: event.seq };
				}
				case "tool.decided": {
					journal.append("tool.decided", {
						tool: String(request.tool ?? "unknown"),
						decision: String(request.decision ?? "allow"),
						reason: request.reason ?? null,
						input: typeof request.input === "string" ? truncate(request.input, 200) : null,
						runId: currentRunId,
					});
					return { ok: true };
				}
				default:
					return { ok: false, error: `未知能力请求: ${String(request.kind)}` };
			}
		},
	});
	await gateway.start();

	/**
	 * 直接问服务商要模型清单（OpenAI 兼容的 GET /models）。
	 *
	 * 密钥只出现在这一次请求的头里：不进日志、不进返回值。
	 */
	async function listModelsFromProvider(
		endpoint: string,
		key: string,
		style: "bearer" | "anthropic" | "x-api-key",
	): Promise<Array<{ id: string; note: string }>> {
		const base = endpoint.replace(/\/+$/, "");
		const url = base.endsWith("/models") ? base : `${base}/models`;
		const headers: Record<string, string> =
			style === "anthropic"
				? { "x-api-key": key, "anthropic-version": "2023-06-01" }
				: style === "x-api-key"
					? { "x-api-key": key }
					: { authorization: `Bearer ${key}` };
		const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`${url} 返回 ${response.status}${response.status === 401 ? "（密钥不对？）" : ""}`);
		const payload = (await response.json()) as {
			data?: Array<{ id?: string; name?: string; context_length?: number; max_input_tokens?: number; owned_by?: string }>;
			models?: Array<{ id?: string; name?: string; context_length?: number; max_input_tokens?: number; owned_by?: string }>;
		};
		const rows = payload.data ?? payload.models ?? [];
		return rows
			.map((row) => {
				const id = String(row.id ?? "");
				const context = row.context_length ?? row.max_input_tokens;
				const note = [context ? `上下文 ${Math.round(Number(context) / 1000)}K` : "", row.owned_by ? `由 ${row.owned_by} 提供` : ""].filter(Boolean).join("　·　");
				return { id, note };
			})
			.filter((model) => model.id);
	}

	/**
	 * 扫日志取语音相关事件。
	 *
	 * 为什么必须扫日志而不是查 `journal.events`：那只是内存滑窗（有检查点时只重放尾巴），
	 * 一段两天前的录音根本不在里面——"日志里明明有，却说不存在"就是这么来的。
	 * `onlyFile` 非空时找到即返回（补写校验只需要"在不在"）。
	 */
	function scanVoice(onlyFile?: string): {
		recorded: Array<{ at: string; transcript?: string; file?: string; bytes?: number; durationMs?: number }>;
		corrections: Map<string, string>;
	} {
		const recorded: Array<{ at: string; transcript?: string; file?: string; bytes?: number; durationMs?: number }> = [];
		const corrections = new Map<string, string>();
		const journalDir = path.join(homeDir, "journal");
		let names: string[] = [];
		try {
			names = fs.readdirSync(journalDir).filter((name) => name.endsWith(".jsonl")).sort();
		} catch {
			return { recorded, corrections };
		}
		// 正序扫：补写事件总在录音之后，后写的自然覆盖先前的
		for (const name of names) {
			let raw: string;
			try {
				raw = fs.readFileSync(path.join(journalDir, name), "utf8");
			} catch {
				continue;
			}
			for (const line of raw.split("\n")) {
				const isRecord = line.includes('"voice.recorded"');
				const isFix = line.includes('"voice.transcribed"');
				if (!isRecord && !isFix) continue;
				try {
					const parsedLine = JSON.parse(line) as {
						at?: string;
						data?: { at?: string; transcript?: string; file?: string; bytes?: number; durationMs?: number };
					};
					const data = parsedLine.data;
					if (!data) continue;
					if (isRecord && !isFix) {
						if (onlyFile) {
							if (data.file === onlyFile) return { recorded: [{ ...data, at: data.at ?? parsedLine.at ?? "" }], corrections };
							continue;
						}
						recorded.push({ ...data, at: data.at ?? parsedLine.at ?? "" });
					} else if (isFix && data.file && typeof data.transcript === "string") {
						corrections.set(data.file, data.transcript);
					}
				} catch {
					// 半行/坏行跳过——日志其他部分照常可读
				}
			}
		}
		return { recorded, corrections };
	}

	// ─── 5. RPC（外壳唯一的入口） ───
	rpc = createRpcServer({
		socketPath,
		log,
		handlers: {
			/**
			 * 某家供应商有哪些模型：直接问 pi（`--list-models`），密钥只进子进程环境。
			 * 为什么值得做：不懂 AI 的人根本不知道该填什么模型名——给个下拉，别让他猜。
			 */
			models: async (provider: string) => {
				const wanted = provider.trim();
				if (!wanted) throw new Error("请先选择供应商");
				const key = settings.model.apiKey;
				const isCustom = settings.model.mode === "custom";
				// ① 能问服务商官方就问官方——它最准
				const endpoint = isCustom ? (settings.model.baseUrl ?? "") : (PROVIDER_MODELS_URL[wanted] ?? "");
				let fallbackReason: string | null = null;
				if (endpoint && key) {
					try {
						const live = await listModelsFromProvider(endpoint, key, PROVIDER_AUTH_STYLE[wanted] ?? "bearer");
						if (live.length > 0) {
							return { provider: wanted, models: live, source: "provider-api", endpoint };
						}
						fallbackReason = `${endpoint} 返回了空清单`;
					} catch (error) {
						fallbackReason = error instanceof Error ? error.message : String(error);
					}
				} else if (!key) {
					fallbackReason = "还没填 API Key，问不了服务商";
				} else {
					fallbackReason = "这家没有已知的 /models 地址";
				}

				// ② 退回 pi 的静态目录，但**标明它不是实时的**
				const env = { ...process.env };
				const keyEnv = PROVIDER_KEY_ENV[wanted];
				if (keyEnv && key && settings.model.provider === wanted) env[keyEnv] = key;
				const raw = await new Promise<string>((resolve, reject) => {
					execFile(piBin, ["--list-models", "--provider", wanted], { env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
						const text = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
						if (error && !text) {
							reject(new Error(`列不出模型：${String(error.message).split("\n")[0].slice(0, 160)}`));
							return;
						}
						resolve(text);
					});
				});
				const models = raw
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line && !/^(warning|no models available)/i.test(line))
					.map((line) => line.split(/\s{2,}/).map((cell) => cell.trim()).filter(Boolean))
					.filter((cells) => cells.length >= 2)
					.filter((cells) => cells[0] !== "provider")
					.map((cells) => {
						const id = cells[0] === wanted ? cells[1]! : cells[0]!;
						const rest = cells[0] === wanted ? cells.slice(2) : cells.slice(1);
						const note = [rest[0] ? `上下文 ${rest[0]}` : "", rest[2] === "yes" ? "会思考" : "", rest[3] === "yes" ? "能看图" : ""].filter(Boolean).join("　·　");
						return { id, note };
					})
					.filter((model) => /^[a-z0-9][a-z0-9._:-]*$/i.test(model.id));
				return { provider: wanted, models, source: "pi-catalog", endpoint: null, fallbackReason };
			},

			/** 设置（**不含密钥值**，只有 hasApiKey） */
			settings: () => ({
				model: {
					mode: settings.model.mode,
					provider: settings.model.provider ?? null,
					apiFormat: settings.model.apiFormat ?? null,
					baseUrl: settings.model.baseUrl ?? null,
					model: settings.model.model ?? null,
					modelName: settings.model.modelName ?? null,
					contextWindow: settings.model.contextWindow ?? null,
					maxTokens: settings.model.maxTokens ?? null,
					hasApiKey: Boolean(settings.model.apiKey),
				},
				providers: KNOWN_PROVIDERS,
				apiFormats: API_FORMATS,
				quietHours: { ...scheduler.quietHours },
				proactive: { ...proactive },
				source: settings.source,
				piAvailable: Boolean(breath),
				piBin,
				homeDir,
				settingsPath: settingsPath(homeDir),
				legacyConfigPath: path.join(homeDir, "config", "llm.conf"),
			}),

			// 名字由内核给（身份是它自己的数据）——外壳只负责显示
			status: () => ({ ...tracker.state, companionName, ...activityFacts() }),
			snapshot: () => ({
				protocolVersion: PROTOCOL_VERSION,
				seq: journal.seq,
				state: { ...tracker.state, companionName, ...activityFacts() },
				imports: importReports,
				piAvailable: Boolean(breath),
				setup: inspectSetup(homeDir, piBin, Boolean(breath), scheduler.quietHours),
			}),
			diagnostics: () => {
				const memory = process.memoryUsage();
				const state = tracker.state;
				let journalBytes = 0;
				try {
					for (const name of fs.readdirSync(path.join(homeDir, "journal"))) {
						if (name.endsWith(".jsonl")) journalBytes += fs.statSync(path.join(homeDir, "journal", name)).size;
					}
				} catch {
					journalBytes = -1;
				}
				return {
					uptimeMs: Date.now() - kernelStartedAt,
					pid: process.pid,
					rssBytes: memory.rss,
					heapUsedBytes: memory.heapUsed,
					seq: journal.seq,
					events: journal.events.length,
					journalBytes,
					runs: state.runs,
					presence: state.presence,
					piAvailable: Boolean(breath),
					usedCheckpoint: journal.usedCheckpoint,
					recoveredEvents: journal.recoveredEvents,
				};
			},
			// 只读记录：**按天聚合**（一天一条），因为"一天一份"才是人翻记录的方式。
			// 日记与探索笔记来自文件（内核是唯一读者），对话与思维流来自读模型。
			records: (kind, limit) => {
				const state = tracker.state;
				const dayOf = (iso: string) =>
					new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
				const clockOf = (iso: string) =>
					new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

				if (kind === "thoughts") {
					// 思维流走**投影文件**：读模型只保留窗口（200 条），
					// 而"翻记录"要看全部（真实记忆里有 1444 条）。文件本身就是它的派生产物。
					const file = path.join(homeDir, "thoughts", "stream.jsonl");
					const items: Array<{ at: string; text: string }> = [];
					try {
						for (const line of fs.readFileSync(file, "utf8").split("\n")) {
							if (!line.trim()) continue;
							try {
								const record = JSON.parse(line) as { time?: string; content?: string };
								if (typeof record.content !== "string") continue;
								// 没有 time 就是没有 time——**绝不能用"现在"顶上**：
								// 那会把旧内容伪装成刚刚发生的（这是撒谎，不是容错）。
								items.push({ at: typeof record.time === "string" ? record.time : "", text: record.content });
							} catch {
								// 非 JSON 行（压缩脚本写的 markdown 前言）：原样保留
								items.push({ at: "", text: line });
							}
						}
					} catch {
						// 文件不在就退回读模型
						for (const entry of state.thoughtTimeline) items.push({ at: entry.at, text: entry.text });
					}
					const byDay = new Map<string, Array<{ at: string; text: string }>>();
					for (const item of items) {
						const day = item.at ? dayOf(item.at) : "";
						if (!byDay.has(day)) byDay.set(day, []);
						byDay.get(day)!.push(item);
					}
					return {
						kind,
						total: items.length,
						entries: [...byDay.entries()]
							// 有日期的新的在前；没日期的（旧版压缩总结）排最后——它最老，不是最新
							.sort((a, b) => {
								if (!a[0]) return 1;
								if (!b[0]) return -1;
								return a[0] < b[0] ? 1 : -1;
							})
							.slice(0, limit)
							.map(([date, list]) => ({
								date,
								title: date ? `${date} 的思维` : "旧格式：那一次压缩总结（原件没写时间）",
								count: list.length,
								preview: list[0]?.text?.slice(0, 80) ?? "",
								text: list.map((item) => (item.at ? `${clockOf(item.at)}　${item.text}` : item.text)).join("\n\n"),
							})),
					};
				}

				if (kind === "voice") {
					// 录音走**日志全量扫描**：读模型窗口只有 2000 条事件，
					// 语音留言很稀疏，掉出窗口就等于永久丢失——用户要能回头听任何一个月的原话。
					const scan = scanVoice();
					const found = scan.recorded.map((item) => {
						const fixed = item.file ? scan.corrections.get(item.file) : undefined;
						return fixed ? { ...item, transcript: fixed } : item;
					});
					found.sort((a, b) => (a.at < b.at ? 1 : -1));
					const entries = found.slice(0, limit).map((item) => {
						const seconds = item.durationMs ? Math.round(item.durationMs / 1000) : undefined;
						const size = item.bytes ? `${Math.max(1, Math.round(item.bytes / 1024))} KB` : "无音频";
						return {
							date: item.at.slice(0, 10),
							at: item.at,
							title: `${clockOf(item.at)} 的语音`,
							meta: [seconds !== undefined ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "", size]
								.filter(Boolean)
								.join("　·　"),
							count: 1,
							preview: (item.transcript ?? "").slice(0, 80),
							text: item.transcript ?? "（这段录音没有转写文字）",
							path: item.file ?? "",
						};
					});
					return { kind, entries };
				}

				if (kind === "conversations") {
					type Item = { at: string; who?: string; text: string };
					const items: Item[] =
						kind === "conversations"
							? [
									...state.messages.map((m) => ({ at: m.at, who: "你", text: m.text })),
									...state.outgoing.map((o) => ({ at: o.at, who: "它", text: o.text })),
								].sort((a, b) => (a.at < b.at ? -1 : 1))
							: state.thoughtTimeline.map((entry) => ({ at: entry.at, text: entry.text }));

					const byDay = new Map<string, Item[]>();
					for (const item of items) {
						const day = dayOf(item.at);
						if (!byDay.has(day)) byDay.set(day, []);
						byDay.get(day)!.push(item);
					}
					const entries = [...byDay.entries()]
						.sort((a, b) => (a[0] < b[0] ? 1 : -1))
						.slice(0, limit)
						.map(([date, list]) => ({
							date,
							title: kind === "conversations" ? `${date} 的对话` : `${date} 的思维`,
							count: list.length,
							preview: list[0]?.text?.slice(0, 80) ?? "",
							text: list
								.map((item) => (item.who ? `${clockOf(item.at)} ${item.who}：${item.text}` : `${clockOf(item.at)}　${item.text}`))
								.join("\n\n"),
						}));
					return { kind, entries };
				}

				// 日记 / 探索笔记：按天合并（一天多篇就并成一条）
				const folder = kind === "explorations" ? "explorations" : "diary";
				const dir = path.join(homeDir, folder);
				let files: string[] = [];
				try {
					files = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
				} catch {
					return { kind, entries: [] };
				}
				const byDay = new Map<string, string[]>();
				const times = new Map<string, string>();
				for (const name of files) {
					const full = path.join(dir, name);
					// 文件名里的日期优先（日记就是 YYYY-MM-DD）；否则用文件的修改时间
					const fromName = /(\d{4}-\d{2}-\d{2})/.exec(name)?.[1];
					let date = fromName ?? "";
					let clock = "";
					try {
						const mtime = fs.statSync(full).mtime.toISOString();
						if (!date) date = dayOf(mtime);
						clock = clockOf(mtime); // 笔记正文里常常没有时间，列表里必须标出来
					} catch {
						date = date || "未知日期";
					}
					const key = date;
					if (!byDay.has(key)) byDay.set(key, []);
					byDay.get(key)!.push(name);
					times.set(`${key}/${name}`, clock);
				}
				const entries = [...byDay.entries()]
					.sort((a, b) => (a[0] < b[0] ? 1 : -1))
					.slice(0, limit)
					.map(([date, names]) => {
						const parts: string[] = [];
						for (const name of names.sort()) {
							try {
								parts.push(`# ${name.replace(/\.md$/, "")}\n\n${fs.readFileSync(path.join(dir, name), "utf8")}`);
							} catch {
								parts.push(`# ${name}\n\n（读不到内容）`);
							}
						}
						const merged = parts.join("\n\n---\n\n");
						const first = names[0];
						return {
							date,
							title: names.length > 1 ? `${date}（${names.length} 篇）` : first.replace(/\.md$/, ""),
							count: names.length,
							// 列表里显示时间——笔记正文里常常没有时间，得由我们标上
							meta: `${date} ${times.get(`${date}/${first}`) ?? ""}`.trim() + (names.length > 1 ? `　·　${names.length} 篇合并` : ""),
							preview: merged.replace(/^#.*$/gm, "").replace(/\n{2,}/g, "\n").trim().slice(0, 160),
							text: merged,
							path: `${folder}/${first}`,
						};
					});
				return { kind, entries };
			},
			document: (relativePath) => {
				// 只允许读它自己的空间，且必须落在允许的目录里
				const allowed = ["diary/", "explorations/", "context/", "conversations/"];
				if (!allowed.some((prefix) => relativePath.startsWith(prefix))) {
					throw new Error("只能读它自己的记录目录");
				}
				const full = path.resolve(homeDir, relativePath);
				if (!full.startsWith(path.resolve(homeDir))) throw new Error("路径越界");
				const text = fs.readFileSync(full, "utf8");
				return { path: relativePath, text, bytes: Buffer.byteLength(text, "utf8") };
			},
			audio: (relativePath) => {
				// 白名单只到 voice/ 且必须是音频后缀：外壳要播放，但绝不能顺手读到别的东西
				if (!relativePath.startsWith("voice/")) throw new Error("只能读语音目录");
				if (!/\.(m4a|caf|wav)$/.test(relativePath)) throw new Error("不是音频文件");
				const full = path.resolve(homeDir, relativePath);
				if (!full.startsWith(path.resolve(homeDir))) throw new Error("路径越界");
				const data = fs.readFileSync(full);
				return {
					path: relativePath,
					base64: data.toString("base64"),
					mimeType: relativePath.endsWith(".caf") ? "audio/x-caf" : "audio/mp4",
					bytes: data.byteLength,
				};
			},
			eventsSince: (seq) => journal.events.filter((event) => event.seq > seq),
			command: (raw) => {
				const parsed = parseCommand(raw);
				if ("error" in parsed) throw new Error(parsed.error);

				if (parsed.type === "message.send") {
					const outcome = journal.applyCommand({
						id: parsed.id,
						produce: () => [{ type: "message.in" as const, data: { text: parsed.text, source: parsed.source } }],
					});
					if (outcome.duplicate) return { duplicate: true, result: outcome.result };
					// 暂停优先于一切：用户说了"安静一会儿"，一条留言不该把它吵醒。
					// 留言照常入库（不丢），面板会如实说明它会在继续之后看到。
					if (scheduler.activePause(pause)) {
						journal.append("wake.deferred", { reason: "已暂停呼吸", commandId: parsed.id });
						return { duplicate: false, deferred: true, paused: true };
					}
					if (scheduler.isQuiet()) {
						journal.append("wake.deferred", { reason: "安静时段", commandId: parsed.id });
						return { duplicate: false, deferred: true, nextBreathAt: tracker.state.nextBreathAt };
					}
					if (timer) clearTimeout(timer);
					void runBreath("message");
					return { duplicate: false, deferred: false };
				}

				if (parsed.type === "voice.commit") {
					// 语音留言：音频落盘 + 一条事件。**不触发呼吸**——说话的人还没点发送，
					// 这一条只是"把原话存下来"，不该替用户做决定。
					let stored: Record<string, unknown> = { transcript: parsed.transcript };
					// 注意：produce 之后 applyCommand 还会追加一条 command.applied，
					// 所以文件名只能在 produce 内部就地记下——不能事后从 events 末尾去取。
					const outcome = journal.applyCommand({
						id: parsed.id,
						produce: () => {
							const data: Record<string, unknown> = { transcript: parsed.transcript };
							if (parsed.audioBase64) {
								const audio = Buffer.from(parsed.audioBase64, "base64");
								if (audio.byteLength > 0) {
									const voiceDir = path.join(homeDir, "voice");
									fs.mkdirSync(voiceDir, { recursive: true });
									const ext = parsed.mimeType === "audio/x-caf" ? "caf" : "m4a";
									const stamp = new Date().toISOString().replace(/[:.]/g, "-");
									const file = `voice/${stamp}.${ext}`;
									fs.writeFileSync(path.join(homeDir, file), audio);
									data.file = file;
									data.bytes = audio.byteLength;
									data.mimeType = parsed.mimeType ?? "audio/mp4";
									stored = { transcript: parsed.transcript, file, bytes: audio.byteLength, mimeType: data.mimeType };
								}
							}
							if (parsed.durationMs !== undefined) data.durationMs = parsed.durationMs;
							return [{ type: "voice.recorded" as const, data }];
						},
					});
					if (outcome.duplicate) return { duplicate: true, result: outcome.result };
					return { duplicate: false, ...stored };
				}

				if (parsed.type === "settings.update") {
					const validated = validatePatch(parsed.patch);
					if (!validated.ok) throw new Error(validated.error);
					const before = settings;
					const patchForAudit: Record<string, unknown> = {};
					if (validated.patch.model) {
						const { apiKey, ...rest } = validated.patch.model;
						patchForAudit.model = { ...rest, apiKeyChanged: Boolean(apiKey), apiKeyCleared: Boolean(validated.patch.model.clearApiKey) };
					}
					if (validated.patch.quietHours) patchForAudit.quietHours = validated.patch.quietHours;
					if (validated.patch.proactive) patchForAudit.proactive = validated.patch.proactive;
					const next = patchSettings(homeDir, validated.patch);
					settings = next;
					// 审计：设置是谁、什么时候、改成了什么（**不记密钥值**）。
					// 之前没有这条记录，出现一个"我没改过"的值时无法追责——这种事不该再发生。
					journal.append("settings.changed", {
						source: parsed.source ?? "unknown",
						patch: patchForAudit,
						quietHours: { ...next.quietHours },
						proactive: { ...next.proactive },
						model: {
							mode: next.model.mode,
							provider: next.model.provider ?? null,
							model: next.model.model ?? null,
							apiFormat: next.model.apiFormat ?? null,
							hasApiKey: Boolean(next.model.apiKey),
						},
					});
					if (validated.patch.quietHours) {
						// 就地改：scheduler 拿着同一个对象，isQuiet() 立刻按新时段判断
						Object.assign(scheduler.quietHours, next.quietHours);
						// 这里**不能**复用 breath.paused：那条事件的含义是"用户让它安静"，
						// 复用会让"从日志恢复暂停"把它误读成暂停（评审指出）。
						// 设置改动本身已经由上面的 settings.changed 记下来了。
					}
					if (validated.patch.proactive) proactive = { ...next.proactive };
					let restarted = false;
					// 只有**真的换了模型**才重启引擎：同一个值重复保存不该把引擎反复杀掉
					// （真实发生：3 秒内点 4 次保存 → 引擎重启 4 次）
					const modelChanged = Boolean(
						validated.patch.model &&
							(before.model.mode !== next.model.mode ||
								before.model.provider !== next.model.provider ||
								before.model.model !== next.model.model ||
								before.model.apiFormat !== next.model.apiFormat ||
								before.model.baseUrl !== next.model.baseUrl ||
								before.model.apiKey !== next.model.apiKey),
					);
					if (modelChanged) {
						// 模型改了就换引擎：停掉旧的 pi，按新设置起一个
						restartingAgent = true;
						stopAgent();
						startAgent();
						restartingAgent = false;
						restarted = true;
						if (breath) journal.append("presence.changed", { state: scheduler.isQuiet() ? "quiet" : "breathing" });
						journal.append("system.problem", {
							code: "model.changed",
							userMessage: `模型已换成 ${next.model.mode === "custom" ? `${next.model.model}（${next.model.apiFormat}）` : `${next.model.provider}/${next.model.model}`}`,
						});
					} else if (validated.patch.model) {
						journal.append("settings.changed", { note: "模型字段提交了但值没变，未重启引擎", source: parsed.source ?? "unknown" });
					}
					return {
						applied: true,
						piRestarted: restarted,
						modelChanged,
						piAvailable: Boolean(breath),
						describe: describeSettings(next),
						quietHours: { ...scheduler.quietHours },
						proactive: { ...proactive },
					};
				}

				if (parsed.type === "voice.transcript") {
					// 只认日志里真实存在的那段语音——补写不是"新建"，不能拿它当写文件的入口。
					// 注意：必须扫日志，不能查 journal.events（那只是内存滑窗，有检查点时更短）。
					const known = scanVoice(parsed.file).recorded.length > 0;
					if (!known) throw new Error("日志里没有这段语音，无法补写转写");
					const outcome = journal.applyCommand({
						id: parsed.id,
						produce: () => [{ type: "voice.transcribed" as const, data: { file: parsed.file, transcript: parsed.transcript } }],
					});
					if (outcome.duplicate) return { duplicate: true, result: outcome.result };
					return { duplicate: false, file: parsed.file, transcript: parsed.transcript };
				}

				if (parsed.type === "breath.pause" || parsed.type === "breath.resume") {
					return applyPause(parsed);
				}

				// wake.now：**显式的人工动作**——用户的意图高于一切日程。
				// 既能解除暂停，也能越过安静时段：夜里人就在屏幕前想说话，
				// 让它"等早上七点"是把日程摆在了人前面（真实用户反馈：点了叫醒没反应）。
				// 自动呼吸、以及普通留言，仍然照旧遵守安静时段。
				if (scheduler.activePause(pause)) {
					pause = null;
					journal.append("breath.resumed", { reason: "用户显式叫醒" });
				}
				const overrodeQuiet = scheduler.isQuiet();
				if (timer) clearTimeout(timer);
				void runBreath("wake");
				return overrodeQuiet ? { deferred: false, overrodeQuiet: true } : { deferred: false };
			},
		},
	});
	published.length = 0;
	await rpc.start();

	// ─── 5. 开门：安排第一拍（有待处理留言就立刻补上） ───
	const state = tracker.state;
	if (state.pendingMessages.length > 0 && !scheduler.isQuiet()) {
		log(`[core] 恢复 ${state.pendingMessages.length} 条待处理留言，立即呼吸`);
		void runBreath("recovered-queue");
	} else {
		scheduleNext();
	}

	log(`[core] 就绪：home=${homeDir} seq=${journal.seq} pi=${breath ? "常驻" : "未启动"}`);

	return {
		homeDir,
		socketPath,
		journal,
		importReports,
		status: () => ({ ...tracker.state, companionName, ...activityFacts() }),
		snapshot: () => ({
			protocolVersion: PROTOCOL_VERSION,
			seq: journal.seq,
			state: { ...tracker.state, companionName, ...activityFacts() },
			imports: importReports,
			piAvailable: Boolean(breath),
			setup: inspectSetup(homeDir, piBin, Boolean(breath), scheduler.quietHours),
		}),
		breathNow: (trigger = "manual") => runBreath(trigger),
		stop() {
			stopped = true;
			// 干净退出时落一个检查点：下次启动几乎瞬间就绪
			journal.writeCheckpoint();
			if (timer) clearTimeout(timer);
			pi?.stop();
			gateway.close();
			rpc?.close();
			journal.close();
		},
	};
}

// ─── CLI ───

const invokedDirectly = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");
if (invokedDirectly) {
	const quietStart = process.env.SPRITE_QUIET_START ? Number(process.env.SPRITE_QUIET_START) : 23;
	const quietEnd = process.env.SPRITE_QUIET_END ? Number(process.env.SPRITE_QUIET_END) : 7;

	// 调试/演示用：覆盖 pi 的参数与 HOME（产品运行时不需要）
	let piArgs: string[] | undefined;
	if (process.env.SPRITE_PI_ARGS) {
		try {
			const parsed = JSON.parse(process.env.SPRITE_PI_ARGS) as unknown;
			if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) piArgs = parsed;
		} catch {
			console.error("[core] SPRITE_PI_ARGS 不是合法 JSON 数组，已忽略");
		}
	}

	const kernel = await startKernel({
		homeDir: process.env.SPRITE_HOME,
		socketPath: process.env.SPRITE_SOCKET,
		piBin: process.env.SPRITE_PI_BIN,
		piArgs,
		piEnv: process.env.SPRITE_PI_HOME ? { HOME: process.env.SPRITE_PI_HOME } : undefined,
		disableAgent: process.env.SPRITE_NO_PI === "1",
		intervalMs: process.env.SPRITE_INTERVAL_MS ? Number(process.env.SPRITE_INTERVAL_MS) : undefined,
		quietHours: { start: quietStart, end: quietEnd },
		log: (message) => console.log(message),
	});
	const shutdown = () => {
		console.log("[core] 收到退出信号，收尾中");
		kernel.stop();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
