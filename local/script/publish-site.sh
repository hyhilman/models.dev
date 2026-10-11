#!/usr/bin/env bash
# Build packages/web/dist and publish it to local/.site, which local/script/serve.ts serves.
# The build deletes dist/ first, so the server never reads dist/: it reads a copy that is
# swapped in only after a build succeeds.
set -euo pipefail
cd "$(dirname "$0")/../.."

log() { echo "event=$1${2:+ $2}" >&2; }

if ! (cd packages/web && ./script/build.ts >/dev/null 2>&1); then
  log site.build_failed
  exit 1
fi

rm -rf local/.site.new local/.site.old
cp -a packages/web/dist local/.site.new
# Upstream leaves canonical_model_id out where a file has no base_model; fill it for our providers.
if ! bun local/script/canonical.ts local/.site.new; then
  rm -rf local/.site.new
  log site.canonical_failed
  exit 1
fi
[ -d local/.site ] && mv local/.site local/.site.old
mv local/.site.new local/.site
rm -rf local/.site.old
echo "$(git rev-parse HEAD)" > local/.site/.built-from
log site.published "head=$(git rev-parse --short=9 HEAD) files=$(find local/.site -type f | wc -l)"
