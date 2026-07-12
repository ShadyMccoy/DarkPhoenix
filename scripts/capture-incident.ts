#!/usr/bin/env ts-node
/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * capture-incident - pull a live incident into a reproducible fixture
 * (spec 09 phase 4: production failures become cells).
 *
 * Grabs, for one shard+room:
 *   1. the BLACK BOX (RawMemory segment 5 - the last ~200 ticks of decisions:
 *      spawns, holds, churn, watch samples, caught errors),
 *   2. the full Memory snapshot (commissioned corps, agendas, intel),
 *   3. the room + neighbours' terrain/scenery (delegates to capture-rooms),
 * and writes test/fixtures/incidents/<date>-<room>/ plus a skeleton grid cell
 * staging that room with TODO assertions - so an incident lands red-ready.
 *
 * Usage:
 *   SCREEPS_TOKEN=... npm run capture:incident -- --shard shard3 --room W1N6
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

declare const fetch: (url: string, init?: any) => Promise<any>;

const API = process.env.SCREEPS_API_URL ?? "https://screeps.com/api";
const BLACKBOX_SEGMENT = 5;
const CALL_GAP_MS = 600;

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

/** The Screeps memory endpoint gzips payloads ("gz:" + base64). */
function ungz(data: unknown): unknown {
  if (typeof data !== "string" || !data.startsWith("gz:")) return data;
  const zlib = require("zlib") as typeof import("zlib");
  return JSON.parse(zlib.gunzipSync(Buffer.from(data.slice(3), "base64")).toString());
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function skeletonCell(shard: string, room: string, dirName: string): string {
  return `import { GridCell, always, eventually } from "../GridCell";
import { fixtureRoom } from "../fixtureRoom";

/**
 * INCIDENT ${dirName}: captured from live (see test/fixtures/incidents/${dirName}/).
 * Black box + Memory snapshot ride alongside the terrain. Reconstruct the
 * failing moment, then replace the TODO assertions with the incident's
 * signature - red first, then fix the bot.
 */
export function buildIncident_${dirName.replace(/[^a-zA-Z0-9]/g, "_")}Cells(): GridCell[] {
  return [
    {
      id: "incident-${dirName}",
      tier: 3,
      avenue: "resilience",
      window: 600,
      rooms: { home: fixtureRoom("${shard}-${room}") },
      bot: { x: 25, y: 25 }, // TODO: the real spawn position from memory.json
      controller: { level: 2 }, // TODO: the real RCL at capture
      assertions: [
        // TODO: encode the incident's signature from blackbox.json, e.g.:
        // always("a spawn buy happens within any 1000-tick span", ...),
        eventually("TODO: the recovery the bot should reach", () => false),
      ],
    },
  ];
}
`;
}

async function main(): Promise<void> {
  const shard = arg("shard") ?? "shard3";
  const room = arg("room");
  if (!room) {
    console.error("usage: npm run capture:incident -- --shard shard3 --room W1N6");
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);
  const dirName = `${date}-${shard}-${room}`;
  const outDir = path.resolve("test", "fixtures", "incidents", dirName);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`capturing incident ${dirName} ...`);

  // 1. The black box segment.
  const seg = await apiGet(`/user/memory-segment?segment=${BLACKBOX_SEGMENT}&shard=${shard}`);
  const blackbox = typeof seg.data === "string" && seg.data.length > 0 ? JSON.parse(seg.data) : null;
  fs.writeFileSync(path.join(outDir, "blackbox.json"), JSON.stringify(blackbox, null, 2));
  console.log(`  blackbox.json: ${blackbox ? `${blackbox.rows?.length ?? 0} rows @ tick ${blackbox.tick}` : "EMPTY (segment 5 unset)"}`);
  await sleep(CALL_GAP_MS);

  // 2. The Memory snapshot.
  const mem = await apiGet(`/user/memory?shard=${shard}`);
  const memory = ungz(mem.data);
  fs.writeFileSync(path.join(outDir, "memory.json"), JSON.stringify(memory, null, 2));
  const memKeys = memory && typeof memory === "object" ? Object.keys(memory as object).length : 0;
  console.log(`  memory.json: ${memKeys} top-level keys`);

  // 3. Terrain fixtures for the room + neighbours (the existing capture path).
  console.log(`  rooms: delegating to capture-rooms --around ${room} ...`);
  execFileSync("npx", ["ts-node", "-P", "tsconfig.test.json", "scripts/capture-rooms.ts", "--shard", shard, "--around", room], {
    stdio: "inherit"
  });

  // 4. Skeleton cell.
  const cellPath = path.join(outDir, "cell.skeleton.ts");
  fs.writeFileSync(cellPath, skeletonCell(shard, room, dirName));
  console.log(`  cell skeleton: ${cellPath}`);
  console.log(`\ndone. Next: read blackbox.json for the signature, move the skeleton into test/grid/cells/, make it red.`);
}

void main();
