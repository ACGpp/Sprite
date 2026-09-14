#!/usr/bin/env bash
# 把**代码**发布到 GitHub，但不发布记忆之家的私人材料。
#
# 背景：本地 main 是完整开发线，25+ 个提交里混着 docs/（私人对话叙述）、
# `.spike/` 试制品、构建缓存。直接 push 会把这些一起公开，而且推上去就收不回来。
#
# 做法：不动工作树、不改写公开历史——
#   在临时索引里从 HEAD 的树出发，摘掉不发布的目录，把"代码快照"提交成
#   origin/main 的子提交（fast-forward），扫过隐私闸门后再推。
#   本地 main 保持原样（完整历史与文档都还在），快照分支单独存着。
#
# 用法：
#   Scripts/publish-code.sh                 # 演练：建快照 + 扫描，不推
#   Scripts/publish-code.sh --push          # 扫描通过才推
#   Scripts/publish-code.sh --push --target main
#   Scripts/publish-code.sh --push --replace # 替换上一次的快照提交（仅当"上一个快照本身
#                                           # 有问题"时用：force-with-lease，远端若被别人
#                                           # 动过就会失败，不会覆盖别人的工作）
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SNAPSHOT_BRANCH="publish/code-only"
REMOTE="origin"
TARGET="main"
DO_PUSH=0
REPLACE=0

while [ $# -gt 0 ]; do
	case "$1" in
		--push) DO_PUSH=1 ;;
		--replace) REPLACE=1 ;;
		--target) TARGET="${2:?--target 需要参数}"; shift ;;
		--branch) SNAPSHOT_BRANCH="${2:?--branch 需要参数}"; shift ;;
		*) echo "未知参数：$1" >&2; exit 2 ;;
	esac
	shift
done

# 不发布的顶层条目（改这里等于改发布范围，谨慎；docs 里是主人的私人叙述）
EXCLUDE=(docs .spike avatar home prototypes bin daemon ext build shell/.build shell/.build-release)

echo "▶ 取远端最新状态"
git fetch --quiet "$REMOTE"
PARENT="$(git rev-parse "$REMOTE/$TARGET")"
# 上一次推的就是"代码快照"吗？是的话，快照要挂在**它的父提交**上（而不是它自己）——
# 否则每发一次就在公开历史里叠一层，而且"上一版快照里的东西"永远留在历史里
# （实测踩过：含私人内容的那版快照被当成父提交，等于白替换）。
SNAPSHOT_MARK="v3：内核 + 原生外壳（代码快照）"
if [ "$(git log -1 --format=%s "$PARENT" 2>/dev/null)" = "$SNAPSHOT_MARK" ]; then
	if [ "$REPLACE" != "1" ]; then
		echo "✗ 远端 main 现在就是一个代码快照；要重新发布请加 --replace" >&2
		exit 1
	fi
	# 一路回溯：可能叠了好几层快照（实测踩过：只退一层，坏的那版仍然留在历史里）
	while [ "$(git log -1 --format=%s "$PARENT" 2>/dev/null)" = "$SNAPSHOT_MARK" ]; do
		PARENT="$(git rev-parse "${PARENT}^")"
	done
	echo "   （远端已是快照：这次挂在快照之前的 ${PARENT:0:7} 上，替换而不是叠加）"
fi

echo "▶ 在临时索引里建代码快照（父提交 = $REMOTE/${TARGET}，工作树不动）"
TMP_INDEX="$(mktemp -t sprite-publish.XXXXXX)"
rm -f "$TMP_INDEX"
export GIT_INDEX_FILE="$TMP_INDEX"
trap 'rm -f "$TMP_INDEX"' EXIT

git read-tree HEAD
for path in "${EXCLUDE[@]}"; do
	git rm -r --quiet --cached --ignore-unmatch "$path" >/dev/null 2>&1 || true
done
TREE="$(git write-tree)"
unset GIT_INDEX_FILE

if git diff --quiet "$PARENT" "$TREE"; then
	echo "✓ 快照与 $REMOTE/$TARGET 没有差异，不需要发布"
	exit 0
fi

echo "▶ 相对 $REMOTE/$TARGET 的变化"
git diff --stat "$PARENT" "$TREE" | tail -3
echo "   删除的公开文件（v2 遗留，v3 已用内核+原生外壳取代）："
git diff --name-status "$PARENT" "$TREE" | awk '$1=="D"{print "     - "$2}' | head -12

COMMIT="$(git commit-tree "$TREE" -p "$PARENT" -m "v3：内核 + 原生外壳（代码快照）

- 内核 core/：单写者日志（真相来源）+ 呼吸调度 + pi 常驻 RPC + 能力网关
- 原生外壳 shell/：菜单栏存在体、下拉面板对话、记录窗口；只经本机 socket 说话
- 契约 contracts/、pi 扩展 pi-extension/、验证脚本 Scripts/
- 取代 v2 的守护进程与 Electron 外壳（bin/ daemon/ ext/ home/ 已移除）

详细开发历史（含文档与试制品）留在作者本地，未随此快照发布。")"
git branch -f "$SNAPSHOT_BRANCH" "$COMMIT" >/dev/null
echo "   快照提交：$(git log -1 --format='%h %an <%ae>' "$SNAPSHOT_BRANCH")"

echo "▶ 隐私闸门（真实密钥 / 主人名字 / 绝对家目录 / 与真实记忆逐字重合）"
python3 "$ROOT/Scripts/privacy-scan.py" "$ROOT" "$SNAPSHOT_BRANCH" || {
	echo "✗ 未通过：先脱敏，或在 Scripts/privacy-allowlist.txt 里逐条确认（快照仍在本地分支 ${SNAPSHOT_BRANCH}）" >&2
	exit 1
}

if [ "$DO_PUSH" = "1" ]; then
	echo "▶ 推送到 $REMOTE/$TARGET"
	if [ "$REPLACE" = "1" ]; then
		# 替换上一个快照：--force-with-lease 先核对远端当前值，
		# 别人若在我们之后推过东西，这次推送会失败而不是覆盖他。
		git push --force-with-lease "$REMOTE" "$SNAPSHOT_BRANCH:$TARGET"
	else
		git push "$REMOTE" "$SNAPSHOT_BRANCH:$TARGET"
	fi
	echo "✓ 已发布。本地 main 仍是完整开发线；$SNAPSHOT_BRANCH 是已公开的代码快照。"
else
	echo
	echo "（演练模式，没有推送。确认无误后加 --push）"
	echo "  快照分支：${SNAPSHOT_BRANCH}（本地 main 未改动）"
fi
