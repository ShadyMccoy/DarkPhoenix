#!/usr/bin/env ts-node
/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * deploy-code - push the TESTED bundle (webpack's dist/main.js) to the live
 * game via the Screeps code API.
 *
 * Why not `npm run push-main` (rollup): the rollup pipeline re-bundles src/
 * with its own TS plugin - a SECOND bundler that can (and in this container
 * does) fail independently of the webpack build every test measured. Deploying
 * dist/main.js deploys exactly the artifact `npm run build` produced and the
 * grid/integration suites ran. One bundler, one truth.
 *
 * Pushes to the account's ACTIVE world branch by default (queried live -
 * screeps.sample.json's hardcoded "main" is not the active branch on this
 * account; "master" is). Override with --branch <name>.
 *
 * Usage:
 *   npm run build && SCREEPS_TOKEN=... npm run deploy
 *   SCREEPS_TOKEN=... npm run deploy -- --branch sim
 */
import { spawnSync } from "child_process";
import { readFileSync } from "fs";

declare const fetch: (url: string, init?: any) => Promise<any>;

/** Same proxy re-exec dance as capture-telemetry (undici ignores env proxies otherwise). */
function ensureFetchUsesProxy(): void {
  const proxied = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!proxied || process.env.NODE_USE_ENV_PROXY === "1") return;
  const result = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" }
  });
  process.exit(result.status ?? 1);
}
ensureFetchUsesProxy();

const API = process.env.SCREEPS_API_URL ?? "https://screeps.com/api";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function api(path: string, init: any = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "X-Token": process.env.SCREEPS_TOKEN ?? "", "Content-Type": "application/json", ...init.headers }
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.ok !== 1) throw new Error(`${path} -> ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function main(): Promise<void> {
  if (!process.env.SCREEPS_TOKEN) {
    console.error("SCREEPS_TOKEN is required (full-access token).");
    process.exit(1);
  }
  const code = readFileSync("dist/main.js", "utf8");

  let branch = arg("branch");
  if (!branch) {
    const branches = await api("/user/branches");
    branch = (branches.list as any[]).find(b => b.activeWorld)?.branch;
    if (!branch) throw new Error("no activeWorld branch found - pass --branch explicitly");
  }

  console.log(`deploying dist/main.js (${(code.length / 1024).toFixed(0)}K) -> branch "${branch}" on ${API} ...`);
  await api("/user/code", { method: "POST", body: JSON.stringify({ branch, modules: { main: code } }) });
  console.log(`done. live code on "${branch}" replaced - the game picks it up within a tick (global reset).`);
}

main().catch(err => {
  console.error("deploy failed:", err);
  process.exit(1);
});
