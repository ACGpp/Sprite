#!/bin/bash
set -euo pipefail
LOCATION="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$LOCATION/runtime/bin/node" ]; then
    RESOURCES="$LOCATION"
else
    RESOURCES="$LOCATION/Sprite.app/Contents/Resources"
fi
# Explicit user confirmation when opening the uninstaller from Finder.
if ! /usr/bin/osascript <<'CONFIRM'
display dialog "Remove Sprite's background service and runtime files? Quit Sprite first. Your memories will be kept.\n\n移除 Sprite 后台服务和运行环境？请先退出 Sprite；记忆会保留。" buttons {"Cancel / 取消", "Uninstall / 卸载"} default button 1 cancel button 1 with icon caution
CONFIRM
then exit 0; fi
"$RESOURCES/runtime/bin/node" "$RESOURCES/bootstrap-runtime.mjs" --uninstall
/usr/bin/osascript <<'DONE'
display dialog "Background service removed. You can move Sprite.app to the Trash. Your memories remain in ~/.claude-memory/.\n\n后台服务已移除，可将应用移到废纸篓。记忆保留。" buttons {"OK / 好"} default button 1
DONE
