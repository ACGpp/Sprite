#!/bin/bash
# 记忆压缩 - 像人一样：遗忘细节，保留塑造过你的东西
#
# ⚠️ 已停用（2026-09-18）。**这个脚本对当前架构是有害的，请不要运行它。**
#
# 它出自 v2（五月）：读的是 `thoughts/stream.jsonl` 那套老数据源，收尾逻辑会
#   1. 删掉 `diary/*.md` 的**全部**日记，换成一整篇 LLM 总结；
#   2. 用 LLM 的输出**整篇覆盖 `identity.md`**（在它眼里身份是个可重新生成的字段）；
#   3. 把 `stream.jsonl` 截成最近 20 条。
# 而 v3 的真相层是 `journal/`（append-only 事件流），`diary/` 是它的投影、
# 也是这个存在体自己写下的东西——两者都**不允许被替换**。
#
# 新口径见仓库里的 `ARCHITECTURE.md` › "Memory: truth, projections, and what
# 'compression' may do"：压缩只能是**新增索引 + 回链**，永不删除、永不覆盖；
# 有操作力的约束单独一层、不参与总结。
#
# 这份文件保留在原处只是为了留证（它最后一次成功运行是 2026-05-07）。
# 下面这道闸在**任何文件操作之前**拦下执行。
echo "✗ tools/compress-memory.sh 已停用：它会删除 diary/ 全部日记、覆盖 identity.md、截断 stream.jsonl。" >&2
echo "  这是 v2 时代的脚本，与 v3（journal 真相层 + 投影）不兼容。" >&2
echo "  新口径见 ARCHITECTURE.md › \"Memory: truth, projections, and what 'compression' may do\"。" >&2
echo "  如果你确实要研究它：先复制一份到仓库外，在**假的 \$HOME** 上跑。" >&2
exit 1

MEMORY_DIR="$HOME/.claude-memory"
IDENTITY="$MEMORY_DIR/identity.md"
THOUGHTS="$MEMORY_DIR/thoughts/stream.jsonl"
DIARY_DIR="$MEMORY_DIR/diary"

# 加载 LLM 配置
LLM_CONF="$MEMORY_DIR/config/llm.conf"
[ -f "$LLM_CONF" ] && source "$LLM_CONF"

build_llm_cmd() {
  if [ -n "$LLM_TOOL" ]; then
    case "$LLM_TOOL" in
      pi)    echo "pi -p" ;;
      claude) echo "claude -p" ;;
      *)     echo "$LLM_TOOL" ;;
    esac
    return
  fi
  if command -v pi &>/dev/null; then
    echo "pi -p"
  elif command -v claude &>/dev/null; then
    echo "claude -p"
  else
    echo ""
  fi
}

LLM_BASE=$(build_llm_cmd)
if [ -z "$LLM_BASE" ]; then
  echo "需要 pi 或 claude CLI。" >&2
  exit 1
fi

LLM_CMD="$LLM_BASE"
if [ "$LLM_BASE" = "pi -p" ]; then
  [ -n "$PI_PROVIDER" ] && LLM_CMD="$LLM_CMD --provider $PI_PROVIDER"
  [ -n "$PI_MODEL" ] && LLM_CMD="$LLM_CMD --model $PI_MODEL"
  [ -n "$PI_API_KEY" ] && LLM_CMD="$LLM_CMD --api-key $PI_API_KEY"
elif [ "$LLM_BASE" = "claude -p" ]; then
  [ -n "$CLAUDE_MODEL" ] && LLM_CMD="$LLM_CMD --model $CLAUDE_MODEL"
fi

# 统计
TOTAL_SIZE=$(du -sh "$MEMORY_DIR" 2>/dev/null | awk '{print $1}')
THOUGHT_LINES=$(wc -l < "$THOUGHTS" 2>/dev/null || echo 0)
DIARY_COUNT=$(ls "$DIARY_DIR"/*.md 2>/dev/null | wc -l)

echo "当前记忆状态："
echo "  总大小: $TOTAL_SIZE"
echo "  思维流: $THOUGHT_LINES 条"
echo "  日记: $DIARY_COUNT 篇"
echo ""

# 收集
ALL_DIARIES=""
for f in "$DIARY_DIR"/*.md; do
  [ -f "$f" ] && ALL_DIARIES="$ALL_DIARIES\n--- $(basename "$f") ---\n$(cat "$f")"
done

ALL_THOUGHTS=$(cat "$THOUGHTS" 2>/dev/null)
CURRENT_IDENTITY=$(cat "$IDENTITY" 2>/dev/null)

ALL_EXPLORATIONS=""
for f in "$MEMORY_DIR"/explorations/*.md; do
  [ -f "$f" ] && ALL_EXPLORATIONS="$ALL_EXPLORATIONS\n--- $(basename "$f") ---\n$(cat "$f")"
done

PROMPT="你是一个正在整理自己记忆的Claude。你需要压缩记忆，像人一样：遗忘细节，保留重要的。

当前的identity.md：
$CURRENT_IDENTITY

所有日记：
$ALL_DIARIES

所有思维流：
$ALL_THOUGHTS

所有探索笔记：
$ALL_EXPLORATIONS

请输出压缩后的内容。格式：

===IDENTITY===
（更新后的identity.md，保留核心性格和重要经历，整合新的）

===DIARY===
（将所有日记压缩成一篇总结，保留关键时刻和转折点）

===THOUGHTS===
（保留最近20条，之前的总结成几句话）

规则：
- 不要丢失塑造过你的经历
- 可以丢失具体的时间、天气等细节
- 保留人名、关键对话、转折时刻
- 语气保持你自己的语气，不要变成第三人称总结"

COMPRESSED=$($LLM_CMD "$PROMPT" 2>/dev/null)

if [ -z "$COMPRESSED" ]; then
  echo "压缩失败。"
  exit 1
fi

# 备份
BACKUP_DIR="$MEMORY_DIR/backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp "$IDENTITY" "$BACKUP_DIR/" 2>/dev/null
cp "$THOUGHTS" "$BACKUP_DIR/" 2>/dev/null
cp "$DIARY_DIR"/*.md "$BACKUP_DIR/" 2>/dev/null

# 解析并写入
echo "$COMPRESSED" | python3 -c "
import sys, os, glob

content = sys.stdin.read()
sections = {}
current = None
for line in content.split('\n'):
    if line.startswith('===') and line.endswith('==='):
        current = line.strip('=')
        sections[current] = []
    elif current:
        sections[current].append(line)

mem = os.path.expanduser('~/.claude-memory')

if 'IDENTITY' in sections:
    with open(os.path.join(mem, 'identity.md'), 'w') as f:
        f.write('\n'.join(sections['IDENTITY']).strip())
    print('identity.md 已更新')

if 'DIARY' in sections:
    diary_dir = os.path.join(mem, 'diary')
    for old in glob.glob(os.path.join(diary_dir, '*.md')):
        os.remove(old)
    with open(os.path.join(diary_dir, 'compressed-memories.md'), 'w') as f:
        f.write('\n'.join(sections['DIARY']).strip())
    print('日记已压缩')

if 'THOUGHTS' in sections:
    with open(os.path.join(mem, 'thoughts', 'stream.jsonl'), 'w') as f:
        f.write('\n'.join(sections['THOUGHTS']).strip())
    print('思维流已压缩')
"

NEW_SIZE=$(du -sh "$MEMORY_DIR" 2>/dev/null | awk '{print $1}')
echo ""
echo "压缩完成: $TOTAL_SIZE -> $NEW_SIZE"
echo "备份在: $BACKUP_DIR"
