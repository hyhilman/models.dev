// Apply the static price feed: a provider's own price list, exported as JSON, dropped in a folder.
//
// The feed may write only the providers listed in local/static.toml, and only inside
// providers/<provider>/. It never touches another provider, upstream-owned or not.
//
// Two inputs per provider:
//   $PRICE_STATIC_DIR/<provider>.json  the price list as the provider shows it (prices.json shape)
//   local/feeds/<provider>.toml        what the list does not say: the API, the env var, the source,
//                                      and a name map for models whose lab file name differs
// A feed with a [fetch] table has no file in $PRICE_STATIC_DIR: local/script/fetch-feeds.ts pulls
// its list from the provider and writes local/.feeds/<provider>.json, already in USD.
//
// Run: bun local/script/apply-static.ts
// Env: PRICE_STATIC_DIR  folder that holds <provider>.json (default ~/.price-router/static)
//      PRICE_DRY_RUN=1   print what would change, write nothing
//      PRICE_NO_COMMIT=1 write and validate, but do not commit
import path from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { z } from "../lib/deps.ts";
import { formatToml } from "../../packages/core/src/sync/index.ts";

const REPO = path.resolve(import.meta.dir, "../..");
const STATIC_DIR = process.env.PRICE_STATIC_DIR ?? path.join(process.env.HOME ?? "/tmp", ".price-router/static");
const DRY_RUN = process.env.PRICE_DRY_RUN === "1";
const NO_COMMIT = process.env.PRICE_NO_COMMIT === "1";

// A model name becomes a file path, so it must not climb out of the provider folder.
const ModelName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/)
  .refine((s) => !s.split("/").includes(".."), "must not contain ..");

const Price = z.number().nonnegative();

/** A price in the catalog's own names. A tier starts at `size` input tokens of context. */
const Cost = z.object({
  input: Price,
  output: Price,
  cache_read: Price.optional(),
  cache_write: Price.optional(),
  reasoning: Price.optional(),
});
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/**
 * A daily window in local time at `utc_offset` hours. It may wrap midnight (22:00 to 08:00).
 * `days` limits it to those local weekdays (0 = Sunday), counted on the day `now` falls in.
 */
const Hours = z
  .object({
    from: Clock,
    to: Clock,
    utc_offset: z.number().min(-12).max(14),
    days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  })
  .strict();
export type Hours = z.infer<typeof Hours>;

/** One row of the provider's price list. Extra fields the provider adds later are ignored. */
const PriceRow = z.object({
  model_name: ModelName,
  // The route behind the provider (a lab or another host), not the host itself.
  provider: z.string(),
  input_cost_per_1m_tokens: Price,
  output_cost_per_1m_tokens: Price,
  cache_read_cost_per_1m_tokens: Price.nullable().optional(),
  cache_write_cost_per_1m_tokens: Price.nullable().optional(),
  // Output price while the model thinks, when it differs from the plain output price.
  reasoning_cost_per_1m_tokens: Price.nullable().optional(),
  // Higher prices for long prompts, written as [[cost.tiers]].
  tiers: z.array(Cost.extend({ size: z.number().int().positive() })).optional(),
  // A cheaper price at night. The job writes it during `hours` and the normal price the rest of
  // the day, so the catalog shows the price that applies now.
  // Either the off-peak `hours`, or the `peak` windows, with off-peak every other hour.
  offpeak: Cost.extend({ hours: Hours.optional(), peak: z.array(Hours).min(1).optional() })
    .refine((o) => (o.hours === undefined) !== (o.peak === undefined), "offpeak needs hours or peak, not both")
    .optional(),
  // 0 means the provider does not say.
  context_length: z.number().int().nonnegative().optional(),
});
export type PriceRow = z.infer<typeof PriceRow>;
const unique = (rows: readonly PriceRow[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.model_name)) ctx.addIssue({ code: "custom", message: `duplicate model_name ${r.model_name}` });
    seen.add(r.model_name);
  }
};
export const PriceList = z.array(PriceRow).min(1).superRefine(unique);
export type PriceList = z.infer<typeof PriceList>;

export const Feed = z
  .object({
    name: z.string().min(1),
    api: z.string().url(),
    env: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1),
    doc: z.string().url().optional(),
    npm: z.string().default("@ai-sdk/openai-compatible"),
    // Hard rule: every price carries a source. The date is the feed file's own date.
    source: z.string().min(1),
    // A patch feed adds a file for a priced model upstream has none for. false for a host whose
    // files need a per-model [provider] (npm, api) that the price list does not say (OpenCode).
    add: z.boolean().default(true),
    // model_name -> "<lab>/<model>", for names that do not match a lab file name.
    map: z.record(z.string(), z.string().regex(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/)).default({}),
    // The provider publishes its list: fetch-feeds.ts pulls it with the named adapter.
    fetch: z
      .object({
        url: z.string().url(),
        // "models" is an OpenAI-style model list with no prices (a subscription plan): it only
        // deletes upstream's files for models the plan no longer serves.
        format: z.enum(["kenari", "dashscope", "models"]),
        // The env var that holds the list's API key, for a list that needs one.
        key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
        // dashscope: the currency of the list, and the region its note names.
        currency: z.enum(["USD", "CNY"]).default("USD"),
        region: z.string().min(1).optional(),
        // "models": price the listed models with another feed's prices (its last fetched list),
        // times price_factor. For a plan billed in credits that has no published rate per model.
        price_from: z.string().regex(/^[a-z0-9-]+$/).optional(),
        // "models": price the listed models from OpenCode's docs source, a Markdown price table
        // (fetch-feeds.ts opencodeDocRows).
        price_doc: z.string().url().optional(),
        price_factor: z.number().positive().default(1),
        // "models": the prices stay in $PRICE_STATIC_DIR/<provider>.json; the live list only drops
        // the rows of models the provider no longer serves.
        static_prices: z.boolean().default(false),
      })
      .strict()
      .refine((f) => (f.price_from ?? f.price_doc) === undefined || f.format === "models", "price_from and price_doc are for a models list")
      .refine((f) => f.price_from === undefined || f.price_doc === undefined, "price_from or price_doc, not both")
      .refine((f) => !f.static_prices || (f.format === "models" && !f.price_from && !f.price_doc), "static_prices is for a plain models list")
      .optional(),
  })
  .strict();
export type Feed = z.infer<typeof Feed>;

/** What fetch-feeds.ts writes: the rows in USD, the day it fetched them, and how it converted. */
export const Snapshot = z
  .object({
    checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string(),
    // Empty for a "models" list, which has no prices.
    rows: z.array(PriceRow).superRefine(unique),
    // Every model the provider serves, priced or not. A patch deletes upstream's files for the
    // rest: the provider's live list wins over upstream's catalog.
    listed: z.array(z.string()).min(1).optional(),
  })
  .strict();
export type Snapshot = z.infer<typeof Snapshot>;

/** Where fetch-feeds.ts keeps a fetched list. Gitignored: the provider files carry the history. */
export const snapshotPath = (provider: string) => path.join(REPO, "local/.feeds", `${provider}.json`);

const Allow = z
  .object({
    providers: z.array(z.string().regex(/^[a-z0-9-]+$/)),
    // Upstream owns these folders. The feed rewrites only the [cost] table of their files.
    patch: z.array(z.string()).default([]),
  })
  .strict()
  .refine((a) => a.patch.every((p) => a.providers.includes(p)), "every patch provider must be in providers");
export type Allow = z.infer<typeof Allow>;

/** Every comment line the patch writes starts with this, so the next patch can find and replace it. */
export const PATCH_MARK = "# Price feed:";
/** The first line of a file the feed added to a patch provider, for a model upstream has no file for. */
export const ADDED_MARK = "# Added by the price feed:";

/**
 * An upstream file with its cost tables ([cost], [cost.*] and [[cost.*]]) replaced and our header
 * on top. Everything else stays upstream's, byte for byte.
 */
export function patchCost(text: string, cost: Record<string, unknown>, header: readonly string[]): string {
  const lines = text.split("\n").filter((l) => !l.startsWith(PATCH_MARK));
  const isCost = (l: string) => /^\[\[?cost[\].]/.test(l.trim());
  const kept: string[] = [];
  let at = -1;
  for (let i = 0; i < lines.length; ) {
    if (!isCost(lines[i]!)) {
      kept.push(lines[i++]!);
      continue;
    }
    if (at === -1) at = kept.length;
    i++;
    while (i < lines.length && !lines[i]!.trim().startsWith("[")) i++;
  }
  // A cost table that ended a file left blank lines behind it; one blank line between tables.
  const trim = (ls: string[]) => {
    while (ls.at(-1) === "") ls.pop();
    return ls;
  };
  const block = formatToml({ cost } as Parameters<typeof formatToml>[0]).trim().split("\n");
  const head = trim(kept.slice(0, at === -1 ? kept.length : at));
  const tail = at === -1 ? [] : trim(kept.slice(at));
  const out = [...head, ...(head.length > 0 ? [""] : []), ...block, ...(tail.length > 0 ? ["", ...tail] : [])];
  return [...header.map((h) => `${PATCH_MARK} ${h}`), ...out].join("\n") + "\n";
}

const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

/** Whether `now` falls in the daily window. */
export function inHours(now: Date, h: Hours): boolean {
  const local = new Date(now.getTime() + h.utc_offset * 3_600_000);
  if (h.days && !h.days.includes(local.getUTCDay())) return false;
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const from = hm(h.from), to = hm(h.to);
  return from <= to ? mins >= from && mins < to : mins >= from || mins < to;
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "22:00-08:00 UTC+8", or "01:00-04:00 UTC Mon-Fri". */
function spanOf(h: Hours): string {
  const tz = h.utc_offset === 0 ? "UTC" : `UTC${h.utc_offset < 0 ? "-" : "+"}${Math.abs(h.utc_offset)}`;
  const d = h.days ? [...h.days].sort() : [];
  const run = d.length > 1 && d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
  const days = d.length === 0 ? "" : ` ${run ? `${DAY[d[0]!]}-${DAY[d.at(-1)!]}` : d.map((x) => DAY[x]).join(",")}`;
  return `${h.from}-${h.to} ${tz}${days}`;
}

/**
 * The [cost] table for a row at `now`, and comment lines that explain it. A row with an off-peak
 * price gets that price inside its hours and the normal (peak) price outside them.
 */
export function rowCost(row: PriceRow, now: Date): { cost: Record<string, unknown>; notes: string[] } {
  const clean = (c: Partial<z.infer<typeof Cost>>) =>
    Object.fromEntries(Object.entries(c).filter(([, v]) => v != null).map(([k, v]) => [k, tidy(v as number)]));
  const peak: Record<string, unknown> = clean({
    input: row.input_cost_per_1m_tokens,
    output: row.output_cost_per_1m_tokens,
    cache_read: row.cache_read_cost_per_1m_tokens ?? undefined,
    cache_write: row.cache_write_cost_per_1m_tokens ?? undefined,
    reasoning: row.reasoning_cost_per_1m_tokens ?? undefined,
  });
  if (row.tiers?.length) {
    peak.tiers = row.tiers.map(({ size, ...c }) => ({ tier: { type: "context", size }, ...clean(c) }));
  }
  if (!row.offpeak) return { cost: peak, notes: [] };
  const { hours, peak: peakHours, ...o } = row.offpeak;
  const off = clean(o);
  const say = (c: Record<string, unknown>) => `input ${c.input}, output ${c.output}`;
  if (hours) {
    const span = spanOf(hours);
    return inHours(now, hours)
      ? { cost: off, notes: [`off-peak price now (${span}); the peak price is ${say(peak)}.`] }
      : { cost: peak, notes: [`peak price now; off-peak (${span}) is ${say(off)}.`] };
  }
  const span = peakHours!.map(spanOf).join(", ");
  return peakHours!.some((h) => inHours(now, h))
    ? { cost: peak, notes: [`peak price now (${span}); off-peak the rest of the time is ${say(off)}.`] }
    : { cost: off, notes: [`off-peak price now; the peak price (${span}) is ${say(peak)}.`] };
}

/** The patched files for an upstream-owned provider: one per upstream file the list prices. */
export function renderPatch(
  provider: string,
  feed: Feed,
  list: PriceList,
  checked: string,
  note: string,
  have: ReadonlyMap<string, string>,
  now = new Date(),
): Rendered {
  const header = [
    `${feed.source}, checked ${checked}.`,
    `only [cost] is ours, written by local/script/apply-static.ts; the rest is upstream's.`,
    ...(note ? [note] : []),
  ];
  const rows = new Map(list.map((r) => [r.model_name, r]));
  const files = new Map<string, string>();
  const skipped: { model: string; reason: string }[] = [];
  const prefix = `providers/${provider}/models/`;
  for (const [p, text] of have) {
    if (!p.startsWith(prefix)) continue;
    // A file the feed added is ours whole: it is written again below, like any other new model.
    if (text.startsWith(ADDED_MARK)) continue;
    const id = p.slice(prefix.length).replace(/\.toml$/, "");
    const row = rows.get(id);
    if (!row) continue;
    rows.delete(id);
    const { cost, notes } = rowCost(row, now);
    files.set(p, patchCost(text, cost, [...header, ...notes]));
  }
  // A priced model upstream has no file for gets a whole file of ours, as a non-patch feed writes
  // it. When upstream adds that file later, the rebase takes upstream's and the patch above prices it.
  const added = [
    `${ADDED_MARK} ${feed.source}, checked ${checked}.`,
    `${ADDED_MARK} upstream has no file for this model, so the whole file is ours, written by local/script/apply-static.ts.`,
    ...(note ? [`${ADDED_MARK} ${note}`] : []),
  ];
  const idx = labIndex();
  for (const row of rows.values()) {
    if (!feed.add) {
      skipped.push({ model: row.model_name, reason: "upstream has no file for it, and this feed does not add one (add = false)" });
      continue;
    }
    const r = renderModel(provider, feed, row, added, idx, now);
    if ("skip" in r) skipped.push({ model: row.model_name, reason: r.skip });
    else files.set(r.path, r.text);
  }
  return { files, skipped };
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
  <path d="M8 15c1 1.5 2.4 2 4 2 2.2 0 4-1 4-3s-2-2.6-4-3-4-1-4-3 1.8-3 4-3c1.6 0 3 .5 4 2"/>
</svg>
`;

const log = (event: string, fields: Record<string, string | number> = {}) =>
  console.error(
    [`event=${event}`, ...Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)].join(" "),
  );

function readToml(file: string): Record<string, unknown> {
  return Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".toml") ? [p] : [];
  });
}

/** Exported prices carry float noise (0.09999999999999999). Six significant digits is plenty. */
export const tidy = (n: number): number => Number(n.toPrecision(6));

/** Lab files by lower-case file name: "deepseek-v4-pro" -> ["deepseek/deepseek-v4-pro"]. */
function labIndex(): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const file of walk(path.join(REPO, "models"))) {
    const rel = path.relative(path.join(REPO, "models"), file).replace(/\.toml$/, "");
    const key = path.basename(rel).toLowerCase();
    idx.set(key, [...(idx.get(key) ?? []), rel]);
  }
  return idx;
}

/**
 * The lab model a price row stands for. The feed's map wins; else the one lab file whose name is
 * the model name without a route prefix (`gemini/`) or a host suffix (`:netra`). Two matches or
 * none is no answer: a guess would put a price on the wrong model.
 */
export function baseModelOf(name: string, feed: Feed, idx: Map<string, string[]>): string | null {
  if (feed.map[name]) return feed.map[name]!;
  const key = name.split("/").at(-1)!.split(":")[0]!.toLowerCase();
  const hits = idx.get(key) ?? [];
  return hits.length === 1 ? hits[0]! : null;
}

/** The lab model a host file stands for: its base_model, else its row in local/aliases.toml. */
function labOf(file: string, t: Record<string, unknown>, aliases: Record<string, string>): string | undefined {
  if (typeof t.base_model === "string") return t.base_model;
  const rel = path.relative(path.join(REPO, "providers"), file).replace(/\.toml$/, "");
  const [provider, , ...rest] = rel.split(path.sep);
  return aliases[`${provider}/${rest.join("/")}`];
}

/**
 * A relay copies the underlying model's controls from an established peer host. OpenCode Go
 * first, since it is a relay of the same kind; then the first other host with real controls.
 * An empty list is a last resort: it means "no caller control", which few hosts really mean.
 */
function peerReasoning(baseModel: string, self: string): { from: string; options: unknown[] } | null {
  const aliases = readToml(path.join(REPO, "local/aliases.toml")) as Record<string, string>;
  const providers = readdirSync(path.join(REPO, "providers"))
    .filter((p) => p !== self)
    .sort((a, b) => (a === "opencode-go" ? -1 : b === "opencode-go" ? 1 : a.localeCompare(b)));
  let empty: { from: string; options: unknown[] } | null = null;
  for (const p of providers) {
    for (const file of walk(path.join(REPO, "providers", p, "models"))) {
      // Only upstream's files are peers. Two files the feed wrote would copy from each other, and
      // the note naming the peer would flip on every run.
      const head = readFileSync(file, "utf8");
      if (head.startsWith(ADDED_MARK) || head.startsWith("# Static price feed:")) continue;
      const t = readToml(file);
      if (labOf(file, t, aliases) !== baseModel || !Array.isArray(t.reasoning_options)) continue;
      const hit = { from: path.relative(REPO, file), options: t.reasoning_options };
      if (t.reasoning_options.length > 0) return hit;
      empty ??= hit;
    }
  }
  return empty;
}

export interface Rendered {
  /** Repo-relative path -> file text. */
  readonly files: Map<string, string>;
  /** Rows left out, with the reason. They are logged on every run until the map covers them. */
  readonly skipped: readonly { readonly model: string; readonly reason: string }[];
}

/** The files the feed wants under providers/<provider>/. */
export function render(
  provider: string,
  feed: Feed,
  list: PriceList,
  checked: string,
  note = "",
  now = new Date(),
): Rendered {
  const files = new Map<string, string>();
  const skipped: { model: string; reason: string }[] = [];
  const dir = `providers/${provider}`;
  const header = [
    `# Static price feed: ${feed.source}, checked ${checked}.`,
    `# Written by local/script/apply-static.ts from ${feed.fetch && !feed.fetch.static_prices ? feed.fetch.url : `${provider}.json`}. Edit the feed, not this file.`,
    ...(note ? [`# ${note}`] : []),
  ];

  files.set(
    `${dir}/provider.toml`,
    [
      ...header,
      `name = ${JSON.stringify(feed.name)}`,
      `env = [${feed.env.map((e) => JSON.stringify(e)).join(", ")}]`,
      `npm = ${JSON.stringify(feed.npm)}`,
      `api = ${JSON.stringify(feed.api)}`,
      ...(feed.doc ? [`doc = ${JSON.stringify(feed.doc)}`] : []),
    ].join("\n") + "\n",
  );

  const idx = labIndex();
  for (const row of list) {
    const r = renderModel(provider, feed, row, header, idx, now);
    if ("skip" in r) skipped.push({ model: row.model_name, reason: r.skip });
    else files.set(r.path, r.text);
  }
  return { files, skipped };
}

/** One model file for a row: its lab model as base_model, a peer's reasoning_options, the row's cost. */
function renderModel(
  provider: string,
  feed: Feed,
  row: PriceList[number],
  header: readonly string[],
  idx: ReturnType<typeof labIndex>,
  now: Date,
): { path: string; text: string } | { skip: string } {
  const base = baseModelOf(row.model_name, feed, idx);
  if (base === null) {
    return { skip: "no lab model by that name; add it to [map] in the feed toml" };
  }
  const labFile = path.join(REPO, "models", `${base}.toml`);
  if (!existsSync(labFile)) {
    return { skip: `[map] names ${base}, which has no file under models/` };
  }
  const lab = readToml(labFile);
  const notes: string[] = [];
  let reasoning_options: unknown[] | undefined;
  // A v2 lab file (`schema = 2`) says it under [capabilities] instead.
  const capabilities = (lab.capabilities ?? {}) as { reasoning?: { supported?: boolean } };
  if (lab.reasoning === true || capabilities.reasoning?.supported === true) {
    const peer = peerReasoning(base, provider);
    if (peer === null) {
      return { skip: `${base} reasons and no peer host has reasoning_options` };
    }
    reasoning_options = peer.options;
    notes.push(`# reasoning_options copied from ${peer.from}`);
  }

  const { cost, notes: priceNotes } = rowCost(row, now);
  notes.push(...priceNotes.map((n) => `# ${n}`));

  // Override the context only when the provider states one and it differs from the lab's.
  const labLimit = (lab.limit ?? {}) as { context?: number; output?: number };
  const ctxLen = row.context_length ?? 0;
  const limit =
    ctxLen > 0 && ctxLen !== labLimit.context
      ? { context: ctxLen, ...(labLimit.output !== undefined && labLimit.output > ctxLen ? { output: ctxLen } : {}) }
      : undefined;

  const body = formatToml({
    base_model: base,
    ...(reasoning_options ? { reasoning_options } : {}),
    cost,
    ...(limit ? { limit } : {}),
  } as Parameters<typeof formatToml>[0]);
  return { path: `providers/${provider}/models/${row.model_name}.toml`, text: [...header, ...notes, body.trimEnd()].join("\n") + "\n" };
}

function git(args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
}

/**
 * Upstream's model files for models the provider no longer lists. The live list wins, however
 * many it drops: a fetch that failed (an HTTP error, bad JSON, an empty or paged list) never
 * reaches here, so the last good list stays.
 */
export function retired(provider: string, have: ReadonlyMap<string, string>, listed: readonly string[] | undefined): string[] {
  if (!listed) return [];
  const prefix = `providers/${provider}/models/`;
  const files = [...have.keys()].filter((p) => p.startsWith(prefix));
  const ids = new Set(listed);
  const gone = files.filter((p) => !ids.has(p.slice(prefix.length).replace(/\.toml$/, ""))).sort();
  if (gone.length > 0) log("static.retired", { provider, models: gone.map((p) => p.slice(prefix.length)).join(",") });
  return gone;
}

type Cost = Record<string, unknown>;

/** The [cost] table of a provider model file, or null when the file has none or cannot be read. */
function costOf(text: string | undefined): Cost | null {
  if (text === undefined) return null;
  try {
    return ((Bun.TOML.parse(text) as { cost?: Cost }).cost ?? null);
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === "number" ? String(tidy(v)) : "-");

/**
 * What a price change says, for the notification: "input 2→2.5, output 8→10". Empty when the cost
 * did not change (a changed comment or date is not a price change).
 */
export function costDiff(before: Cost | null, after: Cost | null): string {
  if (JSON.stringify(before) === JSON.stringify(after)) return "";
  const parts: string[] = [];
  for (const k of ["input", "output", "cache_read", "cache_write", "reasoning"]) {
    const a = before?.[k], b = after?.[k];
    if (a !== b) parts.push(`${k} ${num(a)}→${num(b)}`);
  }
  return parts.length > 0 ? parts.join(", ") : "tiers or off-peak";
}

function apply(provider: string, patch: boolean): "unchanged" | "changed" | "skipped" {
  const feed = Feed.parse(readToml(path.join(REPO, "local/feeds", `${provider}.toml`)));
  const fromStatic = !feed.fetch || feed.fetch.static_prices;
  const src = fromStatic ? path.join(STATIC_DIR, `${provider}.json`) : snapshotPath(provider);
  if (!existsSync(src)) {
    log("static.skip", { provider, reason: fromStatic ? "no feed file" : "not fetched yet", path: src });
    return "skipped";
  }
  let list: PriceList, checked: string, note: string, listed: string[] | undefined;
  if (!fromStatic) {
    ({ rows: list, checked, note, listed } = Snapshot.parse(JSON.parse(readFileSync(src, "utf8"))));
  } else {
    list = PriceList.parse(JSON.parse(readFileSync(src, "utf8")));
    checked = statSync(src).mtime.toISOString().slice(0, 10);
    note = "";
  }
  if (feed.fetch?.static_prices) {
    // The live list wins: a static row for a model it does not list is dropped, so its file goes.
    const snap = snapshotPath(provider);
    if (!existsSync(snap)) {
      log("static.skip", { provider, reason: "not fetched yet", path: snap });
      return "skipped";
    }
    const live = new Set(Snapshot.parse(JSON.parse(readFileSync(snap, "utf8"))).listed);
    const gone = list.filter((r) => !live.has(r.model_name)).map((r) => r.model_name);
    if (gone.length > 0) log("static.delisted", { provider, models: gone.join(",") });
    list = list.filter((r) => live.has(r.model_name));
  }

  const dir = path.join(REPO, "providers", provider);
  const have = new Map<string, string>();
  for (const file of [path.join(dir, "provider.toml"), ...walk(path.join(dir, "models"))]) {
    if (existsSync(file)) have.set(path.relative(REPO, file), readFileSync(file, "utf8"));
  }

  let want: Map<string, string>, skipped: Rendered["skipped"];
  if (patch) {
    ({ files: want, skipped } = renderPatch(provider, feed, list, checked, note, have));
  } else {
    ({ files: want, skipped } = render(provider, feed, list, checked, note));
  }
  for (const s of skipped) log("static.unmatched", { provider, model: s.model, reason: s.reason });

  // The header carries the feed's date. A file touched but not changed must not count as a change.
  const body = (text: string | undefined) => text?.split("\n").slice(1).join("\n");
  const writes = [...want].filter(([p, text]) => body(have.get(p)) !== body(text));
  // A patch deletes only upstream files for models the provider's live list no longer has.
  const deletes = patch ? retired(provider, have, listed) : [...have.keys()].filter((p) => !want.has(p));
  const needLogo = !patch && !existsSync(path.join(dir, "logo.svg"));
  if (writes.length === 0 && deletes.length === 0 && !needLogo) {
    log("static.unchanged", { provider, models: patch ? want.size : want.size - 1, skipped: skipped.length });
    return "unchanged";
  }
  log("static.diff", { provider, write: writes.length, delete: deletes.length, skipped: skipped.length });
  if (DRY_RUN) return "changed";

  for (const [p, text] of writes) {
    mkdirSync(path.dirname(path.join(REPO, p)), { recursive: true });
    writeFileSync(path.join(REPO, p), text);
  }
  for (const p of deletes) rmSync(path.join(REPO, p));
  // A placeholder only. The owner may replace it; a later run never overwrites it.
  if (needLogo) writeFileSync(path.join(dir, "logo.svg"), LOGO);

  const v = Bun.spawnSync(["bun", "validate"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (v.exitCode !== 0) {
    // Put the provider folder back exactly as it was, so the last good prices stay.
    git(["checkout", "--", `providers/${provider}`]);
    git(["clean", "-fdq", "--", `providers/${provider}`]);
    const err = (v.stderr.toString() + v.stdout.toString()).split("\n").filter(Boolean).slice(-15).join("\n");
    throw new Error(`bun validate failed, changes reverted:\n${err}`);
  }

  if (!NO_COMMIT) {
    git(["add", "-A", "--", `providers/${provider}`]);
    const c = git(["commit", "-q", "-m", `chore(prices): update ${provider} prices (checked ${checked})`]);
    if (!c.ok) throw new Error(`git commit failed: ${c.out}`);
  }
  // One line per model whose price changed, new or removed, for the notification.
  for (const [p, text] of writes) {
    const id = p.replace(`providers/${provider}/models/`, "").replace(/\.toml$/, "");
    const before = have.get(p);
    if (before === undefined) log("static.change", { provider, model: id, kind: "new" });
    else {
      const d = costDiff(costOf(before), costOf(text));
      if (d) log("static.change", { provider, model: id, kind: "price", diff: d });
    }
  }
  for (const p of deletes) {
    log("static.change", { provider, model: p.replace(`providers/${provider}/models/`, "").replace(/\.toml$/, ""), kind: "removed" });
  }
  log("static.applied", { provider, write: writes.length, delete: deletes.length, committed: NO_COMMIT ? 0 : 1 });
  return "changed";
}

if (import.meta.main) {
  const allow = Allow.parse(readToml(path.join(REPO, "local/static.toml")));
  let failed = 0;
  for (const provider of allow.providers) {
    try {
      apply(provider, allow.patch.includes(provider));
    } catch (e) {
      failed++;
      log("static.error", { provider, error: e instanceof Error ? e.message : String(e) });
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}
