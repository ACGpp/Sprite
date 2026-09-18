#!/usr/bin/env bash
# Swift 外壳 ↔ Node 内核 的跨语言契约验证。
#
# 做三件事（全部离线，不碰用户真实记忆）：
#   1. 用夹具记忆目录启一个真内核（不含 pi）
#   2. 用 sprite-rpc-probe 验证 Swift 侧解码、幂等命令、事件续传、错误路径
#   3. 跑外壳自检（不显示任何窗口）
#
# 用法：Scripts/verify-shell.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.core-test/shell-verify"
SOCK="$WORK/runtime/core.sock"
SWIFT_ENV=(env CLANG_MODULE_CACHE_PATH="$ROOT/shell/.build/clang-cache" SWIFT_MODULE_CACHE_PATH="$ROOT/shell/.build/swift-cache")

rm -rf "$WORK"
mkdir -p "$WORK/conversations" "$WORK/thoughts"
printf '[2026/06/20 18:39] 零号: 老的一行\n[2026/06/20 19:39] 用户: 老的回话\n' > "$WORK/conversations/mailbox.md"
printf '{"time":"2026-05-07T01:13:46Z","type":"breath","content":"老思维"}\n' > "$WORK/thoughts/stream.jsonl"

echo "=== 1. 编译 Swift 侧 ==="
bash -c 'cd "$1/shell" && shift && "$@" swift build --disable-sandbox --scratch-path .build --cache-path .build/cache 2>&1 | grep -E "error|Build complete" | head -5; exit ${PIPESTATUS[0]}' _ "$ROOT" "${SWIFT_ENV[@]}" || { echo "  ✗ Swift 编译失败——后面的检查不算数"; exit 1; }

echo
echo "=== 2. 启动真内核（夹具记忆，无 pi）==="
SPRITE_HOME="$WORK" SPRITE_SOCKET="$SOCK" SPRITE_NO_PI=1 SPRITE_QUIET_START=0 SPRITE_QUIET_END=0 \
  node "$ROOT/core/main.ts" > "$WORK/core.log" 2>&1 &
CORE_PID=$!
trap 'kill "$CORE_PID" 2>/dev/null || true; wait "$CORE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do
  [ -S "$SOCK" ] && break
  sleep 0.1
done
if [ ! -S "$SOCK" ]; then
  echo "FAIL 内核 socket 未出现"; cat "$WORK/core.log"; exit 1
fi
echo "内核就绪：$(grep -c . "$WORK/core.log") 行日志"

echo
echo "=== 3. Swift 探针 × 真内核 ==="
"$ROOT/shell/.build/debug/sprite-rpc-probe" selftest "$SOCK"
PROBE_EXIT=$?

echo
echo "=== 4. 外壳自检（不显示窗口）==="
"$ROOT/shell/.build/debug/sprite-shell" --lang zh --selftest --socket "$SOCK"
SHELL_EXIT=$?

echo
echo "=== 5. 内核侧证据 ==="
echo "journal 事件：$(cat "$WORK"/journal/*.jsonl | grep -c .) 条"
echo "gateway.sock 权限：$(stat -f '%Sp' "$WORK/runtime/gateway.sock" 2>/dev/null || echo '未创建（无 pi 时不监听）')"
echo "内核日志尾部："; tail -3 "$WORK/core.log" | sed 's/^/  /'

# ─── 记录窗口不许卡死（布局重入曾经让「现在」当场卡住）───
# 用真实窗口跑 3 秒 run loop，数主线程响应了多少次定时器：卡住/崩溃会是 0。
for SECTION in live settings conversations; do
  if "$ROOT/shell/.build/debug/sprite-shell" --lang zh --hang-check "$SECTION" >/dev/null 2>&1; then
    echo "PASS 记录窗口-$SECTION 不卡"
  else
    echo "FAIL 记录窗口-$SECTION 卡死或崩溃（布局重入）"; exit 1
  fi
done

# ─── 安装脚本的语言开关（英文用户第一眼看到的东西；回归过就不许再退化）───
if SPRITE_LANG=en "$ROOT/install.sh" --help 2>&1 | grep -q "Sprite installer"; then
  echo "PASS 安装脚本英文帮助"
else
  echo "FAIL 安装脚本英文帮助（SPRITE_LANG=en --help 里没有英文）"; exit 1
fi
if SPRITE_LANG=zh "$ROOT/install.sh" --help 2>&1 | grep -q "安装脚本"; then
  echo "PASS 安装脚本中文帮助"
else
  echo "FAIL 安装脚本中文帮助"; exit 1
fi

echo
if [ "$PROBE_EXIT" -eq 0 ] && [ "$SHELL_EXIT" -eq 0 ]; then
  echo "结论: PASS ✓ Swift 外壳与 Node 内核契约一致"
  exit 0
fi
echo "结论: FAIL ✗ probe=$PROBE_EXIT shell=$SHELL_EXIT"
exit 1
