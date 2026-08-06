#!/usr/bin/env ts-node
/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * arm-sweep - start (or stop, or inspect) the spawn-handicap sweep on the live
 * colony by writing `Memory.spawnSweep` through the Screeps memory API.
 *
 * The sweep (spec 45, economy/spawnSweep) NEVER self-arms: with no
 * `Memory.spawnSweep` the planner's margin resolves to the static
 * SPAWN_PLAN_FRACTION (0.9, the measured-good value). That is what keeps the
 * grid, the sims and the unit suite free of the experiment, and what makes a
 * wiped Memory fail safe to 0.9 rather than to the 1.0 that overheated the
 * colony on 2026-08-04.
 *
 * So arming is a DELIBERATE, one-time act - this script. Everything after it is
 * the bot's: it advances one step per fiscal month, escalates 1%->2% by itself
 * if RCL 8 threatens to land mid-ramp, wraps at 20% and starts over. No redeploy
 * and no monitoring (owner 2026-08-06).
 *
 * Usage:
 *   SCREEPS_TOKEN=... npm run sweep:arm                  # arm at 0%, 1%/month
 *   SCREEPS_TOKEN=... npm run sweep:arm -- --pct 10      # arm mid-ramp
 *   SCREEPS_TOKEN=... npm run sweep:arm -- --step 2      # start accelerated
 *   SCREEPS_TOKEN=... npm run sweep:arm -- --status      # read it back
 *   SCREEPS_TOKEN=... npm run sweep:arm -- --disarm      # back to the static 0.9
 *
 * @module scripts/arm-sweep
 */
import { spawnSync } from "child_process";

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
    console.error("SCREEPS_TOKEN is required (full-access token - this WRITES Memory).");
    process.exit(1);
  }
  const shard = arg("shard") ?? "shard1";
  const q = `path=spawnSweep&shard=${shard}`;

  if (process.argv.includes("--status")) {
    const got = await api(`/user/memory?${q}`);
    console.log(`Memory.spawnSweep on ${shard}:`, JSON.stringify(got.data ?? null));
    return;
  }

  if (process.argv.includes("--disarm")) {
    // The bot treats absent AND null alike (`getSweep()` returns undefined), so
    // writing null is a clean disarm back to the static 0.9.
    await api(`/user/memory`, { method: "POST", body: JSON.stringify({ path: "spawnSweep", value: null, shard }) });
    console.log(`disarmed on ${shard} - planner margin back to the static SPAWN_PLAN_FRACTION (0.9)`);
    return;
  }

  const pct = Number(arg("pct") ?? 0);
  const step = Number(arg("step") ?? 1);
  if (!Number.isFinite(pct) || pct < 0 || pct > 20) throw new Error("--pct must be 0..20");
  if (step !== 1 && step !== 2) throw new Error("--step must be 1 or 2");

  // Mirrors economy/spawnSweep.newSweep(). lastBoundary -1 means "no boundary
  // handled yet", so the very next month boundary takes the first step.
  const value = { pct, step, lastBoundary: -1, cycle: 0, stepReason: "armed" };
  await api(`/user/memory`, { method: "POST", body: JSON.stringify({ path: "spawnSweep", value, shard }) });

  const readBack = await api(`/user/memory?${q}`);
  console.log(`ARMED on ${shard}: ${JSON.stringify(readBack.data ?? null)}`);
  console.log(
    `  planner margin now ${(1 - pct / 100).toFixed(2)} (handicap ${pct}%), stepping +${step}%/fiscal month,\n` +
      `  wrapping at 20% -> 0%. The bot drives it from here; nothing else to do.`
  );
}

main().catch(e => {
  console.error(String(e));
  process.exit(1);
});
