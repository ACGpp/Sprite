#!/usr/bin/env bash
# Create a public tree without exposing private development history.
# Default: prepare and scan a local commit only. --push explicitly publishes it.
# --source worktree includes pending tracked and untracked files without staging them.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SNAPSHOT_BRANCH="publish/code-only"
REMOTE="origin"
TARGET="main"
SOURCE="HEAD"
DO_PUSH=0
while [ $# -gt 0 ]; do
    case "$1" in
        --push) DO_PUSH=1 ;;
        --source) SOURCE="${2:?--source requires a commit or worktree}"; shift ;;
        --target) TARGET="${2:?--target requires a branch}"; shift ;;
        --branch) SNAPSHOT_BRANCH="${2:?--branch requires a branch}"; shift ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
git check-ref-format "refs/heads/$TARGET" >/dev/null
git check-ref-format "refs/heads/$SNAPSHOT_BRANCH" >/dev/null
if [ "$SNAPSHOT_BRANCH" = "$TARGET" ]; then
    echo "Snapshot branch must differ from the development/target branch." >&2
    exit 2
fi
# Resolve before updating the candidate branch, including when source == destination.
if [ "$SOURCE" != worktree ]; then SOURCE="$(git rev-parse --verify "${SOURCE}^{commit}")"; fi

echo "▶ Fetch public branch"
git fetch --quiet "$REMOTE" "refs/heads/$TARGET:refs/remotes/$REMOTE/$TARGET"
PARENT="$(git rev-parse "refs/remotes/$REMOTE/$TARGET")"
EXCLUDE=(docs .spike avatar home prototypes bin daemon ext build shell/.build shell/.build-release .core-test .demo .cleanup-backup node_modules dist dist-electron dist-shell out output release)
TMP_INDEX="$(mktemp -t sprite-publish.XXXXXX)"
rm -f "$TMP_INDEX"
trap 'rm -f "$TMP_INDEX"' EXIT
# Run in a subshell so the caller's index environment is left intact.
TREE="$(
    set -e
    export GIT_INDEX_FILE="$TMP_INDEX"
    if [ "$SOURCE" = worktree ]; then
        git read-tree HEAD
        PATHS=(.)
        for excluded in "${EXCLUDE[@]}"; do PATHS+=(":(exclude)$excluded"); done
        git ls-files --cached --others --exclude-standard -z -- "${PATHS[@]}" |
            git --literal-pathspecs add -A --pathspec-from-file=- --pathspec-file-nul
    else
        git read-tree "$SOURCE"
    fi
    for excluded in "${EXCLUDE[@]}"; do
        git rm -r --quiet --cached --ignore-unmatch -- "$excluded" >/dev/null
    done
    git write-tree
)"
VERSION="$(git show "$TREE:package.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
if git diff --quiet "$PARENT" "$TREE"; then
    echo "✓ Public tree is unchanged; nothing to publish."
    exit 0
fi
# Push only an already reviewed candidate based on the current public tip.
# Never silently rebase a stale candidate over someone else's update.
if [ "$DO_PUSH" = 1 ]; then
    if [ "$SOURCE" = worktree ] || [ "$(git show -s --format=%P "$SOURCE")" != "$PARENT" ] || [ "$(git rev-parse "$SOURCE^{tree}")" != "$TREE" ]; then
        echo "Prepare and review a snapshot first, then use --source <candidate> --push. The candidate must have the current public tip as its sole parent." >&2
        exit 1
    fi
fi
# Reuse a reviewed snapshot when its tree and parent are unchanged.
if [ "$SOURCE" != worktree ] && [ "$(git show -s --format=%P "$SOURCE")" = "$PARENT" ] && [ "$(git rev-parse "$SOURCE^{tree}")" = "$TREE" ]; then
    COMMIT="$SOURCE"
else
    COMMIT="$(git commit-tree "$TREE" -p "$PARENT" -m "Sprite $VERSION: public source snapshot" -m "See CHANGELOG.md and CHANGELOG.zh.md. Private development notes and history are excluded.")"
fi
echo "▶ Privacy scan (local memory probes; inspect the diff too)"
python3 "$ROOT/Scripts/privacy-scan.py" "$ROOT" "$COMMIT"
# A failed scan must not replace the last reviewed candidate branch.
git branch -f "$SNAPSHOT_BRANCH" "$COMMIT" >/dev/null
git diff --stat "$PARENT" "$COMMIT"
echo "Candidate: $SNAPSHOT_BRANCH ($COMMIT); parent: $PARENT"
if [ "$DO_PUSH" = 1 ]; then
    # Ordinary fast-forward only: concurrent remote updates must never be overwritten.
    git push "$REMOTE" "$COMMIT:refs/heads/$TARGET"
else
    echo "Prepared locally; no push. Working tree and normal index are unchanged."
fi
