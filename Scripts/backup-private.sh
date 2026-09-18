#!/usr/bin/env bash
# 把**完整开发线**（含 docs、评审、验收报告与逐步历史）备份到私有仓库。
#
# 为什么需要：公开仓库 origin/main 只是"代码快照"，docs/ 与 33+ 个提交的逐步历史
# 只在本机。硬盘坏了、误删了就没了——公开仓库里没有副本。
#
# 私有仓库：github.com/ACGpp/Sprite-dev（private）。私人备份本来就该带文档与真实经历，
# 所以 pre-push 钩子对非公开仓库放行（只对公开的 origin 跑隐私闸门）。
#
# 用法：Scripts/backup-private.sh
set -euo pipefail

cd "$(dirname "$0")/.."
REMOTE="private"
BRANCH="main"

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
	echo "✗ 没有名为 $REMOTE 的远端。先加上：" >&2
	echo "    git remote add $REMOTE git@github.com:ACGpp/Sprite-dev.git" >&2
	exit 1
fi

url="$(git remote get-url "$REMOTE")"
case "$url" in
	*ACGpp/Sprite.git*)
		echo "✗ $REMOTE 指向的是**公开**仓库（${url}）——这个脚本只用来备份到私有仓库" >&2
		exit 1
		;;
esac

echo "▶ 备份 $BRANCH → ${REMOTE}（${url}）"
git push "$REMOTE" "$BRANCH"
echo "✓ 备份完成：$(git rev-parse "$BRANCH")"
echo "  公开仓库 origin/main 仍是代码快照（$(git rev-parse origin/main 2>/dev/null || echo '未知')）"
