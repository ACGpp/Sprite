/**
 * journal：追加式事件日志 —— 运行时的唯一事实来源。
 *
 * 不变量（每条都有测试）：
 *   1. 单一写入者：独占锁；第二个写入者必须被拒绝
 *   2. 幂等：同一 commandId 只生效一次，重启后依然判重
 *   3. 可恢复：seq 从日志恢复，重启不重置、不重复
 *   4. 抗撕裂：未写完的尾行必须被丢弃**并截断修复**（只丢弃会让 O_APPEND
 *      把下一条事件粘在垃圾后面，导致新事件一起丢失）
 *
 * 每天一个文件（UTC），恢复时按文件名顺序读取全部。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseJournalEvent, type EventType, type JournalEvent } from "../contracts/events.ts";
import { dayInShanghai, sanitizeDeep } from "./text.ts";

export type TornTail = { file: string; bytes: number; preview: string };

export type JournalOptions = {
	dir: string;
	/** true 时获取独占锁（内核必须为 true；只读工具可省略）。 */
	exclusive?: boolean;
	/** 每条事件后 fsync（默认 true；测试可关掉以提速）。 */
	fsync?: boolean;
	now?: () => Date;
	/** 每次 append 后回调（RPC 广播、投影、指标都挂在这里）。回调抛错不得影响写入。 */
	onAppend?: (event: JournalEvent) => void;
	/** 恢复扫描时对**每一条**历史事件回调一次（用于建读模型基线，不必把它们留在内存）。 */
	onRecover?: (event: JournalEvent) => void;
	/** 检查点载荷（读模型快照）。由调用方提供，journal 只负责存取与校验。 */
	checkpointPayload?: () => unknown;
	/**
	 * 从检查点恢复时回调。**返回 false 表示拒收**（例如快照字段结构已经变了）——
	 * 此时必须退回全量重扫，否则读模型会缺字段（真实事故：新增字段后思维流整段消失）。
	 */
	onCheckpoint?: (payload: unknown) => boolean;
	/**
	 * 内存里保留多少条事件。
	 *
	 * 为什么要窗口：日志按年增长。全留内存实测约 1.7KB/条，
	 * 一年 70 万条 ≈ 1.2GB。而内存里的事件只服务于"断线续传"，
	 * 而续传的调用方总是先拉快照、再从快照的 seq 订阅——只需要最近的。
	 */
	eventWindow?: number;
};

export type CommandOutcome = {
	applied: boolean;
	duplicate: boolean;
	result?: Record<string, unknown>;
	events?: JournalEvent[];
};

export type Journal = {
	readonly dir: string;
	readonly filePath: string;
	readonly seq: number;
	readonly events: readonly JournalEvent[];
	readonly tornTails: readonly TornTail[];
	/** 落一个检查点：下次启动只需折叠它之后的事件。返回是否写入成功。 */
	writeCheckpoint(): boolean;
	/** 本次启动是否用上了检查点（诊断/测试用） */
	readonly usedCheckpoint: boolean;
	/** 本次启动为恢复折叠了多少条事件（诊断/测试用） */
	readonly recoveredEvents: number;
	/** 导入游标（恢复扫描时建好，不受内存事件窗口影响） */
	cursorFor(source: string, file: string): { offset: number; prefixHash: string; line: number } | null;
	/** 这个来源已经导入到的绝对行号（-1 = 一行都没有） */
	importedLineFor(source: string): number;
	/** 所有权交接标记（同上） */
	hasOwnershipHandoff(file: string): boolean;
	append(type: EventType, data: Record<string, unknown>, causeId?: string): JournalEvent;
	applyCommand(input: {
		id: string;
		produce: () => Array<{ type: EventType; data: Record<string, unknown> }>;
	}): CommandOutcome;
	close(): void;
};

/**
 * 日志文件的"天"用**上海日**，和产品里其它所有"今天/昨天"（主动额度、安静时段、
 * 记录窗口的分组）保持一致——否则界面上说"昨天"，文件却按 UTC 分到另一天。
 */
function dayStamp(date: Date): string {
	return dayInShanghai(date);
}

export function openJournal(options: JournalOptions): Journal {
	const {
		dir,
		exclusive = false,
		fsync = true,
		now = () => new Date(),
		onAppend,
		onRecover,
		checkpointPayload,
		onCheckpoint,
		eventWindow = 2000,
	} = options;
	const journalDir = path.join(dir, "journal");
	fs.mkdirSync(journalDir, { recursive: true });

	// ─── 1. 独占锁 ───
	const lockPath = path.join(journalDir, "journal.lock");
	if (exclusive) {
		/**
		 * 抢锁必须是**一个原子动作**。
		 *
		 * 老写法是 check-then-act（先读锁文件、再写自己的 pid），两个进程可能同时通过
		 * "没人占"的检查、然后各写一次——评审指出这条窗口（它实测 1/6 复现，
		 * 比子评审说的窄，但缺陷是真的）。现在用 `wx`（O_CREAT|O_EXCL）：
		 * 要么创建成功拿下锁，要么说明已经有人占了。
		 */
		const claim = (): void => {
			const fd = fs.openSync(lockPath, "wx");
			try {
				fs.writeSync(fd, String(process.pid));
			} finally {
				fs.closeSync(fd);
			}
		};
		try {
			claim();
		} catch {
			// 已经有人写了锁：看它还活着没有。活着就认输，死了（崩溃残留）就接管。
			let heldBy: number | null = null;
			try {
				heldBy = Number(fs.readFileSync(lockPath, "utf8").trim());
			} catch {
				heldBy = null;
			}
			let alive = false;
			if (heldBy && Number.isInteger(heldBy)) {
				try {
					process.kill(heldBy, 0);
					alive = true;
				} catch {
					alive = false;
				}
			}
			if (alive) throw new Error(`journal 已被 pid ${heldBy} 占用（同一时刻只允许一个写入者）`);
			// 残留锁：原子地换掉它（先删再抢，抢不到就认输）
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// 别人抢先删了也无妨
			}
			try {
				claim();
			} catch {
				throw new Error("journal 锁竞争失败：另一个内核刚刚接管了它");
			}
		}
	}

	// ─── 3+4. 恢复：优先用检查点，否则折叠全部历史 ───
	const files = fs
		.readdirSync(journalDir)
		.filter((name) => name.endsWith(".jsonl"))
		// 按**文件里第一条事件的 seq** 排序，而不是按文件名：
		// 文件名排序在"有 last.jsonl 之类的非日期文件"时会乱序折叠，
		// 于是 run.started / run.finished 交错，读模型会凭空写一条假的 run.failed。
		// 拿不到首条 seq 就退回文件名顺序（老行为）。
		.map((name) => {
			let firstSeq = Number.MAX_SAFE_INTEGER;
			try {
				const raw = fs.readFileSync(path.join(journalDir, name), "utf8");
				for (const line of raw.split("\n")) {
					const at = line.indexOf('"seq":');
					if (at < 0) continue;
					const end = line.indexOf(",", at);
					const value = Number(line.slice(at + 6, end < 0 ? undefined : end));
					if (Number.isInteger(value)) {
						firstSeq = value;
						break;
					}
				}
			} catch {
				// 读不到就按文件名排
			}
			return { name, firstSeq };
		})
		.sort((a, b) => (a.firstSeq === b.firstSeq ? a.name.localeCompare(b.name) : a.firstSeq - b.firstSeq))
		.map((entry) => entry.name);

	/**
	 * 检查点：一份**可丢弃**的读模型快照，用来避免每次启动都解析整份历史
	 * （实测 20 万条 676ms，一年约 2.4 秒——菜单栏应用等不起）。
	 *
	 * 安全性规则（任何一条不满足就整份重扫，绝不猜）：
	 *   1. 校验和不匹配 → 丢弃
	 *   2. 快照的 seq 在日志里找不到对应位置（日志被删/被截断）→ 丢弃
	 *   3. 解析失败 → 丢弃
	 * 原始日志永远是唯一事实来源，检查点只是加速器。
	 */
	type Checkpoint = {
		seq: number;
		/** 写入检查点时 journal 的总体积。日志只会增长；**变小就说明有人改过日志** */
		journalBytes: number;
		checksum: string;
		appliedCommands: Array<[string, Record<string, unknown>]>;
		cursors: Array<[string, { offset: number; prefixHash: string; line: number }]>;
		/** 每个来源"已经导入到第几行"（来自导入事件自带的行号标签） */
		importLines: Array<[string, number]>;
		handoffs: string[];
		payload: unknown;
	};
	const checkpointPath = path.join(journalDir, "checkpoint.json");
	let checkpoint: Checkpoint | null = null;
	try {
		const raw = fs.readFileSync(checkpointPath, "utf8");
		const parsed = JSON.parse(raw) as Checkpoint;
		const body = JSON.stringify({ ...parsed, checksum: undefined });
		const expected = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
		if (parsed.checksum === expected && Number.isInteger(parsed.seq) && parsed.seq > 0) checkpoint = parsed;
		// 日志只会增长。若当前体积比检查点记录的还小，说明日志被删改过——
		// 此时检查点是"上一份内容的快照"，用它就会把已删除的东西复活（真实事故）。
		if (checkpoint && journalBytesOnDisk() < checkpoint.journalBytes) {
			checkpoint = null;
		}
	} catch {
		checkpoint = null;
	}
	const events: JournalEvent[] = [];
	const tornTails: TornTail[] = [];
	const appliedCommands = new Map<string, Record<string, unknown>>();
	// 持久索引：从全部历史里建，但只留很小的结果（不随日志增长）
	const cursors = new Map<string, { offset: number; prefixHash: string; line: number }>();
	/**
	 * 每个来源已导入到的**绝对行号**。
	 *
	 * 为什么需要它：导入是"逐条 append + 最后写游标"。如果崩在中途，游标还没写，
	 * 下次会把整段重新导入一遍（留言翻倍，评审 M2）。现在每条导入事件自带
	 * `importSource` + `importLine` 标签，恢复扫描时取最大值 → 断点精确到行，
	 * 不需要额外事件、也不会重复或丢失。
	 */
	const importLines = new Map<string, number>();
	const handoffs = new Set<string>();
	let seq = 0;

	// 检查点必须对应日志里真实存在的位置——否则（日志被删/被截断）整份重扫
	let checkpointUsable = false;
	if (checkpoint) {
		const lastSeqOnDisk = readLastSeq(files, journalDir);
		checkpointUsable = lastSeqOnDisk >= checkpoint.seq;
		if (checkpointUsable) {
			seq = checkpoint.seq;
			for (const [id, result] of checkpoint.appliedCommands) appliedCommands.set(id, result);
			for (const [key, value] of checkpoint.cursors) cursors.set(key, { offset: value.offset, prefixHash: value.prefixHash, line: value.line ?? 0 });
			for (const [key, value] of checkpoint.importLines ?? []) importLines.set(key, value);
			for (const file of checkpoint.handoffs) handoffs.add(file);
			const accepted = onCheckpoint ? onCheckpoint(checkpoint.payload) : true;
			if (!accepted) {
				// 快照用不了：把从它恢复的一切清掉，老老实实重扫
				seq = 0;
				appliedCommands.clear();
				cursors.clear();
				handoffs.clear();
				importLines.clear();
				checkpointUsable = false;
			}
		}
	}
	let recoveredEvents = 0;

	for (const name of files) {
		// 整个文件都在检查点之前 → 连读都不用读（这才是启动时间的大头）。
		// tailSeq 返回 null 表示"尾部读不出 seq"（例如最后一行超过 8KB）——
		// 这种情况**必须读这个文件**，否则会静默跳过一整天的事件。
		const tail = tailSeq(name, journalDir);
		if (checkpointUsable && checkpoint && tail !== null && tail <= checkpoint.seq) continue;
		const filePath = path.join(journalDir, name);
		const raw = fs.readFileSync(filePath, "utf8");
		const lastNewline = raw.lastIndexOf("\n");
		const validPrefix = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : "";
		if (validPrefix.length !== raw.length) {
			tornTails.push({
				file: name,
				bytes: Buffer.byteLength(raw.slice(validPrefix.length), "utf8"),
				preview: raw.slice(validPrefix.length, validPrefix.length + 80),
			});
			fs.truncateSync(filePath, Buffer.byteLength(validPrefix, "utf8"));
		}
		for (const line of validPrefix.split("\n")) {
			if (!line.trim()) continue;
			// 快速预筛：检查点之前的行不必 JSON.parse（这是启动时间的大头）
			if (checkpointUsable && checkpoint) {
				const seqAt = line.indexOf('"seq":');
				if (seqAt >= 0) {
					const end = line.indexOf(",", seqAt);
					const value = Number(line.slice(seqAt + 6, end < 0 ? undefined : end));
					if (Number.isInteger(value) && value <= checkpoint.seq) continue;
				}
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // 已被截断修复覆盖；这里只防御性跳过
			}
			const event = parseJournalEvent(parsed);
			if (!event) continue;
			// 读取时也做卫生处理：修复之前版本写坏的日志（自愈），
			// 否则历史上一条被截断的 emoji 会永远让消费者解析失败。
			event.data = sanitizeDeep(event.data);
			if (event.seq > seq) seq = event.seq;
			indexEvent(event);
			// 基线：让调用方逐条折叠（不必把历史留在内存）
			onRecover?.(event);
			recoveredEvents += 1;
			// 内存只留滑动尾巴
			events.push(event);
			if (events.length > eventWindow) events.splice(0, events.length - eventWindow);
		}
	}

	// 日志**按天一个文件**，而且要在跨过零点时换文件。
	// 老实现只在启动那一刻算一次路径，于是长期运行的内核把好几天写进同一个文件
	// （真实事故：文件叫 2026-09-12.jsonl，里面却装着 09-14 的事件；
	//  依赖"按文件名倒序找最新"的逻辑——恢复暂停、早上交回收着的话——都会看错）。
	let currentStamp = dayStamp(now());
	let fd = fs.openSync(path.join(journalDir, `${currentStamp}.jsonl`), "a");
	let closed = false;

	/** 跨天就换文件（同一天不重复 open）。 */
	function rotateIfNeeded(): void {
		const stamp = dayStamp(now());
		if (stamp === currentStamp) return;
		fs.closeSync(fd);
		currentStamp = stamp;
		fd = fs.openSync(path.join(journalDir, `${stamp}.jsonl`), "a");
	}

	/**
	 * 日志里最大的 seq（用于校验检查点是否仍然有效）。
	 *
	 * 只读每个文件的**尾部 8KB**：不能假设"文件名排序最后 = seq 最大"
	 * （那个假设被真实场景打破过：夹具的 last.jsonl 排在日期文件之后，
	 *  于是检查点被误判为失效，每次都退化成全量重扫）。
	 * 也不能整份读——那正是我们要避免的开销。
	 */
	function journalBytesOnDisk(): number {
		let total = 0;
		for (const name of fs.readdirSync(journalDir)) {
			if (!name.endsWith(".jsonl")) continue;
			try {
				total += fs.statSync(path.join(journalDir, name)).size;
			} catch {
				// 读不到就忽略
			}
		}
		return total;
	}

	/**
	 * 文件末尾最大的 seq。
	 *
	 * **必须区分"真的是 0"和"我读不出来"**：老实现两者都返回 0，
	 * 而调用方把 0 理解成"整份文件都在检查点之前"→ `continue` 跳过整个文件。
	 * 于是只要某文件最后一条事件 > 8KB（一条长思维流就够），尾部 8KB 全是那行的中段、
	 * 扫不到 `"seq":` → 返回 0 → **这一整天的事件对读模型永久不可见，而且 seq 会回退重号**。
	 * 返回 null 表示"不知道"，调用方必须老老实实读这个文件。
	 */
	function tailSeq(name: string, dirPath: string): number | null {
		const filePath = path.join(dirPath, name);
		let size = 0;
		try {
			size = fs.statSync(filePath).size;
		} catch {
			return 0;
		}
		if (size === 0) return 0;
		const start = Math.max(0, size - 8192);
		const length = size - start;
		const fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(length);
		try {
			fs.readSync(fd, buffer, 0, length, start);
		} finally {
			fs.closeSync(fd);
		}
		const lines = buffer.toString("utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const at = lines[i].indexOf('"seq":');
			if (at < 0) continue;
			const end = lines[i].indexOf(",", at);
			const value = Number(lines[i].slice(at + 6, end < 0 ? undefined : end));
			if (Number.isInteger(value)) return value;
		}
		// 尾部 8KB 里一个完整 seq 都没找到：可能最后一行太大了。**不许当成 0**。
		return null;
	}

	function readLastSeq(fileNames: string[], dirPath: string): number {
		let max = 0;
		for (const name of fileNames) {
			const value = tailSeq(name, dirPath) ?? 0;
			if (value > max) max = value;
		}
		return max;
	}

	/** 维护持久索引：恢复扫描与运行期追加都必须走这里，否则本会话写入的游标不会生效。 */
	function indexEvent(event: JournalEvent): void {
		if (event.type === "command.applied" && typeof event.data.commandId === "string") {
			appliedCommands.set(event.data.commandId, (event.data.result ?? {}) as Record<string, unknown>);
		}
		// 导入事件自带的位置标签：断点靠它精确到行。
		// **必须在下面那个 early return 之前**：带标签的事件大多是 message.in / thought.recorded，
		// 它们不是 legacy.imported，放到后面就永远读不到（这个错误被 M2 的回归测试当场抓住）。
		if (typeof event.data.importSource === "string" && typeof event.data.importLine === "number") {
			const key = event.data.importSource;
			const current = importLines.get(key);
			if (current === undefined || event.data.importLine > current) importLines.set(key, event.data.importLine);
		}
		if (event.type !== "legacy.imported") return;
		if (event.data.kind === "cursor" && typeof event.data.source === "string" && typeof event.data.file === "string") {
			cursors.set(`${event.data.source}\u0000${event.data.file}`, {
				offset: Number(event.data.offset ?? 0),
				prefixHash: String(event.data.prefixHash ?? ""),
				line: Number(event.data.line ?? 0),
			});
		}
		if (event.data.kind === "ownership.handoff" && typeof event.data.file === "string") {
			handoffs.add(event.data.file);
		}
	}

	function append(type: EventType, data: Record<string, unknown>, causeId?: string): JournalEvent {
		if (closed) throw new Error("journal 已关闭：拒绝写入（关停途中的在途事件不得污染日志）");
		const event: JournalEvent = {
			seq: ++seq,
			at: now().toISOString(),
			type,
			// 卫生检查放在唯一写入者的边界上：出去的事件必须是合法 JSON。
			// 否则一个被截断的 emoji 就能让 Swift 侧解析不了整份 status（真实事故）。
			data: sanitizeDeep(data),
			...(causeId ? { causeId: sanitizeDeep(causeId) } : {}),
		};
		rotateIfNeeded();
		fs.writeSync(fd, `${JSON.stringify(event)}\n`);
		if (fsync) fs.fsyncSync(fd);
		indexEvent(event);
		events.push(event);
		if (events.length > eventWindow) events.splice(0, events.length - eventWindow);
		if (onAppend) {
			try {
				onAppend(event);
			} catch {
				// 观察者出错不得影响唯一事实来源的写入
			}
		}
		return event;
	}

	return {
		dir: journalDir,
		/** 当前正在写的文件（会随跨天轮转变化，所以是 getter 而不是快照值）。 */
		get filePath() {
			return path.join(journalDir, `${currentStamp}.jsonl`);
		},
		get seq() {
			return seq;
		},
		get events() {
			return events;
		},
		get tornTails() {
			return tornTails;
		},
		get usedCheckpoint() {
			return checkpointUsable;
		},
		get recoveredEvents() {
			return recoveredEvents;
		},

		writeCheckpoint() {
			if (!checkpointPayload) return false;
			try {
				const body = {
					seq,
					journalBytes: journalBytesOnDisk(),
					appliedCommands: [...appliedCommands.entries()],
					cursors: [...cursors.entries()],
					importLines: [...importLines.entries()],
					handoffs: [...handoffs],
					payload: checkpointPayload(),
				};
				const checksum = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
				const tmp = `${checkpointPath}.tmp`;
				fs.writeFileSync(tmp, JSON.stringify({ ...body, checksum }));
				fs.renameSync(tmp, checkpointPath); // 原子替换：半截检查点永远不会被读到
				return true;
			} catch {
				return false; // 检查点只是加速器，写不进去不影响正确性
			}
		},

		cursorFor(source, file) {
			return cursors.get(`${source}\u0000${file}`) ?? null;
		},
		importedLineFor(source) {
			return importLines.get(source) ?? -1;
		},
		hasOwnershipHandoff(file) {
			return handoffs.has(file);
		},
		append,

		applyCommand({ id, produce }) {
			if (appliedCommands.has(id)) {
				return { applied: false, duplicate: true, result: appliedCommands.get(id) };
			}
			const written = produce().map((effect) => append(effect.type, effect.data, id));
			const result: Record<string, unknown> = { commandId: id, effects: written.length };
			append("command.applied", result, id);
			appliedCommands.set(id, result);
			return { applied: true, duplicate: false, result, events: written };
		},

		close() {
			if (closed) return;
			closed = true;
			fs.closeSync(fd);
			if (exclusive) {
				try {
					if (Number(fs.readFileSync(lockPath, "utf8").trim()) === process.pid) fs.unlinkSync(lockPath);
				} catch {
					// 锁文件已不在，忽略
				}
			}
		},
	};
}
