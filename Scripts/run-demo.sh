#!/usr/bin/env bash
# 离线演示：把整个产品跑起来给你看。
#
# 它说的话是假的（内置离线 provider 的固定台词），但除此之外全是真的：
# 真内核、真事件、真能力网关、真光球、真气泡、真读你的记忆。
# 不联网、不使用你的 API key、不改动 ~/.claude-memory 一个字节。
#
#   Scripts/run-demo.sh              启动内核 + 打开存在体
#   Scripts/run-demo.sh --no-launch  只起内核（CI / 自检用）
#
# 退出：在菜单栏选「退出（让它睡下）」，或在本脚本里按 Ctrl-C。

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="$ROOT/.demo"
HOME_DIR="$DEMO/home"
SOCK="$DEMO/runtime/core.sock"
NO_LAUNCH="${1:-}"

echo "=== 准备演示记忆（真实记忆的副本，排除密钥与会话大文件）==="
mkdir -p "$HOME_DIR"
if [ ! -f "$HOME_DIR/identity.md" ]; then
  REAL="$HOME/.claude-memory"
  if [ -f "$REAL/identity.md" ]; then
    rsync -a \
      --exclude 'config/llm.conf' \
      --exclude 'journal/' --exclude 'runtime/' \
      --exclude 'sessions/' --exclude 'daemon.log' \
      --exclude '*.lock' --exclude '.next-breath' \
      "$REAL/" "$HOME_DIR/" 2>/dev/null || cp -R "$REAL/." "$HOME_DIR/"
    echo "已复制：$(find "$HOME_DIR" -type f | wc -l | tr -d ' ') 个文件（不含 API key 与 session）"
  else
    echo "没有找到 ~/.claude-memory，用空记忆启动（它会像新的一样）"
  fi
else
  echo "复用已有演示记忆：$HOME_DIR"
fi

# 让引导面板知道"配置已就绪"，同时**绝不把 API key 复制进副本**
mkdir -p "$HOME_DIR/config"
cat > "$HOME_DIR/config/llm.conf" <<'CONF'
# 演示环境的配置占位：只有键名，没有你的密钥
LLM_TOOL=pi
PI_PROVIDER=demo-offline
PI_MODEL=demo-offline-provider
PI_API_KEY=
QUIET_START=0
QUIET_END=0
CONF
# 标记这是演示环境：外壳据此显示"演示模式"，而不是弹出首次见面引导
: > "$HOME_DIR/DEMO"

echo
echo "=== 编译内核（无需构建步骤）与外壳 ==="
(cd "$ROOT/shell" && CLANG_MODULE_CACHE_PATH="$ROOT/shell/.build/clang-cache" \
  SWIFT_MODULE_CACHE_PATH="$ROOT/shell/.build/swift-cache" \
  swift build --disable-sandbox --scratch-path .build --cache-path .build/cache 2>&1 | grep -E "error|Build complete" | head -3)

echo
echo "=== 启动内核（离线 provider，60 秒一拍，安静时段关闭）==="
PI_ARGS=$(printf '["--mode","rpc","--no-session","--provider","spike","--model","spike-1","-e","%s","-e","%s"]' \
  "$ROOT/pi-extension/sprite.ts" "$ROOT/core/__test__/fake-provider.ts")
SPRITE_HOME="$HOME_DIR" SPRITE_SOCKET="$SOCK" \
SPRITE_INTERVAL_MS=300000 SPRITE_QUIET_START=0 SPRITE_QUIET_END=0 \
SPRITE_PI_ARGS="$PI_ARGS" SPRITE_PI_HOME="$DEMO/pi-home" SPRITE_SPIKE_KEY=spike \
  node "$ROOT/core/main.ts" > "$DEMO/core.log" 2>&1 &
CORE_PID=$!
trap 'kill "$CORE_PID" 2>/dev/null; pkill -f "Sprite.app/Contents/MacOS/Sprite" 2>/dev/null' EXIT

for _ in $(seq 1 100); do [ -S "$SOCK" ] && break; sleep 0.1; done
if [ ! -S "$SOCK" ]; then
  echo "内核启动失败："; cat "$DEMO/core.log"; exit 1
fi
grep -E "导入|就绪" "$DEMO/core.log" | sed 's/^/  /'

echo
if [ "$NO_LAUNCH" = "--no-launch" ]; then
  echo "=== 只起内核（--no-launch）==="
  "$ROOT/shell/.build/debug/sprite-rpc-probe" status "$SOCK"
  echo "内核跑在 ${SOCK}，按 Ctrl-C 结束"
  wait "$CORE_PID"
  exit 0
fi

echo "=== 打开存在体 ==="
# 直接启动 bundle 内的可执行文件：参数一定传得到，且脚本能验证"真的连上了"
pkill -f "Sprite.app/Contents/MacOS/Sprite" 2>/dev/null || true
sleep 1
"$ROOT/dist-shell/Sprite.app/Contents/MacOS/Sprite" --socket "$SOCK" > "$DEMO/shell.log" 2>&1 &
SHELL_PID=$!

CONNECTED=false
for _ in $(seq 1 60); do
  if grep -q "新订阅者" "$DEMO/core.log" 2>/dev/null; then CONNECTED=true; break; fi
  sleep 0.5
done

echo
if [ "$CONNECTED" = true ]; then
  echo "✓ 它已经在桌面上了（内核已看到外壳订阅事件）"
else
  echo "⚠︎ 外壳没有连上内核，看 $DEMO/shell.log"
fi
echo "  菜单栏：「● Sprite」——状态点会随它的状态变（● 呼吸 / ◍ 想事情 / ‖ 暂停 / ○ 休息）"
echo "  桌面右下角：会呼吸的光球，环走满 = 它下一次醒来"
echo "  点光球 → 走近面板：此刻在做什么 / 最近 / 说一句话 / ⏺ 说话（语音输入）"
echo "  菜单里还有：现在叫醒它 · 暂停呼吸 · 它说话时朗读（默认关）· 设置与指引 · 诊断"
echo "  它每 5 分钟一拍（接近真实节奏）；台词是离线假的，状态/事件/记忆是真的"
echo
echo "  退出：菜单栏 →「退出（让它睡下）」，或在本脚本里按 Ctrl-C"

wait "$CORE_PID"
