#!/usr/bin/env bash
# Rebase our router branch onto the latest upstream models.dev, then check it.
# Run it in the tools image: local/script/run.sh bash local/script/sync-upstream.sh
#
# Rebase, so router is always upstream's dev plus our own commits on top. Only our code commits
# are replayed. The price commits (subject `chore(prices):`) are dropped: the feed writes the
# prices again on the new base from its last fetched lists, as one new `chore(prices):` commit.
#
# The new history is built on a detached HEAD, and router moves only after every check passes.
# A conflict, a failed check or a killed run leaves router where it was, and the script exits
# non-zero. It never resolves a conflict by keeping our side. The one exception takes upstream's
# side: a conflict inside a price folder (a provider in local/static.toml), which the feed
# writes again anyway.
set -euo pipefail
cd "$(dirname "$0")/../.."

log() { echo "event=$1${2:+ $2}" >&2; }

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "router" ]; then log sync.skip "reason=\"on branch $branch, not router\""; exit 1; fi
if [ -n "$(git status --porcelain)" ]; then log sync.skip 'reason="working tree not clean"'; exit 1; fi

git fetch -q upstream dev
before="$(git rev-parse HEAD)"
base="$(git rev-parse upstream/dev)"
if git merge-base --is-ancestor "$base" HEAD; then
  log sync.unchanged "head=${before:0:9}"
  exit 0
fi

# Our commits since upstream, oldest first, without merges and without price commits.
mapfile -t picks < <(git rev-list --reverse --topo-order --no-merges --invert-grep --grep='^chore(prices):' "$base..$before")

if [ "${PRICE_DRY_RUN:-0}" = "1" ]; then
  log sync.dry_run "would_rebase=${#picks[@]} upstream=${base:0:9}"
  exit 0
fi

mapfile -t price_dirs < <(bun -e 'const t = Bun.TOML.parse(await Bun.file("local/static.toml").text()); for (const p of t.providers ?? []) console.log(`providers/${p}/`)')
in_price_dir() {
  local p
  for p in "${price_dirs[@]}"; do case "$1" in "$p"*) return 0 ;; esac; done
  return 1
}

# Put the checkout back on router as it was. The tree was clean before, so this loses nothing.
moved=0
restore() {
  [ "$moved" = 1 ] && return
  git cherry-pick --abort >/dev/null 2>&1 || true
  git checkout -q -f router
  git clean -fdq -- providers
}
trap restore EXIT
trap 'exit 143' TERM INT

fail() {
  log sync.check_failed "step=$1"
  exit 3
}

# A picked commit keeps its own author. The job's GIT_AUTHOR_* would otherwise replace it.
pick() { env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_AUTHOR_DATE git -c core.editor=true cherry-pick "$@" >/dev/null 2>&1; }

git checkout -q --detach "$base"

for c in "${picks[@]}"; do
  pick "$c" && continue
  mapfile -t conflicted < <(git diff --name-only --diff-filter=U)
  if [ "${#conflicted[@]}" -gt 0 ]; then
    for f in "${conflicted[@]}"; do
      if ! in_price_dir "$f"; then
        log sync.conflict "commit=${c:0:9} files=\"$(IFS=,; echo "${conflicted[*]}")\""
        exit 2
      fi
    done
    # HEAD is the new base here, so "ours" is upstream's side.
    for f in "${conflicted[@]}"; do
      if git cat-file -e "HEAD:$f" 2>/dev/null; then git checkout -q --ours -- "$f" && git add -- "$f"
      else git rm -q -- "$f"; fi
    done
    log sync.took_upstream "commit=${c:0:9} files=\"$(IFS=,; echo "${conflicted[*]}")\""
  fi
  # A commit that upstream already has now changes nothing: drop it, so the history stays short.
  if git diff --cached --quiet; then
    pick --skip || fail "pick ${c:0:9}"
  else
    pick --continue || fail "pick ${c:0:9}"
  fi
done

# The feed writes the prices again on the new base. Its event lines stay out of the log: compared
# with upstream's files, every price would look new.
out="$(PRICE_NO_COMMIT=1 bun local/script/apply-static.ts 2>&1)" || { printf '%s\n' "$out" | grep '^event=static.error' >&2 || true; fail apply; }
git add -A -- "${price_dirs[@]}"
if ! git diff --cached --quiet; then
  git commit -q -m "chore(prices): write the prices again on upstream ${base:0:9}"
fi

# Upstream never touches our own files. A difference here means a commit was dropped or picked
# wrong, so router stays where it was.
git diff --quiet "$before" HEAD -- local CLAUDE.md doppelganger.toml doppelganger.config.ts || fail guard

if ! git diff --quiet "$before" HEAD -- bun.lock package.json 'packages/*/package.json'; then
  bun install --frozen-lockfile >/dev/null || fail install
fi
bun validate >/dev/null || fail validate
# Only our tests: upstream's own suite already has failures we do not own, so a full
# `bun test` would block every sync.
bun test local/test >/dev/null 2>&1 || fail test

git checkout -q -B router
moved=1
log sync.rebased "from=${before:0:9} to=$(git rev-parse --short=9 HEAD) upstream=${base:0:9} picked=${#picks[@]}"
