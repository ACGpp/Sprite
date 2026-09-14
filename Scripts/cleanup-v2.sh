#!/usr/bin/env bash
# P5 清理：删除 Electron/Whisper/bash daemon 等被取代的实现。
#
# 默认**只打印**将要发生的事。真正执行需要两个显式开关：
#     Scripts/cleanup-v2.sh --apply --yes
#
# 执行前会自动备份到 .cleanup-backup/<时间戳>.tar.gz（工作区内，不入库）。
# 绝不触碰 ~/.claude-memory —— 那是它的记忆。
#
# 清单依据：docs/cleanup-plan.md

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPLY=false
CONFIRMED=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --yes) CONFIRMED=true ;;
    --help|-h) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg"; exit 2 ;;
  esac
done

DELETE_PATHS=(
  "src"
  "index.html"
  "vite.config.ts"
  "dist-electron"
  "dist"
  "avatar"
  "home"
  "prototypes"
  "bin/claude-daemon"
  "bin/claude-home"
  "bin/claude-office"
  "bin/claude-status"
  "bin/claude-stop"
  "daemon"
  "ext/claude-daemon.ts"
)

ARCHIVE_DOCS=(
  "docs/architecture.md"
  "docs/architecture-v2.md"
  "docs/design.md"
  "docs/flows.md"
  "docs/permissions.md"
  "docs/variables.md"
  "docs/automation.md"
  "docs/tests.md"
  "docs/release-macos.md"
  "docs/electron-rewrite-prd.md"
)

# 安全检查：这些必须存在，否则说明路径搞错了
SANITY=("core/main.ts" "contracts/events.ts" "pi-extension/sprite.ts" "shell/Package.swift")
for path in "${SANITY[@]}"; do
  if [ ! -e "$ROOT/$path" ]; then
    echo "✗ 安全检查失败：找不到 ${path}。新架构不完整，拒绝清理。"
    exit 1
  fi
done

echo "═══ P5 清理预览 ═══"
echo
echo "【将删除】"
total=0
for path in "${DELETE_PATHS[@]}"; do
  if [ -e "$ROOT/$path" ]; then
    size=$(du -sk "$ROOT/$path" 2>/dev/null | awk '{print $1}')
    lines=$(find "$ROOT/$path" -type f 2>/dev/null | wc -l | tr -d ' ')
    printf "  %-28s %6s KB  %4s 个文件\n" "$path" "$size" "$lines"
    total=$((total + size))
  fi
done
printf "  %-28s %6s KB\n" "合计" "$total"

echo
echo "【将归档到 docs/archive/v2/】"
for path in "${ARCHIVE_DOCS[@]}"; do
  [ -e "$ROOT/$path" ] && echo "  $path"
done

echo
echo "【明确不动】"
echo "  ~/.claude-memory/        它的记忆（新内核只追加、不重写历史）"
echo "  core/ contracts/ pi-extension/ shell/ Scripts/   新架构"
echo "  README.md LICENSE config.example"
echo
echo "【保留待定】tsconfig.json · tools/*.sh · build/ · .github/ · .spike/"

if [ "$APPLY" != true ]; then
  echo
  echo "（预览模式，什么都没做。要执行请加 --apply --yes）"
  exit 0
fi

if [ "$CONFIRMED" != true ]; then
  echo
  echo "✗ 需要 --apply 和 --yes 同时给出才会真正执行。"
  exit 2
fi

echo
echo "═══ 开始执行 ═══"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$ROOT/.cleanup-backup"
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/cleanup-$STAMP.tar.gz"

echo "1) 备份到 $BACKUP"
EXISTING=()
for path in "${DELETE_PATHS[@]}" "${ARCHIVE_DOCS[@]}"; do
  # dist/ 与 dist-electron/ 是可重建的构建产物（约 2GB），不值得进备份
  case "$path" in dist|dist-electron) continue ;; esac
  [ -e "$ROOT/$path" ] && EXISTING+=("$path")
done
(cd "$ROOT" && tar -czf "$BACKUP" "${EXISTING[@]}" 2>/dev/null)
echo "   备份完成：$(du -h "$BACKUP" | awk '{print $1}')（构建产物不入备份）"

echo "2) 删除"
for path in "${DELETE_PATHS[@]}"; do
  [ -e "$ROOT/$path" ] || continue
  rm -rf "$ROOT/$path"
  echo "   已删 $path"
done

echo "3) 归档文档"
mkdir -p "$ROOT/docs/archive/v2"
for path in "${ARCHIVE_DOCS[@]}"; do
  [ -e "$ROOT/$path" ] || continue
  mv "$ROOT/$path" "$ROOT/docs/archive/v2/"
  echo "   已归档 $(basename "$path")"
done

echo
echo "═══ 完成 ═══"
echo "备份：$BACKUP"
echo
echo "还需要手动做的（脚本不替你做）："
echo "  · npm pkg delete dependencies.electron-updater dependencies.@huggingface/transformers dependencies.react dependencies.react-dom dependencies.lucide-react dependencies.gsap dependencies.@gsap/react"
echo "  · npm pkg delete devDependencies.electron devDependencies.electron-builder devDependencies.vite devDependencies.vite-plugin-electron devDependencies.vite-plugin-electron-renderer devDependencies.@vitejs/plugin-react devDependencies.@types/react devDependencies.@types/react-dom"
echo "  · npm pkg delete scripts.dev scripts.dev:electron scripts.build scripts.dist:mac scripts.dist:mac:arm64 scripts.dist:mac:x64 scripts.release scripts.preview"
echo "  · 重写 README.md / README_EN.md，把 docs/redesign-v3.md 提升为 docs/architecture.md"
echo "  · npm ci 清理 node_modules"
