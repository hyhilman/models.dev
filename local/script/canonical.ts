// Fill the canonical model id upstream leaves out, in the built site.
//
// The generator sets canonical_model_id (v2: canonical_id) only from base_model, and many of
// upstream's files in our providers have none (opencode-go/deepseek-v4-pro, most of OpenCode Zen).
// Their APIs carry no lab either, so nothing upstream can fill it. We may not edit those files
// (add-only), so this step fills the id in the built JSON instead, for the providers in
// local/static.toml only:
//
// - local/aliases.toml wins: "<provider>/<model>" = "<lab>/<model>".
// - Else the one lab file named like the model, ignoring case and a host suffix (`:netra`).
//   Two matches or none is no answer.
//
// Any model still without an id, unless local/house-models.toml lists it (no lab model behind
// it), is logged as `missing`, and the price plugin sends an alert.
//
// Usage: bun local/script/canonical.ts <site dir>
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "../..");

const readToml = (file: string) => Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".toml") ? [p] : [];
  });
}

/** Lab ids by lower-case file name: "minimax-m2.7" -> ["minimax/MiniMax-M2.7"]. */
export function labIndex(modelsDir = path.join(REPO, "models")): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const file of walk(modelsDir)) {
    const id = path.relative(modelsDir, file).replace(/\.toml$/, "").split(path.sep).join("/");
    const key = id.split("/").at(-1)!.toLowerCase();
    idx.set(key, [...(idx.get(key) ?? []), id]);
  }
  return idx;
}

export function canonicalOf(
  provider: string,
  model: string,
  idx: Map<string, string[]>,
  aliases: Record<string, string>,
): string | undefined {
  const alias = aliases[`${provider}/${model}`];
  if (alias) return alias;
  const hits = idx.get(model.split("/").at(-1)!.split(":")[0]!.toLowerCase()) ?? [];
  return hits.length === 1 ? hits[0] : undefined;
}

type Models = Record<string, Record<string, unknown>>;
type Providers = Record<string, { models?: Models }>;

/** Put the key right after `id`, where the generator puts it. */
function withKey(model: Record<string, unknown>, key: string, value: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(model)) {
    out[k] = v;
    if (k === "id") out[key] = value;
  }
  if (!(key in out)) out[key] = value;
  return out;
}

/** Fill the missing ids in one provider map. Returns the "<provider>/<model>" ids it filled. */
export function fill(
  providers: Providers,
  key: string,
  listed: readonly string[],
  idx: Map<string, string[]>,
  aliases: Record<string, string>,
): string[] {
  const filled: string[] = [];
  for (const p of listed) {
    const models = providers[p]?.models;
    if (!models) continue;
    for (const [id, model] of Object.entries(models)) {
      if (model[key] !== undefined) continue;
      const lab = canonicalOf(p, id, idx, aliases);
      if (!lab) continue;
      models[id] = withKey(model, key, lab);
      filled.push(`${p}/${id}`);
    }
  }
  return filled;
}

/** Every built JSON that carries provider models, with where they sit and the key name. */
const TARGETS: { match: RegExp; providers: (d: any) => Providers; key: string }[] = [
  { match: /^_api(-[a-z]+)?\.json$/, providers: (d) => d, key: "canonical_model_id" },
  { match: /^_catalog(-[a-z]+)?\.json$/, providers: (d) => d.providers, key: "canonical_model_id" },
  { match: /^_experimental_v2\.0_api\.json$/, providers: (d) => d, key: "canonical_id" },
];

export function fillSite(dir: string, root = REPO): { files: number; filled: Set<string>; missing: Set<string> } {
  const listed = (readToml(path.join(root, "local/static.toml")).providers as string[]) ?? [];
  const aliases = readToml(path.join(root, "local/aliases.toml")) as Record<string, string>;
  const house = new Set((readToml(path.join(root, "local/house-models.toml")).models as string[]) ?? []);
  const idx = labIndex(path.join(root, "models"));
  const known = new Set([...idx.values()].flat());
  for (const [k, lab] of Object.entries(aliases)) {
    if (!known.has(lab)) throw new Error(`local/aliases.toml: ${k} points at ${lab}, which has no lab file`);
  }
  let files = 0;
  const filled = new Set<string>();
  const missing = new Set<string>();
  for (const name of readdirSync(dir)) {
    const target = TARGETS.find((t) => t.match.test(name));
    if (!target) continue;
    const file = path.join(dir, name);
    const data = JSON.parse(readFileSync(file, "utf8"));
    const providers = target.providers(data);
    const done = fill(providers, target.key, listed, idx, aliases);
    for (const p of listed) {
      for (const [id, m] of Object.entries(providers[p]?.models ?? {})) {
        if (m[target.key] === undefined && !house.has(`${p}/${id}`)) missing.add(`${p}/${id}`);
      }
    }
    if (done.length === 0) continue;
    writeFileSync(file, JSON.stringify(data));
    files++;
    done.forEach((d) => filled.add(d));
  }
  return { files, filled, missing };
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: bun local/script/canonical.ts <site dir>");
  const { files, filled, missing } = fillSite(path.resolve(dir));
  console.error(`event=site.canonical files=${files} filled=${filled.size} missing=${JSON.stringify([...missing].sort().join(","))}`);
}
