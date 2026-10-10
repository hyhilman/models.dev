#!/usr/bin/env bash
# The one entry point doppelganger calls, inside the tools image.
# Usage: bash local/script/job.sh static|sync
#
# A lock in .git keeps the two jobs from writing the repo at once: the feed runs every minute
# and the sync every hour, in separate containers on the same files.
#
# Env: PRICE_PUSH=1     push `router` to origin when it is ahead
#      GH_CONFIG_DIR    a gh login, mounted read-only; pushes go over https with its token
set -euo pipefail
cd "$(dirname "$0")/../.."

log() { echo "event=$1${2:+ $2}" >&2; }

exec 9>.git/price-router.lock
if ! flock -w 300 9; then log job.locked 'reason="the other price job held the lock for 5 minutes"'; exit 1; fi

# The jobs commit, so they work only on router. A person who switched branches is left alone.
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "router" ]; then log job.skip "reason=\"on branch $branch, not router\""; exit 0; fi

[ -d node_modules ] || bun install --frozen-lockfile >/dev/null

case "${1:-}" in
  # A failed fetch keeps the last fetched list, so the apply still runs. The job still fails, so the
  # log reports it.
  static) fetched=0; bun local/script/fetch-feeds.ts || fetched=$?
          bun local/script/apply-static.ts
          [ "$fetched" = 0 ] || exit "$fetched" ;;
  sync) bash local/script/sync-upstream.sh ;;
  *) log job.usage "got=\"${1:-}\""; exit 64 ;;
esac

# Rebuild the local site when the repo moved since the last build. A failed build keeps the old
# site and fails the job, so the log reports it.
if [ "${PRICE_DRY_RUN:-0}" != "1" ] && [ "$(cat local/.site/.built-from 2>/dev/null)" != "$(git rev-parse HEAD)" ]; then
  bash local/script/publish-site.sh
fi

[ "${PRICE_PUSH:-0}" = "1" ] || exit 0
if [ "$(git rev-parse HEAD)" = "$(git rev-parse -q --verify origin/router || true)" ]; then exit 0; fi

net=()
if [ -n "${GH_CONFIG_DIR:-}" ]; then
  # origin is an ssh URL and the image has no key, so talk https with the gh login's token.
  net=(-c "url.https://github.com/.insteadOf=git@github.com:"
       -c credential.helper=
       -c "credential.https://github.com.helper=!gh auth git-credential")
fi
git "${net[@]}" push -q origin router
log job.pushed "head=$(git rev-parse --short=9 HEAD)"
