// The price jobs. The supervisor runs them on the schedule below (see "Scheduling" in local/AGENTS.md).
import { join } from "node:path";
import { definePlugin, killSwitch } from "doppelganger/plugin";
import { defineJob } from "doppelganger/ports/job";
import { PRICES_ENV, runPriceTask } from "./run.ts";

/** The repo's .doppelganger/logs, where the schedule writes each job's log. */
const LOGS = join(import.meta.dirname, "..", "..", "..", "..", ".doppelganger", "logs");

const NO_STATIC = killSwitch("prices", "static", "1 stops ops-price-static, so the feed changes nothing");
const NO_SYNC = killSwitch("prices", "sync", "1 stops ops-price-sync, so router is not rebased on upstream");

const opsPriceStatic = defineJob({
  name: "ops-price-static",
  description: "Apply the static price feed (one JSON per provider in local/static.toml) and commit the change",
  plugin: "prices",
  permissionMode: "auto",
  // Every minute, so its run lease is keyed on the minute: an hourly key would refuse 59 runs.
  leaseWindow: "minute",
  exec: async (ctx) => {
    if (ctx.env.str(NO_STATIC) === "1") {
      ctx.log.info("off", { reason: NO_STATIC.key });
      return;
    }
    await runPriceTask(ctx, "static");
  },
});

const opsPriceSync = defineJob({
  name: "ops-price-sync",
  description: "Rebase the router branch on upstream models.dev and write the prices again; on a conflict or a failed check, move nothing",
  plugin: "prices",
  permissionMode: "auto",
  // Every 15 minutes: the default hourly lease would allow one run an hour.
  leaseWindow: "minute",
  exec: async (ctx) => {
    if (ctx.env.str(NO_SYNC) === "1") {
      ctx.log.info("off", { reason: NO_SYNC.key });
      return;
    }
    await runPriceTask(ctx, "sync");
  },
});

export default definePlugin({
  name: "prices",
  kill: [NO_STATIC, NO_SYNC],
  sources: [],
  routes: [],
  trackers: [],
  steps: [],
  answerers: [],
  forges: [],
  jobs: [opsPriceStatic, opsPriceSync],
  schedule: [
    {
      name: "ops-price-static",
      job: "ops-price-static",
      cron: "* * * * *",
      log: join(LOGS, "ops-price-static.log"),
      why: "apply the static price feed and commit the change",
    },
    {
      name: "ops-price-sync",
      job: "ops-price-sync",
      // Every 15 minutes, off the quarter hours. ops-price-static takes the gate every minute, so
      // this waits for it instead of losing its slot.
      cron: "12,27,42,57 * * * *",
      gateWait: true,
      log: join(LOGS, "ops-price-sync.log"),
      why: "rebase router on upstream models.dev and write the prices again",
    },
  ],
  env: PRICES_ENV,
  dir: import.meta.dirname,
});
