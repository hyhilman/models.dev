import { expect, test } from "bun:test";
import { kenariRows, rateDate } from "../script/fetch-feeds.ts";
import { patchCost, PATCH_MARK } from "../script/apply-static.ts";

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
  expect(patchCost(up + "\n[[cost.tiers]]\ninput = 1\n", { input: 1, output: 2 }, [])).toBeNull();
});
