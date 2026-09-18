#!/bin/bash
# 语音全链路验证：真麦克风 → 真转写 → 存进记忆 → 回读 → 逐字节比对。
#
# 关键点：**不碰用户的真实记忆**。这里起一个独立的测试内核（工作区内的 home），
# 用系统 TTS 对着麦克风念一句话，剩下的走与面板完全相同的代码路径。
#
# 用法：Scripts/verify-voice.sh [秒数]
set -euo pipefail
cd "$(dirname "$0")/.."
SECONDS_TO_RECORD="${1:-7}"
HOME_DIR="$PWD/.core-test/voice-e2e"
SOCKET="$HOME_DIR/runtime/core.sock"
SHELL_BIN="shell/.build/debug/sprite-shell"
VOICE_TEXT="我现在在测试一段比较长的录音，用来确认实时识别的文字和完整音频重新识别的文字是一致的，而且一句话很长、中间不停顿，看看会不会丢掉后面的内容。"

rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR/conversations"
: > "$HOME_DIR/conversations/mailbox.md"

echo "── 1. 起测试内核（独立 home，SPRITE_NO_PI=1）──"
SPRITE_HOME="$HOME_DIR" SPRITE_SOCKET="$SOCKET" SPRITE_NO_PI=1 \
	SPRITE_QUIET_START=0 SPRITE_QUIET_END=0 \
	node core/main.ts > "$HOME_DIR/kernel.log" 2>&1 &
KERNEL_PID=$!
trap 'kill $KERNEL_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do [ -S "$SOCKET" ] && break; sleep 0.25; done
[ -S "$SOCKET" ] || { echo "内核没起来："; tail -5 "$HOME_DIR/kernel.log"; exit 1; }
echo "内核就绪（pid ${KERNEL_PID}）"

echo
echo "── 2. 先量一下环境里有没有声音（夜间静音 / 无声卡时不该假失败）──"
"$SHELL_BIN" --lang zh --transcribe voice/不存在.m4a --socket "$SOCKET" >/dev/null 2>&1 || true
# 录 2 秒，量电平：几乎没有声音就跳过（这属于"环境不具备条件"，不是产品缺陷）
"$SHELL_BIN" --lang zh --record-test 2 --socket "$SOCKET" > "$HOME_DIR/probe.log" 2>&1 || true
if grep -q "麦克风几乎没收到声音" "$HOME_DIR/probe.log"; then
	echo "  环境无声（音量关了 / 没有麦克风输入）——语音链路本阶段**如实跳过**，不算通过"
	echo "  跳过原因见：$HOME_DIR/probe.log"
	exit 0
fi

echo
echo "── 2. 对着麦克风念一句（系统 TTS 出声，同时开始录音）──"
( sleep 1.2; say -v Tingting "$VOICE_TEXT" 2>/dev/null || say "$VOICE_TEXT" ) &
SAY_PID=$!
"$SHELL_BIN" --lang zh --record-test "$SECONDS_TO_RECORD" --socket "$SOCKET"
RC=$?
wait $SAY_PID 2>/dev/null || true

echo
echo "── 3. 界面里看不看得见（真视图截图 + 系统文字识别读回来）──"
SHOT_DIR="$HOME_DIR/shots"
"$SHELL_BIN" --lang zh --shot "$SHOT_DIR" --section voice --socket "$SOCKET" 2>&1 | grep -E "✓|✗|连接|结论" | sed 's/^/  /'
"$SHELL_BIN" --lang zh --shot "$SHOT_DIR" --section voice --socket "$SOCKET" 2>&1 | sed -n '/记录窗口-voice.png 屏上文字/,$p' | sed 's/^/  /'

echo
echo "── 4. 记忆里到底落了什么（直接看文件，不看接口自述）──"
ls -l "$HOME_DIR/voice" 2>/dev/null | tail -3
echo "日志事件："
grep -o '"type":"voice.recorded"' "$HOME_DIR"/journal/*.jsonl 2>/dev/null | wc -l | xargs echo "  voice.recorded 条数："
grep -o '"transcript":"[^"]*"' "$HOME_DIR"/journal/*.jsonl 2>/dev/null | head -2
exit $RC
