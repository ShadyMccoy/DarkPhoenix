#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * sim-real-rooms - run the bot on REAL game-world terrain.
 *
 * Loads captured fixtures (scripts/capture-rooms.ts) with their REAL room
 * names - adjacency and exits come straight from the names - drops the colony
 * in, runs N ticks, and reports how the economy actually parceled itself out:
 * per-room fleet, per-source utilization, controller progress, roads paved.
 *
 * Usage (after: npm run build):
 *   npm run sim:real -- --shard shard3 --home W1N8 --ticks 1500
 *   npm run sim:real -- --home W1N8 --own W2N8 --gcl 2 --ticks 2000 --debug
 *   npm run sim:real -- --home W1N8 --ticks 3000 --deploy-at 1500
 *     (prod-style mid-run deploy: at the tick, the bot's code is re-read from
 *      --deploy-file [default dist/main.js] and swapped in over the live
 *      world + Memory - rebuild between launch and the deploy tick to A/B
 *      two builds across one persistent state, the deploy-over-live class
 *      of bugs fresh sims can never see.)
 *
 * --home picks the bot's first room (spawn auto-placed on an open plain tile
 * near its sources unless --spawn x,y). Every captured fixture for the shard
 * that is chebyshev-adjacent-or-equal to a colony room is loaded, so capture a
 * contiguous cluster and remotes/scouting work on the real map. --own adds
 * extra OWNED rooms (their spawns auto-placed too; raise --gcl to match).
 */
import { readFileSync, readdirSync, mkdirSync } from "fs";
import * as path from "path";
import { loadLayout, addOwnedRoom, padNeighborTerrain } from "../test/integration/loadLayout";
import { pickSpawnSpot as pickSpot } from "../src/spatial/spawnPlacement";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const DIST_MAIN_JS = "dist/main.js";
const FIXTURE_DIR = path.resolve("test", "fixtures", "real-rooms");

interface Fixture {
  room: string;
  shard: string;
  ownedOnLive?: boolean;
  terrain: string[];
  objects: Array<{ type: string; x: number; y: number; attributes?: Record<string, unknown> }>;
}

function loadFixtures(shard: string): Map<string, Fixture> {
  const out = new Map<string, Fixture>();
  for (const f of readdirSync(FIXTURE_DIR)) {
    if (!f.startsWith(`${shard}-`) || !f.endsWith(".json")) continue;
    const fx = JSON.parse(readFileSync(path.join(FIXTURE_DIR, f)).toString()) as Fixture;
    out.set(fx.room, fx);
  }
  return out;
}

/**
 * The bot's own spawn placement (src/spatial/spawnPlacement) applied to a
 * fixture. Override with --spawn x,y.
 */
function pickSpawnSpot(fx: Fixture): { x: number; y: number } {
  const anchors = fx.objects.filter(o => o.type === "source" || o.type === "controller");
  const spot = pickSpot(fx.terrain, anchors, fx.objects);
  if (!spot) throw new Error(`${fx.room}: no open plain tile found - pass --spawn x,y`);
  return spot;
}

function parseRoom(name: string): { x: number; y: number } {
  const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name)!;
  const x = m[1] === "W" ? -Number(m[2]) - 1 : Number(m[2]);
  const y = m[3] === "N" ? -Number(m[4]) - 1 : Number(m[4]);
  return { x, y };
}

const roomDist = (a: string, b: string): number => {
  const pa = parseRoom(a);
  const pb = parseRoom(b);
  return Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  const shard = getArg("shard", process.env.SCREEPS_SHARD ?? "shard3");
  const home = getArg("home", "");
  const own: string[] = [];
  args.forEach((a, i) => {
    if (a === "--own" && args[i + 1]) own.push(args[i + 1]);
  });
  const gcl = parseInt(getArg("gcl", String(1 + own.length)), 10);
  const ticks = parseInt(getArg("ticks", "1500"), 10);
  const debug = args.includes("--debug");
  const spawnOverride = getArg("spawn", "");
  // Mid-run code deploy (owner: "that's how it works in prod"): at tick N,
  // swap the bot's modules for a fresh read of --deploy-file (default
  // dist/main.js - rebuild between launch and the deploy tick to A/B two
  // builds over ONE persistent world). Tests the deploy-over-live-state
  // class of bugs (e.g. the stale-spawnId incident) that fresh sims can
  // never see.
  const deployAt = parseInt(getArg("deploy-at", "0"), 10);
  const deployFile = getArg("deploy-file", DIST_MAIN_JS);

  const fixtures = loadFixtures(shard);
  if (!home || !fixtures.has(home)) {
    console.log(`usage: npm run sim:real -- --home <room> [--own <room>]... [--ticks N] [--debug]`);
    console.log(`captured for ${shard}: ${[...fixtures.keys()].join(", ") || "(none - run capture:rooms first)"}`);
    process.exit(1);
  }
  const colonyRooms = [home, ...own];
  for (const r of colonyRooms) {
    if (!fixtures.has(r)) throw new Error(`no fixture for ${r} (run capture:rooms)`);
  }
  // Load every captured room within 1 of a colony room: real remotes/exits.
  const loaded = [...fixtures.values()].filter(fx => colonyRooms.some(r => roomDist(fx.room, r) <= 1));

  const port = 25000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("server", `real-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();

  for (const fx of loaded) await loadLayout(server.world, fx);
  // Real rooms have OPEN borders, so pads must be WALL terrain (radius 2 so
  // the analysis box always finds terrain): a plain pad is enterable and a
  // scout escaping through it wedges the engine on the first terrain-less room.
  await padNeighborTerrain(server.world, loaded.map(fx => fx.room), 2, "wall");

  const spawnAt = (room: string): { x: number; y: number } => {
    if (room === home && spawnOverride) {
      const [x, y] = spawnOverride.split(",").map(Number);
      return { x, y };
    }
    return pickSpawnSpot(fixtures.get(room)!);
  };

  const modules = { main: readFileSync(DIST_MAIN_JS).toString() };
  const homeSpot = spawnAt(home);
  const player = await server.world.addBot({ username: "player", room: home, x: homeSpot.x, y: homeSpot.y, gcl, modules });
  if (debug) {
    player.on("console", (logs: string[]) => {
      for (const line of logs ?? []) console.log(`  ${line}`);
    });
  }
  for (const r of own) {
    const spot = spawnAt(r);
    await addOwnedRoom(server.world, player.id, r, spot.x, spot.y, `Spawn-${r}`);
  }

  console.log(
    `world: ${loaded.map(fx => fx.room).join(", ")} | colony: ${colonyRooms.join("+")} ` +
      `| spawn ${home}@${homeSpot.x},${homeSpot.y} | gcl ${gcl} | ${ticks} ticks`
  );

  await server.start();
  const t0 = Date.now();

  // --metrics: every 100 ticks, sample PLAN vs ACTUAL for the home room -
  // what the planner budgeted (Memory.economyPlan) against what physically
  // happened (controller progress, spawn spend, build progress, fielded vs
  // planned hauler CARRY). Answers "what does the planner expect and what
  // does it actually perform".
  const metrics = args.includes("--metrics");
  const PART_COST: Record<string, number> = { work: 100, carry: 50, move: 50, claim: 600, attack: 80, ranged_attack: 150, heal: 250, tough: 10 };
  const seenCreeps = new Set<string>();
  let prevProgress = 0;
  let prevSiteProgress = new Map<string, { progress: number; total: number }>();
  const samples: Array<Record<string, number>> = [];

  const sampleMetrics = async (t: number): Promise<void> => {
    const objs = await server.world.roomObjects(home);
    const mem = JSON.parse((await player.memory) || "{}");
    const ctrl = objs.find((o: any) => o.type === "controller");

    // actual: controller energy (progress is 1:1 with upgrade energy)
    const progress = (ctrl?.progress ?? 0) + 0; // per-level; resets on RCL-up
    const ctrlDelta = Math.max(0, progress - prevProgress); // reset -> undercount once
    prevProgress = progress;

    // actual: energy spent on spawned bodies (attributed at completion)
    let spawnSpend = 0;
    for (const o of objs.filter((x: any) => x.type === "creep" && x.user)) {
      if (seenCreeps.has(o._id)) continue;
      seenCreeps.add(o._id);
      spawnSpend += (o.body ?? []).reduce((s: number, p: any) => s + (PART_COST[p.type] ?? 0), 0);
    }

    // actual: construction energy (site progress deltas + completions)
    const sites = new Map<string, { progress: number; total: number }>();
    let buildDelta = 0;
    for (const o of objs.filter((x: any) => x.type === "constructionSite")) {
      sites.set(String(o._id), { progress: o.progress ?? 0, total: o.progressTotal ?? 0 });
      const prev = prevSiteProgress.get(String(o._id));
      buildDelta += Math.max(0, (o.progress ?? 0) - (prev?.progress ?? 0));
    }
    for (const [id, prev] of prevSiteProgress) {
      if (!sites.has(id)) buildDelta += Math.max(0, prev.total - prev.progress); // completed
    }
    prevSiteProgress = sites;

    // planned: the roster the solver published
    const corps: any[] = mem.economyPlan?.corps ?? [];
    const planUpgrade = corps.filter(c => c.kind === "upgrade").reduce((s, c) => s + (c.work ?? 0), 0);
    const planBuild = corps.filter(c => c.kind === "build").reduce((s, c) => s + (c.work ?? 0) * 5, 0);
    const planMine = corps.filter(c => c.kind === "mine").reduce((s, c) => s + (c.work ?? 0) * 2, 0);
    const planCarry = corps.filter(c => c.kind === "haul").reduce((s, c) => s + (c.carry ?? 0), 0);

    // fielded: live hauler CARRY vs the plan's
    let fieldedCarry = 0;
    for (const name in mem.creeps ?? {}) {
      if (mem.creeps[name]?.workType !== "haul") continue;
      const doc = objs.find((x: any) => x.type === "creep" && x.name === name);
      if (doc) fieldedCarry += (doc.body ?? []).filter((p: any) => p.type === "carry").length;
    }

    samples.push({
      t,
      planMine,
      planUpgrade,
      planBuild,
      planCarry,
      fieldedCarry,
      ctrl: ctrlDelta / 100,
      build: buildDelta / 100,
      spawn: spawnSpend / 100
    });
  };

  for (let t = 1; t <= ticks; t += 1) {
    if (deployAt > 0 && t === deployAt) {
      // Prod-style deploy: overwrite the bot's code in the db mid-run; the
      // runtime picks it up like a push + global reset, with Memory and the
      // world state persisting across the boundary.
      const { db } = await server.world.load();
      const fresh = readFileSync(deployFile).toString();
      await db["users.code"].update({ user: player.id }, { $set: { modules: { main: fresh } } });
      console.log(`\n[deploy] code swapped at tick ${t} (${deployFile})`);
    }
    await server.tick();
    if (metrics && t % 100 === 0) await sampleMetrics(t);
    if (t % 100 === 0) process.stdout.write(".");
  }
  console.log(` ${(Date.now() - t0) / 1000 | 0}s`);

  if (metrics) {
    console.log("\nPLAN vs ACTUAL (per-tick rates over each 100-tick window; carry in parts)");
    console.log("tick   plan: mine  ctrl  build  carry | fielded-carry | actual: ctrl  build  spawn  (sum)");
    for (const s of samples) {
      const sum = (s.ctrl + s.build + s.spawn).toFixed(1);
      console.log(
        `${String(s.t).padStart(5)}       ${String(s.planMine).padStart(4)}  ${String(s.planUpgrade).padStart(4)}  ` +
          `${String(s.planBuild).padStart(5)}  ${String(s.planCarry).padStart(5)} | ${String(s.fieldedCarry).padStart(13)} | ` +
          `        ${s.ctrl.toFixed(1).padStart(4)}  ${s.build.toFixed(1).padStart(5)}  ${s.spawn.toFixed(1).padStart(5)}  (${sum})`
      );
    }
  }

  // ------ report: how did the economy parcel itself across the real map ------
  const mem = JSON.parse((await player.memory) || "{}");
  const workTypes: Record<string, number> = {};
  for (const name in mem.creeps ?? {}) {
    const wt = mem.creeps[name]?.workType ?? "?";
    workTypes[wt] = (workTypes[wt] ?? 0) + 1;
  }

  console.log("\nroom        RCL  progress  creeps  srcUse   roads(sites)  spawnBank");
  for (const fx of loaded) {
    const objs = await server.world.roomObjects(fx.room);
    const ctrl = objs.find((o: any) => o.type === "controller");
    const creeps = objs.filter((o: any) => o.type === "creep");
    const sources = objs.filter((o: any) => o.type === "source");
    const worked = sources.filter((o: any) => (o.energy ?? o.energyCapacity) < (o.energyCapacity ?? 3000)).length;
    const roads = objs.filter((o: any) => o.type === "road").length;
    const roadSites = objs.filter((o: any) => o.type === "constructionSite" && o.structureType === "road").length;
    const spawns = objs.filter((o: any) => o.type === "spawn");
    const bank = spawns.reduce((s: number, sp: any) => s + (sp.store?.energy ?? 0), 0);
    const owned = colonyRooms.includes(fx.room);
    console.log(
      `${fx.room.padEnd(10)}  ${String(ctrl?.level ?? "-").padStart(3)}  ${String(ctrl?.progress ?? 0).padStart(8)}  ` +
        `${String(creeps.length).padStart(6)}  ${worked}/${sources.length}      ${String(roads).padStart(5)}(${roadSites})` +
        `  ${owned ? String(bank).padStart(9) : "   remote"}`
    );
  }
  console.log(`\nfleet by workType: ${JSON.stringify(workTypes)}`);
  const receipts: string[] = [];
  for (const r of Object.keys(mem.rooms ?? {})) {
    for (const [id, v] of Object.entries((mem.rooms[r]?.roadRoutes ?? {}) as Record<string, any>)) {
      receipts.push(`${r}:${id.slice(-4)}:${v.paved ? "paved" : v.declined ? "declined" : "building"}`);
    }
  }
  console.log(`paved receipts: ${JSON.stringify(receipts)}`);

  if (args.includes("--dump")) {
    console.log(`\neconomyPlan: ${JSON.stringify(mem.economyPlan ?? null)}`);
    console.log(`\ncommissionedCorps: ${JSON.stringify(Object.keys(mem.commissionedCorps ?? {}))}`);
    console.log(`\nspawnDemandFirstSeen: ${JSON.stringify(mem.spawnDemandFirstSeen ?? null)}`);
    for (const r of colonyRooms) {
      const objs = await server.world.roomObjects(r);
      const ctrl = objs.find((o: any) => o.type === "controller");
      console.log(`\n${r} controller: level=${ctrl?.level} progress=${ctrl?.progress} downgrade=${ctrl?.downgradeTime}`);
      const spawnObjs = objs.filter((o: any) => o.type === "spawn");
      console.log(`${r} spawns: ${JSON.stringify(spawnObjs.map((s: any) => ({ id: s._id, name: s.name, energy: s.store?.energy })))}`);
    }
  }

  await server.stop();
  process.exit(0);
}

main().catch(err => {
  console.error("sim-real-rooms failed:", err);
  process.exit(1);
});
