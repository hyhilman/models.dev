import { expect, test } from "bun:test";
import path from "node:path";
import { readFileSync } from "node:fs";
import { render, StaticFile } from "../script/apply-static.ts";

const example = () =>
  JSON.parse(readFileSync(path.join(import.meta.dir, "../example/sumopod.json"), "utf8")) as Record<string, unknown>;

test("the example feed validates", () => {
  expect(StaticFile.safeParse(example()).success).toBe(true);
});

test("an unknown field fails", () => {
  expect(StaticFile.safeParse({ ...example(), surprise: 1 }).success).toBe(false);
});

test("a model id cannot climb out of the provider folder", () => {
  const feed = example();
  feed.models = [{ id: "../opencode-go/kimi-k3", base_model: "moonshotai/kimi-k3", cost: { input: 1, output: 1 } }];
  expect(StaticFile.safeParse(feed).success).toBe(false);
});

test("a feed without source or date fails", () => {
  const { source: _, ...rest } = example();
  expect(StaticFile.safeParse(rest).success).toBe(false);
});

test("render writes only inside the feed's own provider folder", () => {
  const files = render(StaticFile.parse(example()));
  for (const p of files.keys()) expect(p.startsWith("providers/sumopod/")).toBe(true);
  expect(files.get("providers/sumopod/models/kimi-k3.toml")).toContain("input = 3\noutput = 15");
});

test("a reasoning model with no options in the feed gets a peer's options", () => {
  const text = render(StaticFile.parse(example())).get("providers/sumopod/models/deepseek-v4-pro.toml")!;
  expect(text).toContain("[[reasoning_options]]");
  expect(text).toContain("# reasoning_options copied from providers/");
});

test("a base model with no lab file fails", () => {
  const feed = example();
  feed.models = [{ id: "x", base_model: "nobody/nothing", cost: { input: 1, output: 1 } }];
  expect(() => render(StaticFile.parse(feed))).toThrow(/has no file under models/);
});
