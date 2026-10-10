#!/usr/bin/env bash
# Merge the latest upstream models.dev into our router branch, then check it.
# Run it in the tools image: local/script/run.sh bash local/script/sync-upstream.sh
#
# Merge, never rebase: a rebase rewrites our commits and loses the shared history.
# On a conflict, or when the checks fail, the branch goes back to where it was, and the
# script exits non-zero. It never resolves a conflict by keeping our side. The one exception
# takes upstream's side: a conflict inside a `patch` provider, where only our prices differ.
set -euo pipefail
cd "$(dirname "$0")/../.."

log() { echo "event=$1${2:+ $2}" >&2; }

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "router" ]; then log sync.skip "reason=\"on branch $branch, not router\""; exit 1; fi
if [ -n "$(git status --porcelain)" ]; then log sync.skip 'reason="working tree not clean"'; exit 1; fi

git fetch -q upstream dev
before="$(git rev-parse HEAD)"
if git merge-base --is-ancestor upstream/dev HEAD; then
  log sync.unchanged "head=${before:0:9}"
  exit 0
fi

if [ "${PRICE_DRY_RUN:-0}" = "1" ]; then
  log sync.dry_run "would_merge=$(git rev-list --count HEAD..upstream/dev) upstream=$(git rev-parse --short=9 upstream/dev)"
  exit 0
fi

if ! git merge -q --no-edit upstream/dev; then
  # In a `patch` provider (local/static.toml) only our [cost] lines differ from upstream, so a
  # conflict there takes upstream's file whole. The next static run writes the price again.
  # A conflict anywhere else aborts.
  patch="$(bun -e 'const t = Bun.TOML.parse(await Bun.file("local/static.toml").text()); console.log((t.patch ?? []).join(" "))')"
  mapfile -t conflicted < <(git diff --name-only --diff-filter=U)
  ours_only=1
  for f in "${conflicted[@]}"; do
    in_patch=0
    for p in $patch; do case "$f" in "providers/$p/"*) in_patch=1 ;; esac; done
    [ "$in_patch" = 1 ] || ours_only=0
  done
  if [ "$ours_only" = 1 ] && [ "${#conflicted[@]}" -gt 0 ]; then
    for f in "${conflicted[@]}"; do
      if git cat-file -e "upstream/dev:$f" 2>/dev/null; then git checkout -q --theirs -- "$f" && git add -- "$f"
      else git rm -q -- "$f"; fi
    done
    git commit -q --no-edit
    log sync.took_upstream "files=\"$(IFS=,; echo "${conflicted[*]}")\""
  else
    files="$(IFS=,; echo "${conflicted[*]}")"
    git merge --abort
    log sync.conflict "files=\"$files\""
    exit 2
  fi
fi

fail() {
  log sync.check_failed "step=$1"
  # The merge is ours and the tree was clean before it, so going back loses nothing.
  git reset -q --hard "$before"
  exit 3
}

if ! git diff --quiet "$before" HEAD -- bun.lock package.json 'packages/*/package.json'; then
  bun install --frozen-lockfile >/dev/null || fail install
fi
bun validate >/dev/null || fail validate
# Only our tests: upstream's own suite already has failures we do not own, so a full
# `bun test` would block every merge.
bun test local/test >/dev/null 2>&1 || fail test

log sync.merged "from=${before:0:9} to=$(git rev-parse --short=9 HEAD) upstream=$(git rev-parse --short=9 upstream/dev)"
