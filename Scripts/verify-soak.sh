#!/usr/bin/env bash
# 长跑验证（soak）：一个要陪你几天的东西，泄漏和漂移只能靠连续观察抓。
#
# 做三件事：
#   1. 内核以 5 秒一拍连续跑 ~100 秒 + 外壳无界面同时跟踪
#   2. 每 10 秒采一次进程诊断（RSS / 堆 / 事件数 / 日志体积）
#   3. 断言：内存增长有界、seq 单调、事件数与日志一致、无挂起呼吸、外壳计数与内核一致
#
# 离线、不联网、不碰 ~/.claude-memory。
# 用法：Scripts/verify-soak.sh [秒数]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.core-test/soak"
SOCK="$WORK/runtime/core.sock"
DURATION="${1:-100}"
readonly TOTAL_SECONDS="$DURATION"
BREATH_MS="${BREATH_MS:-5000}"
SWIFT_ENV=(env CLANG_MODULE_CACHE_PATH="$ROOT/shell/.build/clang-cache" SWIFT_MODULE_CACHE_PATH="$ROOT/shell/.build/swift-cache")

rm -rf "$WORK"
mkdir -p "$WORK/conversations" "$WORK/thoughts" "$WORK/pi-home"
: > "$WORK/conversations/mailbox.md"
: > "$WORK/thoughts/stream.jsonl"

bash -c 'cd "$1/shell" && shift && "$@" swift build --disable-sandbox --scratch-path .build --cache-path .build/cache 2>&1 | grep -E "error|Build complete" | head -5; exit ${PIPESTATUS[0]}' _ "$ROOT" "${SWIFT_ENV[@]}" || { echo "  ✗ Swift 编译失败——后面的检查不算数"; exit 1; }

PI_ARGS=$(printf '["--mode","rpc","--no-session","--provider","spike","--model","spike-1","-e","%s","-e","%s"]' \
  "$ROOT/pi-extension/sprite.ts" "$ROOT/core/__test__/fake-provider.ts")

echo "=== 启动内核（每 ${BREATH_MS}ms 一拍，跑 ${DURATION}s）==="
SPRITE_HOME="$WORK" SPRITE_SOCKET="$SOCK" SPRITE_INTERVAL_MS="$BREATH_MS" \
SPRITE_QUIET_START=0 SPRITE_QUIET_END=0 \
SPRITE_PI_ARGS="$PI_ARGS" SPRITE_PI_HOME="$WORK/pi-home" SPRITE_SPIKE_KEY=spike \
  node "$ROOT/core/main.ts" > "$WORK/core.log" 2>&1 &
CORE_PID=$!
trap 'kill "$CORE_PID" 2>/dev/null || true; wait "$CORE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do [ -S "$SOCK" ] && break; sleep 0.1; done
[ -S "$SOCK" ] || { echo "FAIL 内核未就绪"; cat "$WORK/core.log"; exit 1; }
sleep 2

echo "=== 外壳无界面同时跟踪 ==="
"$ROOT/shell/.build/debug/sprite-shell" --lang zh --headless --seconds "$((DURATION + 5))" --socket "$SOCK" > "$WORK/shell.log" 2>&1 &
SHELL_PID=$!

echo

# 采一次内核诊断（RSS/堆/事件数/呼吸数/日志体积）
sample() {
  node -e '
const net=require("net");
const s=net.connect(process.argv[1]);
let buf="";
s.setTimeout(5000);
s.on("connect",()=>s.write(JSON.stringify({id:"d",type:"query.diagnostics"})+"\n"));
s.on("data",d=>{buf+=d;const i=buf.indexOf("\n");if(i>=0){const r=JSON.parse(buf.slice(0,i));s.destroy();
  if(!r.ok){console.log("ERR");return;}
  const x=r.result;
  console.log([Math.round(x.rssBytes/1048576),Math.round(x.heapUsedBytes/1048576),x.events,x.runs,Math.round(x.journalBytes/1024)].join(" "));}});
s.on("error",()=>{console.log("ERR")});
s.on("timeout",()=>{console.log("ERR")});
' "$SOCK"
}

echo "=== 采样（每 10 秒）==="
printf "  %-6s %-10s %-12s %-10s %-8s %-8s\n" "时刻" "RSS(MB)" "堆(MB)" "事件数" "呼吸" "日志(KB)"
SAMPLES=()
ELAPSED=0
while [ "$ELAPSED" -lt "$DURATION" ]; do
  sleep 10
  ELAPSED=$((ELAPSED + 10))
  SAMPLE=$(sample)
  if [ "$SAMPLE" = "ERR" ]; then
    echo "  FAIL 采样失败（第 ${ELAPSED} 秒）"
    break
  fi
  # 用 read 拆字段：`set --` 会覆盖脚本自己的位置参数（$1 等）
  read -r RSS HEAP EVENTS RUNS JB <<< "$SAMPLE"
  printf "  %-6s %-10s %-12s %-10s %-8s %-8s\n" "${ELAPSED}s" "$RSS" "$HEAP" "$EVENTS" "$RUNS" "$JB"
  SAMPLES+=("$SAMPLE")
done

wait "$SHELL_PID" 2>/dev/null || true

# 收尾采样：外壳刚退出，此刻的内核状态才与外壳最终报告可比
FINAL=$(sample)
if [ "$FINAL" != "ERR" ]; then
  SAMPLES+=("$FINAL")
  read -r f_rss f_heap f_events f_runs f_jb <<< "$FINAL"
  printf "  %-6s %-10s %-12s %-10s %-8s %-8s\n" "收尾" "$f_rss" "$f_heap" "$f_events" "$f_runs" "$f_jb"
fi

kill "$CORE_PID" 2>/dev/null || true
sleep 1

echo
echo "=== 断言 ==="
FAILED=0

FIRST_RSS=$(echo "${SAMPLES[0]}" | awk '{print $1}')
LAST_RSS=$(echo "${SAMPLES[${#SAMPLES[@]}-1]}" | awk '{print $1}')
FIRST_EVENTS=$(echo "${SAMPLES[0]}" | awk '{print $3}')
LAST_EVENTS=$(echo "${SAMPLES[${#SAMPLES[@]}-1]}" | awk '{print $3}')
LAST_RUNS=$(echo "${SAMPLES[${#SAMPLES[@]}-1]}" | awk '{print $4}')
GROWTH=$((LAST_RSS - FIRST_RSS))

if [ "$GROWTH" -lt 80 ]; then
  echo "PASS 内存增长有界：${FIRST_RSS}MB → ${LAST_RSS}MB（+${GROWTH}MB，上限 80MB）"
else
  echo "FAIL 内存增长 ${GROWTH}MB 超过上限（${FIRST_RSS} → ${LAST_RSS}）"
  FAILED=$((FAILED + 1))
fi

if [ "$LAST_EVENTS" -gt "$FIRST_EVENTS" ]; then
  echo "PASS 事件持续增长（$FIRST_EVENTS → ${LAST_EVENTS}）"
else
  echo "FAIL 事件没有增长（$FIRST_EVENTS → ${LAST_EVENTS}）"
  FAILED=$((FAILED + 1))
fi

EXPECTED_RUNS=$((DURATION / (BREATH_MS / 1000)))
if [ "$LAST_RUNS" -ge $((EXPECTED_RUNS - 2)) ] && [ "$LAST_RUNS" -le $((EXPECTED_RUNS + 2)) ]; then
  echo "PASS 呼吸次数符合预期：$LAST_RUNS 拍（预期约 ${EXPECTED_RUNS}）"
else
  echo "FAIL 呼吸次数异常：$LAST_RUNS 拍（预期约 ${EXPECTED_RUNS}）"
  FAILED=$((FAILED + 1))
fi

# journal 的 seq 必须严格连续，且事件数与之一致
JOURNAL_SEQS=$(cat "$WORK"/journal/*.jsonl | wc -l | tr -d ' ')
GAPS=$(node -e '
const fs=require("fs"),path=require("path");
const dir=process.argv[1];
let seqs=[];
for(const f of fs.readdirSync(dir)) if(f.endsWith(".jsonl")) for(const line of fs.readFileSync(path.join(dir,f),"utf8").split("\n")) { if(!line.trim()) continue; seqs.push(JSON.parse(line).seq); }
let gaps=0;
for(let i=0;i<seqs.length;i++) if(seqs[i]!==i+1) gaps++;
console.log(seqs.length+" "+gaps);
' "$WORK/journal")
JOURNAL_COUNT=$(echo "$GAPS" | awk '{print $1}')
GAP_COUNT=$(echo "$GAPS" | awk '{print $2}')
if [ "$GAP_COUNT" = "0" ]; then
  echo "PASS journal seq 连续无缺口（$JOURNAL_COUNT 条）"
else
  echo "FAIL journal 有 $GAP_COUNT 处序号缺口"
  FAILED=$((FAILED + 1))
fi

if grep -q "run.started" "$WORK"/journal/*.jsonl && ! grep -q "danglingRun\":true" "$WORK"/journal/*.jsonl; then
  echo "PASS 没有留下挂起的呼吸"
else
  echo "FAIL 存在挂起的呼吸"
  FAILED=$((FAILED + 1))
fi

# 外壳的计数必须与内核一致（防漂移）
SHELL_RUNS=$(sed -n 's/.*呼吸次数：\([0-9]*\).*/\1/p' "$WORK/shell.log" | tail -1)
if [ "${SHELL_RUNS:-0}" = "$LAST_RUNS" ]; then
  echo "PASS 外壳计数与内核一致（${SHELL_RUNS} 拍）"
else
  echo "FAIL 外壳显示 ${SHELL_RUNS} 拍，内核是 ${LAST_RUNS} 拍"
  FAILED=$((FAILED + 1))
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "结论: PASS ✓ 连续运行 ${DURATION}s 无泄漏、无漂移、无挂起"
  exit 0
fi
echo "结论: FAIL ✗ $FAILED 项未通过"
exit 1
