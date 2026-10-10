// Serve the built site the way models.dev serves it, on this machine.
//
// It runs upstream's own Cloudflare Worker (packages/function/src/worker.ts), so every route
// matches the real site: /api.json?type=, /models.json, /catalog.json, /model-schema.json, the
// HTML pages and the logo fallback. Only ASSETS is ours: it reads files from SITE_DIR.
//
// Env: SITE_DIR   the published copy of packages/web/dist (default local/.site)
//      SITE_HOST  default 0.0.0.0, so other machines on the network can reach it
//      SITE_PORT  default 7311
import path from "node:path";
import worker from "../../packages/function/src/worker.ts";

const REPO = path.resolve(import.meta.dir, "../..");
const SITE_DIR = path.resolve(process.env.SITE_DIR ?? path.join(REPO, "local/.site"));
const HOST = process.env.SITE_HOST ?? "0.0.0.0";
const PORT = Number(process.env.SITE_PORT ?? 7311);

/** Cloudflare's asset binding, from files: an exact file, else the same path plus .html. */
export async function assetFetch(dir: string, request: Request): Promise<Response> {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const file = path.resolve(dir, "." + pathname);
  // Never serve outside the site folder.
  if (file !== dir && !file.startsWith(dir + path.sep)) return new Response("Not Found", { status: 404 });
  for (const candidate of [file, `${file}.html`]) {
    const f = Bun.file(candidate);
    if ((await f.exists()) && !candidate.endsWith(path.sep)) {
      return new Response(f, { headers: { "Access-Control-Allow-Origin": "*" } });
    }
  }
  return new Response("Not Found", { status: 404 });
}

const env = {
  ASSETS: { fetch: (r: Request) => assetFetch(SITE_DIR, r) },
  // The worker posts analytics to upstream's PostHog and Lake for opencode and bun user agents.
  // We strip the user agent below, so these are never read.
  PosthogToken: "",
  LakeEndpoint: "",
  LakeToken: "",
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

if (import.meta.main) {
  Bun.serve({
    hostname: HOST,
    port: PORT,
    fetch(request) {
      const headers = new Headers(request.headers);
      headers.delete("user-agent");
      return worker.fetch(new Request(request, { headers }), env as never, ctx as never);
    },
  });
  console.error(`event=site.listening host=${HOST} port=${PORT} dir=${JSON.stringify(SITE_DIR)}`);
}
