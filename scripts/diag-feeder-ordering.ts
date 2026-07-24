/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * diag-feeder-ordering (throwaway probe) - pins the ONE open assumption
 * behind the "ring feeder" / PCB-pocket design: within a single tick where a
 * pure-CARRY creep does `transfer`/`withdraw` AND `move`, does the store
 * change resolve BEFORE the movement phase computes fatigue?
 *
 * This runs the REAL @screeps/engine processor (via screeps-server-mockup), so
 * intent ordering and fatigue are EXECUTED, not modeled. Same code as live.
 * (The hand-rolled test/sim/GameSimulator fake resolves store/fatigue in
 * caller order and would give a false answer - do not use it for this.)
 *
 * Body is [CARRY,CARRY,CARRY,MOVE] (the design's 3C:1M) so the detector IS the
 * real creep. On PLAIN, a loaded step generates 3*2 = 6 fatigue; an empty step
 * generates 0. So post-step fatigue reads:
 *     0  -> the creep was EMPTY when fatigue was computed  (free step)
 *     6  -> the creep was FULL  when fatigue was computed  (heavy step)
 *
 * Probe A: loaded, same-tick  transfer(sink) + move   -> expect fatigue 0 (free)
 * Probe B: empty,  same-tick  withdraw(src)  + move    -> expect fatigue 6 (heavy)
 *
 * Design consequence if that's what the engine says: the ring feeder should
 * STEP on the tick it empties out (free), and REFILL on arrival - never
 * withdraw on the same tick it departs.
 *
 * Containers (unowned, trivial to stage) stand in for the link/extensions -
 * intent ordering is identical across transfer/withdraw targets.
 *
 * Run:  npm install && npm run build (build not strictly needed - bot is inline)
 *       npx ts-node scripts/diag-feeder-ordering.ts
 */
import * as fs from "fs";
import { mkdirSync } from "fs";
import * as path from "path";
import { loadLayout } from "../test/integration/loadLayout";
import { bulkPadTerrain } from "../test/grid/bulkPad";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const ROOM = "W0N0";

// The micro-bot. One creep, both probes, so the spawn only pays for one body
// (300 spawn energy can't afford two 200-energy creeps). A single MOVE part
// lets it recover between the probes.
const MAIN = `
  module.exports.loop = function () {
    const spawn = Object.values(Game.spawns)[0];
    const M = Memory;
    if (M.phase === undefined) M.phase = "spawn";
    const c = Game.creeps.F;

    const cont = (x, y) => c.room.find(FIND_STRUCTURES, {
      filter: s => s.structureType === "container" && s.pos.x === x && s.pos.y === y
    })[0];

    if (M.phase === "spawn") {
      if (spawn && !spawn.spawning) { spawn.spawnCreep([CARRY,CARRY,CARRY,MOVE], "F"); M.phase = "posA"; }
      return;
    }
    if (!c || c.spawning) return;

    if (M.phase === "posA") {
      // Travel EMPTY to the probe-A tile (empty travel is fatigue-free).
      if (c.pos.x !== 10 || c.pos.y !== 20) { c.moveTo(new RoomPosition(10, 20, "${ROOM}")); return; }
      M.phase = "loadA"; return;
    }
    if (M.phase === "loadA") {
      // Load from the source below (stationary - adds no fatigue).
      c.withdraw(cont(10, 21), RESOURCE_ENERGY);
      if (c.store.getFreeCapacity(RESOURCE_ENERGY) === 0) M.phase = "fireA";
      return;
    }
    if (M.phase === "fireA") {
      // THE PROBE: same tick, empty into the sink above AND step RIGHT.
      c.transfer(cont(10, 19), RESOURCE_ENERGY);
      c.move(RIGHT);
      M.aFired = Game.time;
      M.phase = "recoverA";
      return;
    }
    if (M.phase === "recoverA") {
      if (c.fatigue > 0) return;      // wait out any fatigue from probe A
      M.phase = "posB"; return;
    }
    if (M.phase === "posB") {
      if (c.pos.x !== 10 || c.pos.y !== 25) { c.moveTo(new RoomPosition(10, 25, "${ROOM}")); return; }
      if (c.fatigue > 0) return;
      M.phase = "fireB"; return;
    }
    if (M.phase === "fireB") {
      // THE MIRROR PROBE: same tick, refill from the source below AND step RIGHT.
      c.withdraw(cont(10, 26), RESOURCE_ENERGY);
      c.move(RIGHT);
      M.bFired = Game.time;
      M.phase = "done";
      return;
    }
  };
`;

async function main(): Promise<void> {
  const port = 25791;
  const serverPath = path.resolve("server", `diag-${port}`);
  (fs as any).rmSync(serverPath, { recursive: true, force: true });
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  const fullContainer = (x: number, y: number) => ({
    type: "container",
    x,
    y,
    attributes: { store: { energy: 2000 }, storeCapacityResource: { energy: 2000 }, hits: 250000, hitsMax: 250000 }
  });
  const emptyContainer = (x: number, y: number) => ({
    type: "container",
    x,
    y,
    attributes: { store: { energy: 0 }, storeCapacityResource: { energy: 2000 }, hits: 250000, hitsMax: 250000 }
  });

  try {
    await server.world.reset();
    await loadLayout(server.world, {
      room: ROOM,
      terrain: Array.from({ length: 50 }, () => ".".repeat(50)), // all PLAIN
      objects: [
        { type: "controller", x: 5, y: 5 },
        fullContainer(10, 21), // srcA  (below probe-A tile)
        emptyContainer(10, 19), // sinkA (above probe-A tile)
        fullContainer(10, 26) // srcB  (below probe-B tile)
      ]
    });
    await bulkPadTerrain(server, [ROOM], 1);
    botHandle = await server.world.addBot({ username: "feeder-probe", room: ROOM, x: 10, y: 10, modules: { main: MAIN } });
    await server.start();

    const read = async () => {
      const objs = await server.world.roomObjects(ROOM);
      const c = objs.find((o: any) => o.type === "creep");
      return c;
    };

    let aCap: any = null;
    let bCap: any = null;
    let rawDumped = false;

    for (let t = 1; t <= 160 && !(aCap && bCap); t++) {
      await server.tick();
      const c = await read();
      if (!c) continue;

      // Pull the bot's Memory to learn which tick each probe fired on.
      const botMem = JSON.parse((await getBotMemory()) || "{}");

      if (botMem.aFired !== undefined && !aCap) {
        if (!rawDumped) {
          rawDumped = true;
          console.log(`raw creep on probe-A tick: ${JSON.stringify(c)}`);
        }
        aCap = { x: c.x, y: c.y, energy: c.store?.energy ?? 0, fatigue: c.fatigue ?? "?" };
      }
      if (botMem.bFired !== undefined && !bCap) {
        bCap = { x: c.x, y: c.y, energy: c.store?.energy ?? 0, fatigue: c.fatigue ?? "?" };
      }
    }

    console.log("\n=== feeder intent-ordering probe (real engine) ===");
    console.log(`Probe A (loaded: transfer-out + move, same tick): ${JSON.stringify(aCap)}`);
    console.log(`Probe B (empty:  withdraw-in + move, same tick):  ${JSON.stringify(bCap)}`);

    if (!aCap || !bCap) {
      console.log("\nINCONCLUSIVE - a probe never fired (creep never reached a fire phase). Bump the window.");
      process.exit(1);
    }

    const aStepped = aCap.x === 11 && aCap.y === 20;
    const bStepped = bCap.x === 11 && bCap.y === 25;
    const aFree = aCap.fatigue === 0;
    const bHeavy = typeof bCap.fatigue === "number" && bCap.fatigue > 0;

    console.log("\n--- verdict ---");
    console.log(`A stepped to (11,20): ${aStepped}; store after transfer = ${aCap.energy} (0 confirms transfer resolved)`);
    console.log(`B stepped to (11,25): ${bStepped}; store after withdraw  = ${bCap.energy} (>0 confirms withdraw resolved)`);
    console.log(`transfer resolves BEFORE movement fatigue?  ${aFree}   (A fatigue = ${aCap.fatigue}: 0=free / 6=heavy)`);
    console.log(`withdraw resolves BEFORE movement fatigue?   ${bHeavy}  (B fatigue = ${bCap.fatigue}: 6=heavy / 0=free)`);

    if (aFree && bHeavy) {
      console.log(
        "\nPINNED: store changes resolve before the movement phase.\n" +
          "  => Ring feeder rule: STEP on the tick you empty out (free), REFILL on arrival.\n" +
          "     Never withdraw on the same tick you depart - that step pays full fatigue."
      );
    } else {
      console.log("\nSURPRISE - engine ordering is not (transfer/withdraw before move). Re-derive the body math from these numbers.");
    }

    // Light pins so the script goes red if the engine ever surprises us.
    assertTrue(aStepped, "probe A must actually step");
    assertTrue(bStepped, "probe B must actually step");
    assertTrue(aCap.energy === 0, "probe A transfer must have emptied the creep");
    assertTrue(bCap.energy > 0, "probe B withdraw must have loaded the creep");
    assertTrue(aFree, "EXPECTED: same-tick transfer-out + move is a FREE step (fatigue 0)");
    assertTrue(bHeavy, "EXPECTED: same-tick withdraw-in + move is a HEAVY step (fatigue > 0)");
    console.log("\nAll pins held.");
  } finally {
    await server.stop();
  }
  process.exit(0);
}

// screeps-server-mockup exposes a bot handle from addBot; we re-read its Memory
// through the storage env the same way stage.ts / diag-concurrent do. Simplest
// robust path: keep the handle addBot returned.
let botHandle: any = null;
async function getBotMemory(): Promise<string> {
  if (botHandle) return (await botHandle.memory) as string;
  return "{}";
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`PIN FAILED: ${msg}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
