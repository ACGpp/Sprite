#!/usr/bin/env python3
"""
发布前的隐私闸门：拿**真实记忆**当探针，扫一个 git 引用里的全部文本文件。

为什么不是"扫模式"而是"扫记忆"：模式法只能抓已知格式的密钥；
这个脚本回答的是一个更硬的问题——
**我准备公开的这些东西里，有没有任何一句和主人的私人记忆逐字重合？**

四路检查：
  1. 真实 API Key（~/.claude-memory/config/settings.json / llm.conf）→ 命中即失败；
  2. 身份名字：主人的（identity.md 的「X 起的」句式）与守护灵自己的（「我叫 X」）
     ——每个实例都是独立个体，公开仓库里不该有任何一个具体名字 → 命中即失败；
  3. 家目录的绝对路径（带本机用户名）→ 命中即失败；
  4. 与真实记忆**长段逐字重合**（默认 ≥12 字连续）→ 命中即失败。

为什么第 4 条卡"长段"而不是 5 字：这个项目是他和它一起写的，产品文案
（"住进你的电脑""会自己探索世界的个体"）天然和记忆重合，5 字阈值会淹在噪声里；
而私人对话泄露是**整句**搬运，12 字连续重合足够灵敏又几乎不误报。
5-gram 级别的重合只统计、不判定（打印数量，便于人工看一眼有没有异常增长）。

白名单：Scripts/privacy-allowlist.txt（一行一条，可用 # 注释）。
产品文案会和记忆重合，因为主人和它讨论过这些字——这些不算泄露，但要一条条写下来，
谁加了新条目都能在 diff 里看见。

用法：
  python3 Scripts/privacy-scan.py [仓库] [引用=HEAD]
退出码：0 = 通过；1 = 发现私人内容（不发布）。
"""
import os
import re
import subprocess
import sys

REPO = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
REF = sys.argv[2] if len(sys.argv) > 2 else "HEAD"
REAL_HOME = os.environ.get("SPRITE_REAL_HOME", os.path.expanduser("~/.claude-memory"))
CJK_RUN = re.compile(r"[\u4e00-\u9fff]+")
N = int(os.environ.get("SPRITE_PRIVACY_N", "12"))  # 判定阈值：连续重合多少字算泄露
INFO_N = 5                                              # 只统计、不判定
TEXT_EXT = (".ts", ".swift", ".md", ".json", ".mjs", ".js", ".sh", ".yml", ".yaml", ".html", ".txt", ".plist", ".py")


def git(*args) -> str:
    out = subprocess.run(["git", "-C", REPO, *args], capture_output=True)
    return out.stdout.decode("utf-8", "replace")


def mask(value: str) -> str:
    value = value.strip()
    return f"<{len(value)} 字符>" if len(value) <= 6 else f"{value[:3]}…<{len(value)} 字符>"


# ── 1. 真实密钥（只做存在性比对，绝不打印原文）────────────────────────
secrets: list[tuple[str, str]] = []
try:
    raw = open(os.path.join(REAL_HOME, "config", "settings.json"), encoding="utf-8").read()
    for match in re.finditer(r'"apiKey"\s*:\s*"([^"]{12,})"', raw):
        secrets.append(("settings.json 里的 API Key", match.group(1)))
except OSError:
    pass
try:
    for line in open(os.path.join(REAL_HOME, "config", "llm.conf"), encoding="utf-8"):
        match = re.match(r'\s*PI_API_KEY\s*=\s*"?([^"\n]{12,})"?\s*$', line)
        if match:
            secrets.append(("llm.conf 里的 API Key", match.group(1)))
except OSError:
    pass

# ── 2. 主人的名字（identity.md 的「X 起的」）与它的名字（「我叫 X」，公开，排除）
owner_names: set[str] = set()
companion_names: set[str] = set()
identity = ""
try:
    identity = open(os.path.join(REAL_HOME, "identity.md"), encoding="utf-8").read()
except OSError:
    pass
for match in re.finditer(r"([\u4e00-\u9fff]{2,4})\s*起的", identity):
    owner_names.add(match.group(1))
# 只认「我叫 X」：`我是X` 会把「我是不是在空转」这种句子抓成名字（实测踩过）
for match in re.finditer(r"我(?:的名字)?叫\s*([\u4e00-\u9fff]{2,4})", identity):
    companion_names.add(match.group(1))

# 探测用的身份串：主人 + 守护灵（占位名除外——那是产品自己的兜底文案）
# 兜底：这些是句子里的常见词，不是名字（提取规则再怎么收紧也留一道）
STOPWORDS = {"守护灵", "零号", "主人", "自己", "别人", "大家", "名字", "我们", "他们", "你们", "这个", "那个"}
identity_names = {name for name in (owner_names | companion_names) if name and name not in STOPWORDS}

# ── 3. 真实记忆的 5-gram ───────────────────────────────────────────────
grams: set[str] = set()       # 判定级：N 字连续重合
grams_info: set[str] = set()  # 统计级：短重合（产品文案常态）


def add_text(text: str) -> None:
    for run in CJK_RUN.findall(text):
        for i in range(len(run) - N + 1):
            grams.add(run[i : i + N])
        for i in range(len(run) - INFO_N + 1):
            grams_info.add(run[i : i + INFO_N])


memory_files = 0
for sub in ("journal", "diary", "notes", "private", "context", "explorations", "conversations"):
    root = os.path.join(REAL_HOME, sub)
    for dirpath, _, names in os.walk(root) if os.path.isdir(root) else []:
        for name in names:
            if not name.endswith((".md", ".txt", ".jsonl")):
                continue
            try:
                add_text(open(os.path.join(dirpath, name), encoding="utf-8", errors="replace").read())
                memory_files += 1
            except OSError:
                continue
for name in os.listdir(REAL_HOME) if os.path.isdir(REAL_HOME) else []:
    if name.endswith((".md", ".txt")):
        try:
            add_text(open(os.path.join(REAL_HOME, name), encoding="utf-8", errors="replace").read())
            memory_files += 1
        except OSError:
            continue

# ── 白名单 ─────────────────────────────────────────────────────────────
allowlist: set[str] = set()
allow_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "privacy-allowlist.txt")
if os.path.exists(allow_path):
    for line in open(allow_path, encoding="utf-8"):
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        # 判定是按 N 字窗口做的，所以白名单短语要展开成它的 N-gram，
        # 否则"白名单里写整句、判定时比对窗口"永远对不上（实测踩过）。
        for run in CJK_RUN.findall(line):
            for i in range(max(1, len(run) - N + 1)):
                allowlist.add(run[i : i + N])

# ── 扫目标引用 ─────────────────────────────────────────────────────────
tracked = [name for name in git("ls-tree", "-r", "--name-only", REF).splitlines() if name]
targets = [name for name in tracked if name.endswith(TEXT_EXT)]
print(f"目标：{REF} 的 {len(targets)} 个文本文件")
print(f"探针：真实密钥 {len(secrets)} 条、身份名 {len(identity_names)} 个（{'、'.join(sorted(identity_names)) or '无'}）、记忆 {memory_files} 个文件 / {len(grams)} 个 {N}-gram")
print(f"白名单：{len(allowlist)} 条（Scripts/privacy-allowlist.txt）")
print()

info_hits = 0
secret_hits: list[str] = []
name_hits: list[str] = []
home_hits: list[str] = []
overlap_hits: dict[str, list[str]] = {}
# 针要拼出来：否则这个脚本自己就含那个字面量，守卫测试会抓住它（正确行为）
user_needle = os.sep.join(["", "Users", ""]) + os.path.basename(os.path.expanduser("~"))

for path in targets:
    text = git("show", f"{REF}:{path}")
    for label, value in secrets:
        if value and value in text:
            secret_hits.append(f"{path}（{label}）")
    for name in identity_names:
        if name in text:
            name_hits.append(path)
            break
    if user_needle in text:
        home_hits.append(path)
    for run in CJK_RUN.findall(text):
        if len(run) < INFO_N:
            continue
        # 判定级：连续 N 字重合（几乎只可能是整句搬运）
        private = [
            run[i : i + N]
            for i in range(len(run) - N + 1)
            if run[i : i + N] in grams and run[i : i + N] not in allowlist
        ]
        if private:
            overlap_hits.setdefault(path, []).append(run[:60])
        # 统计级：短重合（产品文案的常态）——只计数，便于发现异常增长
        for i in range(len(run) - INFO_N + 1):
            if run[i : i + INFO_N] in grams_info:
                info_hits += 1

ok = True
print("═══ 1. 真实 API Key ═══")
if secret_hits:
    ok = False
    for hit in secret_hits:
        print(f"  ✗ {hit}")
else:
    print("  ✓ 零命中")

print("═══ 2. 身份名字（主人与守护灵）═══")
if name_hits:
    ok = False
    print(f"  ✗ {len(name_hits)} 个文件：{', '.join(sorted(set(name_hits))[:8])}")
else:
    print(f"  ✓ 零命中（探针：{', '.join(mask(n) for n in sorted(identity_names)) or '无'}）")

print("═══ 3. 绝对家目录 ═══")
if home_hits:
    ok = False
    print(f"  ✗ {len(home_hits)} 个文件：{', '.join(sorted(home_hits)[:8])}")
else:
    print("  ✓ 零命中")

print(f"═══ 4. 与真实记忆长段逐字重合（≥{N} 字，白名单外）═══")
if overlap_hits:
    ok = False
    total = sum(len(v) for v in overlap_hits.values())
    print(f"  ✗ {len(overlap_hits)} 个文件 / {total} 段")
    for path in sorted(overlap_hits):
        print(f"    {path}")
        for run in overlap_hits[path][:5]:
            print(f"        {run}")
    print("  （确认这些不是私人内容后，把短语加进 Scripts/privacy-allowlist.txt；否则脱敏）")
else:
    print("  ✓ 零命中")

print()
print(f"（参考：{INFO_N} 字级短重合 {info_hits} 处——产品文案的常态，只做统计不判定）")
print("结论：" + ("PASS ✓ 没有私人内容，可以发布" if ok else "FAIL ✗ 先脱敏，别发布"))
sys.exit(0 if ok else 1)
