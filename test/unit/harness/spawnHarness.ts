/**
 * @fileoverview Spawn harness - drive the REAL spawn pipeline to observe the
 * creep fleet a scenario actually produces.
 *
 * The miner-sizing question ("why are remote mines 2 miners x 2 WORK?") is hard
 * to answer by reading code because the fleet is an emergent result of three
 * pieces talking to each other: a corp's getSpawnDemand (count + sizing), the
 * scheduler (what it picks + how much energy it grants), and the body builder
 * (how the granted energy maps to parts). This harness wires those three real
 * pieces together and "spawns out" a scenario - looping demand -> schedule ->
 * materialize until the corp stops asking - then hands back the fleet it built.
 *
 * It deliberately uses production code (no re-implementation): HarvestCorp,
 * scheduleSpawn, buildMinerBody. So whatever it prints is exactly what the live
 * colony would build for the same inputs - which makes it a diagnostic *and* a
 * regression guard. This file is the template for sibling harnesses (haulers,
 * upgraders) as we build the economy up.
 *
 * @module test/unit/harness/spawnHarness
 */

import { HarvestCorp } from "../../../src/corps/HarvestCorp";
import { buildMinerBody } from "../../../src/spawn/BodyBuilder";
import { scheduleSpawn } from "../../../src/spawn/SpawnScheduler";
import { MinerAssignment } from "../../../src/flow/FlowTypes";

/** Inputs that define one mining situation. */
export interface MinerScenario {
  /** room.energyCapacityAvailable - the body the room *could* build. */
  energyCapacity: number;
  /**
   * Spawn energy actually on hand each time a miner is spawned. Defaults to a
   * full spawn (energyCapacity) - the steady-state "spawn refilled between
   * miners" case. Lower it to model a cold/drained spawn.
   */
  energyAvailable?: number;
  /** Source output in energy/tick (5 = unowned remote 1500/300, 10 = owned 3000/300). */
  harvestRate: number;
  /** Mining spots around the source (countMiningSpots) - the count cap. */
  maxMiners: number;
  /** Source efficiency from the flow solver (affects demand value only). */
  efficiency?: number;
  /** Safety cap so a logic bug can't loop forever. */
  maxSpawns?: number;
}

/** What the scenario actually built. */
export interface MinerFleet {
  /** WORK parts of each miner, in spawn order. e.g. [2, 2] is the 2x2 split. */
  workParts: number[];
  /** Convenience: a label like "2 x 2 WORK" / "1 x 3 WORK". */
  shape: string;
}

interface FakeCreep {
  name: string;
  spawning: boolean;
  memory: { corpId: string; workType: string };
  getActiveBodyparts: (part: string) => number;
}

const HARNESS_CORP_ID = "harness-harvest";

/** Build a HarvestCorp wired to a single source with the given assignment. */
function makeMinerCorp(harvestRate: number, maxMiners: number, efficiency: number): HarvestCorp {
  const corp = new HarvestCorp("W1N1-harvest-aaaa", "spawn1", "source-aaaa", 5, HARNESS_CORP_ID);
  corp.setMinerAssignment({
    sourceId: "source-aaaa",
    spawnId: "spawn-spawn1",
    harvestRate,
    maxMiners,
    efficiency,
  } as MinerAssignment);
  return corp;
}

/**
 * Run the director's per-tick spawn step in a loop until the corp stops asking,
 * materializing each granted miner into game.creeps. Returns the number spawned.
 */
function spawnOut(
  corp: HarvestCorp,
  game: { creeps: { [n: string]: FakeCreep } },
  energyCapacity: number,
  energyAvailable: number,
  maxSpawns: number
): void {
  const tick = 100;
  for (let i = 0; i < maxSpawns; i++) {
    const demands = corp.getSpawnDemand({ energyCapacity, tick });
    if (demands.length === 0) break; // corp satisfied - fleet complete

    // The director stamps grouping for the fund-one-fully strategy; replicate it
    // so the scheduler sees the same demand the live pipeline would.
    const started = corp.getCreepCount() > 0;
    for (const d of demands) {
      d.groupId = "source-aaaa";
      d.groupStarted = started;
    }

    const result = scheduleSpawn(demands, { energyAvailable, energyCapacity, energyIncome: 10, tick });
    if (!result) break; // scheduler chose to wait - nothing to materialize

    const desiredWork = result.demand.bodyParam ?? 5;
    const workParts = buildMinerBody(desiredWork, result.energyBudget).workParts;
    if (workParts === 0) break; // can't build anything - avoid an infinite loop

    const name = `miner-${Object.keys(game.creeps).length}`;
    game.creeps[name] = {
      name,
      spawning: false,
      memory: { corpId: HARNESS_CORP_ID, workType: "harvest" },
      getActiveBodyparts: (part: string) => (part === WORK ? workParts : 0),
    } as FakeCreep;
  }
}

function fleetWorkParts(game: { creeps: { [n: string]: FakeCreep } }): number[] {
  return Object.values(game.creeps)
    .filter((c) => c.memory.corpId === HARNESS_CORP_ID)
    .map((c) => c.getActiveBodyparts(WORK))
    .sort((a, b) => b - a);
}

/**
 * Spawn a scenario out to completion and return the miner fleet it produced.
 *
 * Mirrors what SpawnDirector does for one spawn each tick - collect the corp's
 * demand, run the scheduler, and (if it grants a spawn) materialize the creep -
 * but compresses it into a loop that runs until the corp is satisfied. Each
 * materialized miner is registered in Game.creeps so the corp's own
 * getTotalCreepCount / colonyHasMiner see it on the next pass, exactly as live.
 */
export function simulateMinerFleet(scenario: MinerScenario): MinerFleet {
  const {
    energyCapacity,
    energyAvailable = energyCapacity,
    harvestRate,
    maxMiners,
    efficiency = 80,
    maxSpawns = 20,
  } = scenario;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const game = (global as any).Game;
  const savedCreeps = game.creeps;
  game.creeps = {} as { [name: string]: FakeCreep };

  try {
    const corp = makeMinerCorp(harvestRate, maxMiners, efficiency);
    spawnOut(corp, game, energyCapacity, energyAvailable, maxSpawns);
    const work = fleetWorkParts(game);
    return { workParts: work, shape: summarize(work) };
  } finally {
    game.creeps = savedCreeps;
  }
}

/** Outcome of growing a room out from under an already-spawned fleet. */
export interface MinerTransition {
  /** The fleet spawned while the room was cold. */
  cold: MinerFleet;
  /**
   * After raising capacity, how many NEW miners the demand path asks for. Zero
   * means the demand path neither grows nor consolidates the existing fleet -
   * whatever was spawned cold is now frozen in (only recycling could fix it).
   */
  newDemandWhenWarm: number;
  /** The fleet still standing after the room warmed up (demand path only). */
  warm: MinerFleet;
}

/**
 * Spawn a fleet while the room is cold, then raise capacity and ask the demand
 * path what it wants now. Models the real lifecycle: remotes get claimed at the
 * RCL2 transition (low capacity), then the home room fills its extensions. This
 * isolates whether the over-split "heals" once the room can afford a big miner -
 * or stays frozen in because the corp no longer asks for anything.
 */
export function simulateColdThenWarm(scenario: {
  coldCapacity: number;
  warmCapacity: number;
  harvestRate: number;
  maxMiners: number;
  efficiency?: number;
  maxSpawns?: number;
}): MinerTransition {
  const { coldCapacity, warmCapacity, harvestRate, maxMiners, efficiency = 80, maxSpawns = 20 } = scenario;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const game = (global as any).Game;
  const savedCreeps = game.creeps;
  game.creeps = {} as { [name: string]: FakeCreep };

  try {
    const corp = makeMinerCorp(harvestRate, maxMiners, efficiency);

    // Phase 1: cold spawn (spawn only ever as full as the cold room).
    spawnOut(corp, game, coldCapacity, coldCapacity, maxSpawns);
    const coldWork = fleetWorkParts(game);

    // Phase 2: room has grown. What does the demand path want now?
    const started = corp.getCreepCount() > 0;
    const warmDemands = corp.getSpawnDemand({ energyCapacity: warmCapacity, tick: 100 });
    for (const d of warmDemands) {
      d.groupId = "source-aaaa";
      d.groupStarted = started;
    }
    const newDemandWhenWarm = warmDemands.length;

    // Let it actually spawn whatever it now wants, to see the resulting fleet.
    spawnOut(corp, game, warmCapacity, warmCapacity, maxSpawns);
    const warmWork = fleetWorkParts(game);

    return {
      cold: { workParts: coldWork, shape: summarize(coldWork) },
      newDemandWhenWarm,
      warm: { workParts: warmWork, shape: summarize(warmWork) },
    };
  } finally {
    game.creeps = savedCreeps;
  }
}

/** "2 x 2 WORK", "1 x 3 WORK", or "3 WORK + 2 WORK" for mixed fleets. */
function summarize(work: number[]): string {
  if (work.length === 0) return "no miners";
  const allSame = work.every((w) => w === work[0]);
  if (allSame) return `${work.length} x ${work[0]} WORK`;
  return work.map((w) => `${w} WORK`).join(" + ");
}
