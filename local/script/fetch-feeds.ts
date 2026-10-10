// Pull the price list of every feed in local/static.toml that has a [fetch] table, convert it to
// USD, and write local/.feeds/<provider>.json for apply-static.ts.
//
// The static job runs this every minute, but a feed is fetched at most once per
// PRICE_FETCH_MINUTES, counted from the last try, so a provider that is down is not hit every minute.
// A failed fetch keeps the last snapshot, so the last good prices stay.
//
// Currency: the rate is the ECB reference rate of the first day of the month (via frankfurter.dev).
// One rate per month keeps a daily rate move from rewriting every price file every day.
//
// Run: bun local/script/fetch-feeds.ts
// Env: PRICE_FETCH_MINUTES  minutes between tries per feed (default 60; 0 = always)
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { z } from "../lib/deps.ts";
import { Feed, PriceList, Snapshot, snapshotPath } from "./apply-static.ts";

const REPO = path.resolve(import.meta.dir, "../..");
const EVERY_MIN = Number(process.env.PRICE_FETCH_MINUTES ?? "60");
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

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } });
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

async function fetchFeed(provider: string, feed: Feed): Promise<void> {
  const out = snapshotPath(provider);
  const tried = out.replace(/\.json$/, ".tried");
  if (existsSync(tried) && Date.now() - statSync(tried).mtimeMs < EVERY_MIN * 60_000) return;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(tried, "");

  const last = existsSync(out) ? Snapshot.safeParse(JSON.parse(readFileSync(out, "utf8"))).data ?? null : null;
  const now = new Date();
  const date = rateDate(now);
  const rate = await idrPerUsd(date, last);
  const main = await getJson(feed.fetch!.url);
  const rows = kenariRows(main, rate);
  // Any list that fails fails the fetch: a short list would delete the models it left out.
  const others = await Promise.all(KENARI_MODALITIES.map((m) => getJson(`${feed.fetch!.url}?modality=${m}`)));
  const snap: Snapshot = {
    checked: now.toISOString().slice(0, 10),
    note: `Converted from IDR at ${rate} IDR per USD (ECB rate of ${date}, via frankfurter.dev).`,
    rows,
    listed: kenariIds([main, ...others]),
  };
  // Write then rename, so apply-static never reads half a file.
  writeFileSync(`${out}.new`, JSON.stringify(snap, null, 1) + "\n");
  renameSync(`${out}.new`, out);
  log("fetch.done", { provider, rows: rows.length, listed: snap.listed!.length, rate });
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
