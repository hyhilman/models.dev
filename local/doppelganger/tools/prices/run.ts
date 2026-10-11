// One price job is one `docker run --rm` of the tools image over this repo. The work itself lives
// in local/script/job.sh; this file only builds the command and reports.
//
// The repo mounts at its host path, so git paths and log lines read the same inside and out. Run
// it on the rootless daemon (DOCKER_HOST): there container root is the host user, so files the job
// writes stay owned by that user.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EnvSpec } from "doppelganger/plugin";
import type { JobContext } from "doppelganger/ports/context";

export const PRICES_STATIC_DIR_ENV: EnvSpec = {
  key: "PRICES_STATIC_DIR",
  required: true,
  why: "host folder holding one <provider>.json static price feed per provider; mounted read-only",
};
export const PRICES_IMAGE_ENV: EnvSpec = {
  key: "PRICES_IMAGE",
  default: "models-dev-router-tools:bun1.3.0",
  why: "the tools image (pinned Bun, git, gh) built from local/docker/Dockerfile",
};
export const PRICES_GIT_NAME_ENV: EnvSpec = {
  key: "PRICES_GIT_NAME",
  default: "price-router",
  why: "author and committer name on the price jobs' commits",
};
export const PRICES_GIT_EMAIL_ENV: EnvSpec = {
  key: "PRICES_GIT_EMAIL",
  default: "price-router@localhost",
  why: "author and committer email on the price jobs' commits",
};
export const PRICES_GH_ENV: EnvSpec = {
  key: "PRICES_GH",
  default: "",
  why: "the .doppelganger/creds/gh/<name> login the price jobs push with; empty = no login, so a push can only fail",
};
export const PRICES_PUSH_ENV: EnvSpec = {
  key: "PRICES_PUSH",
  default: "0",
  why: "1 = push the router branch to origin after a job moves it; 0 keeps every commit local",
};
export const PRICES_DRY_RUN_ENV: EnvSpec = {
  key: "PRICES_DRY_RUN",
  default: "0",
  why: "1 = print what the feed would write and what upstream would merge; write, commit and push nothing",
};

export const PRICES_FETCH_MINUTES_ENV: EnvSpec = {
  key: "PRICES_FETCH_MINUTES",
  default: "10",
  why: "minutes between pulls of a published price list (a feed with [fetch], such as kenari); 0 = every run",
};

export const PRICES_DASHSCOPE_API_KEY_ENV: EnvSpec = {
  key: "PRICES_DASHSCOPE_API_KEY",
  default: "",
  secret: true,
  why: "Alibaba Model Studio API key for the alibaba price list; set it in doppelganger.secret.toml",
};
export const PRICES_DASHSCOPE_CN_API_KEY_ENV: EnvSpec = {
  key: "PRICES_DASHSCOPE_CN_API_KEY",
  default: "",
  secret: true,
  why: "Alibaba Model Studio China-region API key for the alibaba-cn price list; empty skips that feed",
};
export const PRICES_ALIBABA_TOKEN_PLAN_API_KEY_ENV: EnvSpec = {
  key: "PRICES_ALIBABA_TOKEN_PLAN_API_KEY",
  default: "",
  secret: true,
  why: "Alibaba Token Plan API key for the alibaba-token-plan model list; empty skips that feed",
};
export const PRICES_ALIBABA_TOKEN_PLAN_CN_API_KEY_ENV: EnvSpec = {
  key: "PRICES_ALIBABA_TOKEN_PLAN_CN_API_KEY",
  default: "",
  secret: true,
  why: "Alibaba Token Plan China-region API key for the alibaba-token-plan-cn model list; empty skips that feed",
};
export const PRICES_OPENCODE_API_KEY_ENV: EnvSpec = {
  key: "PRICES_OPENCODE_API_KEY",
  default: "",
  secret: true,
  why: "OpenCode Zen API key; the opencode feeds read the public lists, so it is unused for now",
};

export const PRICES_SUMOPOD_API_KEY_ENV: EnvSpec = {
  key: "PRICES_SUMOPOD_API_KEY",
  default: "",
  secret: true,
  why: "Sumopod API key for its model list (GET /v1/models); a static price whose model it no longer lists is dropped. Empty skips that feed",
};

/** Each feed's key: the env var the feed's key_env names, and the setting that holds it. */
export const KEY_ENVS: Readonly<Record<string, EnvSpec>> = {
  DASHSCOPE_API_KEY: PRICES_DASHSCOPE_API_KEY_ENV,
  DASHSCOPE_CN_API_KEY: PRICES_DASHSCOPE_CN_API_KEY_ENV,
  ALIBABA_TOKEN_PLAN_API_KEY: PRICES_ALIBABA_TOKEN_PLAN_API_KEY_ENV,
  ALIBABA_TOKEN_PLAN_CN_API_KEY: PRICES_ALIBABA_TOKEN_PLAN_CN_API_KEY_ENV,
  OPENCODE_API_KEY: PRICES_OPENCODE_API_KEY_ENV,
  SUMOPOD_API_KEY: PRICES_SUMOPOD_API_KEY_ENV,
};

export const PRICES_ENV: readonly EnvSpec[] = [
  PRICES_STATIC_DIR_ENV,
  PRICES_IMAGE_ENV,
  PRICES_GIT_NAME_ENV,
  PRICES_GIT_EMAIL_ENV,
  PRICES_GH_ENV,
  PRICES_PUSH_ENV,
  PRICES_DRY_RUN_ENV,
  PRICES_FETCH_MINUTES_ENV,
  ...Object.values(KEY_ENVS),
];

export type Task = "static" | "sync";

export interface PriceRun {
  readonly task: Task;
  readonly repo: string;
  readonly staticDir: string;
  readonly image: string;
  readonly gitName: string;
  readonly gitEmail: string;
  /** Host path of a gh login, or null for none. */
  readonly ghDir: string | null;
  readonly push: boolean;
  readonly dryRun: boolean;
  readonly fetchMinutes: number;
  /** API keys for the price lists, by the env var the feed names. */
  readonly keys: Readonly<Record<string, string>>;
}

/** In-container path of the gh login. Read-only: the job uses the token, never writes the login. */
export const GH_IN_CONTAINER = "/gh";

export function dockerArgs(p: PriceRun): string[] {
  // HOME points at a throwaway folder: Bun keeps its install cache there.
  const args = ["run", "--rm", "-v", `${p.repo}:${p.repo}`, "-w", p.repo, "-e", "HOME=/tmp"];
  args.push("-v", `${p.staticDir}:${p.staticDir}:ro`, "-e", `PRICE_STATIC_DIR=${p.staticDir}`);
  for (const k of ["AUTHOR", "COMMITTER"]) {
    args.push("-e", `GIT_${k}_NAME=${p.gitName}`, "-e", `GIT_${k}_EMAIL=${p.gitEmail}`);
  }
  if (p.dryRun) args.push("-e", "PRICE_DRY_RUN=1");
  args.push("-e", `PRICE_FETCH_MINUTES=${p.fetchMinutes}`);
  // By name only: docker reads the value from its own env, so a key never shows in `ps`.
  for (const k of Object.keys(p.keys).sort()) args.push("-e", k);
  // A dry run never pushes, whatever PRICES_PUSH says.
  if (p.push && !p.dryRun) args.push("-e", "PRICE_PUSH=1");
  if (p.ghDir !== null) args.push("-v", `${p.ghDir}:${GH_IN_CONTAINER}:ro`, "-e", `GH_CONFIG_DIR=${GH_IN_CONTAINER}`);
  args.push(p.image, "bash", "local/script/job.sh", p.task);
  return args;
}

/** A whole number of minutes, 0 or more. Anything else is a typo, so it stops the job. */
export function fetchMinutes(v: string): number {
  if (!/^\d+$/.test(v.trim())) throw new Error(`PRICES_FETCH_MINUTES must be a whole number of minutes, got "${v}"`);
  return Number(v.trim());
}

/** The keys that are set. An empty one is left out, so the feed says plainly that it has none. */
export const keys = (all: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(all).filter(([, v]) => v !== ""));

export function priceRun(ctx: JobContext, task: Task): PriceRun {
  const gh = ctx.env.str(PRICES_GH_ENV).trim();
  return {
    task,
    repo: ctx.root,
    staticDir: ctx.env.str(PRICES_STATIC_DIR_ENV).trim(),
    image: ctx.env.str(PRICES_IMAGE_ENV),
    gitName: ctx.env.str(PRICES_GIT_NAME_ENV),
    gitEmail: ctx.env.str(PRICES_GIT_EMAIL_ENV),
    ghDir: gh === "" ? null : ctx.path(".doppelganger", "creds", "gh", gh),
    push: ctx.env.str(PRICES_PUSH_ENV) === "1",
    dryRun: ctx.env.str(PRICES_DRY_RUN_ENV) === "1",
    fetchMinutes: fetchMinutes(ctx.env.str(PRICES_FETCH_MINUTES_ENV)),
    keys: keys(Object.fromEntries(Object.entries(KEY_ENVS).map(([k, spec]) => [k, ctx.env.str(spec).trim()]))),
  };
}

/** The scripts' own logfmt lines, which carry the result. Bun's and git's noise is left out. */
export const eventLines = (out: string): string[] => out.split("\n").filter((l) => l.startsWith("event="));

/** One logfmt event line: `event=static.applied provider="x" write="4"`. */
export function parseEvent(line: string): { name: string; f: Record<string, string> } {
  const name = line.match(/^event=(\S+)/)?.[1] ?? "";
  const f: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
    if (m[1] !== "event") f[m[1]!] = m[2]!.startsWith('"') ? JSON.parse(m[2]!) : m[2]!;
  }
  return { name, f };
}

/** Open problems by key ("fetch:kenari"), so a failure is reported once, and again when it clears. */
export type Alerts = Record<string, string>;

const short = (names: string, n = 8): string => {
  const all = names.split(",").map((x) => x.replace(/\.toml$/, ""));
  return all.length <= n ? all.join(", ") : `${all.slice(0, n).join(", ")} +${all.length - n} more`;
};

/**
 * The ntfy report for one run, and the open problems after it. A change (a price, a new or
 * removed model) is reported with its diff; a plain upstream merge is not reported, a failed one is; a failure only when it is new or its message
 * changed, and once more when it clears. A run with neither sends nothing.
 */
export function report(task: Task, lines: readonly string[], failed: string | null, open: Alerts): { body: string | null; open: Alerts } {
  const ev = lines.map(parseEvent);
  const next: Alerts = { ...open };
  const out: string[] = [];
  const fail = (key: string, what: string) => {
    if (next[key] !== what) out.push(`❌ ${what}`);
    next[key] = what;
  };
  const clear = (key: string, what: string) => {
    if (next[key] === undefined) return;
    delete next[key];
    out.push(`✅ ${what} works again`);
  };
  // What changed per provider, one line per model: a price diff, a new model, a removed one.
  const changes = new Map<string, string[]>();
  for (const e of ev) {
    if (e.name !== "static.change") continue;
    const what = e.f.kind === "price" ? e.f.diff : e.f.kind === "new" ? "new" : "removed";
    changes.set(e.f.provider!, [...(changes.get(e.f.provider!) ?? []), `${e.f.model}: ${what}`]);
  }
  for (const e of ev) {
    const p = e.f.provider ?? "";
    if (e.name === "fetch.error") fail(`fetch:${p}`, `${p} fetch: ${e.f.error}`);
    else if (e.name === "fetch.done") clear(`fetch:${p}`, `${p} fetch`);
    else if (e.name === "static.error") fail(`static:${p}`, `${p} apply: ${(e.f.error ?? "").split("\n")[0]}`);
    else if (e.name === "static.unchanged") clear(`static:${p}`, `${p} apply`);
    else if (e.name === "static.applied") {
      clear(`static:${p}`, `${p} apply`);
      // A write that changed no price (a date, a rate comment) says nothing.
      const c = changes.get(p) ?? [];
      if (c.length > 0) out.push(`💲 ${p}\n${c.slice(0, 10).join("\n")}${c.length > 10 ? `\n+${c.length - 10} more` : ""}`);
    } else if (e.name === "sync.took_upstream") out.push(`↩️ upstream's files kept on a conflict: ${short(e.f.files ?? "")}`);
    else if (e.name === "sync.conflict" || e.name === "sync.check_failed") fail("sync", `upstream merge: ${e.name === "sync.conflict" ? `conflict in ${short(e.f.files ?? "")}` : `check failed at ${e.f.step}`}`);
    else if (e.name === "sync.unchanged") clear("sync", "upstream merge");
    else if (e.name === "site.canonical") {
      if (e.f.missing) fail("canonical", `no canonical id: ${short(e.f.missing)}`);
      else clear("canonical", "canonical id check");
    }
  }
  if (failed !== null) fail(`job:${task}`, `price ${task} job failed: ${failed}`);
  else clear(`job:${task}`, `price ${task} job`);
  if (task === "sync" && failed === null && !ev.some((e) => e.name === "sync.conflict" || e.name === "sync.check_failed")) clear("sync", "upstream merge");
  return { body: out.length > 0 ? out.join("\n") : null, open: next };
}

const alertsPath = (root: string) => path.join(root, "local/.feeds/alerts.json");

function readAlerts(root: string): Alerts {
  try {
    return existsSync(alertsPath(root)) ? (JSON.parse(readFileSync(alertsPath(root), "utf8")) as Alerts) : {};
  } catch {
    return {};
  }
}

function writeAlerts(root: string, a: Alerts): void {
  const p = alertsPath(root);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(`${p}.new`, JSON.stringify(a, null, 1) + "\n");
  renameSync(`${p}.new`, p);
}

export async function runPriceTask(ctx: JobContext, task: Task): Promise<void> {
  const run = priceRun(ctx, task);
  ctx.log.info("start", { task, dryRun: run.dryRun });
  const r = ctx.runIn(ctx.root, "docker", dockerArgs(run), { ...run.keys });
  const events = eventLines(r.out);
  for (const line of events) ctx.log.raw(line);
  // No event line means the container never reached the script: a missing image, a bad mount.
  const tail = r.ok ? null : events.length > 0 ? events.at(-1)! : r.out.trim().split("\n").slice(-3).join(" | ");
  if (!run.dryRun) {
    const { body, open } = report(task, events, tail, readAlerts(ctx.root));
    // Saved before the send: a failed send must not repeat the same report every minute.
    writeAlerts(ctx.root, open);
    if (body !== null) {
      const sent = await ctx.notify(`models.dev router\n${body}`);
      if (!sent.ok) ctx.log.warn("notify-failed", { task });
    }
  }
  if (tail !== null) {
    ctx.log.error("job-failed", { task, msg: tail });
    throw new Error(`price ${task} failed: ${tail}`);
  }
  ctx.log.info("done", { task, dryRun: run.dryRun });
}
