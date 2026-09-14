#!/usr/bin/env bash
# 一键跑完全部验证，并输出一份可复核的汇总。
#
# 特性：
#   - 全程离线、不需要 API key、**不触碰 ~/.claude-memory**
#   - 每个阶段独立判定，任一失败则整体失败（退出码非 0）
#   - 输出机器可读的关键数字，供 docs/acceptance-report.md 引用
#
# 用法：Scripts/verify-all.sh [--quick]
#   --quick 跳过最耗时的规模测量（20 万条），用较小的规模代替

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QUICK=false
[ "${1:-}" = "--quick" ] && QUICK=true
cd "$ROOT"

SWIFT_ENV=(env CLANG_MODULE_CACHE_PATH="$ROOT/shell/.build/clang-cache" SWIFT_MODULE_CACHE_PATH="$ROOT/shell/.build/swift-cache")
OUT="$ROOT/.core-test/verify-all.log"
mkdir -p "$ROOT/.core-test"
: > "$OUT"

STAGES=()
RESULTS=()
DURATIONS=()
METRICS=()

run_stage() {
  local name="$1"; shift
  local started
  started=$(date +%s)
  printf '\n\033[1m▶ %s\033[0m\n' "$name"
  if "$@" 2>&1 | tee -a "$OUT"; then
    RESULTS+=("PASS")
  else
    RESULTS+=("FAIL")
  fi
  DURATIONS+=("$(( $(date +%s) - started ))s")
  STAGES+=("$name")
}

metric() { METRICS+=("$1"); }

# ─── 1. 类型检查 ───
# 三个都要跑：根 tsconfig 曾经 include 的是已删除的目录，检查 0 个文件却退 0（假绿）
run_stage "类型检查 (内核 / 策略 / 根)" bash -c "npm run --silent core:typecheck && npm run --silent policy:typecheck && npx tsc -p tsconfig.json --noEmit"

# ─── 2. 内核测试 ───
run_stage "内核测试（journal/导入/投影/RPC/调度/呼吸/网关策略/设置/规模/端到端）" \
  node --test --test-reporter=spec "core/**/*.test.ts"
CORE_COUNT=$(grep -oE "^ℹ pass [0-9]+" "$OUT" | tail -1 | grep -oE "[0-9]+")
metric "内核测试通过：${CORE_COUNT:-?} 项"

# ─── 3. Swift 契约测试 ───
run_stage "Swift 契约测试" bash -c \
  "cd '$ROOT/shell' && '${SWIFT_ENV[0]}' CLANG_MODULE_CACHE_PATH='$ROOT/shell/.build/clang-cache' SWIFT_MODULE_CACHE_PATH='$ROOT/shell/.build/swift-cache' swift test --disable-sandbox --scratch-path .build --cache-path .build/cache"

# ─── 4. 跨语言契约 + 外壳自检 ───
# Swift 6 并发：必须零**代码**告警（SwiftPM 的缓存提示不算）。
# 这套检查曾经从 886 条清到 0，切进了 swiftLanguageModes v6——这条阶段防止它退回去。
run_stage "Swift 并发检查（零代码告警）" bash -c '
  cd "'"$ROOT"'/shell"
  out=$(CLANG_MODULE_CACHE_PATH="$PWD/.build/clang-cache" SWIFT_MODULE_CACHE_PATH="$PWD/.build/swift-cache" swift build --disable-sandbox --scratch-path .build/concurrency-check --cache-path .build/cache -Xswiftc -strict-concurrency=complete 2>&1)
  # 只认"文件:行:列"的代码告警：SwiftPM 的缓存提示里也含 .swift 字样，必须排除
  count=$(printf "%s" "$out" | grep -cE "warning: .*\.swift:[0-9]+:[0-9]+:")
  if [ "$count" -ne 0 ]; then printf "%s" "$out" | grep -E "warning: .*\.swift:[0-9]+:[0-9]+:" | head -5; echo "  ✗ 有 $count 条并发告警"; exit 1; fi
  echo "  ✓ 零代码告警"
'
run_stage "跨语言契约与外壳自检" Scripts/verify-shell.sh
SHELL_PASS=$(grep -cE "^PASS" "$OUT")
metric "探针与外壳自检通过：${SHELL_PASS} 项"

# ─── 5. 活体链路 ───
run_stage "活体链路（真内核 + 真 pi + 真网关 + 真外壳）" Scripts/verify-live.sh 20
grep -E "呼吸次数|工具决策" "$OUT" | tail -1 | sed 's/^/    /' | tee -a "$OUT" >/dev/null || true

# ─── 6. 断线重连 ───
run_stage "语音全链路（真麦克风 → 真转写 → 记忆 → 回读）" Scripts/verify-voice.sh 6
run_stage "断线重连（杀掉内核再拉起）" Scripts/verify-reconnect.sh

# ─── 7. 长跑 ───
run_stage "长跑 soak（连续呼吸）" Scripts/verify-soak.sh 60

# ─── 8. 规模 ───
if [ "$QUICK" = true ]; then
  run_stage "规模测量（快速：5 万条）" node Scripts/measure-scale.mjs 50000 30
else
  run_stage "规模测量（20 万条 / 100 天）" node Scripts/measure-scale.mjs 200000 100
fi
SCALE_LINE=$(grep -E "^启动到可服务|^RSS|^状态查询往返|^内存中事件" "$OUT" | tail -4 | tr '\n' ' ')
metric "规模（冷启动，无检查点）：${SCALE_LINE}"

# ─── 汇总 ───
echo
echo "════════════════ 验收汇总 ════════════════"
printf '%-58s %-6s %s\n' "阶段" "结果" "耗时"
for i in "${!STAGES[@]}"; do
  printf '%-58s %-6s %s\n' "${STAGES[$i]}" "${RESULTS[$i]}" "${DURATIONS[$i]}"
done
echo
for line in "${METRICS[@]}"; do echo "  $line"; done

FAILED=0
for result in "${RESULTS[@]}"; do [ "$result" = "FAIL" ] && FAILED=$((FAILED + 1)); done

echo
echo "完整日志：$OUT"
if [ "$FAILED" -eq 0 ]; then
  echo "结论: PASS ✓ 全部 ${#STAGES[@]} 个阶段通过"
  exit 0
fi
echo "结论: FAIL ✗ ${FAILED}/${#STAGES[@]} 个阶段未通过"
exit 1
