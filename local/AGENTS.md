# Price router: our additions to models.dev

This fork tracks `anomalyco/models.dev` (remote `upstream`, branch `dev`). Our work lives on the
`router` branch. Root `AGENTS.md` is upstream's; this file is ours.

## Hard rules

1. **Add only.** Never edit a file upstream owns. Our changes live only in `local/`,
   `providers/<p>/` for each `<p>` in `local/static.toml`, and the root `CLAUDE.md`.
   `local/test/add-only.test.ts` enforces this. It keeps every upstream merge free of conflicts.
2. Never commit a secret. Files name the env var that holds a key, never the key.
3. Every price carries a source and the date it was checked.
4. The static feed writes only the providers in `local/static.toml`. Add a provider there only
   when the owner says so.

## Layout

| Path | What |
|---|---|
| `local/static.toml` | Providers the static price feed may write (now: `sumopod`) |
| `local/aliases.toml` | Lab model for a host entry that has no `base_model` |
| `local/example/<p>.json` | An example feed file, the format reference |
| `local/script/apply-static.ts` | Applies `$PRICE_STATIC_DIR/<p>.json` to `providers/<p>/`, validates, commits |
| `local/script/sync-upstream.sh` | Merges `upstream/dev` into `router`, checks, goes back on failure |
| `local/script/run.sh` | Runs a command in the Bun image (the host has no Bun) |
| `local/docker/Dockerfile` | The Bun image: pinned Bun and git |
| `local/test/` | Our tests |

## Commands

```bash
# one time: build the image on the rootless daemon
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker build -t models-dev-router-tools:bun1.3.0 local/docker
local/script/run.sh bun install --frozen-lockfile

local/script/run.sh bun validate                          # upstream's check
local/script/run.sh bun test local/test                   # our tests
local/script/run.sh bun local/script/apply-static.ts      # apply the static feed
local/script/run.sh bash local/script/sync-upstream.sh    # merge upstream
```

Upstream's full `bun test` already has failures we do not own. Gate on `bun validate` and
`bun test local/test`.

## The static feed

One JSON file per provider, `$PRICE_STATIC_DIR/<provider>.json` (default
`~/.price-router/static/`). See `local/example/sumopod.json`. Unknown fields fail.

- `models[].id` is the exact id the provider accepts. It becomes the file name.
- `models[].base_model` must exist under `models/`.
- `cost` is the **list price**, USD per 1M tokens.
- `reasoning_options` is optional. When the base model reasons and the feed leaves it out, the
  script copies it from a peer host (OpenCode Go first) and says so in a file comment.
- The provider folder mirrors the feed exactly: a model removed from the feed is deleted.
- When `bun validate` fails after a write, the script puts the folder back and exits non-zero,
  so the last good prices stay.

## How to change a price

Edit the feed JSON. The scheduled job applies it within a minute. To do it by hand, run the
apply command above.

## Scheduling

doppelganger runs both scripts (the `ops-price-*` jobs): the feed every minute, the upstream
sync every hour.
