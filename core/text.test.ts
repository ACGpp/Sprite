/**
 * 文本卫生与截断的单测。
 * 运行：node --test core/text.test.ts
 *
 * 这些函数是上一轮"半个 emoji 让界面全黑"事故的修复核心，
 * 但它们此前只被间接覆盖（经由 journal 的写入路径）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeDeep, sanitizeText, truncate } from "./text.ts";

const isWellFormed = (text: string) => Buffer.from(text, "utf8").toString("utf8") === text;

test("sanitizeText：孤立代理项换成 U+FFFD，合法代理对原样保留", () => {
	const emoji = "🌊";
	const broken = emoji.slice(0, 1); // 只取高位代理
	assert.ok(!isWellFormed(broken), "前提：这个切片本身是非法的");

	assert.equal(sanitizeText(broken), "\uFFFD");
	assert.equal(sanitizeText(emoji), emoji, "合法 emoji 必须无损");
	assert.equal(sanitizeText(`潮汐${broken}月亮`), "潮汐\uFFFD月亮");
	assert.equal(sanitizeText("普通中文 abc 123"), "普通中文 abc 123");
	assert.ok(isWellFormed(sanitizeText(`a${broken}b${broken}c`)));
});

test("truncate：按码点截断，绝不在字符中间下刀", () => {
	const text = "潮汐与月亮🌊🌙还有别的";
	assert.equal(truncate("很短", 10), "很短", "短于上限时原样返回");
	assert.equal(truncate("", 5), "");

	const cut = truncate(text, 5);
	assert.equal(cut, "潮汐与月亮…", "五个码点 + 省略号");
	assert.ok(isWellFormed(cut), "截断结果必须合法");

	// 关键：无论上限落在哪里，都不能产生孤立代理项
	for (let limit = 1; limit <= Array.from(text).length; limit++) {
		const piece = truncate(text, limit);
		assert.ok(isWellFormed(piece), `上限 ${limit} 时产生了非法 Unicode: ${JSON.stringify(piece)}`);
		assert.ok(Array.from(piece).length <= limit + 1, "不得超出上限太多（+省略号）");
	}
});

test("sanitizeDeep：递归清洗任意 JSON，且不改动结构", () => {
	const dirty = {
		text: `看这个${"🌊".slice(0, 1)}`,
		nested: { list: [`${"🌙".slice(0, 1)}月亮`, "干净的"], n: 42, flag: true, nil: null },
	};
	const clean = sanitizeDeep(dirty);
	assert.ok(isWellFormed(clean.text));
	assert.ok(isWellFormed(clean.nested.list[0]));
	assert.equal(clean.nested.list[1], "干净的");
	assert.equal(clean.nested.n, 42, "数字不能变");
	assert.equal(clean.nested.flag, true, "布尔不能变");
	assert.equal(clean.nested.nil, null, "null 不能丢");
	assert.equal(JSON.stringify(clean).includes("\uFFFD"), true, "非法部分应被替换而不是整条丢弃");
});
