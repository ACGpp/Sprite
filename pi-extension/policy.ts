/**
 * 能力网关的**纯策略**：不依赖 pi、不依赖 typebox，因此可以被直接测试。
 *
 * 为什么单独一个文件：策略代码原来和在 pi 扩展里，而 pi 运行时提供的 typebox
 * 在 Node 测试环境里不存在，于是**唯一执行能力策略的代码完全在静态检查与测试之外**
 * （评审第 7 节第 3 条）。抽出来之后：可 import、可单测、可进 tsconfig。
 */

import fs from "node:fs";
import path from "node:path";

export const ALLOWED_ROOTS = (process.env.SPRITE_ALLOWED_ROOTS ?? "")
	.split(":")
	.filter(Boolean);

export const MAX_SAYS_PER_RUN = 3;

/**
 * 路径是否落在允许的根里。
 *
 * 老实现只折叠 `//` 与 `/./`，**不解析 `..`、不展开 `~`、不看符号链接**，
 * 而 pi 侧的 `resolveToCwd` 会 `expandPath(~)` + `path.resolve(..)` 之后再写。
 * 策略放行、执行展开——合起来就是一次真实越界写入（评审给出的例子：
 * 允许根里的 `../../../etc/passwd` 这种）。
 *
 * 现在：
 *   1. 拒绝 `~`（pi 会把它展开成家目录，我们无法在策略侧知道展开结果）；
 *   2. `path.resolve` 归一化 `..`（相对路径按 cwd 解析）；
 *   3. 对**最近存在的祖先**做 `realpath`，挡掉"符号链接指到外面"；
 *   4. 必须严格落在 `root + 分隔符` 之下（相等也算）。
 */
export function inAllowedRoot(filePath: string, cwd: string = process.cwd()): boolean {
	if (ALLOWED_ROOTS.length === 0) return true; // 未配置 = 不限制（仅用于开发）
	if (!filePath) return false;
	// pi 侧会 expandPath(~) 再写：策略侧无法预知它展开成什么，所以直接拒绝
	if (filePath === "~" || filePath.startsWith("~/")) return false;

	const absolute = path.resolve(cwd, filePath);
	// 找到**最近存在的祖先**做 realpath（文件还不存在时 realpath 会失败），
	// 再把不存在的那几段拼回去比较。这样 `..` 与符号链接都挡得住。
	let probe = absolute;
	let suffix = "";
	for (let depth = 0; depth < 64; depth += 1) {
		try {
			const real = fs.realpathSync(probe);
			const resolved = suffix ? path.join(real, suffix) : real;
			return ALLOWED_ROOTS.some((root) => {
				const rootReal = realpathOrSelf(root);
				const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
				return resolved === rootReal || resolved.startsWith(prefix);
			});
		} catch {
			const parent = path.dirname(probe);
			if (parent === probe) return false;
			suffix = suffix ? path.join(path.basename(probe), suffix) : path.basename(probe);
			probe = parent;
		}
	}
	return false;
}

/**
 * 绝不能读的文件：它自己的密钥、内核运行时与日志。
 *
 * 读工具在网关里是"放行但留痕"的，但**没有哪条正当理由需要它读自己的 API key**。
 * 同 UID + bash 仍然是更大的洞（评审 C3/C4），这一条只是把"我们主动递钥匙"堵掉。
 */
const SECRET_PATTERNS = [
	/(^|\/)config\/(settings\.json|llm\.conf)$/,
	/(^|\/)journal\//,
	/(^|\/)runtime\//,
	/(^|\/)sessions\//,
];

export function isSecretPath(filePath: string, cwd: string = process.cwd()): boolean {
	if (!filePath) return false;
	const absolute = path.resolve(cwd, filePath);
	return SECRET_PATTERNS.some((pattern) => pattern.test(absolute));
}

function realpathOrSelf(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return target;
	}
}

export const DANGEROUS_BASH = [
	/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
	/\bsudo\b/i,
	/\bcurl\b[^|]*\|\s*(ba)?sh/i,
	/\bwget\b[^|]*\|\s*(ba)?sh/i,
	/\bchmod\b.*\b777\b/,
	/\b(mkfs|diskutil)\b.*\b(erase|reformat)/i,
	/>\s*\/dev\/(disk|rdisk)/,
	/\b(shutdown|reboot|halt)\b/,
];

