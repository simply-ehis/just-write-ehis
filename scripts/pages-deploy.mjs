#!/usr/bin/env node
/**
 * Deploy the web app to just-write-ehis.pages.dev/app.
 *
 * The marketing page in `site/` owns the root of the `just-write-ehis`
 * Pages project, so the app has to be served from a sub-path: a
 * `--mode pages` Vite build emits every URL prefixed with `/app/`, and
 * this script stages the two together (landing at `/`, app at `/app/`)
 * before handing the directory to wrangler.
 *
 * `cf pages deploy` is a stub in the `cf` CLI — it refuses non-legacy
 * Pages projects and points at `cf deploy`, which only publishes Workers
 * — so wrangler is the tool that can reach this project's deployments API.
 *
 * Usage: npm run deploy:web
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = resolve(root, ".pages-deploy");
const appBuild = resolve(root, "dist");
const landing = resolve(root, "site");

const PROJECT = "just-write-ehis";

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true });
  if (res.status !== 0) {
    console.error(`\n${cmd} ${args.join(" ")} failed with exit code ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

if (!existsSync(landing)) {
  console.error(`Missing marketing page directory: ${landing}`);
  process.exit(1);
}

console.log("› building the app (base /app/)");
run("npx", ["vite", "build", "--mode", "pages"]);
if (!existsSync(resolve(appBuild, "index.html"))) {
  console.error(`Build produced no index.html in ${appBuild}`);
  process.exit(1);
}

console.log("› staging landing page + app");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(landing, staging, { recursive: true });
cpSync(appBuild, resolve(staging, "app"), { recursive: true });

console.log(`› deploying ${staging} to the ${PROJECT} Pages project`);
run("npx", [
  "wrangler",
  "pages",
  "deploy",
  staging,
  "--project-name",
  PROJECT,
  "--commit-dirty=true",
]);

console.log(`\nLive: https://${PROJECT}.pages.dev/app/`);
