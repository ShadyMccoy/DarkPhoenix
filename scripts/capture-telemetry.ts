#!/usr/bin/env ts-node
/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * capture-telemetry - snapshot the live bot's telemetry segments to disk.
 *
 * The live bot writes colony state to RawMemory.segments[0-6] every tick and
 * marks them public (src/telemetry/Telemetry.ts). This pulls those parsed
 * segments down as ONE timestamped JSON file so live economy state is
 * diff-able / inspectable in the dev repo - the on-disk counterpart of the
 * telemetry-app dashboard, which keeps the same data in the browser only.
 *
 * Writes test/fixtures/telemetry/<shard>-t<tick>.json, where <tick> is the
 * game tick the CORE segment was written at (the freshness ground truth - the
 * CPU governor can skip telemetry under load, so this is not necessarily "now").
 *
 * Segments (see the exported interfaces in src/telemetry/Telemetry.ts):
 *   0 core   1 nodes   2 edges   3 intel   4 corps   5 blackbox   6 flow
 *
 * Needs a read token: https://screeps.com/a/#!/account/auth-tokens
 *
 * Usage:
 *   SCREEPS_TOKEN=... npm run capture:telemetry -- --shard shard3
 *   SCREEPS_TOKEN=... npm run capture:telemetry -- --shard shard3 --segments 0,4,6
 *   SCREEPS_TOKEN=... npm run capture:telemetry -- --out /tmp/live.json
 */
import { spawnSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";

// Node 18+ global fetch; the test tsconfig has no DOM lib, so declare it.
declare const fetch: (url: string, init?: any) => Promise<any>;

/**
 * Make Node's built-in fetch honour HTTPS_PROXY. Unlike curl, undici (fetch)
 * ignores the proxy env vars unless NODE_USE_ENV_PROXY=1 is set BEFORE the
 * runtime starts - setting it in-process is too late (the global dispatcher is
 * already built). So when a proxy is configured but the flag is off, re-exec
 * this same command once with the flag set. No-ops off-proxy, and the guard on
 * the flag itself prevents an exec loop. Without this, a proxied environment
 * (e.g. Claude Code's egress proxy) gets a 403 on the first API call.
 */
function ensureFetchUsesProxy(): void {
  const proxied = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!proxied || process.env.NODE_USE_ENV_PROXY === "1") return;
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1" } }
  );
  process.exit(result.status ?? 1);
}
ensureFetchUsesProxy();

const API = process.env.SCREEPS_API_URL ?? "https://screeps.com/api";
const OUT_DIR = path.resolve("test", "fixtures", "telemetry");
/** Screeps API etiquette: stay well under the rate limit. */
const CALL_GAP_MS = 600;

/** Segment -> human label, matching src/telemetry/Telemetry.ts. */
const SEGMENT_LABELS: Record<number, string> = {
  0: "core",
  1: "nodes",
  2: "edges",
  3: "intel",
  4: "corps",
  5: "blackbox",
  6: "flow"
};
const ALL_SEGMENTS = [0, 1, 2, 3, 4, 5, 6];

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function apiGet(pathAndQuery: string): Promise<any> {
  const headers: Record<string, string> = {};
  if (process.env.SCREEPS_TOKEN) headers["X-Token"] = process.env.SCREEPS_TOKEN;
  const res = await fetch(`${API}${pathAndQuery}`, { headers });
  if (res.status === 429) {
    await sleep(3000);
    return apiGet(pathAndQuery);
  }
  if (!res.ok) throw new Error(`GET ${pathAndQuery} -> HTTP ${res.status}`);
  const body = (await res.json()) as any;
  if (body.ok !== 1) throw new Error(`GET ${pathAndQuery} -> ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Read one segment; parse its JSON string payload, or null if unset/unparseable. */
async function readSegment(segment: number, shard: string): Promise<unknown> {
  const body = await apiGet(`/user/memory-segment?segment=${segment}&shard=${shard}`);
  const data: unknown = body.data;
  if (typeof data !== "string" || data.length === 0) return null;
  try {
    return JSON.parse(data);
  } catch {
    // Not JSON (shouldn't happen for telemetry segments) - keep the raw string.
    return data;
  }
}

async function main(): Promise<void> {
  const shard = arg("shard") ?? process.env.SCREEPS_SHARD ?? "shard3";
  const segArg = arg("segments");
  const segments = segArg ? segArg.split(",").map(s => Number(s.trim())) : ALL_SEGMENTS;
  const outOverride = arg("out");

  if (!process.env.SCREEPS_TOKEN) {
    console.error("SCREEPS_TOKEN is required (memory segments are per-account).");
    console.error("Get one at https://screeps.com/a/#!/account/auth-tokens, then:");
    console.error("  SCREEPS_TOKEN=... npm run capture:telemetry -- --shard shard3");
    process.exit(1);
  }

  console.log(`capturing telemetry segments [${segments.join(", ")}] from ${API} (${shard})...`);

  const data: Record<string, unknown> = {};
  for (const seg of segments) {
    const label = SEGMENT_LABELS[seg] ?? `seg${seg}`;
    const parsed = await readSegment(seg, shard);
    data[label] = parsed;
    const desc = parsed === null ? "EMPTY (segment unset)" : `${JSON.stringify(parsed).length} bytes`;
    console.log(`  ${seg} ${label}: ${desc}`);
    await sleep(CALL_GAP_MS);
  }

  // Freshness ground truth: the tick the bot stamped on the core segment.
  const core = data.core as { tick?: number } | null | undefined;
  const tick = core?.tick;

  const snapshot = {
    shard,
    capturedAt: new Date().toISOString(),
    tick: tick ?? null,
    segments,
    data
  };

  const file = outOverride
    ? path.resolve(outOverride)
    : path.join(OUT_DIR, `${shard}-t${tick ?? "unknown"}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(snapshot, null, 2));

  console.log(
    `\ndone. tick ${tick ?? "unknown"}` +
      (tick === undefined ? " (core segment empty - telemetry may be off or CPU-skipped)" : "") +
      ` -> ${path.relative(".", file)}`
  );
}

main().catch(err => {
  console.error("capture-telemetry failed:", err);
  process.exit(1);
});
