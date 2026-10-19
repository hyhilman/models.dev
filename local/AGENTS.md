# Price router: our additions to models.dev

This fork tracks `anomalyco/models.dev` (remote `upstream`, branch `dev`). Our work lives on the
`router` branch. Root `AGENTS.md` is upstream's; this file is ours.

## Hard rules

1. **Add only.** Never edit a file upstream owns. Our changes live only in `local/`,
   `providers/<p>/` for each `<p>` in `local/static.toml`, and the root files `CLAUDE.md`,
   `doppelganger.toml` and `doppelganger.config.ts`. `.gitignore` may only gain lines.
   `local/test/add-only.test.ts` enforces this. It keeps every upstream rebase free of conflicts.
   One exception: a `patch` provider in `local/static.toml` is upstream's folder, and the feed
   changes only the cost tables and its own `# Price feed:` comments there, deletes models
   the provider no longer lists, and adds a file for a priced model upstream has none for
   (also tested).
2. Never commit a secret. Files name the env var that holds a key, never the key.
3. Every price carries a source and the date it was checked.
4. The static feed writes only the providers in `local/static.toml`. Add a provider there only
   when the owner says so.

## Layout

| Path | What |
|---|---|
| `local/static.toml` | Providers the price feed may write (now: `sumopod`, `kenari`, the six `alibaba*`, `opencode`, `opencode-go`, `engy`, `openrouter`), and which are `patch` |
| `local/aliases.toml` | Lab model for a host entry that has no `base_model` and no lab file named like it |
| `local/house-models.toml` | Host models with no lab model, so no canonical id is expected |
| `local/feeds/<p>.toml` | Provider details the price list does not carry, and its name map |
| `local/example/<p>.json` | A cut of a real price list, the format reference |
| `local/script/fetch-feeds.ts` | Pulls a published price list (a feed with `[fetch]`) into `local/.feeds/<p>.json`, in USD |
| `local/script/apply-static.ts` | Applies a price list to `providers/<p>/`, validates, commits |
| `local/script/sync-upstream.sh` | Rebases `router` on `upstream/dev` (code commits only, prices written again), checks, keeps the old `router` on failure |
| `local/script/run.sh` | Runs a command in the Bun image (the host has no Bun) |
| `local/docker/Dockerfile` | The tools image: pinned Bun, git, gh, flock |
| `local/docker/compose.yml` | The local site on `0.0.0.0:7311` |
| `local/script/serve.ts` | Runs upstream's own `worker.ts` over `local/.site` |
| `local/script/publish-site.sh` | Builds `packages/web/dist` and swaps it into `local/.site` |
| `local/script/canonical.ts` | Fills the `canonical_model_id` upstream leaves out for our providers (alias, else lab file name), in the built JSON |
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
local/script/run.sh bash local/script/sync-upstream.sh    # rebase on upstream
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
  `fetch-feeds.ts` first. It pulls a list at most once per `[prices] fetch_minutes` (default 10),
  counted from the last try, and keeps the last list when a pull fails.
- Kenari prices are micro-rupiah per 1M tokens. USD = micro_idr / 1,000,000 / rate. The rate is
  the ECB reference rate of the first day of the month (`api.frankfurter.dev`), one rate per
  month, so a daily rate move does not rewrite every file every day. A `:free` model costs 0.
  Only chat models: image, video and speech prices are not per token.
- Upstream already owns `providers/kenari/` (all costs 0, by their policy). So kenari is in
  `patch`: the feed rewrites only `[cost]` of upstream's files whose name is a Kenari id, and
  adds three `# Price feed:` lines (source, date, rate).
- A priced model that upstream has no file for gets a whole file of ours, built like a Sumopod
  file (`base_model`, a peer's `reasoning_options`, the cost). Its first line is
  `# Added by the price feed:`, so the next run writes it again whole instead of patching it.
  When upstream adds the same file later, the rebase takes upstream's file and the feed prices it.
  A model with no lab file is skipped (`static.unmatched`). A feed whose files need a per-model
  `[provider]` the list does not say sets `add = false` (OpenCode Zen and Go).
- `reasoning_options` are copied only from upstream's files, never from a file the feed wrote:
  two such files would copy from each other and flip on every run.
- Kenari's live list wins over upstream's catalog: an upstream file whose id is in none of
  Kenari's lists (the main one and each `?modality=`) is deleted (`static.retired`). A fetch where
  any list fails changes nothing. There is no limit on how many a good list deletes: a failed
  call (HTTP error, bad JSON, an empty or paged list) never gets that far, so the last list stays.
- A rebase conflict inside a price folder takes upstream's file (`sync.took_upstream`). The
  rebase writes the prices again right after. A conflict anywhere else aborts the rebase.

## Alibaba (DashScope, international)

`local/feeds/alibaba.toml` pulls `https://dashscope-intl.aliyuncs.com/api/v1/models` (every page)
with an API key, so it works like Kenari with three differences:

- The key lives in `doppelganger.secret.toml` as `[prices] dashscope_api_key`. The plugin passes it
  to the container as `DASHSCOPE_API_KEY`, by name only, so it never shows in `ps`. A missing key
  skips the feed (`fetch.skip`) and the last prices stay.
- Prices are USD already. A model needs `input_token` and `output_token` prices per 1M tokens;
  other models (image, video, speech) are not priced. The explicit cache price wins over the
  implicit one; a thinking output price that differs becomes `reasoning`; each later price range
  (`256k<Input<=1m`) becomes a `[[cost.tiers]]` entry.
- Off-peak: a few models (DeepSeek) are half price from 22:00 to 08:00 UTC+8. The list marks the
  prices but not the hours, so the hours sit in `fetch-feeds.ts` (`DASHSCOPE_OFFPEAK`, from
  Alibaba's pricing page). The minute job writes the off-peak price inside those hours and the peak
  price outside them, so the catalog shows the price that applies now; each switch is a commit.
- The key is a workspace key, and about half of upstream's folder is missing from its list. The
  owner chose the list.

## The other Alibaba providers

Each of upstream's Alibaba folders has its own feed in `local/feeds/`, all in `patch`:

| Provider | List | Key (`[prices]` in `doppelganger.secret.toml`) | What the feed does |
|---|---|---|---|
| `alibaba-cn` | `dashscope.aliyuncs.com/api/v1/models` | `dashscope_cn_api_key` (China region) | Prices, as `alibaba`; CNY converted at the ECB rate of the first day of the month |
| `alibaba-coding-plan` | `coding-intl.dashscope.aliyuncs.com/v1/models` | none, the list is public | Deletes models the plan dropped |
| `alibaba-coding-plan-cn` | `coding.dashscope.aliyuncs.com/v1/models` | none, the list is public | Deletes models the plan dropped |
| `alibaba-token-plan` | `token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models` | `alibaba_token_plan_api_key` | Deletes models the plan dropped |
| `alibaba-token-plan-cn` | `token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models` | `alibaba_token_plan_cn_api_key` | Deletes models the plan dropped |

- `alibaba-token-plan` sets `price_from = "alibaba"`: each listed model gets the international
  pay-as-you-go price (with its off-peak switch) times `price_factor`, because a cost of 0 would win
  every routing choice and Alibaba publishes no Credit rate per model. Models with no such price
  (image, audio) keep 0. A `price_from` feed is fetched even when its own folder is off.
- The plans are monthly subscriptions. Their lists (format `models`) carry ids only, so upstream's
  cost of 0 stays; the feed only removes what the plan no longer serves.
- A feed whose key is not set is skipped (`fetch.skip`), so it waits for its key without failing
  the job. A new key needs an `EnvSpec` in `KEY_ENVS` (`tools/prices/run.ts`) and its name in
  `local/script/run.sh`; a test checks both.

## OpenCode (Zen and Go)

`opencode` and `opencode-go` are `patch` feeds of format `models` with a `price_doc`:

- The model list (`opencode.ai/zen/v1/models`, `opencode.ai/zen/go/v1/models`, public, no key; a
  key shows only what one account has turned on) decides which of upstream's files stay.
- Prices come from OpenCode's own docs source on GitHub (`packages/web/src/content/docs/zen.mdx`,
  `go.mdx`): the Markdown price table, matched to ids by the docs' "Model | Model ID" table.
  `(≤ 256K tokens)` / `(> 256K tokens)` rows become `[[cost.tiers]]`; `(Peak)` / `(Off-Peak)` rows
  become the off-peak switch with the hours the page states (Go: peak 01:00-04:00 and 06:00-10:00
  UTC, Monday to Friday; off-peak the rest of the time, weekends included); `Free` is 0, and a sale
  (`~~$1.36~~ $0.68`) is its current price. A row or sentence it cannot read fails the whole fetch,
  so the last prices stay.

## Engy

`engy` is a `patch` feed of format `openrouter`: `https://api.engy.ai/v1/models` is public (no
key) and OpenRouter-shaped, prices in USD per token (`pricing.prompt`, `completion`,
`input_cache_read`), so the feed multiplies by 1,000,000. A `0` cache price means none. Upstream
already prices `providers/engy/` from the same list, so a run usually changes only the
`# Price feed:` lines. It works like Kenari: costs patched, a delisted id deleted, a new priced
model added with a peer's `reasoning_options` (no `[interleaved]` or probed controls) until
upstream adds its own file. An empty list fails the fetch.

## OpenRouter

`openrouter` is a `patch` feed of format `openrouter` with `add = false`. It reads
`https://openrouter.ai/api/v1/models?output_modalities=all` (public): every model, so a model
missing from it is deleted. `openrouterRows` maps prices as upstream's OpenRouter sync does
(`packages/core/src/sync/providers/openrouter.ts`): text and decision models only, a `-1` price
(a router) or an empty parameter list (a dead route) is left out, `internal_reasoning` is
`reasoning` for a reasoning model, a `min_prompt_tokens` override is a tier, the 1h cache write is
not read. Two differences from upstream:

- The live list wins: a tier the list no longer has is removed (upstream's sync keeps the old one).
- Time overrides (`utc_start`, `utc_end`, `utc_days`) become the off-peak switch: dearer windows
  are peak hours (`peak`), one cheaper window is the off-peak `hours`. Any other shape keeps the
  top-level price (`fetch.peak_unread`).

Upstream adds new OpenRouter models through its own sync, so the feed never adds one. Some
prices (DeepSeek routes, `~` aliases) move often, and each move is a commit and an ntfy message.

## Sumopod (static prices, live list)

`sumopod` keeps its prices in the exported `$PRICE_STATIC_DIR/sumopod.json` (default for this
machine: `local/.static/`, gitignored). Its `[fetch]` has `static_prices = true`: the job pulls
`https://ai.sumopod.com/v1/models` (needs `[prices] sumopod_api_key`) and drops every static row
whose model that list does not have (`static.delisted`), so its file is deleted. A failed or empty
fetch changes nothing; a missing key skips the feed (`fetch.skip`) and all static rows stay.

## The upstream sync (rebase)

Every 15 minutes `sync-upstream.sh` rebases `router` on `upstream/dev`, so `router` is always
upstream's `dev` plus our commits on top:

- It replays only our code commits. Price commits (subject `chore(prices):`) are dropped, and the
  feed writes the prices again on the new base from its last fetched lists, as one
  `chore(prices): write the prices again on upstream <sha>` commit. The git history of each price
  change is gone after a rebase; the ntfy messages keep it.
- A commit that upstream already has comes out empty and is dropped.
- It builds the new history on a detached HEAD (no branch checked out) and moves `router` only
  after `bun validate`, our tests and a guard pass. The guard checks that our own files
  (`local/`, `CLAUDE.md`, `doppelganger.*`) did not change. Any failure leaves `router` as it was.
- A run that is killed half-way leaves HEAD detached. Both jobs then skip ("not on router") until
  someone runs `git checkout -f router`.
- So the price job never mixes into a rebase, never leave a change staged in this checkout: the
  feed's commit takes the whole index.

## Notifications

After each run, the plugin (`tools/prices/run.ts`, `report`) sends one ntfy message (the `[ntfy]`
settings) when something happened:

- `💲 <provider>` and one line per model, `name: input 2→2.5, output 8→10` (or `new`, `removed`),
  for every commit that changed a price, added or removed a model. A commit that changed no price
  (a date, a rate comment) sends nothing. Off-peak switches show as price changes. `↩️` when a rebase
  kept upstream's files. A normal upstream rebase sends nothing; a conflict or a failed check sends `❌`.
- `❌` once for a new failure (a fetch, an apply, the rebase, the job, a model in our providers
  with no canonical id that `local/house-models.toml` does not list), and `✅ ... works again`
  once when it clears. Open failures live in `local/.feeds/alerts.json`, so a failure that lasts
  is not repeated every minute. A quiet run sends nothing; a dry run never sends.

## How to change a price

Drop a new export of the price list at `$PRICE_STATIC_DIR/<provider>.json`. The scheduled job
applies it within a minute. A fetched feed needs nothing: a change at the provider lands within
`fetch_minutes` (10) plus a minute. To do it by hand, run the
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

## Pushing to GitHub

With `[prices] push = 1`, a job pushes `router` to `origin` when it moved, and the sync (every 15 minutes)
also fast-forwards `origin`'s `dev` to `upstream/dev`, so the fork never shows as behind. `dev`
holds none of our commits: a push that is not a fast-forward is refused and the job fails.

The sync rebases `router`, so its push is a force push with a lease (`--force-with-lease`, which
overwrites origin's `router` only if it is still the one this checkout last saw). Never base other
work on `origin/router`: its commits change on every rebase.

Pushes go over ssh with a deploy key (a key that can push to this one repo only):
`[prices] ssh = "deploy"` names `.doppelganger/creds/ssh/deploy/` (gitignored), which holds
`id_ed25519` and GitHub's `known_hosts`. It is mounted read-only. A deploy key can push changes to
`.github/workflows/`, which upstream's commits carry; a gh token would need the `workflow` scope for
that. The key is registered on `hyhilman/models.dev` (Settings → Deploy keys, write access). To make
a new one:

```bash
d=.doppelganger/creds/ssh/deploy
ssh-keygen -t ed25519 -N "" -f $d/id_ed25519 && ssh-keyscan -t ed25519,rsa,ecdsa github.com > $d/known_hosts
gh api repos/hyhilman/models.dev/keys -f title=price-router -f key="$(cat $d/id_ed25519.pub)" -F read_only=false
```

With no `ssh` set, pushes use the gh login below over https.

The image has no ssh key, so pushes use a gh login kept for the jobs (gitignored):

```bash
GH_CONFIG_DIR=.doppelganger/creds/gh/<name> gh auth login   # once, by hand
```

Then set `gh = "<name>"` and `push = 1` under `[prices]` in `doppelganger.toml`.

## Scheduling

An attached plugin cannot schedule jobs yet, so this machine's crontab runs them. Cron has no
nvm on its PATH, and Docker must be the rootless daemon, so the lines set both:

```
* * * * * PATH=/home/hyhilman/.nvm/versions/node/v22.23.1/bin:/usr/local/bin:/usr/bin:/bin DOCKER_HOST=unix:///run/user/1000/docker.sock /home/hyhilman/projects/me/models.dev/local/doppelganger/dg job ops-price-static >> /home/hyhilman/projects/me/models.dev/.doppelganger/logs/ops-price-static.log 2>&1
12,27,42,57 * * * * PATH=/home/hyhilman/.nvm/versions/node/v22.23.1/bin:/usr/local/bin:/usr/bin:/bin DOCKER_HOST=unix:///run/user/1000/docker.sock /home/hyhilman/projects/me/models.dev/local/doppelganger/dg job ops-price-sync >> /home/hyhilman/projects/me/models.dev/.doppelganger/logs/ops-price-sync.log 2>&1
```
