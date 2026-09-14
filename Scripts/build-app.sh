#!/usr/bin/env bash
# 组装 Sprite.app（菜单栏应用，无主窗口）。
#
# 关键 Info.plist 项：
#   LSUIElement = true            —— 菜单栏应用，不占 Dock、不抢焦点
#   NSMicrophoneUsageDescription  —— 语音输入必须声明，否则授权弹窗不会出现
#   NSSpeechRecognitionUsageDescription —— 系统语音识别同理
#
# 用法：Scripts/build-app.sh [debug|release]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${1:-release}"
SHELL_DIR="$ROOT/shell"
APP="$ROOT/dist-shell/Sprite.app"

echo "=== 编译 ($CONFIG) ==="
cd "$SHELL_DIR"
CLANG_MODULE_CACHE_PATH="$SHELL_DIR/.build/clang-cache" \
SWIFT_MODULE_CACHE_PATH="$SHELL_DIR/.build/swift-cache" \
  swift build --disable-sandbox --configuration "$CONFIG" --scratch-path .build --cache-path .build/cache

BIN="$SHELL_DIR/.build/$CONFIG/sprite-shell"
[ -x "$BIN" ] || { echo "找不到可执行文件: $BIN"; exit 1; }

echo "=== 组装 $APP ==="
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Sprite"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Sprite</string>
	<key>CFBundleDisplayName</key><string>Sprite</string>
	<key>CFBundleIdentifier</key><string>com.sprite.shell</string>
	<key>CFBundleExecutable</key><string>Sprite</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.3.0</string>
	<key>CFBundleVersion</key><string>3</string>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<!-- 菜单栏常驻应用：不出现在 Dock，也没有可关闭的主窗口 -->
	<key>LSUIElement</key><true/>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSMicrophoneUsageDescription</key>
	<string>Sprite 使用麦克风把你的语音转成文字；录音只在你主动按住时开始。</string>
	<key>NSSpeechRecognitionUsageDescription</key>
	<string>Sprite 使用系统语音识别把你说的话转成文字；不使用云端识别。</string>
	<key>NSHumanReadableCopyright</key><string>MIT License</string>
</dict>
</plist>
PLIST

echo "=== 校验 ==="
plutil -lint "$APP/Contents/Info.plist" >/dev/null && echo "Info.plist 合法"
/usr/libexec/PlistBuddy -c "Print :LSUIElement" "$APP/Contents/Info.plist" | sed 's/^/LSUIElement = /'
codesign --force --sign - "$APP" 2>/dev/null && echo "已做本地临时签名（ad-hoc）" || echo "跳过签名（未安装签名工具链）"
echo "产物：$APP"
echo "启动方式：open '$APP'（它会先找 ~/.claude-memory/runtime/core.sock，没有内核时如实显示未连接）"
