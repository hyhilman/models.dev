#!/usr/bin/env bash
# Run one command in the tools image, with this repo mounted at its host path.
# Usage: local/script/run.sh <command> [args...]
# Example: local/script/run.sh bun validate
#
# doppelganger builds the same `docker run` itself, because its supervisor cannot see this
# script. Keep the two in step: same image, same mounts, same env names.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${PRICE_IMAGE:-models-dev-router-tools:bun1.3.0}"
STATIC_DIR="${PRICE_STATIC_DIR:-$HOME/.price-router/static}"
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"

args=(run --rm -v "$REPO:$REPO" -w "$REPO" -e HOME=/tmp)
# On a rootless daemon, container root is the host user. On a root daemon, run as the host user,
# or every file the script writes ends up owned by root.
if ! docker info -f '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
  args+=(--user "$(id -u):$(id -g)")
fi
if [ -d "$STATIC_DIR" ]; then
  args+=(-v "$STATIC_DIR:$STATIC_DIR:ro" -e "PRICE_STATIC_DIR=$STATIC_DIR")
fi
# The image has no git identity. Commits carry the repo's own identity from the host.
: "${GIT_AUTHOR_NAME:=$(git -C "$REPO" config user.name || echo price-router)}"
: "${GIT_AUTHOR_EMAIL:=$(git -C "$REPO" config user.email || echo price-router@localhost)}"
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
for v in PRICE_DRY_RUN PRICE_NO_COMMIT PRICE_FETCH_MINUTES GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL; do
  [ -n "${!v:-}" ] && args+=(-e "$v=${!v}")
done

exec docker "${args[@]}" "$IMAGE" "$@"
