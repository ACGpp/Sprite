#!/usr/bin/env bash
# 断线重连验证：内核被杀掉再起来，外壳必须自己走回去。
#
# 这是"守护灵"的底线之一：内核会因为升级或崩溃重启，桌面上的它不能因此永久消失。
# 设计文档 §4.4 要求"断线从 fromSeq 续传"；这个脚本验证外壳真的做到了。
#
# 离线、不联网、不碰 ~/.claude-memory。
# 用法：Scripts/verify-reconnect.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.core-test/reconnect"
SOCK="$WORK/runtime/core.sock"
LOG="$WORK/shell-output.log"
SWIFT_ENV=(env CLANG_MODULE_CACHE_PATH="$ROOT/shell/.build/clang-cache" SWIFT_MODULE_CACHE_PATH="$ROOT/shell/.build/swift-cache")

rm -rf "$WORK"
mkdir -p "$WORK/conversations" "$WORK/thoughts" "$WORK/pi-home"
printf '[2026/06/20 19:39] 用户: 老的回话\n' > "$WORK/conversations/mailbox.md"
: > "$WORK/thoughts/stream.jsonl"

bash -c 'cd "$1/shell" && shift && "$@" swift build --disable-sandbox --scratch-path .build --cache-path .build/cache 2>&1 | grep -E "error|Build complete" | head -5; exit ${PIPESTATUS[0]}' _ "$ROOT" "${SWIFT_ENV[@]}" || { echo "  ✗ Swift 编译失败——后面的检查不算数"; exit 1; }

PI_ARGS=$(printf '["--mode","rpc","--no-session","--provider","spike","--model","spike-1","-e","%s","-e","%s"]' \
  "$ROOT/pi-extension/sprite.ts" "$ROOT/core/__test__/fake-provider.ts")

start_core() {
  SPRITE_HOME="$WORK" SPRITE_SOCKET="$SOCK" SPRITE_INTERVAL_MS=6000 \
  SPRITE_QUIET_START=0 SPRITE_QUIET_END=0 \
  SPRITE_PI_ARGS="$PI_ARGS" SPRITE_PI_HOME="$WORK/pi-home" SPRITE_SPIKE_KEY=spike \
    node "$ROOT/core/main.ts" >> "$WORK/core.log" 2>&1 &
  CORE_PID=$!
  for _ in $(seq 1 100); do [ -S "$SOCK" ] && break; sleep 0.1; done
}

echo "=== 第一次启动内核 ==="
start_core
echo "  内核 pid=$CORE_PID"
sleep 2

echo "=== 外壳无界面运行（30 秒，中途杀掉内核再拉起）==="
"$ROOT/shell/.build/debug/sprite-shell" --headless --seconds 30 --socket "$SOCK" > "$LOG" 2>&1 &
SHELL_PID=$!

sleep 8
echo "  → 杀掉内核（模拟崩溃/升级）pid=$CORE_PID"
kill -9 "$CORE_PID" 2>/dev/null || true
wait "$CORE_PID" 2>/dev/null || true
rm -f "$SOCK" || true
sleep 3

echo "  → 重新启动内核"
start_core
echo "  新内核 pid=$CORE_PID"

wait "$SHELL_PID" || true
SHELL_EXIT=$?
kill "$CORE_PID" 2>/dev/null || true

echo
echo "=== 外壳输出（连接相关行）==="
grep -nE "连接状态|结论" "$LOG" | sed 's/^/  /'

echo
echo "=== 断言 ==="
FAILED=0
expect() {
  if grep -q "$1" "$LOG"; then echo "PASS $2"; else echo "FAIL $2（未找到: $1）"; FAILED=$((FAILED + 1)); fi
}

expect "连接状态：已连接"           "第一次连接成功"
expect "最终连接：已连接"           "结束时仍保持连接"
expect "连接状态：未连接"           "内核消失时如实报告断开（不是静默失联）"
expect "没有连上内核"               "断线时不显示旧状态（不撒谎）"
expect "结论: PASS"                 "外壳最终判定链路正常"

# 断线之后必须重新连上：已连接要出现至少两次
# 只数连接事件本身（摘要行用的是"最终连接"，不会混进来）
CONNECTS=$(grep -c "^连接状态：已连接$" "$LOG")
if [ "$CONNECTS" -ge 2 ]; then
  echo "PASS 断线后自动重连成功（已连接出现 $CONNECTS 次）"
else
  echo "FAIL 只连上过 $CONNECTS 次，说明没有重连"
  FAILED=$((FAILED + 1))
fi

# 重连之后必须继续收到事件（seq 继续增长，且来自新内核实例）
LAST_SEQ=$(grep -oE "末尾 seq=[0-9]+" "$LOG" | tail -1 | grep -oE "[0-9]+")
if [ "${LAST_SEQ:-0}" -gt 0 ]; then
  echo "PASS 重连后仍在接收事件（末尾 seq=${LAST_SEQ}）"
else
  echo "FAIL 重连后没有事件（末尾 seq=${LAST_SEQ}）"
  FAILED=$((FAILED + 1))
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "结论: PASS ✓ 内核重启后外壳能自己走回去，并继续跟踪状态"
  exit 0
fi
echo "结论: FAIL ✗ $FAILED 项未通过"
exit 1
