/**
 * @fileoverview Spawn director - drives the demand-driven spawn pipeline.
 *
 * Each tick, for every owned spawn, the director:
 *   1. collects SpawnDemands from the corps that spawn there (getSpawnDemand),
 *   2. stamps anti-starvation aging timestamps,
 *   3. estimates current energy income,
 *   4. asks the {@link scheduleSpawn} scheduler for the single best creep to
 *      spawn, and
 *   5. tells the SpawningCorp to build + spawn it.
 *
 * This replaces the old requestFlowCreeps + fixed-priority queue machinery.
 *
 * @module execution/SpawnDirector
 */

import "../types/Memory";
import { ScheduleContext, SpawnDemand, SpawnDemandContext, scheduleSpawn } from "../spawn/SpawnScheduler";
import { CorpRegistry } from "./CorpRunner";

/**
 * Below this RCL the flow economy stands aside and lets the bootstrap corp
 * drive RCL 1 -> 2. At RCL 1 a room has only 300 energy capacity and energy
 * trickles in via a single jack; spending it on the flow economy starves the
 * spawn so the bootstrap jack never reaches its upgrade branch.
 */
const FLOW_MIN_RCL = 2;

/**
 * Run the demand-driven spawn scheduler for all owned spawns.
 */
export function runSpawnScheduling(registry: CorpRegistry): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    // Let bootstrap own the very early game.
    if (room.controller.level < FLOW_MIN_RCL) continue;

    const income = estimateIncome(registry, room);

    for (const spawn of spawns) {
      const spawningCorp = registry.spawningCorps[spawn.id];
      if (!spawningCorp) continue;
      if (spawn.spawning) continue;

      const demandCtx: SpawnDemandContext = {
        energyCapacity: room.energyCapacityAvailable,
        tick: Game.time
      };

      const demands = collectDemands(registry, spawn.id, demandCtx);
      if (demands.length === 0) continue;

      const ctx: ScheduleContext = {
        energyAvailable: room.energyAvailable,
        energyCapacity: room.energyCapacityAvailable,
        energyIncome: income,
        tick: Game.time
      };

      const result = scheduleSpawn(demands, ctx);
      if (!result) continue;

      const d = result.demand;
      spawningCorp.executeSpawn(
        d.role,
        d.buyerCorpId,
        result.energyBudget,
        Game.time,
        d.bodyParam,
        d.haulerRatio,
        d.bodyStrategy
      );
    }
  }
}

/**
 * Collect spawn demands from every corp that spawns at the given spawn.
 *
 * A source's miner (harvestCorps[id]) and that source's haulers (haulingCorps[id])
 * are both keyed by the same source id, so they form one *income unit* (groupId
 * = source id). A unit is "started" once the source has a miner in the field;
 * from then on its remaining demands (its haulers, any second miner) are flagged
 * groupStarted so the scheduler finishes funding that source before opening a
 * fresh one - the "fund one corp fully, then move on" strategy.
 *
 * Exported so the spawn-decision harness can drive the real grouping logic (not
 * a re-implementation) when freezing "what spawns next" regression moments.
 */
export function collectDemands(registry: CorpRegistry, spawnId: string, ctx: SpawnDemandContext): SpawnDemand[] {
  const demands: SpawnDemand[] = [];

  for (const id in registry.harvestCorps) {
    const c = registry.harvestCorps[id];
    if (c.getSpawnId() !== spawnId) continue;
    const started = sourceHasMiner(registry, id);
    for (const d of c.getSpawnDemand(ctx)) {
      d.groupId = id;
      d.groupStarted = started;
      demands.push(d);
    }
  }
  for (const id in registry.haulingCorps) {
    const c = registry.haulingCorps[id];
    if (c.getSpawnId() !== spawnId) continue;
    const started = sourceHasMiner(registry, id);
    for (const d of c.getSpawnDemand(ctx)) {
      d.groupId = id;
      d.groupStarted = started;
      demands.push(d);
    }
  }
  for (const id in registry.upgradingCorps) {
    const c = registry.upgradingCorps[id];
    if (c.getSpawnId() === spawnId) demands.push(...c.getSpawnDemand(ctx));
  }
  for (const id in registry.constructionCorps) {
    const c = registry.constructionCorps[id];
    if (c.getSpawnId() === spawnId) demands.push(...c.getSpawnDemand(ctx));
  }
  for (const id in registry.reservationCorps) {
    const c = registry.reservationCorps[id];
    if (c.getSpawnId() === spawnId) demands.push(...c.getSpawnDemand(ctx));
  }

  return demands;
}

/**
 * True once a source's income unit is underway: it already has a miner in the
 * field, so the energy is being produced and what remains is to finish hauling
 * it home. Keyed by source id (the registry key shared by the source's harvest
 * and hauling corps).
 */
function sourceHasMiner(registry: CorpRegistry, sourceId: string): boolean {
  const harvest = registry.harvestCorps[sourceId];
  return !!harvest && harvest.getCreepCount() > 0;
}

/**
 * Crude estimate of energy delivery into the spawn network: any hauler or
 * bootstrap jack counts as a deliverer. The scheduler only needs a
 * positive/zero signal (whether it is safe to wait for a blocking demand to
 * become affordable, versus needing to spawn an income producer first).
 */
function estimateIncome(registry: CorpRegistry, room: Room): number {
  let deliverers = 0;
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (creep.room.name !== room.name) continue;
    if (creep.memory.workType === "haul") deliverers++;
  }
  const bootstrap = registry.bootstrapCorps[room.name];
  if (bootstrap) deliverers += bootstrap.getCreepCount();
  return deliverers * 10;
}
