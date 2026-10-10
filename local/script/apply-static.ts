// Apply the static price feed: one JSON file per provider, written by the owner.
//
// The feed may write only the providers listed in local/static.toml, and only inside
// providers/<provider>/. It never touches another provider, upstream-owned or not.
//
// Run: bun local/script/apply-static.ts
// Env: PRICE_STATIC_DIR  folder that holds <provider>.json (default ~/.price-router/static)
//      PRICE_DRY_RUN=1   print what would change, write nothing
//      PRICE_NO_COMMIT=1 write and validate, but do not commit
import path from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { z } from "../lib/deps.ts";
import { formatToml } from "../../packages/core/src/sync/index.ts";
import { ReasoningOption } from "../../packages/core/src/schema.ts";

const REPO = path.resolve(import.meta.dir, "../..");
const STATIC_DIR = process.env.PRICE_STATIC_DIR ?? path.join(process.env.HOME ?? "/tmp", ".price-router/static");
const DRY_RUN = process.env.PRICE_DRY_RUN === "1";
const NO_COMMIT = process.env.PRICE_NO_COMMIT === "1";

// A model id becomes a file path, so it must not climb out of the provider folder.
const ModelId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/)
  .refine((s) => !s.split("/").includes(".."), "must not contain ..");

const Price = z.number().nonnegative();

const Cost = z
  .object({
    input: Price,
    output: Price,
    cache_read: Price.optional(),
    cache_write: Price.optional(),
    reasoning: Price.optional(),
  })
  .strict();

const StaticModel = z
  .object({
    id: ModelId,
    base_model: z.string().regex(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/),
    cost: Cost,
    // Optional. When left out and the base model reasons, it is copied from a peer host.
    reasoning_options: z.array(ReasoningOption).optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  })
  .strict();

export const StaticFile = z
  .object({
    provider: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    api: z.string().url(),
    env: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1),
    doc: z.string().url().optional(),
    npm: z.string().default("@ai-sdk/openai-compatible"),
    // Hard rule: every price carries a source and the date it was checked.
    source: z.string().min(1),
    checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    models: z.array(StaticModel).min(1),
  })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const m of f.models) {
      if (seen.has(m.id)) ctx.addIssue({ code: "custom", message: `duplicate model id ${m.id}` });
      seen.add(m.id);
    }
  });
export type StaticFile = z.infer<typeof StaticFile>;

const Allow = z.object({ providers: z.array(z.string().regex(/^[a-z0-9-]+$/)) }).strict();

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
  <path d="M8 15c1 1.5 2.4 2 4 2 2.2 0 4-1 4-3s-2-2.6-4-3-4-1-4-3 1.8-3 4-3c1.6 0 3 .5 4 2"/>
</svg>
`;

const log = (event: string, fields: Record<string, string | number> = {}) =>
  console.error(
    [`event=${event}`, ...Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)].join(" "),
  );

function readToml(file: string): Record<string, unknown> {
  return Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".toml") ? [p] : [];
  });
}

/** The base model's `reasoning`, or null when the lab file is missing. */
function baseReasons(baseModel: string): boolean | null {
  const file = path.join(REPO, "models", `${baseModel}.toml`);
  if (!existsSync(file)) return null;
  return readToml(file).reasoning === true;
}

/** The lab model a host file stands for: its base_model, else its row in local/aliases.toml. */
function labOf(file: string, t: Record<string, unknown>, aliases: Record<string, string>): string | undefined {
  if (typeof t.base_model === "string") return t.base_model;
  const rel = path.relative(path.join(REPO, "providers"), file).replace(/\.toml$/, "");
  const [provider, , ...rest] = rel.split(path.sep);
  return aliases[`${provider}/${rest.join("/")}`];
}

/**
 * A relay copies the underlying model's controls from an established peer host. OpenCode Go
 * first, since it is a relay of the same kind; then the first other host with real controls.
 * An empty list is a last resort: it means "no caller control", which few hosts really mean.
 */
function peerReasoning(baseModel: string, self: string): { from: string; options: unknown[] } | null {
  const aliases = readToml(path.join(REPO, "local/aliases.toml")) as Record<string, string>;
  const providers = readdirSync(path.join(REPO, "providers"))
    .filter((p) => p !== self)
    .sort((a, b) => (a === "opencode-go" ? -1 : b === "opencode-go" ? 1 : a.localeCompare(b)));
  let empty: { from: string; options: unknown[] } | null = null;
  for (const p of providers) {
    for (const file of walk(path.join(REPO, "providers", p, "models"))) {
      const t = readToml(file);
      if (labOf(file, t, aliases) !== baseModel || !Array.isArray(t.reasoning_options)) continue;
      const hit = { from: path.relative(REPO, file), options: t.reasoning_options };
      if (t.reasoning_options.length > 0) return hit;
      empty ??= hit;
    }
  }
  return empty;
}

/** The files the feed wants under providers/<provider>/, keyed by repo-relative path. */
export function render(feed: StaticFile): Map<string, string> {
  const out = new Map<string, string>();
  const dir = `providers/${feed.provider}`;
  const header = [
    `# Static price feed: ${feed.source}, checked ${feed.checked}.`,
    "# Written by local/script/apply-static.ts. Edit the feed JSON, not this file.",
  ];

  const prov = [
    ...header,
    `name = ${JSON.stringify(feed.name)}`,
    `env = [${feed.env.map((e) => JSON.stringify(e)).join(", ")}]`,
    `npm = ${JSON.stringify(feed.npm)}`,
    `api = ${JSON.stringify(feed.api)}`,
    ...(feed.doc ? [`doc = ${JSON.stringify(feed.doc)}`] : []),
  ];
  out.set(`${dir}/provider.toml`, prov.join("\n") + "\n");

  for (const m of feed.models) {
    const reasons = baseReasons(m.base_model);
    if (reasons === null) throw new Error(`${m.id}: base_model ${m.base_model} has no file under models/`);
    let reasoning_options = m.reasoning_options;
    const notes: string[] = [];
    if (reasons && reasoning_options === undefined) {
      const peer = peerReasoning(m.base_model, feed.provider);
      if (peer === null) {
        throw new Error(`${m.id}: ${m.base_model} reasons, no peer host has reasoning_options; set them in the feed`);
      }
      reasoning_options = peer.options as typeof reasoning_options;
      notes.push(`# reasoning_options copied from ${peer.from}`);
    }
    const body = formatToml({
      base_model: m.base_model,
      ...(m.status ? { status: m.status } : {}),
      ...(reasons ? { reasoning_options } : {}),
      cost: m.cost,
    } as Parameters<typeof formatToml>[0]);
    out.set(`${dir}/models/${m.id}.toml`, [...header, ...notes, body.trimEnd()].join("\n") + "\n");
  }
  return out;
}

function git(args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
}

function apply(provider: string): "unchanged" | "changed" | "skipped" {
  const src = path.join(STATIC_DIR, `${provider}.json`);
  if (!existsSync(src)) {
    log("static.skip", { provider, reason: "no feed file", path: src });
    return "skipped";
  }
  const feed = StaticFile.parse(JSON.parse(readFileSync(src, "utf8")));
  if (feed.provider !== provider) throw new Error(`${src}: provider is ${feed.provider}, file name says ${provider}`);

  const want = render(feed);
  const dir = path.join(REPO, "providers", provider);
  const have = new Map<string, string>();
  for (const file of [path.join(dir, "provider.toml"), ...walk(path.join(dir, "models"))]) {
    if (existsSync(file)) have.set(path.relative(REPO, file), readFileSync(file, "utf8"));
  }

  const writes = [...want].filter(([p, text]) => have.get(p) !== text);
  const deletes = [...have.keys()].filter((p) => !want.has(p));
  const needLogo = !existsSync(path.join(dir, "logo.svg"));
  if (writes.length === 0 && deletes.length === 0 && !needLogo) {
    log("static.unchanged", { provider, models: feed.models.length });
    return "unchanged";
  }
  log("static.diff", { provider, write: writes.map(([p]) => p).join(","), delete: deletes.join(",") });
  if (DRY_RUN) return "changed";

  for (const [p, text] of writes) {
    mkdirSync(path.dirname(path.join(REPO, p)), { recursive: true });
    writeFileSync(path.join(REPO, p), text);
  }
  for (const p of deletes) rmSync(path.join(REPO, p));
  // A placeholder only. The owner may replace it; a later run never overwrites it.
  if (needLogo) writeFileSync(path.join(dir, "logo.svg"), LOGO);

  const v = Bun.spawnSync(["bun", "validate"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (v.exitCode !== 0) {
    // Put the provider folder back exactly as it was, so the service keeps the last good prices.
    git(["checkout", "--", `providers/${provider}`]);
    git(["clean", "-fdq", "--", `providers/${provider}`]);
    const err = (v.stderr.toString() + v.stdout.toString()).split("\n").filter(Boolean).slice(-15).join("\n");
    throw new Error(`bun validate failed, changes reverted:\n${err}`);
  }

  if (!NO_COMMIT) {
    git(["add", "-A", "--", `providers/${provider}`]);
    const c = git(["commit", "-q", "-m", `chore(prices): update ${provider} static prices (checked ${feed.checked})`]);
    if (!c.ok) throw new Error(`git commit failed: ${c.out}`);
  }
  log("static.applied", { provider, write: writes.length, delete: deletes.length, committed: NO_COMMIT ? 0 : 1 });
  return "changed";
}

if (import.meta.main) {
  const allow = Allow.parse(readToml(path.join(REPO, "local/static.toml")));
  let failed = 0;
  for (const provider of allow.providers) {
    try {
      apply(provider);
    } catch (e) {
      failed++;
      log("static.error", { provider, error: e instanceof Error ? e.message : String(e) });
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}
