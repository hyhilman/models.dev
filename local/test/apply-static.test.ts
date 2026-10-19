import { expect, test } from "bun:test";
import path from "node:path";
import { readFileSync } from "node:fs";
import { ADDED_MARK, baseModelOf, costDiff, Feed, PriceList, render, renderPatch, tidy } from "../script/apply-static.ts";

const example = () =>
  JSON.parse(readFileSync(path.join(import.meta.dir, "../example/sumopod.json"), "utf8")) as Record<string, unknown>[];
const feed = () =>
  Feed.parse(Bun.TOML.parse(readFileSync(path.join(import.meta.dir, "../feeds/sumopod.toml"), "utf8")));
const rendered = () => render("sumopod", feed(), PriceList.parse(example()), "2026-10-10");

test("the example list and the sumopod feed validate", () => {
  expect(PriceList.safeParse(example()).success).toBe(true);
  expect(Feed.safeParse(Bun.TOML.parse(readFileSync(path.join(import.meta.dir, "../feeds/sumopod.toml"), "utf8"))).success).toBe(true);
});

test("a model name cannot climb out of the provider folder", () => {
  const row = { ...example()[0], model_name: "../opencode-go/kimi-k3" };
  expect(PriceList.safeParse([row]).success).toBe(false);
});

test("a duplicate model name fails", () => {
  expect(PriceList.safeParse([example()[0], example()[0]]).success).toBe(false);
});

test("float noise is rounded away", () => {
  expect(tidy(0.09999999999999999)).toBe(0.1);
  expect(tidy(0.0038499999999999997)).toBe(0.00385);
});

test("a name matches its lab file without the route prefix or the host suffix", () => {
  const idx = new Map([
    ["deepseek-v4.1-flash", ["deepseek/deepseek-v4.1-flash"]],
    ["gemini-3-flash-preview", ["google/gemini-3-flash-preview"]],
    ["twice", ["a/twice", "b/twice"]],
  ]);
  const f = feed();
  expect(baseModelOf("deepseek-v4.1-flash:netra", f, idx)).toBe("deepseek/deepseek-v4.1-flash");
  expect(baseModelOf("gemini/gemini-3-flash-preview", f, idx)).toBe("google/gemini-3-flash-preview");
  expect(baseModelOf("twice", f, idx)).toBeNull();
  expect(baseModelOf("nothing", f, idx)).toBeNull();
  expect(baseModelOf("twice", { ...f, map: { twice: "a/twice" } }, idx)).toBe("a/twice");
});

test("render writes only inside the provider folder, and skips what it cannot match", () => {
  const { files, skipped } = rendered();
  for (const p of files.keys()) expect(p.startsWith("providers/sumopod/")).toBe(true);
  expect(skipped.map((s) => s.model)).toEqual(["seed-2-0-mini"]);
  expect(files.get("providers/sumopod/models/gpt-4.1-mini.toml")).toContain("input = 0.4\noutput = 1.6\ncache_read = 0.1");
  expect(files.has("providers/sumopod/models/gemini/gemini-3-flash-preview.toml")).toBe(true);
});

test("a reasoning model gets a peer's reasoning_options", () => {
  const text = rendered().files.get("providers/sumopod/models/deepseek-v4.1-flash:netra.toml")!;
  expect(text).toContain("[[reasoning_options]]");
  expect(text).toContain("# reasoning_options copied from providers/opencode-go/");
});

test("a v2 lab model that reasons gets a peer's reasoning_options too", () => {
  const row = { model_name: "claude-opus-4-8", provider: "anthropic", input_cost_per_1m_tokens: 5, output_cost_per_1m_tokens: 25, cache_read_cost_per_1m_tokens: 0.5, context_length: 1000000 };
  const { files, skipped } = render("sumopod", feed(), PriceList.parse([row]), "2026-10-19");
  expect(skipped).toEqual([]);
  expect(files.get("providers/sumopod/models/claude-opus-4-8.toml")).toContain("[[reasoning_options]]");
});

test("a patch feed adds a whole file of ours for a priced model upstream has none for", () => {
  const row = { model_name: "deepseek-v4.1-flash-1017", provider: "deepseek", input_cost_per_1m_tokens: 1, output_cost_per_1m_tokens: 2, cache_read_cost_per_1m_tokens: null, context_length: 0 };
  const p = "providers/alibaba-token-plan/models/deepseek-v4.1-flash-1017.toml";
  const { files, skipped } = renderPatch("alibaba-token-plan", feed(), PriceList.parse([row]), "2026-10-19", "", new Map());
  expect(skipped).toEqual([]);
  const text = files.get(p)!;
  expect(text.startsWith(ADDED_MARK)).toBe(true);
  expect(text).toContain('base_model = "deepseek/deepseek-v4.1-flash-1017"');
  expect(text).toContain("[[reasoning_options]]");
  // Next run: the file is ours, so it is written again whole, not patched.
  const again = renderPatch("alibaba-token-plan", feed(), PriceList.parse([row]), "2026-10-20", "", new Map([[p, text]]));
  expect(again.files.get(p)!.split("\n").slice(1).join("\n")).toBe(text.split("\n").slice(1).join("\n"));
});

test("sumopod keeps its prices in the static list and reads the live list only to drop models", () => {
  const f = feed().fetch!;
  expect(f.static_prices).toBe(true);
  expect(f.format).toBe("models");
  const bad = { ...feed(), fetch: { ...f, format: "kenari" } };
  expect(Feed.safeParse(bad).success).toBe(false);
});

test("costDiff names only what changed, and nothing for an equal cost", () => {
  expect(costDiff({ input: 2, output: 8 }, { input: 2.5, output: 8 })).toBe("input 2→2.5");
  expect(costDiff({ input: 2, output: 8 }, { input: 2, output: 8 })).toBe("");
  expect(costDiff({ input: 2, output: 8, cache_read: 0.2 }, { input: 2, output: 8 })).toBe("cache_read 0.2→-");
  expect(costDiff({ input: 1, output: 2 }, { input: 1, output: 2, tiers: [{}] })).toBe("tiers or off-peak");
});
