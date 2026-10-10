# Price router: our additions to models.dev

This fork tracks `anomalyco/models.dev` (remote `upstream`, branch `dev`). Our work lives on the
`router` branch. Root `AGENTS.md` is upstream's; this file is ours.

## Hard rules

1. **Add only.** Never edit a file upstream owns. Our changes live only in `local/`,
   `providers/<p>/` for each `<p>` in `local/static.toml`, and the root files `CLAUDE.md`,
   `doppelganger.toml` and `doppelganger.config.ts`. `.gitignore` may only gain lines.
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
| `local/doppelganger/` | doppelganger, installed from a release tarball (`vendor/`), and its `dg` wrapper |
| `local/doppelganger/tools/prices/` | The `prices` plugin: the `ops-price-static` and `ops-price-sync` jobs |
| `doppelganger.config.ts`, `doppelganger.toml` | Attach the plugin; the shared settings (no secrets) |
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

## doppelganger

doppelganger is installed in `local/doppelganger/`, not at the root: the root is a Bun workspace,
and npm cannot install into it (`workspace:*` versions). Run every doppelganger command through the
wrapper, which points it at the repo root:

```bash
local/doppelganger/dg config check
local/doppelganger/dg --list
local/doppelganger/dg job ops-price-static
```

The `prices` plugin's jobs are plain code: each runs `local/script/job.sh` in the tools image.
Settings live under `[prices]` in `doppelganger.toml`. Secrets go in `doppelganger.secret.toml`
(gitignored).

To upgrade: download the new tarball into `local/doppelganger/vendor/`, then in that folder run
`npm install -D ./vendor/doppelganger-<version>.tgz`, delete the old `.tgz`, and set `version` in
`doppelganger.toml`.

## Scheduling

An attached plugin cannot schedule jobs yet, so this machine's crontab runs them. Docker must be
the rootless daemon:

```
* * * * *  DOCKER_HOST=unix:///run/user/1000/docker.sock /home/hyhilman/projects/me/models.dev/local/doppelganger/dg job ops-price-static >> /home/hyhilman/projects/me/models.dev/.doppelganger/logs/ops-price-static.log 2>&1
27 * * * * DOCKER_HOST=unix:///run/user/1000/docker.sock /home/hyhilman/projects/me/models.dev/local/doppelganger/dg job ops-price-sync >> /home/hyhilman/projects/me/models.dev/.doppelganger/logs/ops-price-sync.log 2>&1
```
