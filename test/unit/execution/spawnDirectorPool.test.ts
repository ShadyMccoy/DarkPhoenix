/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * runSpawnScheduling - the POOLED assignment loop (owner 2026-07-25: spawn
 * distribution is not per-spawn). A room's spawns share one demand pool; each
 * free spawn pulls the next-best affordable demand, routed to the spawn nearest
 * its work site, and the shared bank is decremented so the second spawn only
 * buys what the first left affordable. This is the one part of the pool that is
 * NOT exercised by the (single-spawn) collectDemands/scheduleSpawn pins, so it
 * gets its own coverage here.
 */

import { expect } from "chai";
import { setupGlobals, Game } from "../mock";
import { runSpawnScheduling } from "../../../src/execution/SpawnDirector";
import { createCorpRegistry } from "../../../src/execution/CorpRunner";
import { resetCommissionHost, seedCommissionStoreForTest } from "../../../src/execution/CommissionHost";
import { ExtensionTenderCorp } from "../../../src/corps/ExtensionTenderCorp";
import { SpawnDemand } from "../../../src/spawn/SpawnScheduler";

const ROOM = "W1N1";

interface Built {
  spawn: string;
  buyer: string;
  budget: number;
}

/** A two-spawn room whose spawns share one bank; executeSpawn is spied. */
function twoSpawnWorld(energyAvailable: number): { registry: any; built: Built[] } {
  const spawns = [
    { id: "spawnA", name: "spawnA", pos: { x: 10, y: 25, roomName: ROOM }, spawning: null },
    { id: "spawnB", name: "spawnB", pos: { x: 40, y: 25, roomName: ROOM }, spawning: null }
  ];
  const room: any = {
    name: ROOM,
    controller: { my: true, level: 5 },
    energyAvailable,
    energyCapacityAvailable: 5600,
    storage: undefined,
    find: (type: number) => (type === (global as any).FIND_MY_SPAWNS ? spawns : [])
  };
  Game.rooms = { [ROOM]: room } as any;
  Game.creeps = {} as any;

  const built: Built[] = [];
  const registry = createCorpRegistry();
  for (const s of spawns) {
    registry.spawningCorps[s.id] = {
      // Faithful to the real executor's affordability gate: no creep if the
      // bank can't cover the granted budget (that is what the decrement guards).
      executeSpawn: (_k: string, _r: string, buyer: string, budget: number) => {
        if (room.energyAvailable < budget) return false;
        built.push({ spawn: s.id, buyer, budget });
        return true;
      }
    } as any;
  }
  return { registry, built };
}

/** A tender corp anchored to `spawnId`, working near `workX`, asking for one
 *  affordable creep at `value`. */
function tenderAt(id: string, spawnId: string, workX: number, value: number, cost: number): ExtensionTenderCorp {
  const corp = new ExtensionTenderCorp(`${ROOM}-${id}`, spawnId);
  (corp as any).getPosition = () => ({ x: workX, y: 25, roomName: ROOM });
  const demand: SpawnDemand = {
    buyerCorpId: corp.id,
    role: "tanker",
    value,
    blocking: false,
    producesIncome: false,
    desiredCost: cost,
    minCost: cost,
    since: 0
  };
  (corp as any).getSpawnDemand = () => [demand];
  seedCommissionStoreForTest(`tender-${id}`, "tender", corp);
  return corp;
}

describe("runSpawnScheduling - pooled two-spawn assignment", () => {
  beforeEach(() => {
    setupGlobals();
    resetCommissionHost();
    Memory.spawnDemandFirstSeen = {};
    Memory.spawnAgenda = {};
  });
  afterEach(() => resetCommissionHost());

  it("both free spawns buy in one tick - two DISTINCT demands, no double-buy", () => {
    const { registry, built } = twoSpawnWorld(5600);
    // Two affordable demands; each is nearest a different spawn.
    tenderAt("A", "spawnA", 12, 100, 800); // near spawnA
    tenderAt("B", "spawnB", 38, 90, 800); // near spawnB

    runSpawnScheduling(registry);

    expect(built.length, "both spawns built").to.equal(2);
    expect(new Set(built.map(b => b.buyer)).size, "two distinct buyers - no double-buy").to.equal(2);
    // Distance term: each demand went to the spawn nearest its work site.
    const bySpawn = new Map(built.map(b => [b.spawn, b.buyer]));
    expect(bySpawn.get("spawnA")).to.contain("A");
    expect(bySpawn.get("spawnB")).to.contain("B");
  });

  it("energy-tight tick: the bank funds ONE body, so only one spawn buys (no over-commit)", () => {
    // Bank affords exactly one 800 body. Without the running decrement the
    // second spawn would plan against the full 800 too, commit, and leave a
    // phantom receipt; with it, the second spawn sees 0 left and holds.
    const { registry, built } = twoSpawnWorld(800);
    tenderAt("A", "spawnA", 12, 100, 800);
    tenderAt("B", "spawnB", 38, 90, 800);

    runSpawnScheduling(registry);

    expect(built.length, "only one spawn buys on a one-body bank").to.equal(1);
    expect(built[0].buyer, "the higher-value demand wins the single slot").to.contain("A");
  });

  it("a BUSY spawn's share is served by the free one (self-balance across the pool)", () => {
    const { registry, built } = twoSpawnWorld(5600);
    // Mark spawnB busy: its former demand must still be served - by spawnA.
    (Game.rooms[ROOM] as any).find = (type: number) =>
      type === (global as any).FIND_MY_SPAWNS
        ? [
            { id: "spawnA", name: "spawnA", pos: { x: 10, y: 25, roomName: ROOM }, spawning: null },
            { id: "spawnB", name: "spawnB", pos: { x: 40, y: 25, roomName: ROOM }, spawning: { name: "x" } }
          ]
        : [];
    tenderAt("B", "spawnB", 38, 100, 800); // anchored to the BUSY spawn

    runSpawnScheduling(registry);

    // The only free spawn (A) builds the busy spawn's demand - it isn't stranded.
    expect(built.length).to.equal(1);
    expect(built[0].spawn).to.equal("spawnA");
    expect(built[0].buyer).to.contain("B");
  });
});
