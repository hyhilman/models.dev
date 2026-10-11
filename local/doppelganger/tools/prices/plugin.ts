// The price jobs. An attached plugin cannot schedule yet, so this machine's crontab runs them:
//   * * * * *  ops-price-static   apply the static price feed
//   27 * * * * ops-price-sync     merge upstream models.dev
// See local/AGENTS.md for the crontab lines.
import { definePlugin, killSwitch } from "doppelganger/plugin";
import { defineJob } from "doppelganger/ports/job";
import { PRICES_ENV, runPriceTask } from "./run.ts";

const NO_STATIC = killSwitch("prices", "static", "1 stops ops-price-static, so the feed changes nothing");
const NO_SYNC = killSwitch("prices", "sync", "1 stops ops-price-sync, so upstream is not merged");

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
  description: "Merge upstream models.dev into the router branch; on a conflict or a failed check, move nothing",
  plugin: "prices",
  permissionMode: "auto",
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
  jobs: [opsPriceStatic, opsPriceSync],
  schedule: [],
  env: PRICES_ENV,
  dir: import.meta.dirname,
});
