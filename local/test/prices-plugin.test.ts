import { expect, test } from "bun:test";
import { dockerArgs, eventLines, fetchMinutes, GH_IN_CONTAINER, keys, type PriceRun } from "../doppelganger/tools/prices/run.ts";

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
