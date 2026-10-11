import { expect, test } from "bun:test";
import { dockerArgs, eventLines, fetchMinutes, GH_IN_CONTAINER, keys, type PriceRun, report } from "../doppelganger/tools/prices/run.ts";

const base: PriceRun = {
  task: "static",
  repo: "/home/u/models.dev",
  staticDir: "/home/u/.price-router/static",
  image: "tools:1",
  gitName: "n",
  gitEmail: "e@x",
  ghDir: null,
  push: false,
  dryRun: false,
  fetchMinutes: 10,
  keys: {},
};

const envOf = (args: string[]): string[] => args.flatMap((a, i) => (args[i - 1] === "-e" ? [a] : []));

test("the repo and the feed folder mount at their host paths; the feed is read-only", () => {
  const args = dockerArgs(base);
  expect(args).toContain(`${base.repo}:${base.repo}`);
  expect(args).toContain(`${base.staticDir}:${base.staticDir}:ro`);
  expect(args.slice(-4)).toEqual(["tools:1", "bash", "local/script/job.sh", "static"]);
});

test("a dry run never pushes, even with push on", () => {
  const env = envOf(dockerArgs({ ...base, push: true, dryRun: true }));
  expect(env).toContain("PRICE_DRY_RUN=1");
  expect(env).not.toContain("PRICE_PUSH=1");
});

test("push carries the flag; the gh login mounts read-only", () => {
  const args = dockerArgs({ ...base, push: true, ghDir: "/p/.doppelganger/creds/gh/me" });
  expect(envOf(args)).toContain("PRICE_PUSH=1");
  expect(args).toContain(`/p/.doppelganger/creds/gh/me:${GH_IN_CONTAINER}:ro`);
});

test("the fetch interval reaches the script, and a typo stops the job", () => {
  expect(envOf(dockerArgs(base))).toContain("PRICE_FETCH_MINUTES=10");
  expect(fetchMinutes(" 0 ")).toBe(0);
  expect(() => fetchMinutes("10m")).toThrow();
});

test("an API key reaches the container by name only, never by value", () => {
  const args = dockerArgs({ ...base, keys: keys({ DASHSCOPE_API_KEY: "sk-secret", OTHER: "" }) });
  expect(envOf(args)).toContain("DASHSCOPE_API_KEY");
  expect(envOf(args)).not.toContain("OTHER");
  expect(args.join(" ")).not.toContain("sk-secret");
});

test("only the scripts' event lines are kept", () => {
  expect(eventLines('bun noise\nevent=static.unchanged provider="x"\n$ git\n')).toEqual([
    'event=static.unchanged provider="x"',
  ]);
});

test("a report: changes every time, a failure once, and once more when it clears", () => {
  const applied = 'event=static.applied provider="kenari" write="2" delete="1" committed="1"';
  const retiredLine = 'event=static.retired provider="kenari" models="a.toml"';
  const r1 = report("static", [retiredLine, applied], null, {});
  expect(r1.body).toBe("💲 kenari: 2 file(s) written, 1 removed (a)");
  const err = 'event=fetch.error provider="alibaba" error="GET x: HTTP 500"';
  const r2 = report("static", [err], "x", r1.open);
  expect(r2.body).toBe("❌ alibaba fetch: GET x: HTTP 500\n❌ price static job failed: x");
  // The same failure next time: nothing new to say.
  expect(report("static", [err], "x", r2.open).body).toBeNull();
  const r3 = report("static", ['event=fetch.done provider="alibaba" rows="1" listed="1"'], null, r2.open);
  expect(r3.body).toBe("✅ alibaba fetch works again\n✅ price static job works again");
  expect(r3.open).toEqual({});
  expect(report("static", ['event=static.unchanged provider="x" models="1" skipped="0"'], null, {}).body).toBeNull();
});
