#!/bin/bash
# ─── Sprite 安装脚本（v3：内核 + 原生外壳）─────────────────
#
# 做四件事：
#   1. 检查依赖（node / pi / Xcode 命令行工具）
#   2. 编译并安装 Sprite.app（默认 /Applications，没权限就装到 ~/Applications）
#   3. 把内核装到 ~/Library/Application Support/Sprite/kernel/
#      （**不依赖仓库目录**：仓库删了/挪了它照样跑）
#   4. 装 launchd 常驻服务（内核崩溃自动拉起），并加载它
#
# 用法：
#   ./install.sh              安装 / 升级（内核复制到稳定目录，与仓库解耦）
#   ./install.sh --dev        开发用：内核直接跑仓库里的代码（改了代码重启就生效）
#   ./install.sh --no-service 只装应用与内核，不装 launchd 服务
#   ./install.sh --uninstall  卸载（**保留记忆** ~/.claude-memory）
#
# 记忆只在本机：~/.claude-memory，脚本不碰它的内容。

set -euo pipefail

# ─── 界面语言：跟随系统（中文 → 中文，其它 → English）───
# 显式覆盖：SPRITE_LANG=zh|en（验证脚本与截图用，避免结果取决于开发机的系统语言）
UI_LANG="${SPRITE_LANG:-}"
if [ -z "$UI_LANG" ]; then
	case "${LC_ALL:-}${LANG:-}${AppleLocale:-}" in
		*zh*|*ZH*|*CN*|*Hans*) UI_LANG=zh ;;
		*) UI_LANG=en ;;
	esac
fi
# t "中文" "English"：英文环境取第二个参数；没给英文就回落中文
t() {
	if [ "$UI_LANG" = "en" ] && [ "$#" -ge 2 ]; then printf '%s' "$2"; else printf '%s' "$1"; fi
}

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME/.claude-memory"
SUPPORT_DIR="$HOME/Library/Application Support/Sprite"
KERNEL_DIR="$SUPPORT_DIR/kernel"
AGENT_LABEL="com.sprite.core"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
MODE="install"

for arg in "$@"; do
	case "$arg" in
		--uninstall) MODE="uninstall" ;;
		--no-service) MODE="no-service" ;;
		--dev) MODE="dev" ;;
		-h|--help)
			if [ "$UI_LANG" = "en" ]; then
				cat <<'USAGE'

  Sprite installer (v3: kernel + native shell)

  What it does:
    1. Checks dependencies (node / pi / Xcode command line tools)
    2. Builds and installs Sprite.app (default /Applications; ~/Applications without permission)
    3. Installs the kernel to ~/Library/Application Support/Sprite/kernel/
       (independent of this repo: move or delete the repo and it still runs)
    4. Installs and loads the launchd service com.sprite.core (auto-restarts on crash)

  Usage:
    ./install.sh              install / upgrade (kernel copied to a stable directory)
    ./install.sh --dev        development: the kernel runs straight from this repo
    ./install.sh --no-service install app + kernel, but no launchd service
    ./install.sh --uninstall  remove app + service (memory in ~/.claude-memory is kept)

  Language: follows the system language (zh or en); SPRITE_LANG=zh|en overrides it.

USAGE
				exit 0
			fi
			sed -n '2,18p' "$0"; exit 0 ;;
		*) echo "$(t "不认识的参数：${arg}（用 --help 看用法）" "Unknown argument: ${arg} (try --help)")"; exit 1 ;;
	esac
done

say() { printf '  %s\n' "$(t "$@")"; }
die() { printf '\n  ✗ %s\n\n' "$(t "$@")"; exit 1; }

# ─── 卸载 ───
if [ "$MODE" = "uninstall" ]; then
	echo ""
	echo "  $(t "卸载 Sprite（记忆保留在 ${HOME_DIR}）" "Uninstalling Sprite (memory kept in ${HOME_DIR})")"
	launchctl bootout "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null || true
	rm -f "$AGENT_PLIST"
	rm -rf "$SUPPORT_DIR"
	for target in "/Applications/Sprite.app" "$HOME/Applications/Sprite.app"; do
		if [ -d "$target" ]; then rm -rf "$target"; say "已删除 $target"; fi
	done
	say "记忆仍然在 ${HOME_DIR}（想彻底清掉就自己删它）" "Memory is still in ${HOME_DIR} (delete it yourself if you want it gone)"
	echo ""
	exit 0
fi

echo ""
echo "  $(t "让它在你的 Mac 上醒来。" "Wake it up on your Mac.")"
echo "  $(t "记忆只留在这台机器：" "Memory stays on this machine: ")$HOME_DIR"
echo ""

# ─── 1. 依赖 ───
command -v node >/dev/null 2>&1 || die "没找到 node。装一个再来：https://nodejs.org（需要 22 以上）"
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then die "node 版本太旧（$("$NODE_BIN" -v)）。内核用 Node 原生跑 TypeScript，需要 22 以上。"; fi
say "node ✓ $("$NODE_BIN" -v)"

command -v pi >/dev/null 2>&1 || die "没找到 pi（思考引擎）。先装：npm install -g @mariozechner/pi-coding-agent"
say "pi ✓ $(command -v pi)"

command -v swift >/dev/null 2>&1 || die "没找到 swift。装 Xcode 命令行工具：xcode-select --install"
say "swift ✓"

# ─── 2. 编译并安装应用 ───
say "编译 Sprite.app（第一次要一两分钟）…" "Building Sprite.app (a minute or two the first time)…"
"$REPO_DIR/Scripts/build-app.sh" release >/dev/null || die "编译失败。单独跑 Scripts/build-app.sh release 看错误。"
APP_SOURCE="$REPO_DIR/dist-shell/Sprite.app"
[ -d "$APP_SOURCE" ] || die "编译产物不在：$APP_SOURCE"

TARGET_DIR="/Applications"
if [ ! -w "$TARGET_DIR" ]; then TARGET_DIR="$HOME/Applications"; fi
mkdir -p "$TARGET_DIR"
rm -rf "$TARGET_DIR/Sprite.app"
cp -R "$APP_SOURCE" "$TARGET_DIR/Sprite.app"
say "应用已装到 $TARGET_DIR/Sprite.app" "App installed to $TARGET_DIR/Sprite.app"

# ─── 3. 装内核 ───
if [ "$MODE" = "dev" ]; then
	# 开发模式：直接跑仓库里的内核（改了代码重启就生效，不用重新装）
	KERNEL_RUN_DIR="$REPO_DIR"
	KERNEL_MAIN="$REPO_DIR/core/main.ts"
	say "内核：跑仓库里的 ${KERNEL_MAIN}（开发模式）" "Kernel: running ${KERNEL_MAIN} from this repo (dev mode)"
else
	mkdir -p "$KERNEL_DIR"
	rm -rf "$KERNEL_DIR/core" "$KERNEL_DIR/contracts" "$KERNEL_DIR/pi-extension"
	cp -R "$REPO_DIR/core" "$REPO_DIR/contracts" "$REPO_DIR/pi-extension" "$KERNEL_DIR/"
	KERNEL_RUN_DIR="$KERNEL_DIR"
	KERNEL_MAIN="$KERNEL_DIR/core/main.ts"
	say "内核已装到 ${KERNEL_DIR}（内核不需要任何 npm 依赖）" "Kernel installed to ${KERNEL_DIR} (it has no npm dependencies)"
fi

mkdir -p "$HOME_DIR"
say "记忆目录：$HOME_DIR" "Memory directory: $HOME_DIR"

if [ "$MODE" = "no-service" ]; then
	echo ""
	echo "  $(t "跳过 launchd 服务（--no-service）。自己起内核：" "Skipping the launchd service (--no-service). Start the kernel yourself:")"
	echo "    SPRITE_HOME=\"$HOME_DIR\" node \"$KERNEL_MAIN\""
	echo ""
else
	# ─── 4. launchd 常驻 ───
	mkdir -p "$(dirname "$AGENT_PLIST")" "$LOG_DIR"
	cat > "$AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$AGENT_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE_BIN</string>
		<string>$KERNEL_MAIN</string>
	</array>
	<key>WorkingDirectory</key><string>$KERNEL_RUN_DIR</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>SPRITE_HOME</key><string>$HOME_DIR</string>
		<key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$LOG_DIR/sprite-core.log</string>
	<key>StandardErrorPath</key><string>$LOG_DIR/sprite-core.err.log</string>
</dict>
</plist>
PLIST
	# bootout 是**异步**的：紧接着 bootstrap 会撞车（实测报 Bootstrap failed: 5），所以要重试
	launchctl bootout "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null || true
	loaded=""
	for attempt in 1 2 3 4 5; do
		if launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST" 2>/dev/null; then loaded="yes"; break; fi
		sleep 1
	done
	[ -n "$loaded" ] || die "launchd 加载失败。看 $LOG_DIR/sprite-core.err.log"
	launchctl kickstart -k "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null || true
	# **装完必须验证内核真的在跑**：加载成功不等于内核起来了（这正是刚才踩的坑）
	started=""
	for _ in $(seq 1 30); do
		if [ -S "$HOME_DIR/runtime/core.sock" ]; then started="yes"; break; fi
		sleep 0.5
	done
	[ -n "$started" ] || die "服务加载了但内核没起来。看 $LOG_DIR/sprite-core.err.log"
	say "内核常驻服务已加载并且在跑（崩溃会自动拉起，日志：$LOG_DIR/sprite-core.log)" "The kernel service is loaded and running (it restarts on crash; log: $LOG_DIR/sprite-core.log)"
fi

echo ""
echo "  $(t "装好了。接下来：" "Done. Next:")"
echo "    $(t "1. 打开应用程序里的 Sprite（菜单栏会出现一个会呼吸的点）" "1. Open Sprite from Applications (a breathing dot appears in the menu bar)")"
echo "    $(t "2. 第一次它会弹出配置面板：选服务商、粘贴 API Key，按「保存并应用」" "2. On first launch it asks for a provider and an API key — then press Save & Apply")"
echo "    $(t "3. 想开机就在：设置页把「登录时自动打开它」打开" "3. To keep it around: turn on “Start at login” in Settings")"
echo ""
echo "  $(t "如果之前用命令行手动跑过内核，先停掉它（同一个记忆只允许一个内核）：" "If you ever started the kernel by hand, stop it first (one kernel per memory):")"
echo "    pkill -f 'core/mai[n].ts'"
echo ""
