/**
 * 模型配置：解析正确、密钥不外泄。
 * 运行：node --test core/config.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { describeLlmConfig, piModelArgs, readLlmConfig } from "./config.ts";

const ROOT = path.join(process.cwd(), ".core-test");

function writeConfig(name: string, body: string): string {
	const home = path.join(ROOT, name);
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(home, "config"), { recursive: true });
	fs.writeFileSync(path.join(home, "config", "llm.conf"), body);
	return home;
}

test("配置解析：与 v1 的 bash KEY=value 格式一致", () => {
	const home = writeConfig(
		"config-parse",
		'LLM_TOOL=pi\nPI_PROVIDER=anthropic\nPI_MODEL=claude-sonnet-4-5\nPI_API_KEY="sk-secret-value"\nQUIET_START=22\nQUIET_END=8\n# 注释行\nUNKNOWN_KEY=忽略我\n',
	);
	const config = readLlmConfig(home);
	assert.equal(config.tool, "pi");
	assert.equal(config.provider, "anthropic");
	assert.equal(config.model, "claude-sonnet-4-5");
	assert.equal(config.apiKey, "sk-secret-value", "引号必须被剥掉");
	assert.equal(config.quietStart, 22);
	assert.equal(config.quietEnd, 8);

	const args = piModelArgs(config);
	assert.deepEqual(args, ["--provider", "anthropic", "--model", "claude-sonnet-4-5", "--api-key", "sk-secret-value"]);
});

test("配置缺失或残缺都不致命", () => {
	const empty = path.join(ROOT, "config-missing");
	fs.rmSync(empty, { recursive: true, force: true });
	fs.mkdirSync(empty, { recursive: true });
	const config = readLlmConfig(empty);
	assert.equal(config.tool, "pi", "默认用 pi");
	assert.deepEqual(piModelArgs(config), [], "没有配置就不传参数，交给 pi 自己的设置");
});

test("可打印的描述绝不包含密钥本身", () => {
	const home = writeConfig("config-redact", "PI_MODEL=some-model\nPI_API_KEY=sk-should-never-appear\n");
	const config = readLlmConfig(home);
	const printable = describeLlmConfig(config);
	assert.ok(!printable.includes("sk-should-never-appear"), `描述泄漏了密钥: ${printable}`);
	assert.match(printable, /apiKey=已配置/);
	assert.match(printable, /model=已配置/);
});
