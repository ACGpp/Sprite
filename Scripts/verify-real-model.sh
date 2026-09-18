#!/usr/bin/env bash
# 真实模型连通性验证：用你 config/llm.conf 里的真实 provider/model/key 跑**一次**真实呼吸。
#
# 会花钱（一次调用），所以刻意做得很小：
#   · 只在**记忆副本**上跑，不写你的真实记录
#   · 只发一条消息
#   · 用完立刻删除副本（副本里含密钥）
#
# 验证的是整条链路：指令 → journal → 常驻 pi（真实模型）→ 工具调用 → 能力网关 → 内核事件 → 产物
#
# 用法：Scripts/verify-real-model.sh

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REAL_MEMORY="$HOME/.claude-memory"
WORK="$ROOT/.core-test/real-model"
SOCK="$WORK/runtime/core.sock"
TIMEOUT="${1:-240}"

if [ ! -f "$REAL_MEMORY/config/llm.conf" ]; then
  echo "✗ 找不到 $REAL_MEMORY/config/llm.conf，无法跑真实模型"
  exit 1
fi

echo "=== 1. 准备记忆副本（不含 session/daemon.log，含你的模型配置）==="
rm -rf "$WORK"
mkdir -p "$WORK"
rsync -a --exclude 'sessions/' --exclude 'daemon.log' --exclude 'journal/' --exclude 'runtime/' \
  "$REAL_MEMORY/" "$WORK/" >/dev/null 2>&1 || cp -R "$REAL_MEMORY/." "$WORK/"
mkdir -p "$WORK/config"
cp "$REAL_MEMORY/config/llm.conf" "$WORK/config/llm.conf"
chmod 600 "$WORK/config/llm.conf"
echo "  副本就绪：$(find "$WORK" -type f | wc -l | tr -d ' ') 个文件（身份与记忆都在，密钥只在 config/ 里）"

cleanup() {
  echo
  echo "=== 清理：删除含密钥的副本 ==="
  rm -rf "$WORK"
  echo "  已删除 $WORK"
}
trap cleanup EXIT

echo
echo "=== 2. 启动内核（读你的 llm.conf，常驻 pi 用真实模型）==="
SPRITE_HOME="$WORK" SPRITE_SOCKET="$SOCK" SPRITE_INTERVAL_MS=3600000 \
SPRITE_QUIET_START=0 SPRITE_QUIET_END=0 \
  node "$ROOT/core/main.ts" > "$WORK/core.log" 2>&1 &
CORE_PID=$!

for _ in $(seq 1 200); do [ -S "$SOCK" ] && break; sleep 0.1; done
if [ ! -S "$SOCK" ]; then echo "✗ 内核未就绪"; cat "$WORK/core.log"; exit 1; fi
grep -E "模型配置|导入|就绪" "$WORK/core.log" | sed 's/^/  /'

echo
echo "=== 3. 发一条消息，等它用真实模型回一次 ==="
node -e '
const net=require("net");
const s=net.connect(process.argv[1]);
let b="";
s.on("connect",()=>s.write(JSON.stringify({id:"c1",type:"command",command:{id:"real-1",type:"message.send",text:"这是一次真实模型的连通测试。请用一句话回应，然后读一下 identity.md，再停下来。"}})+"\n"));
s.on("data",d=>{b+=d;const i=b.indexOf("\n");if(i>=0){const r=JSON.parse(b.slice(0,i));console.log("  指令结果:",JSON.stringify(r.result));s.destroy();}});
' "$SOCK"

DEADLINE=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STATE=$(node -e '
const net=require("net");
const s=net.connect(process.argv[1]);
let b="";
s.on("connect",()=>s.write(JSON.stringify({id:"q",type:"query.status"})+"\n"));
s.on("data",d=>{b+=d;const i=b.indexOf("\n");if(i>=0){const r=JSON.parse(b.slice(0,i));const st=r.result;console.log(JSON.stringify({runs:st.runs,dangling:st.danglingRun,thoughts:st.thoughts.length,out:st.outgoing.length,acts:st.activities.length,dec:st.toolDecisions,fail:st.failures.length}));s.destroy();}});
s.on("error",()=>{console.log("ERR")});
' "$SOCK" 2>/dev/null)
  case "$STATE" in
    *'"dangling":false'*runs*|*'"runs":1'*) if echo "$STATE" | grep -q '"dangling":false'; then break; fi ;;
  esac
  sleep 3
done

echo
echo "=== 4. 真实模型这一拍的原始结果 ==="
node -e '
const net=require("net");
const s=net.connect(process.argv[1]);
let b="";
s.on("connect",()=>s.write(JSON.stringify({id:"s",type:"query.status"})+"\n"));
s.on("data",d=>{b+=d;const i=b.indexOf("\n");if(i>=0){
  const st=JSON.parse(b.slice(0,i)).result;
  console.log("  呼吸次数:", st.runs, "｜ 工具决策:", st.toolDecisions, "｜ 失败:", st.failures.length);
  console.log("  它说的话:");
  for (const o of st.outgoing.slice(-3)) console.log("    ·", o.text);
  console.log("  思维流:");
  for (const t of st.thoughts.slice(-3)) console.log("    ·", t.slice(0,200));
  console.log("  工具活动:");
  for (const a of st.activities.slice(-5)) console.log("    ·", a.tool, String(a.summary||"").slice(0,120));
  if (st.failures.length) { console.log("  失败原因:"); for (const f of st.failures.slice(-3)) console.log("    ✗", f.slice(0,300)); }
  s.destroy();
}});
' "$SOCK"

echo
echo "=== 5. 产物落盘情况 ==="
MAILBOX="$WORK/conversations/mailbox.md"
if [ -f "$MAILBOX" ]; then
  echo "  mailbox 新增行数: $(grep -c 'real\|测试\|回应' "$MAILBOX" 2>/dev/null || echo 0)"
  tail -3 "$MAILBOX" | sed 's/^/    /'
fi
echo "  journal 事件数: $(cat "$WORK"/journal/*.jsonl 2>/dev/null | grep -c . )"
echo "  session 文件: $(ls -la "$WORK"/sessions/*.jsonl 2>/dev/null | awk '{print $NF" ("$5" 字节)"}' | tail -1)"

echo
echo "=== 6. 内核日志里的错误（如果有）==="
grep -iE "error|失败|refused|denied|unauthorized|401|403|ENOTFOUND|fetch failed" "$WORK/core.log" | tail -5 | sed 's/^/  /' || echo "  （无）"

kill "$CORE_PID" 2>/dev/null
echo
echo "（副本内已有真实模型的一次对话与它的记忆；脚本退出时会删除副本）"
