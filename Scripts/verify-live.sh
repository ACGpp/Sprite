#!/usr/bin/env bash
# 活体验证：真内核（含真 pi 进程 + 真能力网关）+ 真外壳，跑一次完整呼吸。
#
# 与 verify-shell.sh 的区别：那个查的是协议与界面属性，这个查的是"整条链路真的活着"——
# 外壳必须能跟着内核的状态走：它在想事情 → 它在呼吸，并且看到的计数与内核一致。
#
# 离线（内置 provider）、不联网、不使用真实 API key、不碰 ~/.claude-memory。
# 用法：Scripts/verify-live.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.core-test/live"
SOCK="$WORK/runtime/core.sock"
SECONDS_TO_RUN="${1:-20}"
SWIFT_ENV=(env CLANG_MODULE_CACHE_PATH="$ROOT/shell/.build/clang-cache" SWIFT_MODULE_CACHE_PATH="$ROOT/shell/.build/swift-cache")

rm -rf "$WORK"
mkdir -p "$WORK/conversations" "$WORK/thoughts" "$WORK/pi-home"
printf '[2026/06/20 18:39] 零号: 老的一行\n[2026/06/20 19:39] 用户: 老的回话\n' > "$WORK/conversations/mailbox.md"
: > "$WORK/thoughts/stream.jsonl"

echo "=== 编译外壳 ==="
bash -c 'cd "$1/shell" && shift && "$@" swift build --disable-sandbox --scratch-path .build --cache-path .build/cache 2>&1 | grep -E "error|Build complete" | head -5; exit ${PIPESTATUS[0]}' _ "$ROOT" "${SWIFT_ENV[@]}" || { echo "  ✗ Swift 编译失败——后面的检查不算数"; exit 1; }

PI_ARGS=$(printf '["--mode","rpc","--no-session","--provider","spike","--model","spike-1","-e","%s","-e","%s"]' \
  "$ROOT/pi-extension/sprite.ts" "$ROOT/core/__test__/fake-provider.ts")

echo
echo "=== 启动真内核（真 pi 进程 + 能力网关）==="
SPRITE_HOME="$WORK" SPRITE_SOCKET="$SOCK" SPRITE_INTERVAL_MS=12000 \
SPRITE_QUIET_START=0 SPRITE_QUIET_END=0 \
SPRITE_PI_ARGS="$PI_ARGS" SPRITE_PI_HOME="$WORK/pi-home" SPRITE_SPIKE_KEY=spike \
  node "$ROOT/core/main.ts" > "$WORK/core.log" 2>&1 &
CORE_PID=$!
trap 'kill "$CORE_PID" 2>/dev/null || true; wait "$CORE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do [ -S "$SOCK" ] && break; sleep 0.1; done
[ -S "$SOCK" ] || { echo "FAIL 内核未就绪"; cat "$WORK/core.log"; exit 1; }
grep -E "就绪" "$WORK/core.log" | sed 's/^/  /'
sleep 2

echo
echo "=== 外壳无界面运行: $SECONDS_TO_RUN 秒 ==="
OUTPUT=$("$ROOT/shell/.build/debug/sprite-shell" --headless --seconds "$SECONDS_TO_RUN" --socket "$SOCK" 2>&1)
echo "$OUTPUT" | tail -12

echo
echo "=== 断言 ==="
FAILED=0
expect() {
  if echo "$OUTPUT" | grep -q "$1"; then
    echo "PASS $2"
  else
    echo "FAIL $2（未找到: $1）"
    FAILED=$((FAILED + 1))
  fi
}

expect "连接状态：已连接"                       "外壳连上了内核"
expect "结论: PASS"                             "外壳判定链路正常"
expect "message.out"                            "它说的话经能力网关回到内核"
expect "question.asked"                         "提问通路可用"
expect "presence.changed"                       "收到状态变化事件"
expect "breath.scheduled"                       "收到了下一次醒来时间"

RUNS=$(echo "$OUTPUT" | sed -n 's/.*呼吸次数：\([0-9]*\).*/\1/p' | tail -1)
TOOLS=$(echo "$OUTPUT" | sed -n 's/.*工具决策：\([0-9]*\).*/\1/p' | tail -1)
if [ "${RUNS:-0}" -ge 1 ]; then echo "PASS 壳里看到至少一次呼吸: $RUNS 次"; else echo "FAIL 呼吸次数=$RUNS"; FAILED=$((FAILED + 1)); fi
if [ "${TOOLS:-0}" -ge 1 ]; then echo "PASS 壳里看到工具审计: $TOOLS 条"; else echo "FAIL 工具决策=$TOOLS"; FAILED=$((FAILED + 1)); fi

# 外壳的计数必须与内核读模型一致（不是外壳自己猜的）
KERNEL_RUNS=$(grep -c '"type":"run.started"' "$WORK"/journal/*.jsonl || true)
if [ "$RUNS" = "$KERNEL_RUNS" ]; then
  echo "PASS 外壳计数与内核一致: run.started=$KERNEL_RUNS"
else
  echo "FAIL 外壳显示 $RUNS 次呼吸，内核日志里是 $KERNEL_RUNS 次"
  FAILED=$((FAILED + 1))
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "结论: PASS ✓ 活体链路成立（指令 → 内核 → pi → 网关 → 事件 → 外壳）"
  exit 0
fi
echo "结论: FAIL ✗ $FAILED 项未通过"
exit 1
