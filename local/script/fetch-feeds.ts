// Pull the price list of every feed in local/static.toml that has a [fetch] table, convert it to
// USD, and write local/.feeds/<provider>.json for apply-static.ts.
//
// The static job runs this every minute, but a feed is fetched at most once per
// PRICE_FETCH_MINUTES, counted from the last try, so a provider that is down is not hit every minute.
// A failed fetch keeps the last snapshot, so the last good prices stay.
//
// Formats: "kenari" (public, IDR), "dashscope" (Alibaba Model Studio, USD or CNY), "openrouter" (an
// OpenRouter-style list, USD per token: OpenRouter, Engy) and "models" (an OpenAI-style model list with no
// prices, for a subscription plan). A list behind a key reads the
// env var named by [fetch] key_env; with that var unset the feed is skipped (fetch.skip), not failed.
//
// Currency: the rate is the ECB reference rate of the first day of the month (via frankfurter.dev).
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
export function dashscopeRows(models: readonly DashscopeModel[], perUsd = 1): PriceRow[] {
  const rows: PriceRow[] = [];
  for (const m of models) {
    const ranges = m.prices ?? [];
    if (ranges.length === 0) continue;
    const prices = (r: (typeof ranges)[number], band: "peak" | "offpeak") => {
      const out = new Map<string, number>();
      for (const x of r.prices) {
        if (x.price_unit !== "Per 1M tokens") continue;
        const b = x.time_band ?? "standard";
        if (band === "offpeak" ? b === "offpeak" : b === "standard" || b === "peak") out.set(x.type, Number(x.price) / perUsd);
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

/**
 * One entry of an OpenRouter-style GET /v1/models (OpenRouter, Engy). Prices are USD per token, as
 * strings; "-1" is a router or a dead route with no fixed price. Engy puts the modalities at the
 * top, OpenRouter under `architecture`.
 */
const PerToken = z.string().optional();
const OpenrouterPrices = z.object({
  prompt: PerToken,
  completion: PerToken,
  internal_reasoning: PerToken,
  input_cache_read: PerToken,
  input_cache_write: PerToken,
});
const OpenrouterModel = z.object({
  id: z.string(),
  owned_by: z.string().optional(),
  output_modalities: z.array(z.string()).optional(),
  architecture: z.object({ output_modalities: z.array(z.string()) }).optional(),
  supported_parameters: z.array(z.string()).optional(),
  context_length: z.number().int().nonnegative().nullable().optional(),
  pricing: OpenrouterPrices.extend({
    overrides: z
      .array(
        OpenrouterPrices.extend({
          min_prompt_tokens: z.number().int().positive().optional(),
          utc_days: z.array(z.string()).optional(),
          utc_start: z.number().int().min(0).max(2400).optional(),
          utc_end: z.number().int().min(0).max(2400).optional(),
        }),
      )
      .optional(),
  }),
});
type OpenrouterModel = z.infer<typeof OpenrouterModel>;
// An empty list would delete every file of the provider.
const OpenrouterList = z.object({ data: z.array(OpenrouterModel).min(1) });

const WEEKDAY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** 130 -> "01:30"; 2400 and 0 are both midnight. */
const clock = (n: number) => `${String(Math.floor(n / 100) % 24).padStart(2, "0")}:${String(n % 100).padStart(2, "0")}`;

/**
 * An OpenRouter-style list as price rows in USD per 1M tokens, mapped as upstream's OpenRouter sync
 * (packages/core/src/sync/providers/openrouter.ts) maps it, so a patch changes only what moved:
 * - only text and decision models, no :batch route; a price below 0 or (but for a decision model) no parameters
 *   is a dead route, left out;
 * - `reasoning` is internal_reasoning, for a model that takes a reasoning parameter;
 * - an override with min_prompt_tokens is a context tier; the 1h cache write is not read.
 * Upstream ignores the time overrides (utc_start, utc_end, utc_days). Here, when the windows hold
 * the top-level price and one other, the other is the price in its windows: a dearer one is the
 * peak price, a cheaper one (in a single window) the off-peak price. Any other shape keeps the top-level price, logged as fetch.peak_unread.
 */
export function openrouterRows(json: unknown): { rows: PriceList; listed: string[] } {
  const perM = (s: string | undefined) => {
    if (s === undefined) return undefined;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e12) / 1e6 : undefined;
  };
  const data = OpenrouterList.parse(json).data;
  const rows: PriceRow[] = [];
  for (const m of data) {
    const out = m.architecture?.output_modalities ?? m.output_modalities ?? ["text"];
    const decision = out.includes("decisions");
    if (!out.includes("text") && !decision) continue;
    // Upstream's sync skips batch routes too: no catalog has a file for them.
    if (m.id.endsWith(":batch")) continue;
    const p = m.pricing;
    if (Number(p.prompt) < 0 || Number(p.completion) < 0) continue;
    if (m.supported_parameters?.length === 0 && !decision) continue;
    const params = new Set(m.supported_parameters ?? []);
    const reasons = params.has("reasoning") || params.has("include_reasoning");
    const cost = (x: z.infer<typeof OpenrouterPrices>) => {
      const input = perM(x.prompt), output = perM(x.completion);
      if (input === undefined || output === undefined) return null;
      const c: { input: number; output: number; reasoning?: number; cache_read?: number; cache_write?: number } = { input, output };
      const r = reasons ? perM(x.internal_reasoning) : undefined, cr = perM(x.input_cache_read), cw = perM(x.input_cache_write);
      if (r !== undefined) c.reasoning = r;
      if (cr !== undefined) c.cache_read = cr;
      if (cw !== undefined) c.cache_write = cw;
      return c;
    };
    const top = cost(p);
    if (top === null) continue;
    const overrides = p.overrides ?? [];
    const tiers = overrides
      .flatMap((o) => (o.min_prompt_tokens === undefined ? [] : [{ size: o.min_prompt_tokens, c: cost(o) }]))
      .flatMap((t) => (t.c === null ? [] : [{ size: t.size, ...t.c }]))
      .sort((x, y) => x.size - y.size);
    const timed = overrides.filter((o) => o.min_prompt_tokens === undefined);
    let base = top, offpeak: PriceRow["offpeak"];
    if (timed.length > 0) {
      const same = (x: object | null, y: object) => JSON.stringify(x) === JSON.stringify(y);
      const other = timed.map((o) => cost(o)).find((c) => !same(c, top));
      const windows = timed.filter((o) => !same(cost(o), top));
      const days = (o: (typeof timed)[number]) => o.utc_days?.map((d) => WEEKDAY.indexOf(d.toLowerCase()));
      const hours = (o: (typeof timed)[number]): Hours => ({
        from: clock(o.utc_start!),
        to: clock(o.utc_end!),
        utc_offset: 0,
        ...(o.utc_days ? { days: days(o)! } : {}),
      });
      const readable =
        other &&
        tiers.length === 0 &&
        windows.every((o) => same(cost(o), other) && o.utc_start !== undefined && o.utc_end !== undefined && !days(o)?.includes(-1));
      if (readable && other.input < top.input) {
        // Cheaper in its windows: an off-peak price. The catalog takes one off-peak window.
        if (windows.length === 1) offpeak = { ...other, hours: hours(windows[0]!) };
        else log("fetch.peak_unread", { model: m.id, reason: "more than one cheaper window; top-level price kept" });
      } else if (readable) {
        // Dearer in its windows: the peak price, the top-level one off-peak.
        base = other;
        offpeak = { ...top, peak: windows.map(hours) };
      } else if (other) {
        log("fetch.peak_unread", { model: m.id, reason: "time overrides not in a peak/off-peak shape; top-level price kept" });
      }
    }
    rows.push({
      model_name: m.id,
      provider: m.owned_by ?? "",
      input_cost_per_1m_tokens: base.input,
      output_cost_per_1m_tokens: base.output,
      cache_read_cost_per_1m_tokens: base.cache_read ?? null,
      cache_write_cost_per_1m_tokens: base.cache_write ?? null,
      reasoning_cost_per_1m_tokens: base.reasoning ?? null,
      ...(tiers.length > 0 ? { tiers } : {}),
      ...(offpeak ? { offpeak } : {}),
      context_length: m.context_length ?? 0,
    });
  }
  return { rows: PriceList.parse(rows), listed: [...new Set(data.map((m) => m.id))].sort() };
}

async function get(url: string, key?: string): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json, text/plain" };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers });
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
  return r;
}
const getJson = async (url: string, key?: string): Promise<unknown> => (await get(url, key)).json();

/** Every Markdown table in `text`, indented ones too (inside <Tabs>). */
export function mdTables(text: string): { head: string[]; rows: string[][] }[] {
  const lines = text.split("\n").map((l) => l.trim());
  const cells = (l: string) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const out: { head: string[]; rows: string[][] }[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i]!.startsWith("|") || !/^\|[\s:|-]+\|$/.test(lines[i + 1]!)) continue;
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j]!.startsWith("|"); j++) rows.push(cells(lines[j]!));
    out.push({ head: cells(lines[i]!), rows });
    i = j - 1;
  }
  return out;
}

/** "$0.40" -> 0.4, "Free" -> 0, "-" -> null, "~~$1.36~~ $0.68" (a sale) -> 0.68. Else it throws. */
export function money(cell: string): number | null {
  if (cell === "-" || cell === "") return null;
  if (cell === "Free") return 0;
  const all = [...cell.replace(/~~[^~]*~~/g, "").matchAll(/\$(\d+(?:\.\d+)?)/g)];
  if (all.length !== 1) throw new Error(`cannot read the price "${cell}"`);
  return Number(all[0]![1]);
}

/** OpenCode's peak hours, from the sentence its docs use: "Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday". */
export function opencodePeak(text: string): Hours[] {
  const found = [...new Set([...text.matchAll(/Peak hours are ([^;.]*?) UTC, Monday through Friday/g)].map((m) => m[1]!))];
  if (found.length !== 1) throw new Error(`expected one "Peak hours are ... UTC, Monday through Friday" sentence, found ${found.length}`);
  const spans = [...found[0]!.matchAll(/(\d\d:\d\d)-(\d\d:\d\d)/g)];
  if (spans.length === 0) throw new Error(`no hours in "${found[0]}"`);
  return spans.map((m) => ({ from: m[1]!, to: m[2]!, utc_offset: 0, days: [1, 2, 3, 4, 5] }));
}

/**
 * OpenCode's price table (docs console/models.mdx, console/go.mdx) as price rows, by model id. The table names a
 * model by its display name; the "Model | Model ID" table gives the id. A name may carry one note:
 * "(≤ 256K tokens)" is the base price and "(> 256K tokens)" a tier from 256K; "(Peak)" and
 * "(Off-Peak)" are the two prices of the off-peak switch; any other note ("50% off") is the price
 * now. Anything it cannot read fails the whole list, so a changed page never half-applies.
 */
export function opencodeDocRows(text: string): PriceRow[] {
  const tables = mdTables(text);
  const ids = new Map<string, string[]>();
  for (const t of tables.filter((t) => t.head[0] === "Model" && t.head[1] === "Model ID")) {
    for (const r of t.rows) ids.set(r[0]!, [...(ids.get(r[0]!) ?? []), r[1]!.replace(/`/g, "")]);
  }
  const priced = tables.filter((t) => t.head[0] === "Model" && t.head[1] === "Input" && t.head[2] === "Output");
  const table = priced[0];
  if (!table || ids.size === 0) throw new Error("no price table or no Model ID table");
  const col = (name: string) => table.head.indexOf(name);
  // Go repeats the table once per plan, with a plan column added. The prices must agree.
  const PRICE_COLS = ["Model", "Input", "Output", "Cached Read", "Cached Write"];
  const prices = (t: (typeof tables)[number]) =>
    JSON.stringify(t.rows.map((r) => PRICE_COLS.map((c) => (t.head.indexOf(c) >= 0 ? r[t.head.indexOf(c)] : null))));
  if (priced.some((t) => prices(t) !== prices(table))) throw new Error("the price tables disagree");
  const [read, write] = [col("Cached Read"), col("Cached Write")];
  type C = { input: number; output: number; cache_read?: number; cache_write?: number };
  const groups = new Map<string, { base?: C; peak?: C; off?: C; tiers: (C & { size: number })[] }>();
  for (const r of table.rows) {
    const m = r[0]!.match(/^(.*?)\s*(?:\(([^)]*)\))?$/)!;
    const name = m[1]!, note = m[2] ?? "";
    const input = money(r[1]!), output = money(r[2]!);
    if (input === null || output === null) throw new Error(`${r[0]}: no input or output price`);
    const c: C = { input, output };
    const cr = read >= 0 ? money(r[read]!) : null, cw = write >= 0 ? money(r[write]!) : null;
    if (cr !== null) c.cache_read = cr;
    if (cw !== null) c.cache_write = cw;
    const g = groups.get(name) ?? { tiers: [] };
    groups.set(name, g);
    const over = note.match(/^>\s*(\d+)([KM]) tokens$/);
    const slot = note === "Peak" ? "peak" : note === "Off-Peak" ? "off" : over ? null : "base";
    if (over) g.tiers.push({ ...c, size: Number(over[1]) * (over[2] === "K" ? 1_000 : 1_000_000) });
    else if (g[slot!]) throw new Error(`${name}: two "${slot}" prices`);
    else g[slot!] = c;
  }
  const peakHours = [...groups.values()].some((g) => g.off) ? opencodePeak(text) : [];
  const rows: PriceRow[] = [];
  for (const [name, g] of groups) {
    const base = g.peak ?? g.base;
    if (!base || (g.peak && g.base) || (g.off && !g.peak)) throw new Error(`${name}: cannot tell the base price`);
    const modelIds = ids.get(name);
    if (!modelIds) throw new Error(`${name}: not in the Model ID table`);
    for (const id of modelIds) {
      rows.push({
        model_name: id,
        provider: "",
        input_cost_per_1m_tokens: base.input,
        output_cost_per_1m_tokens: base.output,
        cache_read_cost_per_1m_tokens: base.cache_read ?? null,
        cache_write_cost_per_1m_tokens: base.cache_write ?? null,
        ...(g.tiers.length > 0 ? { tiers: g.tiers } : {}),
        ...(g.off ? { offpeak: { ...g.off, peak: peakHours } } : {}),
        context_length: 0,
      });
    }
  }
  return PriceList.parse(rows);
}

/** `cur` per USD on `date`. The note in the last snapshot carries the rate, so a month asks once. */
async function perUsd(cur: string, date: string, last: Snapshot | null): Promise<number> {
  const m = last?.note.match(new RegExp(`at ([\\d.]+) ${cur} per USD \\(ECB rate of (\\d{4}-\\d{2}-\\d{2})`));
  if (m && m[2] === date) return Number(m[1]);
  const fx = z
    .object({ rates: z.record(z.string(), z.number().positive()) })
    .parse(await getJson(`${FX_URL}/${date}?base=USD&symbols=${cur}`));
  const rate = fx.rates[cur];
  if (rate === undefined) throw new Error(`no ${cur} rate for ${date}`);
  return rate;
}

const fxNote = (cur: string, rate: number, date: string) =>
  `at ${rate} ${cur} per USD (ECB rate of ${date}, via frankfurter.dev).`;

type Got = Pick<Snapshot, "note" | "rows" | "listed">;

async function kenari(feed: Feed, last: Snapshot | null, now: Date): Promise<Got> {
  const date = rateDate(now);
  const rate = await perUsd("IDR", date, last);
  const main = await getJson(feed.fetch!.url);
  const rows = kenariRows(main, rate);
  // Any list that fails fails the fetch: a short list would delete the models it left out.
  const others = await Promise.all(KENARI_MODALITIES.map((m) => getJson(`${feed.fetch!.url}?modality=${m}`)));
  return {
    note: `Converted from IDR ${fxNote("IDR", rate, date)}`,
    rows,
    listed: kenariIds([main, ...others]),
  };
}

/** Every page of the list. A short read fails the fetch, since a missing page would delete models. */
async function dashscope(feed: Feed, key: string, last: Snapshot | null, now: Date): Promise<Got> {
  const f = feed.fetch!;
  const models: DashscopeModel[] = [];
  for (let page = 1; ; page++) {
    const got = DashscopePage.parse(await getJson(`${feed.fetch!.url}?page_no=${page}&page_size=100`, key)).output;
    models.push(...got.models);
    if (got.models.length === 0 || models.length >= got.total) {
      if (models.length !== got.total) throw new Error(`read ${models.length} models, the list says ${got.total}`);
      break;
    }
  }
  const region = f.region ? ` of the ${f.region} region` : "";
  const listed = [...new Set(models.map((m) => m.model))].sort();
  if (f.currency === "USD") return { note: `USD list prices${region}.`, rows: dashscopeRows(models), listed };
  const date = rateDate(now);
  const rate = await perUsd(f.currency, date, last);
  return {
    note: `${f.currency} list prices${region}, converted ${fxNote(f.currency, rate, date)}`,
    rows: dashscopeRows(models, rate),
    listed,
  };
}

/** An OpenAI-style model list with no prices. More pages than one would need paging we do not do. */
// Coding Plan says hasMore, Token Plan says has_more.
export const ModelList = z.object({
  data: z.array(z.object({ id: z.string() })).min(1),
  hasMore: z.boolean().nullable().optional(),
  has_more: z.boolean().nullable().optional(),
});

async function models(feed: Feed, key: string | undefined): Promise<Got> {
  const f = feed.fetch!;
  const got = ModelList.parse(await getJson(f.url, key));
  // A short list would delete the models it left out.
  if (got.hasMore || got.has_more) throw new Error("the list has more pages; read them before trusting it");
  const listed = [...new Set(got.data.map((m) => m.id))].sort();
  if (f.price_doc) {
    const rows = opencodeDocRows(await (await get(f.price_doc)).text());
    return { note: `prices from OpenCode's docs source, ${f.price_doc}.`, rows, listed };
  }
  if (f.static_prices) return { note: "", rows: [], listed };
  if (!f.price_from) return { note: "", rows: [], listed };
  const src = snapshotPath(f.price_from);
  if (!existsSync(src)) throw new Error(`no prices yet from ${f.price_from}`);
  const from = Snapshot.parse(JSON.parse(readFileSync(src, "utf8")));
  return {
    note:
      `price of ${f.price_from} (its own list) x ${f.price_factor}: the plan bills in Credits, ` +
      `and Alibaba publishes no Credit rate per model.`,
    rows: borrowRows(from.rows, listed, f.price_factor),
    listed,
  };
}

/** Another feed's rows for the listed models only, every price times `factor`. */
export function borrowRows(rows: readonly PriceRow[], listed: readonly string[], factor: number): PriceRow[] {
  const ids = new Set(listed);
  const x = (n: number | null | undefined) => (n == null ? n : n * factor);
  const cost = <T extends Record<string, unknown>>(c: T): T =>
    Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === "number" && k !== "size" ? v * factor : v])) as T;
  return rows
    .filter((r) => ids.has(r.model_name))
    .map((r) => ({
      ...r,
      input_cost_per_1m_tokens: r.input_cost_per_1m_tokens * factor,
      output_cost_per_1m_tokens: r.output_cost_per_1m_tokens * factor,
      cache_read_cost_per_1m_tokens: x(r.cache_read_cost_per_1m_tokens),
      cache_write_cost_per_1m_tokens: x(r.cache_write_cost_per_1m_tokens),
      reasoning_cost_per_1m_tokens: x(r.reasoning_cost_per_1m_tokens),
      ...(r.tiers ? { tiers: r.tiers.map(cost) } : {}),
      ...(r.offpeak ? { offpeak: cost(r.offpeak) } : {}),
    }));
}

async function fetchFeed(provider: string, feed: Feed): Promise<void> {
  const out = snapshotPath(provider);
  const tried = out.replace(/\.json$/, ".tried");
  if (existsSync(tried) && Date.now() - statSync(tried).mtimeMs < EVERY_MIN * 60_000) return;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(tried, "");

  const f = feed.fetch!;
  const key = f.key_env ? process.env[f.key_env] : undefined;
  // A feed waiting for its key is not broken: the last prices (or upstream's) stay.
  if (f.key_env && !key) {
    log("fetch.skip", { provider, reason: `no API key; set ${f.key_env}` });
    return;
  }
  const last = existsSync(out) ? Snapshot.safeParse(JSON.parse(readFileSync(out, "utf8"))).data ?? null : null;
  const now = new Date();
  const got =
    f.format === "kenari" ? await kenari(feed, last, now)
    : f.format === "dashscope" ? await dashscope(feed, key!, last, now)
    : f.format === "openrouter" ? { note: "USD list prices.", ...openrouterRows(await getJson(f.url, key)) }
    : await models(feed, key);
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
  const feedOf = (p: string) =>
    Feed.parse(Bun.TOML.parse(readFileSync(path.join(REPO, "local/feeds", `${p}.toml`), "utf8")));
  // A feed another one borrows prices from is fetched first, even when its own folder is off.
  const sources = allow.providers.flatMap((p) => feedOf(p).fetch?.price_from ?? []);
  const order = [...new Set([...sources, ...allow.providers])];
  let failed = 0;
  for (const provider of order) {
    const feed = feedOf(provider);
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
