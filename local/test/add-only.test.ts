// Our changes must stay out of every file upstream owns, so a merge from upstream never
// conflicts. This lists each path we changed since the fork point and fails on any outside
// the allowed list.
import { expect, test } from "bun:test";
import path from "node:path";
import { readFileSync } from "node:fs";
import { PATCH_MARK } from "../script/apply-static.ts";

const REPO = path.resolve(import.meta.dir, "../..");

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
};

const staticToml = () =>
  Bun.TOML.parse(readFileSync(path.join(REPO, "local/static.toml"), "utf8")) as { providers: string[]; patch?: string[] };

/** Providers the static feed writes. A `patch` one is upstream's, checked line by line below. */
function ownedProviders(): string[] {
  return staticToml().providers;
}

/** A file without our part: the price feed's comments and the [cost] table. */
export function withoutCost(text: string): string {
  const out: string[] = [];
  let inCost = false;
  for (const line of text.split("\n")) {
    if (line.startsWith(PATCH_MARK)) continue;
    // [cost], [cost.*] and [[cost.tiers]]: every cost table is the feed's.
    if (line.trim().startsWith("[")) inCost = /^\[\[?cost[\].]/.test(line.trim());
    if (!inCost) out.push(line);
  }
  return out.join("\n").trim();
}

/** Root files upstream does not have. `.gitignore` is upstream's, so it is checked apart: append only. */
const OUR_ROOT_FILES = ["CLAUDE.md", "doppelganger.toml", "doppelganger.config.ts"];

export function allowed(p: string, owned: readonly string[]): boolean {
  if (OUR_ROOT_FILES.includes(p) || p.startsWith("local/")) return true;
  return owned.some((o) => p.startsWith(`providers/${o}/`));
}

test("allowed paths", () => {
  expect(allowed("local/x.ts", ["sumopod"])).toBe(true);
  expect(allowed("CLAUDE.md", ["sumopod"])).toBe(true);
  expect(allowed("providers/sumopod/models/a.toml", ["sumopod"])).toBe(true);
  expect(allowed("providers/opencode-go/models/a.toml", ["sumopod"])).toBe(false);
  expect(allowed("AGENTS.md", ["sumopod"])).toBe(false);
  expect(allowed("doppelganger.toml", ["sumopod"])).toBe(true);
  expect(allowed("package.json", ["sumopod"])).toBe(false);
});

// Skips where there is no upstream remote (a fresh clone of the private repo).
const base = git("merge-base", "HEAD", "upstream/dev");

test.skipIf(!base.ok)("every change since the fork point is add-only", () => {
  const owned = ownedProviders();
  const changed = git("diff", "--name-only", base.out, "HEAD").out.split("\n").filter(Boolean);
  const bad = changed.filter((p) => p !== ".gitignore" && !allowed(p, owned));
  expect(bad).toEqual([]);
});

// In a patch provider the feed may change only [cost] and its own comments, and delete a model the
// provider no longer lists. It never adds a file: everything else is upstream's.
test.skipIf(!base.ok)("a patch provider differs from upstream only in [cost] and retired models", () => {
  const bad: string[] = [];
  for (const p of staticToml().patch ?? []) {
    const changed = git("diff", "--name-status", base.out, "HEAD", "--", `providers/${p}`).out.split("\n").filter(Boolean);
    for (const row of changed) {
      const [status, file] = row.split("\t") as [string, string];
      if (status === "D") continue;
      if (status !== "M") { bad.push(`${status} ${file}`); continue; }
      if (withoutCost(git("show", `${base.out}:${file}`).out) !== withoutCost(git("show", `HEAD:${file}`).out)) bad.push(file);
    }
  }
  expect(bad).toEqual([]);
});

test("withoutCost drops the feed's comments and [cost], and keeps the rest", () => {
  const a = 'base_model = "x/y"\n\n[cost]\ninput = 0\noutput = 0\n\n[limit]\ncontext = 1\n';
  const b = `${PATCH_MARK} hi\nbase_model = "x/y"\n\n[cost]\ninput = 2\noutput = 3\ncache_read = 1\n\n[limit]\ncontext = 1\n`;
  expect(withoutCost(a)).toBe(withoutCost(b));
  expect(withoutCost(a)).toBe(withoutCost(b.replace("\n[limit]", "[[cost.tiers]]\ntier = { type = \"context\", size = 1 }\ninput = 9\n\n[limit]")));
  expect(withoutCost(a)).not.toBe(withoutCost(b.replace("context = 1", "context = 2")));
});

// doppelganger init appends its ignore lines. Lines added at the end merge cleanly; an edited or
// removed upstream line would not.
test.skipIf(!base.ok)(".gitignore only gains lines", () => {
  const diff = git("diff", "--unified=0", base.out, "HEAD", "--", ".gitignore").out;
  const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
  expect(removed).toEqual([]);
});
