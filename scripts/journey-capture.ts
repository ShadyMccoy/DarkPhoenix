#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * journey-capture - run ONE organic long sim and harvest RCL-journey trip
 * points (docs/specs/10) into replayable snapshots.
 *
 * The organic run is the expensive, paid-once half of the loop: a rolling
 * buffer keeps the last ~5 ticks of full world state (objects + Memory), and
 * the first tick a trip point (test/journey/tripPoints.ts) fires, the
 * buffered state from 5 ticks earlier is written to
 * test/fixtures/journey/<scenario>--<trip>.json. The grid's rcl-journey
 * avenue (test/grid/cells/journey.ts) then replays each snapshot as a SHORT
 * staged cell asserting the same trip fires again - the long sim never runs
 * in the grid.
 *
 * Usage:
 *   npm run journey:capture                                # synthetic 2-source room, 6000 ticks
 *   npm run journey:capture -- --ticks 10000
 *   npm run journey:capture -- --fixture shard3-W1N6 --spawn 28,30
 *   npm run journey:capture -- --trips rcl3,storage-built  # only these
 *
 * Build first (npm run build): the sim runs dist/main.js.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { loadLayout, RoomLayout } from "../test/integration/loadLayout";
import { sealBorders } from "../test/grid/fixtureRoom";
import { JourneySample, TRIP_POINTS } from "../test/journey/tripPoints";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const DIST_MAIN_JS = "dist/main.js";
const OUT_DIR = path.resolve("test", "fixtures", "journey");
const BUFFER_DEPTH = 6; // snapshot lands ~5 ticks before the trip

interface BufferedState {
  tick: number;
  gameTime: number;
  memory: any;
  objectsByRoom: Record<string, any[]>;
}


/** All-plain sealed starter room: controller north, two sources south. */
function syntheticLayout(room: string): RoomLayout {
  return {
    room,
    terrain: sealBorders(Array.from({ length: 50 }, () => ".".repeat(50))),
    objects: [
      { type: "controller", x: 25, y: 10 },
      { type: "source", x: 10, y: 40 },
      { type: "source", x: 40, y: 40 },
    ],
  };
}

function loadFixtureLayout(name: string): RoomLayout {
  const file = path.resolve("test", "fixtures", "real-rooms", `${name}.json`);
  const fx = JSON.parse(readFileSync(file).toString());
  return { room: fx.room, terrain: sealBorders(fx.terrain), objects: fx.objects };
}

function getArg(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

/** Strip storage-engine bookkeeping so snapshots are stable JSON. */
function cleanDoc(doc: any): any {
  const { $loki, meta, ...rest } = doc;
  return rest;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ticks = parseInt(getArg(args, "ticks", "6000"), 10);
  const fixture = getArg(args, "fixture", "");
  const spawnArg = getArg(args, "spawn", "25,25");
  const only = getArg(args, "trips", "");
  const wanted = new Set(only ? only.split(",") : TRIP_POINTS.map((t) => t.id));

  const scenario = fixture || "synthetic-2src";
  const layout = fixture ? loadFixtureLayout(fixture) : syntheticLayout("W0N0");
  const [sx, sy] = spawnArg.split(",").map(Number);

  const port = 27000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("server", `journey-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  await loadLayout(server.world, layout);
  const modules = { main: readFileSync(DIST_MAIN_JS).toString() };
  const player = await server.world.addBot({ username: "player", room: layout.room, x: sx, y: sy, modules });
  await server.start();

  console.log(`journey-capture: ${scenario} @ ${layout.room}, spawn ${sx},${sy}, up to ${ticks} ticks`);
  console.log(`watching: ${[...wanted].join(", ")}`);

  const buffer: BufferedState[] = [];
  const pending = new Set(wanted);
  let captured = 0;

  for (let t = 1; t <= ticks && pending.size > 0; t++) {
    await server.tick();

    const objects = (await server.world.roomObjects(layout.room)).map(cleanDoc);
    const memory = JSON.parse((await player.memory) || "{}");
    const gameTime = await server.world.gameTime;
    buffer.push({ tick: t, gameTime, memory, objectsByRoom: { [layout.room]: objects } });
    if (buffer.length > BUFFER_DEPTH) buffer.shift();

    const sample: JourneySample = { tick: t, memory, objects: () => objects };
    for (const tp of TRIP_POINTS) {
      if (!pending.has(tp.id)) continue;
      let fired = false;
      try {
        fired = tp.check(sample);
      } catch {
        fired = false;
      }
      if (!fired) continue;
      pending.delete(tp.id);

      const snap = buffer[0]; // ~5 ticks before the moment
      const out = {
        version: 1,
        scenario,
        trip: tp.id,
        description: tp.description,
        trippedAt: t,
        tick: snap.tick,
        gameTime: snap.gameTime,
        botUserId: player.id,
        rooms: Object.entries(snap.objectsByRoom).reduce<Record<string, { terrain: string[]; objects: any[] }>>(
          (acc, [room, objs]) => {
            // A terrain-less snapshot would replay unsealed and terrain-less
            // (engine wedges on the first terrain read) - refuse to write one.
            if (!layout.terrain || layout.terrain.length !== 50) {
              throw new Error(`journey-capture: layout for ${room} has no full terrain to snapshot`);
            }
            acc[room] = { terrain: layout.terrain, objects: objs };
            return acc;
          },
          {}
        ),
        memory: snap.memory,
      };
      const file = path.join(OUT_DIR, `${scenario}--${tp.id}.json`);
      writeFileSync(file, JSON.stringify(out, null, 1));
      captured++;
      console.log(`  [${t}] ${tp.id} tripped -> ${path.relative(process.cwd(), file)} (state@${snap.tick})`);
    }

    if (t % 500 === 0) console.log(`  tick ${t}, ${pending.size} trip(s) pending`);
  }

  console.log(`done: ${captured} snapshot(s); never tripped: ${[...pending].join(", ") || "none"}`);
  await server.stop();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("journey-capture failed:", e);
    process.exit(1);
  }
);
