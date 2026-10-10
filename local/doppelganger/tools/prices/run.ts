// One price job is one `docker run --rm` of the tools image over this repo. The work itself lives
// in local/script/job.sh; this file only builds the command and reports.
//
// The repo mounts at its host path, so git paths and log lines read the same inside and out. Run
// it on the rootless daemon (DOCKER_HOST): there container root is the host user, so files the job
// writes stay owned by that user.
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

export const PRICES_ENV: readonly EnvSpec[] = [
  PRICES_STATIC_DIR_ENV,
  PRICES_IMAGE_ENV,
  PRICES_GIT_NAME_ENV,
  PRICES_GIT_EMAIL_ENV,
  PRICES_GH_ENV,
  PRICES_PUSH_ENV,
  PRICES_DRY_RUN_ENV,
  PRICES_FETCH_MINUTES_ENV,
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
  };
}

/** The scripts' own logfmt lines, which carry the result. Bun's and git's noise is left out. */
export const eventLines = (out: string): string[] => out.split("\n").filter((l) => l.startsWith("event="));

export function runPriceTask(ctx: JobContext, task: Task): void {
  const run = priceRun(ctx, task);
  ctx.log.info("start", { task, dryRun: run.dryRun });
  const r = ctx.runIn(ctx.root, "docker", dockerArgs(run));
  const events = eventLines(r.out);
  for (const line of events) ctx.log.raw(line);
  if (!r.ok) {
    // No event line means the container never reached the script: a missing image, a bad mount.
    const tail = events.length > 0 ? events.at(-1)! : r.out.trim().split("\n").slice(-3).join(" | ");
    ctx.log.error("job-failed", { task, msg: tail });
    throw new Error(`price ${task} failed: ${tail}`);
  }
  ctx.log.info("done", { task, dryRun: run.dryRun });
}
