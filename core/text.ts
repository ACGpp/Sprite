/**
 * 文本卫生：确保任何写进 journal 的字符串都是合法 Unicode，并且能产生合法 JSON。
 *
 * 为什么需要它（真实事故）：内核为了审计把工具参数截断到 200 字符，
 * 若截断点正好落在 emoji 中间，就会留下一个孤立代理项（lone surrogate，如 \uD83C）。
 * `JSON.stringify` 会把它写成 `"\uD83C"` —— 这在 JSON 规范里是**非法**的。
 * Node 的 JSON.parse 容忍它，但 Swift 的 JSONDecoder / JSONSerialization 会直接报错，
 * 于是**一条被截断的审计字符串会让整个界面读不到状态**。
 *
 * 所以卫生检查必须放在唯一写入者的边界上：无论谁传进来什么，出去的都是合法 JSON。
 */

/** 把孤立代理项替换成 U+FFFD；合法代理对保持原样。 */
/**
 * 上海时区的小时 / 日期。
 *
 * 为什么必须有它：安静时段是**产品语义**（面板上写着 23:00–07:00），
 * 而 `getHours()` 读的是机器本地时区。用户在 UTC 或别的时区的机器上跑，
 * 界面写 23:00 而实际在别的钟点静默——实测 `TZ=UTC` 下调度器测试 2 项失败。
 */
const SHANGHAI_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false });
const SHANGHAI_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

export function hourInShanghai(date: Date): number {
	return Number(SHANGHAI_HOUR.format(date)) % 24;
}

/** YYYY-MM-DD（上海） */
export function dayInShanghai(date: Date): string {
	return SHANGHAI_DAY.format(date);
}

export function sanitizeText(input: string): string {
	let output = "";
	for (let index = 0; index < input.length; index++) {
		const code = input.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			// 高位代理：必须紧跟一个低位代理
			const next = input.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				output += input[index] + input[index + 1];
				index += 1;
			} else {
				output += "\uFFFD";
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			// 落单的低位代理
			output += "\uFFFD";
		} else {
			output += input[index];
		}
	}
	return output;
}

/** 递归清洗任意 JSON 值里的字符串。 */
export function sanitizeDeep<T>(value: T): T {
	if (typeof value === "string") return sanitizeText(value) as unknown as T;
	if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item)) as unknown as T;
	if (value && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			output[sanitizeText(key)] = sanitizeDeep(item);
		}
		return output as unknown as T;
	}
	return value;
}

/**
 * 按**码点**截断，绝不在字符中间下刀。
 * 比 `String.prototype.slice` 贵一点，但它永远不会制造非法 Unicode。
 */
export function truncate(input: string, maxChars: number): string {
	const points = Array.from(input);
	if (points.length <= maxChars) return input;
	return `${points.slice(0, maxChars).join("")}…`;
}
