# Price router: our additions to models.dev

This fork tracks `anomalyco/models.dev` (remote `upstream`, branch `dev`). Our work lives on the
`router` branch. Root `AGENTS.md` is upstream's; this file is ours.

## Hard rules

1. **Add only.** Never edit a file upstream owns. Our changes live only in `local/`,
   `providers/<p>/` for each `<p>` in `local/static.toml`, and the root files `CLAUDE.md`,
   `doppelganger.toml` and `doppelganger.config.ts`. `.gitignore` may only gain lines.
   `local/test/add-only.test.ts` enforces this. It keeps every upstream merge free of conflicts.
   One exception: a `patch` provider in `local/static.toml` is upstream's folder, and the feed
   changes only the `[cost]` table and its own `# Price feed:` comments there (also tested).
2. Never commit a secret. Files name the env var that holds a key, never the key.
3. Every price carries a source and the date it was checked.
4. The static feed writes only the providers in `local/static.toml`. Add a provider there only
   when the owner says so.

## Layout

| Path | What |
|---|---|
| `local/static.toml` | Providers the price feed may write (now: `sumopod`, `kenari`), and which are `patch` |
| `local/aliases.toml` | Lab model for a host entry that has no `base_model` |
| `local/feeds/<p>.toml` | Provider details the price list does not carry, and its name map |
| `local/example/<p>.json` | A cut of a real price list, the format reference |
| `local/script/fetch-feeds.ts` | Pulls a published price list (a feed with `[fetch]`) into `local/.feeds/<p>.json`, in USD |
| `local/script/apply-static.ts` | Applies a price list to `providers/<p>/`, validates, commits |
| `local/script/sync-upstream.sh` | Merges `upstream/dev` into `router`, checks, goes back on failure |
| `local/script/run.sh` | Runs a command in the Bun image (the host has no Bun) |
| `local/docker/Dockerfile` | The tools image: pinned Bun, git, gh, flock |
| `local/docker/compose.yml` | The local site on `0.0.0.0:7311` |
| `local/script/serve.ts` | Runs upstream's own `worker.ts` over `local/.site` |
| `local/script/publish-site.sh` | Builds `packages/web/dist` and swaps it into `local/.site` |
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

## Fetched feeds and patch providers (Kenari)

Kenari publishes its prices at `https://kenari.id/v1/models`, so nobody exports a file:

- `local/feeds/kenari.toml` has a `[fetch]` table. Each minute the static job runs
  `fetch-feeds.ts` first. It pulls a list at most once per `PRICE_FETCH_MINUTES` (default 60),
  counted from the last try, and keeps the last list when a pull fails.
- Kenari prices are micro-rupiah per 1M tokens. USD = micro_idr / 1,000,000 / rate. The rate is
  the ECB reference rate of the first day of the month (`api.frankfurter.dev`), one rate per
  month, so a daily rate move does not rewrite every file every day. A `:free` model costs 0.
  Only chat models: image, video and speech prices are not per token.
- Upstream already owns `providers/kenari/` (all costs 0, by their policy). So kenari is in
  `patch`: the feed rewrites only `[cost]` of upstream's files whose name is a Kenari id, and
  adds three `# Price feed:` lines (source, date, rate). It never adds or deletes a file. Priced
  models upstream does not list are logged as `static.unlisted`.
- An upstream merge that conflicts inside a patch folder takes upstream's file
  (`sync.took_upstream`). The next static run writes the price again. A conflict anywhere else
  still aborts the merge.

## How to change a price

Drop a new export of the price list at `$PRICE_STATIC_DIR/<provider>.json`. The scheduled job
applies it within a minute. A fetched feed needs nothing: a change at the provider lands within
the hour. To do it by hand, run the
apply command above.

## The local site

The same site and API as models.dev, with our prices, on `http://<this machine>:7311`:
`/api.json`, `/models.json`, `/catalog.json`, `/model-schema.json` and the HTML pages.

- `local/script/serve.ts` runs upstream's own Cloudflare Worker, so every route behaves like the
  real site. It strips the user agent first: the worker would otherwise post analytics to
  upstream's PostHog for opencode and bun clients.
- After each price job, `job.sh` rebuilds the site when HEAD moved since the last build
  (`local/.site/.built-from`). The build deletes `dist/` first, so the server reads `local/.site`,
  a copy swapped in only after a build succeeds. No restart is needed.

```bash
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker compose -f local/docker/compose.yml up -d
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker compose -f local/docker/compose.yml logs -f
```

It restarts on its own (`unless-stopped`) and comes back after a reboot, because the rootless
daemon starts at boot (linger is on).

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
