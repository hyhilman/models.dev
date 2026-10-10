// Our changes must stay out of every file upstream owns, so a merge from upstream never
// conflicts. This lists each path we changed since the fork point and fails on any outside
// the allowed list.
import { expect, test } from "bun:test";
import path from "node:path";
import { readFileSync } from "node:fs";

const REPO = path.resolve(import.meta.dir, "../..");

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
};

/** Providers we own: the ones the static feed writes. */
function ownedProviders(): string[] {
  const t = Bun.TOML.parse(readFileSync(path.join(REPO, "local/static.toml"), "utf8")) as { providers: string[] };
  return t.providers;
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

// doppelganger init appends its ignore lines. Lines added at the end merge cleanly; an edited or
// removed upstream line would not.
test.skipIf(!base.ok)(".gitignore only gains lines", () => {
  const diff = git("diff", "--unified=0", base.out, "HEAD", "--", ".gitignore").out;
  const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
  expect(removed).toEqual([]);
});
