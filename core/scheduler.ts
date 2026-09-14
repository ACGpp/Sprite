import { hourInShanghai } from "./text.ts";
/**
 * 调度：下一次呼吸什么时候发生。
 *
 * 节奏是它的生理，不是 UI 的动画参数——所以 nextBreathAt 必须存在事件里，
 * 并且 UI 显示的数字与这里算出来的必须是同一个（§5 验收标准 5）。
 *
 * 规则：
 *   - 默认 5 分钟；安静时段 30 分钟
 *   - 它可以自己改下一次间隔（30s–6h 限幅）
 *   - 用户可以暂停（1h / 今晚 / 直到手动继续）
 *   - 连跑两次就说明有问题：失败后按退避重排，而不是疯狂重试
 */

export type QuietHours = { start: number; end: number };

export type SchedulerOptions = {
	intervalMs?: number;
	quietIntervalMs?: number;
	quietHours?: QuietHours;
	now?: () => Date;
};

export const MIN_INTERVAL_MS = 30_000;
export const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000];

/** 无限期暂停时多久"看一眼表"（暂停期间不叫引擎，这个节奏只影响排期事件的数量）。 */
export const PAUSED_CHECK_MS = 30 * 60_000;

export function isQuietAt(date: Date, hours: QuietHours): boolean {
	// 按 Asia/Shanghai 判断：安静时段是产品语义（界面写 23:00–07:00），
	// 不能用机器本地时区——否则换个时区就"界面说 23 点、实际在别的钟点静默"
	const hour = hourInShanghai(date);
	if (hours.start === hours.end) return false;
	if (hours.start < hours.end) return hour >= hours.start && hour < hours.end;
	return hour >= hours.start || hour < hours.end;
}

export function clampInterval(ms: number): number {
	if (!Number.isFinite(ms)) return MIN_INTERVAL_MS;
	return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}

export type Pause = { until: number | null } | null; // null = 无限期（直到手动继续）

export type Scheduler = {
	/** 当前的安静时段设置（只读，供设置面板如实展示） */
	readonly quietHours: QuietHours;
	/** 计算下一次该在什么时候醒来，并给出理由（用于 UI 如实解释）。 */
	next(input: { consecutiveFailures: number; pause: Pause; requestedIntervalMs?: number }): {
		at: string;
		intervalMs: number;
		quiet: boolean;
		reason: "interval" | "quiet" | "self-requested" | "backoff" | "paused";
	};
	isQuiet(): boolean;
	/** 暂停是否还有效（到期自动失效）。 */
	activePause(pause: Pause): Pause;
};

export function createScheduler(options: SchedulerOptions = {}): Scheduler {
	const {
		intervalMs = 5 * 60_000,
		quietIntervalMs = 30 * 60_000,
		quietHours = { start: 23, end: 7 },
		now = () => new Date(),
	} = options;

	const scheduler: Scheduler = {
		quietHours,

		isQuiet() {
			return isQuietAt(now(), quietHours);
		},

		activePause(pause) {
			if (!pause) return null;
			if (pause.until === null) return pause;
			return pause.until > now().getTime() ? pause : null;
		},

		next({ consecutiveFailures, pause, requestedIntervalMs }) {
			const current = now();
			const quiet = isQuietAt(current, quietHours);

			if (scheduler.activePause(pause)) {
				// 无限期暂停（"直到我说继续"）不需要每 5 分钟醒一次看表：
				// 定时拍在暂停期间本来就是空转（不叫引擎），排得稀一点，日志也干净。
				const until = pause?.until ?? current.getTime() + PAUSED_CHECK_MS;
				return {
					at: new Date(until).toISOString(),
					intervalMs: Math.max(0, until - current.getTime()),
					quiet,
					reason: "paused",
				};
			}

			if (consecutiveFailures > 0) {
				const backoff = BACKOFF_STEPS_MS[Math.min(consecutiveFailures - 1, BACKOFF_STEPS_MS.length - 1)];
				return { at: new Date(current.getTime() + backoff).toISOString(), intervalMs: backoff, quiet, reason: "backoff" };
			}

			if (typeof requestedIntervalMs === "number") {
				const interval = clampInterval(requestedIntervalMs);
				return { at: new Date(current.getTime() + interval).toISOString(), intervalMs: interval, quiet, reason: "self-requested" };
			}

			const interval = quiet ? quietIntervalMs : intervalMs;
			return { at: new Date(current.getTime() + interval).toISOString(), intervalMs: interval, quiet, reason: quiet ? "quiet" : "interval" };
		},
	};

	return scheduler;
}
