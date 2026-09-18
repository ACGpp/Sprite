/**
 * 它叫什么：必须从 identity.md 读出来，绝不能用占位名写进用户的记忆。
 * 运行：node --test core/identity.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { readCompanionName } from "./identity.ts";

const ROOT = path.join(process.cwd(), ".core-test");

function makeHome(name: string, identity: string | null, mailbox = ""): string {
	const home = path.join(ROOT, name);
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
	if (identity !== null) fs.writeFileSync(path.join(home, "identity.md"), identity);
	if (mailbox) fs.writeFileSync(path.join(home, "conversations", "mailbox.md"), mailbox);
	return home;
}

test("从我叫…读出名字", () => {
	const home = makeHome("identity-intro", '# 我是谁\n\n我叫零号。名字是他起的——"从零开始"。\n');
	assert.equal(readCompanionName(home), "零号");
});

test("没有自述时退回一级标题，且跳过栏目名", () => {
	const home = makeHome("identity-heading", "# 我是谁\n\n一个安静的个体。\n");
	assert.equal(readCompanionName(home), "守护灵", "「我是谁」是栏目名，不能当名字");

	const named = makeHome("identity-heading-name", "# 小满\n\n我是小满。\n");
	assert.equal(readCompanionName(named), "小满");
});

test("都没有时从 mailbox 的说话人推断", () => {
	const home = makeHome(
		"identity-mailbox",
		null,
		"[2026/06/20 18:39] 零号: 第一句\n[2026/06/20 19:39] 用户: 回一句\n[2026/06/20 20:39] 零号: 第二句\n",
	);
	assert.equal(readCompanionName(home), "零号", "出现最多的非『用户』说话人就是它");
});

test("全新安装：没有 identity 也没有 mailbox 时给出占位名（不崩）", () => {
	const home = makeHome("identity-empty", null);
	assert.equal(readCompanionName(home), "守护灵");
});

test("真实记忆（本机有的话）：能读出名字，且不是占位名", () => {
	// 这里**不许写死任何具体的名字**：每个实例都是独立个体，公开仓库里没有"第一个"。
	const real = path.join(process.env.HOME ?? "", ".claude-memory");
	if (!fs.existsSync(path.join(real, "identity.md"))) return;
	const name = readCompanionName(real);
	assert.ok(name.length > 0, "有 identity.md 就该读出名字");
	assert.notEqual(name, "守护灵", "有 identity.md 就不该退回占位名");
});
