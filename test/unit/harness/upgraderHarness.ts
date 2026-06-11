/**
 * @fileoverview Upgrader-fleet harness - observe the upgrader fleet the REAL
 * spawn pipeline builds for a controller's energy allocation.
 *
 * The third sibling of the miner- and hauler-fleet harnesses (the spawnHarness
 * doc anticipates it). Upgrader staffing is an emergent result of the real
 * pieces: UpgradingCorp.getSpawnDemand (the #59 "no flow upgrader until a hauler
 * delivers" gate; the count sized to the controller allocation; the #62
 * scale-down while a source is dedicated to an active build), the scheduler, and
 * SpawningCorp.buildBodyForRole. It drives that production code end-to-end -
 * collectDemands, scheduleSpawn, executeSpawn via a captured fake spawn - so the
 * fleet it reports is exactly what the live colony would staff.
 *
 * @module test/unit/harness/upgraderHarness
 */

import { setupGlobals, Game, FIND_MY_CREEPS, FIND_SOURCES } from "../mock";
import { UpgradingCorp } from "../../../src/corps/UpgradingCorp";
import { SpawningCorp } from "../../../src/corps/SpawningCorp";
import { SinkAllocation } from "../../../src/flow/FlowTypes";
import { createCorpRegistry } from "../../../src/execution/CorpRunner";
import { collectDemands } from "../../../src/execution/SpawnDirector";
import { scheduleSpawn } from "../../../src/spawn/SpawnScheduler";

const SPAWN_ID = "spawn1";
const ROOM = "W1N1";

/** Inputs that define one upgrading situation. */
export interface UpgraderScenario {
  /** room.energyCapacityAvailable - the body the room *could* build. */
  energyCapacity: number;
  /** Spawn energy on hand each spawn. Defaults to a full spawn (energyCapacity). */
  energyAvailable?: number;
  /** Controller energy/tick the plan allocated to upgrading (SinkAllocation.allocated). */
  allocated: number;
  /** Number of sources in the room (matters only with an active build). Default 1. */
  sources?: number;
  /** Is a source dedicated to an active build? Scales the upgrader allocation (#62). */
  dedicatedBuild?: boolean;
  /** Is a real flow hauler delivering? The #59 gate stands upgraders down without one. Default true. */
  hauler?: boolean;
  /** Safety cap so a logic bug can't loop forever. */
  maxSpawns?: number;
}

/** What the scenario actually built. */
export interface UpgraderFleet {
  /** WORK parts of each upgrader, spawn order, largest first. */
  workParts: number[];
  /** Total WORK across the fleet (the controller-consuming capacity it staffs). */
  totalWork: number;
  /** Number of upgraders. */
  count: number;
  /** A label like "2 x 4 WORK" / "4 WORK + 2 WORK" / "no upgraders". */
  shape: string;
}

interface FakeCreep {
  name: string;
  spawning: boolean;
  memory: { corpId: string; workType: string };
  getActiveBodyparts: (part: string) => number;
}

/**
 * Spawn a controller's upgrader fleet out to completion and return what it built.
 * Mirrors the director's per-tick step (collect -> schedule -> spawn) in a loop
 * until the UpgradingCorp stops asking.
 */
export function simulateUpgraderFleet(scenario: UpgraderScenario): UpgraderFleet {
  const {
    energyCapacity,
    energyAvailable = energyCapacity,
    allocated,
    sources = 1,
    dedicatedBuild = false,
    hauler = true,
    maxSpawns = 20
  } = scenario;

  setupGlobals();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const game = Game as any;
  const savedCreeps = game.creeps;
  const savedGetObjectById = game.getObjectById;
  const savedLog = console.log;
  game.creeps = {} as { [name: string]: FakeCreep };
  console.log = () => {};

  // A real hauler in the field opens the #59 supply-before-demand gate.
  if (hauler) {
    game.creeps["hauler-0"] = {
      name: "hauler-0", spawning: false,
      memory: { corpId: "hauling-src", workType: "haul" },
      getActiveBodyparts: () => 0
    } as FakeCreep;
  }

  let lastBody: string[] = [];
  let lastMemory: { corpId: string; workType: string } | null = null;
  const fakeSpawn = {
    id: SPAWN_ID,
    spawning: false,
    room: {
      name: ROOM,
      energyAvailable,
      energyCapacityAvailable: energyCapacity,
      // No controller -> the corp uses its mobile (no-buffer) strategy.
      controller: undefined,
      memory: dedicatedBuild ? { dedicatedBuildSourceId: "src-build" } : {},
      find: (type: number) => {
        if (type === FIND_MY_CREEPS) return Object.values(game.creeps);
        if (type === FIND_SOURCES) return Array.from({ length: sources }, () => ({}));
        return [];
      }
    },
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
    const corp = new UpgradingCorp(`${ROOM}-upgrading`, SPAWN_ID, `upgrading-${ROOM}`);
    corp.setSinkAllocation({
      sinkId: "controller-x", sinkType: "controller", allocated, demand: allocated, unmet: 0, priority: 65
    } as SinkAllocation);
    registry.upgradingCorps[ROOM] = corp;

    const spawning = new SpawningCorp(`${ROOM}-spawning`, SPAWN_ID, energyCapacity);

    for (let i = 0; i < maxSpawns; i++) {
      const demands = collectDemands(registry, SPAWN_ID, { energyCapacity, tick: 100 + i });
      if (demands.length === 0) break; // corp satisfied (or gated) - fleet complete
      const result = scheduleSpawn(demands, { energyAvailable, energyCapacity, energyIncome: 10, tick: 100 + i });
      if (!result) break;

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

      const workCount = lastBody.filter(p => p === WORK).length;
      const memory = lastMemory;
      const body = lastBody;
      game.creeps[`upgrader-${i}`] = {
        name: `upgrader-${i}`,
        spawning: false,
        memory,
        getActiveBodyparts: (p: string) => body.filter(b => b === p).length
      } as FakeCreep;
    }

    const work = Object.values(game.creeps as { [n: string]: FakeCreep })
      .filter(c => c.memory.workType === "upgrade")
      .map(c => c.getActiveBodyparts(WORK))
      .sort((a, b) => b - a);
    return { workParts: work, totalWork: work.reduce((s, w) => s + w, 0), count: work.length, shape: summarize(work) };
  } finally {
    game.creeps = savedCreeps;
    game.getObjectById = savedGetObjectById;
    console.log = savedLog;
  }
}

/** "2 x 4 WORK", "1 x 5 WORK", or "4 WORK + 2 WORK" for mixed fleets. */
function summarize(work: number[]): string {
  if (work.length === 0) return "no upgraders";
  const allSame = work.every(w => w === work[0]);
  if (allSame) return `${work.length} x ${work[0]} WORK`;
  return work.map(w => `${w} WORK`).join(" + ");
}
