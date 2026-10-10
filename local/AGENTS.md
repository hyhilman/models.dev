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
| `local/feeds/<p>.toml` | Provider details the price list does not carry, and its name map |
| `local/example/<p>.json` | A cut of a real price list, the format reference |
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

Two inputs per provider:

- `$PRICE_STATIC_DIR/<provider>.json` (default `~/.price-router/static/`): the provider's own price
  list, exported as is. A list of rows with `model_name`, `provider` (the route behind the host),
  `input_cost_per_1m_tokens`, `output_cost_per_1m_tokens`, `cache_read_cost_per_1m_tokens` and
  `context_length`. See `local/example/sumopod.json`. Sumopod's prices already include its
  discounts, so no discount is stored.
- `local/feeds/<provider>.toml`: what the list does not say. The API URL, the env var, the source,
  and `[map]` for a model name that does not match a lab file name.

How a row becomes `providers/<provider>/models/<model_name>.toml`:

- `base_model` is the one lab file named like the model, ignoring a route prefix (`gemini/`) and a
  host suffix (`:netra`), unless `[map]` names it. No match, or two, and the row is skipped and
  logged as `static.unmatched` on every run.
- `cost` comes from the row, rounded to 6 significant digits. A `null` cache price is left out.
- `limit.context` is written only when the row states one (not 0) and it differs from the lab's.
- When the base model reasons, `reasoning_options` is copied from a peer host (OpenCode Go
  first), and a file comment names the peer. No peer, and the row is skipped.
- The checked date is the date of the feed file.
- The provider folder mirrors the list exactly: a model removed from the list is deleted.
- When `bun validate` fails after a write, the script puts the folder back and exits non-zero,
  so the last good prices stay.

## How to change a price

Drop a new export of the price list at `$PRICE_STATIC_DIR/<provider>.json`. The scheduled job
applies it within a minute. To do it by hand, run the
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

An attached plugin cannot schedule jobs yet, so this machine's crontab runs them. Cron has no
nvm on its PATH, and Docker must be the rootless daemon, so the lines set both:

```
* * * * * PATH=/home/hyhilman/.nvm/versions/node/v22.23.1/bin:/usr/local/bin:/usr/bin:/bin DOCKER_HOST=unix:///run/user/1000/docker.sock /home/hyhilman/projects/me/models.dev/local/doppelganger/dg job ops-price-static >> /home/hyhilman/projects/me/models.dev/.doppelganger/logs/ops-price-static.log 2>&1
27 * * * * PATH=/home/hyhilman/.nvm/versions/node/v22.23.1/bin:/usr/local/bin:/usr/bin:/bin DOCKER_HOST=unix:///run/user/1000/docker.sock /home/hyhilman/projects/me/models.dev/local/doppelganger/dg job ops-price-sync >> /home/hyhilman/projects/me/models.dev/.doppelganger/logs/ops-price-sync.log 2>&1
```
