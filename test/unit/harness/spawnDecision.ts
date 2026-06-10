/**
 * @fileoverview Spawn-decision harness - freeze "what does the colony spawn
 * NEXT?" as a fast, server-free assertion.
 *
 * The choice of the next creep is an emergent result of three real pieces:
 *   - each corp's getSpawnDemand (count, sizing, value, blocking flags),
 *   - the director's collectDemands grouping (groupId / groupStarted, the
 *     "fund one income unit fully" bookkeeping), and
 *   - the scheduler (withMinerPrecedence + effectiveValue ranking + the
 *     wait-for-blocking / affordability decision).
 *
 * Bugs hide in the *seams* between them - e.g. a miner that stopped counting as
 * "blocking" while a bootstrap jack was alive, so the upgrader out-ranked it and
 * the colony never handed off from bootstrap to the flow economy. A pure
 * scheduler test can't catch that: it feeds the scheduler synthetic demands and
 * so bypasses the demand-generation logic where the bug lived.
 *
 * This harness wires the REAL pieces together (HarvestCorp, CarryCorp,
 * UpgradingCorp, the exported collectDemands, scheduleSpawn) over a tiny
 * declarative situation and reports the single creep the live director would
 * spawn next - so a test can assert "next = miner of source A" in milliseconds.
 *
 * @module test/unit/harness/spawnDecision
 */

import { setupGlobals, Game } from "../mock";
import { HarvestCorp } from "../../../src/corps/HarvestCorp";
import { CarryCorp } from "../../../src/corps/CarryCorp";
import { UpgradingCorp } from "../../../src/corps/UpgradingCorp";
import { MinerAssignment, HaulerAssignment, SinkAllocation } from "../../../src/flow/FlowTypes";
import { createCorpRegistry } from "../../../src/execution/CorpRunner";
import { collectDemands } from "../../../src/execution/SpawnDirector";
import { scheduleSpawn } from "../../../src/spawn/SpawnScheduler";

/** The one spawn every corp in a situation spawns from. */
const SPAWN_ID = "spawn1";
const ROOM = "W1N1";

/** A live creep to place in Game.creeps for the situation. */
export interface SituationCreep {
  /** corpId tying the creep to its corp (e.g. "mining-A", "hauling-A", "bootstrap-W1N1"). */
  corpId: string;
  /** "harvest" | "haul" | ... - the workType the corp's creep-count scan matches on. */
  workType: string;
  /** WORK parts (miners) - drives size-based logic. */
  work?: number;
  /** CARRY parts (haulers) - drives store capacity. */
  carry?: number;
}

/** A source that has a flow HarvestCorp (and optionally a CarryCorp). */
export interface SituationSource {
  /** Source id; the registry key and the suffix of the corp ids. */
  id: string;
  /** Source output e/tick (5 remote, 10 owned). Default 10. */
  harvestRate?: number;
  /** Mining spots around the source. Default 1. */
  maxMiners?: number;
  /** Flow efficiency (affects miner demand value only). Default 80. */
  efficiency?: number;
  /** CARRY parts this source's haulers should staff. Omit for no hauling corp. */
  haulCarry?: number;
}

/** A declarative spawn moment. */
export interface SpawnSituation {
  /** Spawn energy on hand right now. */
  energyAvailable: number;
  /** Room energy capacity (spawn + extensions). Default = energyAvailable. */
  energyCapacity?: number;
  /** Estimated income e/tick (gates wait-for-blocking). Default 10. */
  energyIncome?: number;
  /** Sources with a flow mining (and optional hauling) corp. */
  sources?: SituationSource[];
  /** Whether the room has an upgrading corp wanting energy. Default false. */
  upgrader?: boolean;
  /** Live creeps already in the field. Default none. */
  creeps?: SituationCreep[];
  /** Current tick (for aging). Default 100. */
  tick?: number;
}

/** The director's decision for the situation. */
export interface SpawnDecision {
  /** Role of the next creep, or null if the director would spawn nothing. */
  role: string | null;
  /** Owning corp id of the next creep. */
  buyerCorpId: string | null;
  /** Scheduler's human-readable reason (or null when nothing is spawned). */
  reason: string | null;
}

function fakeCreep(c: SituationCreep, idx: number): any {
  const work = c.work ?? 0;
  const carry = c.carry ?? 0;
  return {
    name: `${c.corpId}-${idx}`,
    spawning: false,
    memory: { corpId: c.corpId, workType: c.workType },
    getActiveBodyparts: (part: string) => (part === WORK ? work : part === CARRY ? carry : 0),
    store: { getCapacity: () => carry * 50 }
  };
}

/**
 * Resolve the single creep the live SpawnDirector would spawn next for the
 * situation, by running the real collectDemands + scheduleSpawn over a registry
 * of real corps. Pure apart from the shared global Game.creeps, which it saves
 * and restores.
 */
export function decideNextSpawn(situation: SpawnSituation): SpawnDecision {
  setupGlobals();

  const energyCapacity = situation.energyCapacity ?? situation.energyAvailable;
  const tick = situation.tick ?? 100;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const game = Game as any;
  const savedCreeps = game.creeps;
  game.creeps = {};
  (situation.creeps ?? []).forEach((c, i) => {
    const creep = fakeCreep(c, i);
    game.creeps[creep.name] = creep;
  });

  try {
    const registry = createCorpRegistry();

    for (const src of situation.sources ?? []) {
      const harvest = new HarvestCorp(`${ROOM}-harvest-${src.id}`, SPAWN_ID, src.id, 5, `mining-${src.id}`);
      harvest.setMinerAssignment({
        sourceId: src.id,
        spawnId: `spawn-${SPAWN_ID}`,
        harvestRate: src.harvestRate ?? 10,
        maxMiners: src.maxMiners ?? 1,
        efficiency: src.efficiency ?? 80
      } as MinerAssignment);
      registry.harvestCorps[src.id] = harvest;

      if (src.haulCarry !== undefined) {
        const carry = new CarryCorp(`${ROOM}-hauling-${src.id}`, SPAWN_ID, `hauling-${src.id}`);
        carry.setHaulerAssignments([
          { fromId: src.id, carryParts: src.haulCarry, spawnId: `spawn-${SPAWN_ID}`, haulerRatio: "1:1" } as HaulerAssignment
        ]);
        registry.haulingCorps[src.id] = carry;
      }
    }

    if (situation.upgrader) {
      const up = new UpgradingCorp(`${ROOM}-upgrading`, SPAWN_ID);
      up.setSinkAllocation({
        sinkId: "controller-x", sinkType: "controller", allocated: 5, demand: 5, unmet: 0, priority: 65
      } as SinkAllocation);
      registry.upgradingCorps[ROOM] = up;
    }

    const demands = collectDemands(registry, SPAWN_ID, { energyCapacity, tick });
    const result = scheduleSpawn(demands, {
      energyAvailable: situation.energyAvailable,
      energyCapacity,
      energyIncome: situation.energyIncome ?? 10,
      tick
    });

    if (!result) return { role: null, buyerCorpId: null, reason: null };
    return { role: result.demand.role, buyerCorpId: result.demand.buyerCorpId, reason: result.reason };
  } finally {
    game.creeps = savedCreeps;
  }
}
