import { expect, test } from "bun:test";
import { borrowRows, DASHSCOPE_OFFPEAK, dashscopeRows, kenariIds, ModelList, money, opencodeDocRows, openrouterRows, kenariRows, rateDate, tierStart } from "../script/fetch-feeds.ts";
import { Feed, inHours, patchCost, PATCH_MARK, retired, rowCost, Snapshot } from "../script/apply-static.ts";
import { KEY_ENVS } from "../doppelganger/tools/prices/run.ts";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const pricing = (p: Record<string, unknown>) => ({ currency: "IDR", unit: "micro_idr_per_1m_tokens", ...p });
const list = {
  data: [
    {
      id: "claude-fable-5", owned_by: "anthropic", endpoints: ["chat"], context_length: 1_000_000,
      pricing: pricing({ input: 210_000_000_000, output: 1_000_000_000_000, cache_read: 21_000_000_000, cache_write: null, free: false }),
    },
    // A free model still shows its paid price; it costs nothing.
    {
      id: "hy3:free", owned_by: "tencent", endpoints: ["chat"],
      pricing: pricing({ input: 2_700_000_000, output: 11_000_000_000, cache_read: 2_700_000_000, cache_write: null, free: true }),
    },
    { id: "nano-banana", owned_by: "google", endpoints: ["images"], pricing: pricing({ input: 0, output: 0, free: false }) },
  ],
};

test("kenari micro-rupiah become USD per 1M tokens; free costs 0; non-chat is left out", () => {
  const rows = kenariRows(list, 17_946);
  expect(rows.map((r) => r.model_name)).toEqual(["claude-fable-5", "hy3:free"]);
  expect(rows[0]!.input_cost_per_1m_tokens).toBeCloseTo(210_000 / 17_946, 9);
  expect(rows[0]!.cache_write_cost_per_1m_tokens).toBeNull();
  expect(rows[1]).toMatchObject({ input_cost_per_1m_tokens: 0, output_cost_per_1m_tokens: 0, cache_read_cost_per_1m_tokens: null });
});

test("a price in another currency fails, never passes as IDR", () => {
  const usd = { data: [{ ...list.data[0], pricing: { ...list.data[0]!.pricing, currency: "USD" } }] };
  expect(() => kenariRows(usd, 17_946)).toThrow();
});

test("the whole month uses the rate of its first day", () => {
  expect(rateDate(new Date("2026-10-31T23:59:00Z"))).toBe("2026-10-01");
});

test("patchCost replaces only [cost], and a second patch replaces the first", () => {
  const up = 'base_model = "a/b"\n\n[cost]\ninput = 0\noutput = 0\n\n[limit]\ncontext = 5\n';
  const once = patchCost(up, { input: 1, output: 2 }, ["src, checked 2026-10-10."])!;
  expect(once).toBe(`${PATCH_MARK} src, checked 2026-10-10.\nbase_model = "a/b"\n\n[cost]\ninput = 1\noutput = 2\n\n[limit]\ncontext = 5\n`);
  expect(patchCost(once, { input: 1, output: 2 }, ["src, checked 2026-10-10."])).toBe(once);
});

test("patchCost replaces every cost table, tiers too, and keeps the rest", () => {
  const up = '[cost]\ninput = 0\noutput = 0\n\n[[cost.tiers]]\ntier = { size = 1 }\ninput = 9\noutput = 9\n\n[limit]\ncontext = 5\n';
  const out = patchCost(up, { input: 1, output: 2, tiers: [{ tier: { type: "context", size: 256_000 }, input: 3, output: 4 }] }, []);
  expect(Bun.TOML.parse(out)).toEqual({
    cost: { input: 1, output: 2, tiers: [{ tier: { type: "context", size: 256_000 }, input: 3, output: 4 }] },
    limit: { context: 5 },
  });
  expect(patchCost(out, { input: 1, output: 2 }, [])).toBe("[cost]\ninput = 1\noutput = 2\n\n[limit]\ncontext = 5\n");
});

test("every list's ids count as listed", () => {
  expect(kenariIds([list, { data: [{ id: "bge-m3" }] }])).toEqual(["bge-m3", "claude-fable-5", "hy3:free", "nano-banana"]);
});

test("a model the provider no longer lists is retired, however many", () => {
  const f = (ids: string[]) => new Map(ids.map((i) => [`providers/k/models/${i}.toml`, ""]));
  const have = new Map([["providers/k/provider.toml", ""], ...f(["a", "b", "c"])]);
  expect(retired("k", have, ["a", "b"])).toEqual(["providers/k/models/c.toml"]);
  expect(retired("k", have, ["a"])).toEqual(["providers/k/models/b.toml", "providers/k/models/c.toml"]);
  expect(retired("k", have, undefined)).toEqual([]);
});

const ds = (prices: object[], ranges = ["Default"]) => ({
  model: "m",
  provider: "deepseek",
  prices: ranges.map((range_name) => ({ range_name, prices })),
});
const p = (type: string, price: string, time_band = "standard") => ({ type, price, price_unit: "Per 1M tokens", time_band });

test("dashscope: base price, cache, thinking price and long-prompt tiers", () => {
  const [row] = dashscopeRows([
    ds(
      [p("input_token", "0.4"), p("output_token", "1.2"), p("thinking_output_token", "4"), p("input_token_cache", "0.08"),
        p("input_token_cache_read", "0.04"), p("input_token_cache_creation_5m", "0.5"), p("input_token_batch", "0.2")],
      ["Input<=256k", "256k<Input<=1m"],
    ),
  ]);
  expect(row).toMatchObject({
    input_cost_per_1m_tokens: 0.4, output_cost_per_1m_tokens: 1.2, reasoning_cost_per_1m_tokens: 4,
    cache_read_cost_per_1m_tokens: 0.04, cache_write_cost_per_1m_tokens: 0.5,
  });
  expect(row!.tiers).toEqual([{ size: 256_000, input: 0.4, output: 1.2, cache_read: 0.04, cache_write: 0.5, reasoning: 4 }]);
  expect(tierStart("32k<Input<=128k")).toBe(32_000);
  expect(tierStart("Default")).toBeNull();
});

test("dashscope: a model without token prices is left out", () => {
  const image = { ...ds([{ type: "image_number", price: "0.04", price_unit: "Per image", time_band: null }]), model: "img" };
  const rows = dashscopeRows([image, ds([p("input_token", "1"), p("output_token", "2")])]);
  expect(rows.map((r) => r.model_name)).toEqual(["m"]);
});

test("dashscope: the off-peak price is written at night (UTC+8) and the peak price by day", () => {
  const [row] = dashscopeRows([
    ds([p("input_token", "0.15", "offpeak"), p("input_token", "0.3", "peak"), p("output_token", "0.6", "offpeak"), p("output_token", "1.2", "peak")]),
  ]);
  expect(row!.offpeak).toEqual({ input: 0.15, output: 0.6, hours: DASHSCOPE_OFFPEAK });
  const day = rowCost(row!, new Date("2026-10-10T05:00:00Z")); // 13:00 UTC+8
  expect(day.cost).toEqual({ input: 0.3, output: 1.2 });
  expect(day.notes[0]).toContain("peak price now");
  const night = rowCost(row!, new Date("2026-10-10T15:00:00Z")); // 23:00 UTC+8
  expect(night.cost).toEqual({ input: 0.15, output: 0.6 });
  expect(rowCost(row!, new Date("2026-10-10T23:59:00Z")).cost.input).toBe(0.15); // 07:59 UTC+8
  expect(rowCost(row!, new Date("2026-10-11T00:00:00Z")).cost.input).toBe(0.3); // 08:00 UTC+8
});

test("inHours handles windows that do and do not wrap midnight", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 10, h));
  expect(inHours(at(10), { from: "09:00", to: "17:00", utc_offset: 0 })).toBe(true);
  expect(inHours(at(17), { from: "09:00", to: "17:00", utc_offset: 0 })).toBe(false);
  expect(inHours(at(2), { from: "22:00", to: "08:00", utc_offset: 0 })).toBe(true);
});

test("dashscope: a CNY list is converted to USD at the given rate", () => {
  const [row] = dashscopeRows([ds([p("input_token", "7.2", "peak"), p("input_token", "3.6", "offpeak"), p("output_token", "14.4", "peak"), p("output_token", "7.2", "offpeak")])], 7.2);
  expect(row).toMatchObject({ input_cost_per_1m_tokens: 1, output_cost_per_1m_tokens: 2 });
  expect(row!.offpeak).toMatchObject({ input: 0.5, output: 1 });
});

test("a model list with no prices deletes only what the plan stopped serving", () => {
  const snap = Snapshot.parse({ checked: "2026-10-11", note: "", rows: [], listed: ["glm-5", "kimi-k2.5"] });
  const have = new Map(["glm-5", "kimi-k2.5", "glm-4.7"].map((m) => [`providers/plan/models/${m}.toml`, ""]));
  expect(retired("plan", have, snap.listed)).toEqual(["providers/plan/models/glm-4.7.toml"]);
});

test("every feed's key_env is passed to the job, and run.sh passes it too", () => {
  const runSh = readFileSync(path.join(import.meta.dir, "../script/run.sh"), "utf8");
  const dir = path.join(import.meta.dir, "../feeds");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".toml"))) {
    const key = Feed.parse(Bun.TOML.parse(readFileSync(path.join(dir, f), "utf8"))).fetch?.key_env;
    if (!key) continue;
    expect(Object.keys(KEY_ENVS)).toContain(key);
    expect(runSh).toMatch(new RegExp(`for v in [^;]*\\b${key}\\b`));
  }
});

test("a model list reads both spellings of more pages", () => {
  const data = [{ id: "glm-5" }];
  expect(ModelList.parse({ data, has_more: true }).has_more).toBe(true);
  expect(ModelList.parse({ data, hasMore: true }).hasMore).toBe(true);
});

test("a plan borrows another feed's prices for its listed models only, times the factor", () => {
  const [a] = dashscopeRows([
    ds([p("input_token", "0.15", "offpeak"), p("input_token", "0.3", "peak"), p("output_token", "0.6", "offpeak"), p("output_token", "1.2", "peak")]),
  ]);
  const other = { ...a!, model_name: "not-in-plan" };
  const rows = borrowRows([a!, other], ["m", "auto"], 0.5);
  expect(rows.map((r) => r.model_name)).toEqual(["m"]);
  expect(rows[0]).toMatchObject({ input_cost_per_1m_tokens: 0.15, output_cost_per_1m_tokens: 0.6 });
  expect(rows[0]!.offpeak).toEqual({ input: 0.075, output: 0.3, hours: DASHSCOPE_OFFPEAK });
  const tiered = { ...a!, offpeak: undefined, tiers: [{ size: 256_000, input: 1, output: 2 }] };
  expect(borrowRows([tiered], ["m"], 0.5)[0]!.tiers).toEqual([{ size: 256_000, input: 0.5, output: 1 }]);
});

const doc = `
| Model           | Model ID        | Endpoint |
| --------------- | --------------- | -------- |
| Qwen3.7 Plus    | qwen3.7-plus    | x        |
| DeepSeek V4 Pro | deepseek-v4-pro | x        |
| Sale Model      | sale            | x        |
| Free Model      | free-free       | x        |

**DeepSeek V4 Pro:** Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday; all other hours are Off-Peak.

<Tabs>
  <TabItem label="Go">

    | Model                        | Input  | Output | Cached Read | Cached Write | Monthly limit |
    | ---------------------------- | ------ | ------ | ----------- | ------------ | ------------- |
    | Qwen3.7 Plus (≤ 256K tokens) | $0.40  | $1.60  | $0.04       | $0.50        | **$60**       |
    | Qwen3.7 Plus (> 256K tokens) | $1.20  | $4.80  | $0.12       | $1.50        | **$60**       |
    | DeepSeek V4 Pro (Off-Peak)   | $0.66  | $1.98  | $0.022      | -            | **$15**       |
    | DeepSeek V4 Pro (Peak)       | $1.32  | $3.96  | $0.044      | -            | **$15**       |
    | Sale Model (50% off)         | ~~$1.36~~ $0.68 | $2.09 | - | -          | **$15**       |
    | Free Model                   | Free   | Free   | Free        | -            | **Unlimited** |
`;

test("opencode docs: tiers, peak and off-peak, sales and free rows, by model id", () => {
  const rows = new Map(opencodeDocRows(doc).map((r) => [r.model_name, r]));
  expect(rows.get("qwen3.7-plus")).toMatchObject({
    input_cost_per_1m_tokens: 0.4, cache_write_cost_per_1m_tokens: 0.5,
    tiers: [{ size: 256_000, input: 1.2, output: 4.8, cache_read: 0.12, cache_write: 1.5 }],
  });
  const ds = rows.get("deepseek-v4-pro")!;
  expect(ds).toMatchObject({ input_cost_per_1m_tokens: 1.32, output_cost_per_1m_tokens: 3.96, cache_write_cost_per_1m_tokens: null });
  expect(ds.offpeak).toMatchObject({ input: 0.66, output: 1.98, cache_read: 0.022 });
  expect(rows.get("sale")).toMatchObject({ input_cost_per_1m_tokens: 0.68, output_cost_per_1m_tokens: 2.09 });
  expect(rows.get("free-free")).toMatchObject({ input_cost_per_1m_tokens: 0, output_cost_per_1m_tokens: 0, cache_read_cost_per_1m_tokens: 0 });
  // Peak on weekdays inside the windows only; a weekend is off-peak all day.
  expect(rowCost(ds, new Date("2026-10-12T02:00:00Z")).cost.input).toBe(1.32); // Monday 02:00
  expect(rowCost(ds, new Date("2026-10-12T05:00:00Z")).cost.input).toBe(0.66); // Monday 05:00
  expect(rowCost(ds, new Date("2026-10-11T02:00:00Z")).cost.input).toBe(0.66); // Sunday 02:00
  expect(rowCost(ds, new Date("2026-10-12T09:59:00Z")).notes[0]).toContain("01:00-04:00 UTC Mon-Fri, 06:00-10:00 UTC Mon-Fri");
});

test("opencode docs: a row it cannot read fails the whole list", () => {
  expect(() => opencodeDocRows(doc.replace("$0.40", "40 cents"))).toThrow();
  expect(() => opencodeDocRows(doc.replace("| DeepSeek V4 Pro | deepseek-v4-pro | x        |\n", ""))).toThrow(/Model ID/);
  expect(() => opencodeDocRows(doc.replace("Peak hours are", "Busy hours are"))).toThrow(/Peak hours/);
  expect(money("-")).toBeNull();
});

// Copies of OpenCode's real docs pages (2026-10-12): Go repeats an indented price table per plan.
const example = (f: string) => readFileSync(path.join(import.meta.dir, "../example", f), "utf8");

test("opencode docs: the real Zen and Go pages read, every listed price row", () => {
  const go = new Map(opencodeDocRows(example("opencode-go.mdx")).map((r) => [r.model_name, r]));
  expect(go.size).toBe(32);
  expect(go.get("deepseek-v4-pro")).toMatchObject({ input_cost_per_1m_tokens: 1.32, offpeak: { input: 0.66 } });
  expect(go.get("qwen3.7-plus")!.tiers).toHaveLength(1);
  const zen = new Map(opencodeDocRows(example("opencode.mdx")).map((r) => [r.model_name, r]));
  expect(zen.size).toBe(88);
  expect(zen.get("deepseek-v4-pro")).toMatchObject({ input_cost_per_1m_tokens: 1.74, output_cost_per_1m_tokens: 3.48 });
});

test("opencode docs: plan tables that disagree on a price fail the list", () => {
  const go = example("opencode-go.mdx");
  const last = go.lastIndexOf("| DeepSeek V4 Pro (Peak)");
  const bad = go.slice(0, last) + go.slice(last).replace("$1.32", "$9.99");
  expect(() => opencodeDocRows(bad)).toThrow(/disagree/);
});

test("openrouter prices per token become USD per 1M tokens; a 0 cache price is none", () => {
  const ex = JSON.parse(readFileSync(path.join(import.meta.dir, "../example/engy.json"), "utf8"));
  const { rows, listed } = openrouterRows(ex);
  expect(listed).toEqual(["deepseek-v4-flash-0731", "deepseek-v4.1-flash", "deepseek-v4.1-flash-1017"]);
  expect(rows[0]!.input_cost_per_1m_tokens).toBeCloseTo(0.045, 12);
  expect(rows[0]!.output_cost_per_1m_tokens).toBeCloseTo(0.09, 12);
  expect(rows[0]!.cache_read_cost_per_1m_tokens).toBeCloseTo(0.009, 12);
  expect(rows[0]!.cache_write_cost_per_1m_tokens).toBeNull();
  expect(rows[0]!.context_length).toBe(1_048_576);
});

test("an empty openrouter list fails, so it never deletes every file", () => {
  expect(() => openrouterRows({ object: "list", data: [] })).toThrow();
});
