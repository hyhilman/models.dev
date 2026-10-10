// Pull the price list of every feed in local/static.toml that has a [fetch] table, convert it to
// USD, and write local/.feeds/<provider>.json for apply-static.ts.
//
// The static job runs this every minute, but a feed is fetched at most once per
// PRICE_FETCH_MINUTES, counted from the last try, so a provider that is down is not hit every minute.
// A failed fetch keeps the last snapshot, so the last good prices stay.
//
// Formats: "kenari" (public, IDR) and "dashscope" (Alibaba Model Studio, USD, needs the key named
// by [fetch] key_env).
//
// Currency: the kenari rate is the ECB reference rate of the first day of the month (via frankfurter.dev).
// One rate per month keeps a daily rate move from rewriting every price file every day.
//
// Run: bun local/script/fetch-feeds.ts
// Env: PRICE_FETCH_MINUTES  minutes between tries per feed (default 10; 0 = always). The job sets
//                           it from [prices] fetch_minutes.
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { z } from "../lib/deps.ts";
import { Feed, type Hours, PriceList, type PriceRow, Snapshot, snapshotPath } from "./apply-static.ts";

const REPO = path.resolve(import.meta.dir, "../..");
const EVERY_MIN = Number(process.env.PRICE_FETCH_MINUTES ?? "10");
const FX_URL = "https://api.frankfurter.dev/v1";

const log = (event: string, fields: Record<string, string | number> = {}) =>
  console.error(
    [`event=${event}`, ...Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)].join(" "),
  );

const MicroIdr = z.number().nonnegative().nullable().optional();

/** One entry of kenari's GET /v1/models. Only the fields we read; the rest is ignored. */
const KenariModel = z.object({
  id: z.string(),
  owned_by: z.string(),
  endpoints: z.array(z.string()).optional(),
  context_length: z.number().int().nonnegative().nullable().optional(),
  pricing: z.object({
    input: MicroIdr,
    output: MicroIdr,
    cache_read: MicroIdr,
    cache_write: MicroIdr,
    free: z.boolean(),
    currency: z.literal("IDR"),
    unit: z.literal("micro_idr_per_1m_tokens"),
  }),
});
const KenariList = z.object({ data: z.array(KenariModel) });

/**
 * Kenari's list as price rows in USD. Only chat models: image, video and speech models are priced
 * per image, second or character, which a token price cannot say. A `:free` model costs nothing,
 * whatever price it shows (that is the paid version's price, per kenari's docs).
 */
export function kenariRows(json: unknown, idrPerUsd: number): PriceList {
  const usd = (micro: number | null | undefined) => (micro == null ? null : micro / 1e6 / idrPerUsd);
  const rows: PriceList = [];
  for (const m of KenariList.parse(json).data) {
    if (!(m.endpoints ?? []).includes("chat")) continue;
    const p = m.pricing;
    const free = p.free;
    if (!free && (p.input == null || p.output == null)) continue;
    rows.push({
      model_name: m.id,
      provider: m.owned_by,
      input_cost_per_1m_tokens: free ? 0 : usd(p.input)!,
      output_cost_per_1m_tokens: free ? 0 : usd(p.output)!,
      cache_read_cost_per_1m_tokens: free ? null : usd(p.cache_read),
      cache_write_cost_per_1m_tokens: free ? null : usd(p.cache_write),
      context_length: m.context_length ?? 0,
    });
  }
  return PriceList.parse(rows);
}

/**
 * Kenari lists embedding, rerank, moderation and System One models only under ?modality=. A
 * model in none of the lists is one Kenari no longer serves.
 */
export const KENARI_MODALITIES = ["embedding", "rerank", "moderation", "systemone"] as const;

/** Every id in Kenari's lists, any kind of model. */
export function kenariIds(lists: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const l of lists) for (const m of z.object({ data: z.array(z.object({ id: z.string() })) }).parse(l).data) ids.add(m.id);
  return [...ids].sort();
}

/** The first day of this month, UTC: the date whose rate the whole month uses. */
export const rateDate = (now: Date): string => `${now.toISOString().slice(0, 7)}-01`;

/** One entry of Alibaba Model Studio's GET /api/v1/models. Only the fields we read. */
const DashscopeModel = z.object({
  model: z.string(),
  provider: z.string().nullable().optional(),
  prices: z
    .array(
      z.object({
        range_name: z.string(),
        prices: z.array(
          z.object({
            type: z.string(),
            price: z.string(),
            price_unit: z.string(),
            time_band: z.string().nullable().optional(),
          }),
        ),
      }),
    )
    .nullable()
    .optional(),
  model_info: z.object({ context_window: z.number().int().nonnegative().nullable().optional() }).nullable().optional(),
});
type DashscopeModel = z.infer<typeof DashscopeModel>;
const DashscopePage = z.object({
  output: z.object({ total: z.number().int(), models: z.array(DashscopeModel) }),
});

/**
 * Alibaba's off-peak hours. The list marks prices `peak` and `offpeak` but does not say when. From
 * https://www.alibabacloud.com/help/en/model-studio/model-pricing (checked 2026-10-10): "Peak hours
 * refer to UTC+8 8:00 - 22:00, and off-peak hours refer to UTC+8 22:00 - 8:00 the next day."
 */
export const DASHSCOPE_OFFPEAK: Hours = { from: "22:00", to: "08:00", utc_offset: 8 };

/** "256k<Input<=1m" -> 256000: where a long-prompt tier starts. null for a name we do not know. */
export function tierStart(range: string): number | null {
  const m = range.match(/^(\d+)([km])<Input<=/i);
  return m ? Number(m[1]) * (m[2]!.toLowerCase() === "k" ? 1_000 : 1_000_000) : null;
}

/**
 * Alibaba's list as price rows, already in USD. Only models priced per token for text in and out
 * (input_token and output_token); image, video and speech prices are per image, second or
 * character. The first price range is the base price, each later one a long-prompt tier.
 */
export function dashscopeRows(models: readonly DashscopeModel[]): PriceRow[] {
  const rows: PriceRow[] = [];
  for (const m of models) {
    const ranges = m.prices ?? [];
    if (ranges.length === 0) continue;
    const prices = (r: (typeof ranges)[number], band: "peak" | "offpeak") => {
      const out = new Map<string, number>();
      for (const x of r.prices) {
        if (x.price_unit !== "Per 1M tokens") continue;
        const b = x.time_band ?? "standard";
        if (band === "offpeak" ? b === "offpeak" : b === "standard" || b === "peak") out.set(x.type, Number(x.price));
      }
      return out;
    };
    const cost = (p: Map<string, number>) => {
      const input = p.get("input_token"), output = p.get("output_token");
      if (input === undefined || output === undefined) return null;
      const thinking = p.get("thinking_output_token");
      return {
        input,
        output,
        // The explicit cache when the model has one, else the implicit (automatic) cache.
        cache_read: p.get("input_token_cache_read") ?? p.get("input_token_cache"),
        cache_write: p.get("input_token_cache_creation_5m"),
        reasoning: thinking !== undefined && thinking !== output ? thinking : undefined,
      };
    };
    const base = cost(prices(ranges[0]!, "peak"));
    if (base === null) continue;
    const tiers = ranges.slice(1).map((r) => ({ size: tierStart(r.range_name), cost: cost(prices(r, "peak")) }));
    // A tier we cannot read would leave long prompts at the short-prompt price.
    if (tiers.some((t) => t.size === null || t.cost === null)) continue;
    // Off-peak prices come only on single-range models today; a tiered one keeps the peak price.
    const off = ranges.length === 1 ? cost(prices(ranges[0]!, "offpeak")) : null;
    rows.push({
      model_name: m.model,
      provider: m.provider ?? "",
      input_cost_per_1m_tokens: base.input,
      output_cost_per_1m_tokens: base.output,
      cache_read_cost_per_1m_tokens: base.cache_read ?? null,
      cache_write_cost_per_1m_tokens: base.cache_write ?? null,
      reasoning_cost_per_1m_tokens: base.reasoning ?? null,
      ...(tiers.length > 0 ? { tiers: tiers.map((t) => ({ size: t.size!, ...t.cost! })) } : {}),
      ...(off ? { offpeak: { ...off, hours: DASHSCOPE_OFFPEAK } } : {}),
      context_length: m.model_info?.context_window ?? 0,
    });
  }
  return PriceList.parse(rows);
}

async function getJson(url: string, key?: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers });
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
  return r.json();
}

/** IDR per USD on `date`. The note in the last snapshot carries the rate, so a month asks once. */
async function idrPerUsd(date: string, last: Snapshot | null): Promise<number> {
  const m = last?.note.match(/at ([\d.]+) IDR per USD \(ECB rate of (\d{4}-\d{2}-\d{2})/);
  if (m && m[2] === date) return Number(m[1]);
  const fx = z
    .object({ rates: z.object({ IDR: z.number().positive() }) })
    .parse(await getJson(`${FX_URL}/${date}?base=USD&symbols=IDR`));
  return fx.rates.IDR;
}

type Got = Pick<Snapshot, "note" | "rows" | "listed">;

async function kenari(feed: Feed, last: Snapshot | null, now: Date): Promise<Got> {
  const date = rateDate(now);
  const rate = await idrPerUsd(date, last);
  const main = await getJson(feed.fetch!.url);
  const rows = kenariRows(main, rate);
  // Any list that fails fails the fetch: a short list would delete the models it left out.
  const others = await Promise.all(KENARI_MODALITIES.map((m) => getJson(`${feed.fetch!.url}?modality=${m}`)));
  return {
    note: `Converted from IDR at ${rate} IDR per USD (ECB rate of ${date}, via frankfurter.dev).`,
    rows,
    listed: kenariIds([main, ...others]),
  };
}

/** Every page of the list. A short read fails the fetch, since a missing page would delete models. */
async function dashscope(feed: Feed): Promise<Got> {
  const name = feed.fetch!.key_env;
  const key = name ? process.env[name] : undefined;
  if (!key) throw new Error(`no API key: set ${name ?? "[fetch] key_env"}`);
  const models: DashscopeModel[] = [];
  for (let page = 1; ; page++) {
    const got = DashscopePage.parse(await getJson(`${feed.fetch!.url}?page_no=${page}&page_size=100`, key)).output;
    models.push(...got.models);
    if (got.models.length === 0 || models.length >= got.total) {
      if (models.length !== got.total) throw new Error(`read ${models.length} models, the list says ${got.total}`);
      break;
    }
  }
  return {
    note: `USD list prices of the international (Singapore) region.`,
    rows: dashscopeRows(models),
    listed: [...new Set(models.map((m) => m.model))].sort(),
  };
}

async function fetchFeed(provider: string, feed: Feed): Promise<void> {
  const out = snapshotPath(provider);
  const tried = out.replace(/\.json$/, ".tried");
  if (existsSync(tried) && Date.now() - statSync(tried).mtimeMs < EVERY_MIN * 60_000) return;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(tried, "");

  const last = existsSync(out) ? Snapshot.safeParse(JSON.parse(readFileSync(out, "utf8"))).data ?? null : null;
  const now = new Date();
  const got = feed.fetch!.format === "kenari" ? await kenari(feed, last, now) : await dashscope(feed);
  const snap: Snapshot = { checked: now.toISOString().slice(0, 10), ...got };
  // Write then rename, so apply-static never reads half a file.
  writeFileSync(`${out}.new`, JSON.stringify(snap, null, 1) + "\n");
  renameSync(`${out}.new`, out);
  log("fetch.done", { provider, rows: snap.rows.length, listed: snap.listed!.length });
}

if (import.meta.main) {
  const allow = z
    .object({ providers: z.array(z.string()) })
    .parse(Bun.TOML.parse(readFileSync(path.join(REPO, "local/static.toml"), "utf8")));
  let failed = 0;
  for (const provider of allow.providers) {
    const feed = Feed.parse(Bun.TOML.parse(readFileSync(path.join(REPO, "local/feeds", `${provider}.toml`), "utf8")));
    if (!feed.fetch) continue;
    try {
      await fetchFeed(provider, feed);
    } catch (e) {
      failed++;
      log("fetch.error", { provider, error: e instanceof Error ? e.message : String(e) });
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}
