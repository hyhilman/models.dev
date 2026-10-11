// Fill the lab model id that upstream's site JSON leaves out for host entries with no base_model.
// local/aliases.toml names the lab model; this writes it as canonical_model_id (canonical_id in
// the v2 file) into a built site folder. Upstream's files stay as they are: only our copy of the
// site changes. An entry that already has an id keeps it.
//
// Run: bun local/script/fill-canonical.ts <site dir>   (publish-site.sh runs it before the swap)
import path from "node:path";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const REPO = path.resolve(import.meta.dir, "../..");

type Models = Record<string, Record<string, unknown>>;

/** Fill one parsed file. Returns how many entries it filled. */
export function fill(json: Record<string, unknown>, aliases: Record<string, string>, key: string): number {
  const providers = (json.providers ?? json) as Record<string, { models?: Models } | undefined>;
  let n = 0;
  for (const [entry, lab] of Object.entries(aliases)) {
    const [provider, ...rest] = entry.split("/");
    const model = providers[provider!]?.models?.[rest.join("/")];
    if (!model || model[key] !== undefined) continue;
    model[key] = lab;
    n++;
  }
  return n;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir || !existsSync(dir)) throw new Error("usage: fill-canonical.ts <site dir>");
  const aliases = Bun.TOML.parse(readFileSync(path.join(REPO, "local/aliases.toml"), "utf8")) as Record<string, string>;
  // A typo would name a lab model that does not exist; refuse it rather than publish it.
  const bad = Object.values(aliases).filter((lab) => !existsSync(path.join(REPO, "models", `${lab}.toml`)));
  if (bad.length > 0) throw new Error(`local/aliases.toml names lab models with no file: ${bad.join(", ")}`);
  let total = 0;
  for (const f of readdirSync(dir).filter((f) => /^_(api|catalog|experimental_v2[.\d]*_api).*\.json$/.test(f))) {
    const file = path.join(dir, f);
    const json = JSON.parse(readFileSync(file, "utf8"));
    const n = fill(json, aliases, f.startsWith("_experimental_v2") ? "canonical_id" : "canonical_model_id");
    if (n > 0) writeFileSync(file, JSON.stringify(json));
    total += n;
  }
  console.error(`event=site.canonical_filled entries=${total}`);
}
