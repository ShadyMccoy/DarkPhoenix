/**
 * @fileoverview Hauler-fleet harness - observe the hauler fleet the REAL spawn
 * pipeline builds for a source's carry route.
 *
 * The sibling of the miner-fleet harness (spawnHarness). Hauler sizing is the
 * same kind of emergent result of three real pieces talking to each other:
 *   - CarryCorp.getSpawnDemand (how many haulers, each sized to the remaining
 *     carry need, with the 3-CARRY runt floor),
 *   - the scheduler (what it picks + how much energy it grants), and
 *   - SpawningCorp.buildBodyForRole (how the granted energy + ratio map to
 *     CARRY/MOVE parts).
 *
 * It drives the actual production code end-to-end: collectDemands (so the
 * director's grouping is real), scheduleSpawn, and SpawningCorp.executeSpawn -
 * the last via a captured fake spawn, so the body is built by the real
 * buildBodyForRole with no re-implementation. So whatever it reports is exactly
 * what the live colony would build for the same route - a diagnostic AND a
 * regression guard for hauler sizing while that logic is iterated on.
 *
 * @module test/unit/harness/haulerHarness
 */

import { setupGlobals, Game } from "../mock";
import { HarvestCorp } from "../../../src/corps/HarvestCorp";
import { CarryCorp } from "../../../src/corps/CarryCorp";
import { SpawningCorp } from "../../../src/corps/SpawningCorp";
import { MinerAssignment, HaulerAssignment } from "../../../src/flow/FlowTypes";
import { createCorpRegistry } from "../../../src/execution/CorpRunner";
import { collectDemands } from "../../../src/execution/SpawnDirector";
import { scheduleSpawn } from "../../../src/spawn/SpawnScheduler";

const SPAWN_ID = "spawn1";
const ROOM = "W1N1";
const SOURCE = "source-aaaa";

/** Inputs that define one hauling situation. */
export interface HaulerScenario {
  /** room.energyCapacityAvailable - the body the room *could* build. */
  energyCapacity: number;
  /** Spawn energy on hand each spawn. Defaults to a full spawn (energyCapacity). */
  energyAvailable?: number;
  /** Total CARRY parts the route needs (HaulerAssignment.carryParts). */
  carryParts: number;
  /** CARRY:MOVE ratio for the route (terrain hint). Default "1:1". */
  haulerRatio?: "2:1" | "1:1" | "1:2";
  /** Safety cap so a logic bug can't loop forever. */
  maxSpawns?: number;
}

/** What the scenario actually built. */
export interface HaulerFleet {
  /** CARRY parts of each hauler, spawn order, largest first. e.g. [5, 3]. */
  carryParts: number[];
  /** A label like "2 x 5 CARRY" / "5 CARRY + 3 CARRY". */
  shape: string;
}

interface FakeCreep {
  name: string;
  spawning: boolean;
  memory: { corpId: string; workType: string };
  getActiveBodyparts: (part: string) => number;
  store: { getCapacity: () => number };
}

/**
 * Spawn a route's hauler fleet out to completion and return what it built.
 *
 * Mirrors the director's per-tick step (collect demands -> schedule -> spawn) in
 * a loop until the CarryCorp stops asking. A miner is placed in the field first
 * so the source counts as "started" and withMinerPrecedence does not hold the
 * haulers back - this harness isolates the hauler-sizing question, not the
 * miner-before-hauler ordering (that is covered by the decision harness).
 */
export function simulateHaulerFleet(scenario: HaulerScenario): HaulerFleet {
  const {
    energyCapacity,
    energyAvailable = energyCapacity,
    carryParts,
    haulerRatio = "1:1",
    maxSpawns = 20
  } = scenario;

  setupGlobals();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const game = Game as any;
  const savedCreeps = game.creeps;
  const savedGetObjectById = game.getObjectById;
  game.creeps = {} as { [name: string]: FakeCreep };

  // SpawningCorp.executeSpawn logs each spawn; silence it so the harness stays
  // quiet (it is driving the real production path, not exercising logging).
  const savedLog = console.log;
  console.log = () => {};

  // A captured fake spawn: executeSpawn looks it up by id, checks energy, and
  // calls spawnCreep - which we intercept to record the body the real
  // buildBodyForRole produced (rather than actually spawning).
  let lastBody: string[] = [];
  let lastMemory: { corpId: string; workType: string } | null = null;
  const fakeSpawn = {
    id: SPAWN_ID,
    spawning: false,
    room: { energyAvailable, energyCapacityAvailable: energyCapacity, memory: {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnCreep: (body: string[], _name: string, opts: any) => {
      lastBody = body;
      lastMemory = opts?.memory;
      return OK;
    }
  };
  game.getObjectById = (id: string) => (id === SPAWN_ID ? fakeSpawn : null);

  try {
    const registry = createCorpRegistry();

    // Source's miner: already in the field (so the source is "started"), and the
    // HarvestCorp is satisfied (target met) so it emits no miner demand.
    const harvest = new HarvestCorp(`${ROOM}-harvest-${SOURCE}`, SPAWN_ID, SOURCE, 5, `mining-${SOURCE}`);
    harvest.setMinerAssignment({
      sourceId: SOURCE, spawnId: `spawn-${SPAWN_ID}`, harvestRate: 10, maxMiners: 1, efficiency: 80
    } as MinerAssignment);
    registry.harvestCorps[SOURCE] = harvest;
    game.creeps["miner-0"] = {
      name: "miner-0", spawning: false,
      memory: { corpId: `mining-${SOURCE}`, workType: "harvest" },
      getActiveBodyparts: (p: string) => (p === WORK ? 5 : 0),
      store: { getCapacity: () => 0 }
    } as FakeCreep;

    // The route's hauling corp.
    const carry = new CarryCorp(`${ROOM}-hauling-${SOURCE}`, SPAWN_ID, `hauling-${SOURCE}`);
    carry.setHaulerAssignments([
      { fromId: SOURCE, toId: "controller-x", carryParts, spawnId: `spawn-${SPAWN_ID}`, haulerRatio } as HaulerAssignment
    ]);
    registry.haulingCorps[SOURCE] = carry;

    const spawning = new SpawningCorp(`${ROOM}-spawning`, SPAWN_ID, energyCapacity);

    for (let i = 0; i < maxSpawns; i++) {
      const demands = collectDemands(registry, SPAWN_ID, { energyCapacity, tick: 100 + i });
      if (demands.length === 0) break; // corps satisfied - fleet complete
      const result = scheduleSpawn(demands, { energyAvailable, energyCapacity, energyIncome: 10, tick: 100 + i });
      if (!result) break; // scheduler chose to wait

      const ok = spawning.executeSpawn(
        result.demand.role,
        result.demand.buyerCorpId,
        result.energyBudget,
        100 + i,
        result.demand.bodyParam,
        result.demand.haulerRatio,
        result.demand.bodyStrategy
      );
      if (!ok || lastMemory === null) break;

      const carryCount = lastBody.filter(p => p === CARRY).length;
      const memory = lastMemory;
      const body = lastBody;
      game.creeps[`hauler-${i}`] = {
        name: `hauler-${i}`,
        spawning: false,
        memory,
        getActiveBodyparts: (p: string) => body.filter(b => b === p).length,
        store: { getCapacity: () => carryCount * 50 }
      } as FakeCreep;
    }

    const fleet = Object.values(game.creeps as { [n: string]: FakeCreep })
      .filter(c => c.memory.workType === "haul")
      .map(c => c.getActiveBodyparts(CARRY))
      .sort((a, b) => b - a);
    return { carryParts: fleet, shape: summarize(fleet) };
  } finally {
    game.creeps = savedCreeps;
    game.getObjectById = savedGetObjectById;
    console.log = savedLog;
  }
}

/** "2 x 5 CARRY", "1 x 3 CARRY", or "5 CARRY + 3 CARRY" for mixed fleets. */
function summarize(carry: number[]): string {
  if (carry.length === 0) return "no haulers";
  const allSame = carry.every(c => c === carry[0]);
  if (allSame) return `${carry.length} x ${carry[0]} CARRY`;
  return carry.map(c => `${c} CARRY`).join(" + ");
}
