import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assetFetch } from "../script/serve.ts";

const dir = mkdtempSync(path.join(tmpdir(), "site-"));
mkdirSync(path.join(dir, "models"));
writeFileSync(path.join(dir, "_index.html"), "home");
writeFileSync(path.join(dir, "_api.json"), "{}");
writeFileSync(path.join(dir, "models", "index.html"), "models");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const get = (p: string) => assetFetch(dir, new Request(`http://x${p}`));

test("an exact file is served", async () => {
  expect(await (await get("/_api.json")).text()).toBe("{}");
});

test("a path without .html finds the .html file, as Cloudflare's assets do", async () => {
  expect(await (await get("/_index")).text()).toBe("home");
  expect(await (await get("/models/index")).text()).toBe("models");
});

test("a missing file is 404, so the worker can fall back", async () => {
  expect((await get("/nope.json")).status).toBe(404);
});

test("nothing outside the site folder is served", async () => {
  expect((await get("/%2e%2e/%2e%2e/etc/passwd")).status).toBe(404);
});
