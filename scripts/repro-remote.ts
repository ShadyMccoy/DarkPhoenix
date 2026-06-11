#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * repro-remote - home room with two LOCAL sources next to an unowned neighbor
 * that also has sources. Question: does the bot mine its local sources, or does
 * it spend spawn capacity reaching into the neighbor ("remote mines") while the
 * local sources sit idle?
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadLayout, padNeighborTerrain, RoomLayout } from "../test/integration/loadLayout";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const HOME = "W0N0";
const NEIGHBOR = "W1N0";

/**
 * A room with a perimeter wall ring (exit gaps in the middle of each side so
 * creeps can still cross rooms). An all-plain room has a flat distance transform
 * with no distinct peaks, so the node surveyor finds nothing and the colony loops
 * on "No nodes in memory" forever; the wall border gives the analysis a gradient
 * to peak on - the difference between a stuck bootstrap and a real economy.
 */
function walledTerrain(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 50; y += 1) {
    let row = "";
    for (let x = 0; x < 50; x += 1) {
      const onBorder = x === 0 || x === 49 || y === 0 || y === 49;
      const exitGap = (x >= 23 && x <= 26) || (y >= 23 && y <= 26);
      row += onBorder && !exitGap ? "#" : ".";
    }
    rows.push(row);
  }
  return rows;
}

function homeRoom(): RoomLayout {
  return {
    room: HOME,
    terrain: walledTerrain(),
    objects: [
      { type: "controller", x: 25, y: 10 },
      { type: "source", x: 15, y: 30 },
      { type: "source", x: 35, y: 30 }
    ]
  };
}

// Unowned neighbor with its own sources (a remote-mine candidate).
function neighborRoom(): RoomLayout {
  return {
    room: NEIGHBOR,
    terrain: walledTerrain(),
    objects: [
      { type: "controller", x: 25, y: 25 },
      { type: "source", x: 10, y: 20 },
      { type: "source", x: 40, y: 20 }
    ]
  };
}

async function main(): Promise<void> {
  const ticks = parseInt(process.argv[2] ?? "500", 10);
  const port = 26000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("server", `repro-remote-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  await loadLayout(server.world, homeRoom());
  await loadLayout(server.world, neighborRoom());
  // Pad the full radius-3 analysis box (get7x7BoxAroundOwnedRooms) so terrain
  // analysis can actually produce nodes - otherwise the colony loops forever on
  // "No nodes in memory" and never mines.
  await padNeighborTerrain(server.world, [HOME, NEIGHBOR], 3);

  const modules = { main: readFileSync("dist/main.js").toString() };
  const bot = await server.world.addBot({ username: "player", room: HOME, x: 25, y: 25, modules });

  const interesting = /miner|Skipping|unprofitable|harvest|assignMiner|spawn|Spawn|hauler|error|Error|TypeError|undefined/i;
  const seen = new Map<string, number>();
  bot.on("console", (log: string[], results: any) => {
    for (const line of log ?? []) {
      if (interesting.test(line)) {
        const key = line.replace(/\d+/g, "#").slice(0, 80);
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    for (const e of results?.errors ?? []) seen.set(`ERR ${String(e).slice(0, 80)}`, (seen.get(`ERR`) ?? 0) + 1);
  });

  await server.start();
  for (let t = 1; t <= ticks; t += 1) {
    await server.tick();
    if (t % 50 === 0) process.stdout.write(".");
  }
  process.stdout.write("\n");

  // Dump creep roster (role + position) for the home room.
  {
    const objs = await server.world.roomObjects(HOME);
    const creeps = objs.filter((o: any) => o.type === "creep");
    const sources = objs.filter((o: any) => o.type === "source");
    console.log(`\n[home creeps] ${creeps.length}:`);
    for (const c of creeps) {
      const work = (c.body ?? []).filter((p: any) => p.type === "work").length;
      const carry = (c.body ?? []).filter((p: any) => p.type === "carry").length;
      console.log(`  (${c.x},${c.y}) work=${work} carry=${carry} fatigue=${c.fatigue ?? 0}`);
    }
    console.log(`[home sources] ${sources.map((s: any) => `(${s.x},${s.y})`).join(" ")}`);
  }

  const report = async (roomName: string) => {
    const objs = await server.world.roomObjects(roomName);
    const creeps = objs.filter((o: any) => o.type === "creep");
    const sources = objs.filter((o: any) => o.type === "source");
    const minedSources = sources.filter((s: any) =>
      creeps.some((c: any) => Math.max(Math.abs(c.x - s.x), Math.abs(c.y - s.y)) <= 1 && (c.body ?? []).some((p: any) => p.type === "work"))
    );
    console.log(`  ${roomName}: ${creeps.length} creeps, ${minedSources.length}/${sources.length} sources have a miner adjacent`);
    return { creeps: creeps.length, sources: sources.length, mined: minedSources.length };
  };

  console.log(`\n=== console (deduped, top 25 by frequency) ===`);
  for (const [k, n] of [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  x${n}  ${k}`);
  }

  console.log(`\n=== After ${ticks} ticks ===`);
  const home = await report(HOME);
  const nb = await report(NEIGHBOR);
  console.log(
    `\nLocal sources mined: ${home.mined}/${home.sources}.  Creeps in neighbor (remote): ${nb.creeps}.`
  );
  console.log(
    home.mined < home.sources && nb.creeps > 0
      ? "  => BUG REPRODUCED: local sources idle while creeps work the neighbor."
      : home.mined === home.sources
        ? "  => local sources are mined (no obvious local-starvation)."
        : "  => local sources NOT fully mined, but no neighbor creeps either."
  );
  await server.stop();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("repro-remote failed:", err);
    process.exit(1);
  });
