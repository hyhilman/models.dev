import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalOf, fillSite, labIndex } from "../script/canonical.ts";

const root = mkdtempSync(path.join(tmpdir(), "canonical-"));
const site = path.join(root, "site");
afterAll(() => rmSync(root, { recursive: true, force: true }));

for (const lab of ["deepseek/deepseek-v4-pro", "minimax/MiniMax-M2.7", "a/twin", "b/twin", "google/gemini-3-flash-preview"]) {
  mkdirSync(path.join(root, "models", path.dirname(lab)), { recursive: true });
  writeFileSync(path.join(root, "models", `${lab}.toml`), 'name = "x"\n');
}
mkdirSync(path.join(root, "local"), { recursive: true });
mkdirSync(site);
writeFileSync(path.join(root, "local/static.toml"), 'providers = ["go"]\n');
writeFileSync(path.join(root, "local/aliases.toml"), '"go/gemini-3-flash" = "google/gemini-3-flash-preview"\n');
writeFileSync(path.join(root, "local/house-models.toml"), 'models = ["go/big-pickle"]\n');

const models = () => ({
  "deepseek-v4-pro": { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  "minimax-m2.7": { id: "minimax-m2.7" },
  "gemini-3-flash": { id: "gemini-3-flash" },
  twin: { id: "twin" },
  "big-pickle": { id: "big-pickle" },
  kept: { id: "kept", canonical_model_id: "x/kept", canonical_id: "x/kept" },
});
writeFileSync(path.join(site, "_api.json"), JSON.stringify({ go: { models: models() }, other: { models: models() } }));
writeFileSync(path.join(site, "_catalog-chat.json"), JSON.stringify({ providers: { go: { models: models() } }, models: {} }));
writeFileSync(path.join(site, "_experimental_v2.0_api.json"), JSON.stringify({ go: { models: models() } }));
writeFileSync(path.join(site, "_models.json"), "{}");

const result = fillSite(site, root);
const read = (f: string) => JSON.parse(readFileSync(path.join(site, f), "utf8"));

test("a lab file named like the model fills the id, ignoring case and a host suffix", () => {
  const idx = labIndex(path.join(root, "models"));
  expect(canonicalOf("go", "deepseek-v4-pro:netra", idx, {})).toBe("deepseek/deepseek-v4-pro");
  expect(read("_api.json").go.models["minimax-m2.7"].canonical_model_id).toBe("minimax/MiniMax-M2.7");
});

test("an alias wins over the name", () => {
  expect(read("_api.json").go.models["gemini-3-flash"].canonical_model_id).toBe("google/gemini-3-flash-preview");
});

test("two matches or none fills nothing; only a model not in house-models.toml counts as missing", () => {
  const go = read("_api.json").go.models;
  expect(go.twin.canonical_model_id).toBeUndefined();
  expect(go["big-pickle"].canonical_model_id).toBeUndefined();
  expect([...result.missing]).toEqual(["go/twin"]);
});

test("an id upstream set is kept", () => {
  expect(read("_api.json").go.models.kept.canonical_model_id).toBe("x/kept");
});

test("only providers in local/static.toml change", () => {
  expect(read("_api.json").other.models["deepseek-v4-pro"].canonical_model_id).toBeUndefined();
});

test("the catalog and v2 files get the id too, v2 under its own key, right after id", () => {
  expect(read("_catalog-chat.json").providers.go.models["deepseek-v4-pro"].canonical_model_id).toBe("deepseek/deepseek-v4-pro");
  const v2 = read("_experimental_v2.0_api.json").go.models["deepseek-v4-pro"];
  expect(Object.keys(v2)).toEqual(["id", "canonical_id", "name"]);
  expect(result.files).toBe(3);
});

test("an alias that points at no lab file fails the build", () => {
  writeFileSync(path.join(root, "local/aliases.toml"), '"go/x" = "nope/x"\n');
  expect(() => fillSite(site, root)).toThrow("no lab file");
});
