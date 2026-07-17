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
import {
  ScheduleContext,
  SpawnDemand,
  SpawnDemandContext,
  buildAgendaQueue,
  scheduleSpawn
} from "../spawn/SpawnScheduler";
import { record as blackBox } from "../telemetry/BlackBox";
import { CorpRegistry } from "./CorpRunner";
import { commissionedCorpsOfKind } from "./CommissionHost";
import { ReservationCorp } from "../corps/ReservationCorp";
import { RaidGuardCorp } from "../corps/RaidGuardCorp";
import { CoreBusterCorp } from "../corps/CoreBusterCorp";
import { ExtensionTenderCorp } from "../corps/ExtensionTenderCorp";
import { ControllerFeederCorp } from "../corps/ControllerFeederCorp";
import { HarvestCorp } from "../corps/HarvestCorp";
import { CarryCorp } from "../corps/CarryCorp";
import { UpgradingCorp } from "../corps/UpgradingCorp";
import { ConstructionCorp } from "../corps/ConstructionCorp";
import { ClaimCorp } from "../corps/ClaimCorp";

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
  // First tick each still-unmet demand was seen, persisted across ticks so the
  // scheduler can age a chronically-outranked demand (see scheduleSpawn's
  // anti-starvation backstop). Pruned below for the spawns we actually evaluate.
  const firstSeen = Memory.spawnDemandFirstSeen ?? (Memory.spawnDemandFirstSeen = {});
  const seenThisTick = new Set<string>();
  const evaluatedSpawns = new Set<string>();

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
      // Skip a busy spawn WITHOUT touching its demand timers: a room whose spawn
      // is forever occupied with income is exactly where a starved builder must
      // keep ageing, so don't reset its clock just because we can't act this tick.
      if (spawn.spawning) continue;
      evaluatedSpawns.add(spawn.id);

      const demandCtx: SpawnDemandContext = {
        energyCapacity: room.energyCapacityAvailable,
        tick: Game.time
      };

      const demands = collectDemands(registry, spawn.id, demandCtx);
      // Stamp each demand's first-seen tick (carrying forward a prior one) so
      // the scheduler sees how long it has been waiting. Deliberately stamps
      // precedence-FILTERED demands too: a route's clock starts when its
      // demand appears, not when its miner lands, so a hauler whose source
      // sat unhauled fires starved-lifted soon after the miner arrives. A
      // freeze-while-filtered variant was tried and REVERTED: it delayed the
      // d=22 loop's first hauler by ~300 ticks (grid cell
      // plan-t1-single-source-loop went red) - the "aging while unspawnable"
      // encodes the real starvation of the route's energy on the ground.
      for (const d of demands) {
        const key = `${spawn.id}:${d.buyerCorpId}:${d.role}`;
        seenThisTick.add(key);
        const first = firstSeen[key] ?? (firstSeen[key] = Game.time);
        d.since = first;
      }
      // THE NOW PLAN (spec 11): publish this spawn's ordered acquisition
      // queue - what the scheduler EXPECTS to buy, in rank order, with each
      // entry's TRANSITION label and precondition (phase 3) - plus the
      // outstanding producer funding need (which the flow adapter routes to
      // the spawn sink so energy streams here while production has bodies to
      // buy). The scheduler still decides; deviations are signal.
      publishSpawnAgenda(spawn.id, demands, room.energyAvailable);
      if (demands.length === 0) continue;

      const ctx: ScheduleContext = {
        energyAvailable: room.energyAvailable,
        energyCapacity: room.energyCapacityAvailable,
        energyIncome: income,
        tick: Game.time
      };

      const result = scheduleSpawn(demands, ctx);
      if (!result) {
        // Flight recorder (rate-limited): an evaluated spawn with live
        // demands that bought nothing is the wedge signature the incident
        // pipeline hunts - record WHAT was waiting and on how much bank.
        if (Game.time % 25 === 0) {
          const head = [...demands].sort((a, b) => b.value - a.value)[0];
          blackBox("hold", {
            spawn: spawn.id,
            role: head.role,
            corp: head.buyerCorpId,
            minCost: head.minCost,
            bank: room.energyAvailable
          });
        }
        continue;
      }

      const d = result.demand;
      const spawned = spawningCorp.executeSpawn(
        d.role,
        d.buyerCorpId,
        result.energyBudget,
        Game.time,
        d.bodyParam,
        d.haulerRatio,
        d.bodyStrategy
      );
      // Execution receipt (actual-vs-NOW): what the spawn actually bought,
      // appended beside the published queue so fidelity cells and telemetry
      // compare intent to action without diffing creep lists from outside.
      if (spawned) {
        recordAgendaExecution(spawn.id, d.role, d.buyerCorpId, result.energyBudget);
        blackBox("spawn", { spawn: spawn.id, role: d.role, corp: d.buyerCorpId, cost: result.energyBudget });
      }
    }
  }

  // Drop timers for demands that no longer appear at a spawn we evaluated this
  // tick (the creep was spawned, or the work went away), resetting their age.
  // Only for evaluated spawns, so a skipped (busy) spawn keeps its timers intact.
  for (const key in firstSeen) {
    const spawnId = key.slice(0, key.indexOf(":"));
    if (evaluatedSpawns.has(spawnId) && !seenThisTick.has(key)) delete firstSeen[key];
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

  // Harvest/carry/upgrade are framework-commissioned (the commission store).
  // A source's miner and haulers must share a groupId so withMinerPrecedence
  // couples them; their commission ids (harvest-<src> / carry-<src>) differ, so
  // the shared key is the source id (harvest's getSourceId, == carry's id minus
  // the "carry-" prefix).
  const harvestCorps = commissionedCorpsOfKind<HarvestCorp>("harvest");
  const carryCorps = commissionedCorpsOfKind<CarryCorp>("carry");
  const upgradeCorps = commissionedCorpsOfKind<UpgradingCorp>("upgrade");

  // Sources with a miner actually in the field (their income unit is "started").
  // Keyed by the real game source id (flow "source-" prefix stripped) so harvest
  // and carry agree regardless of id format.
  const sourceKey = (s: string): string => s.replace("source-", "");
  const minedSources = new Set<string>();
  for (const id in harvestCorps) {
    if (harvestCorps[id].getCreepCount() > 0) minedSources.add(sourceKey(harvestCorps[id].getSourceId()));
  }

  for (const id in harvestCorps) {
    const c = harvestCorps[id];
    if (c.getSpawnId() !== spawnId || c.retiring) continue;
    const sourceId = sourceKey(c.getSourceId());
    const started = minedSources.has(sourceId);
    for (const d of c.getSpawnDemand(ctx)) {
      d.groupId = sourceId;
      d.groupStarted = started;
      demands.push(d);
    }
  }
  for (const id in carryCorps) {
    const c = carryCorps[id];
    if (c.getSpawnId() !== spawnId || c.retiring) continue;
    // Shared source key, matching harvest's getSourceId() (the real game id). Take
    // it from the route's fromId (stripped of the flow "source-" prefix) so a
    // source's miner and haulers land in the same group regardless of id format;
    // fall back to the commission corpId when there are no routes yet.
    const fromId = c.getHaulerAssignments()[0]?.fromId;
    const sourceId = sourceKey(fromId ?? id.replace(/^carry-/, ""));
    // A scavenger's energy is already on the ground (no miner to wait for), so its
    // income unit is always "started" - otherwise withMinerPrecedence would drop it
    // for having no miner and the scavenger could never spawn.
    const started = sourceId.startsWith("scavenge-") || minedSources.has(sourceId);
    for (const d of c.getSpawnDemand(ctx)) {
      d.groupId = sourceId;
      d.groupStarted = started;
      demands.push(d);
    }
  }
  for (const id in upgradeCorps) {
    const c = upgradeCorps[id];
    if (c.getSpawnId() === spawnId && !c.retiring) demands.push(...c.getSpawnDemand(ctx));
  }
  const constructionCorps = commissionedCorpsOfKind<ConstructionCorp>("construction");
  for (const id in constructionCorps) {
    const c = constructionCorps[id];
    if (c.getSpawnId() === spawnId && !c.retiring) demands.push(...c.getSpawnDemand(ctx));
  }
  // Extension tenders live in the commission store (framework-ported); their
  // tankers still compete here on the value-ranked path (infrastructure tier).
  const tenderCorps = commissionedCorpsOfKind<ExtensionTenderCorp>("tender");
  for (const id in tenderCorps) {
    const c = tenderCorps[id];
    if (c.getSpawnId() === spawnId && !c.retiring) demands.push(...c.getSpawnDemand(ctx));
  }
  // Controller feeders live in the commission store (framework-ported); their
  // feeders compete here on the same value-ranked infrastructure tier as tenders.
  const controllerFeederCorps = commissionedCorpsOfKind<ControllerFeederCorp>("controllerFeeder");
  for (const id in controllerFeederCorps) {
    const c = controllerFeederCorps[id];
    if (c.getSpawnId() === spawnId && !c.retiring) demands.push(...c.getSpawnDemand(ctx));
  }
  // Reservation corps live in the commission store (framework-ported), but
  // their reservers still compete here on the value-ranked path.
  const reservationCorps = commissionedCorpsOfKind<ReservationCorp>("reservation");
  for (const id in reservationCorps) {
    const c = reservationCorps[id];
    if (c.getSpawnId() !== spawnId || c.retiring) continue;
    for (const d of c.getSpawnDemand(ctx)) {
      // The reserver is INCOME work: it unlocks +5 e/tick on every source in the
      // remote room it holds. Give it a groupId so spawnPriority places it in the
      // income tier (it already declares producesIncome) - otherwise it sits at its
      // base value (92), below every income corp AND every blocking consumer, and is
      // starved forever while the colony ramps, so the remote never gets reserved and
      // stays at the unreserved half-rate.
      //
      // It is also groupStarted: the reserver's demand only exists once a miner is
      // already harvesting that remote (ReservationCorp.targetRooms gates on it), so
      // the reserved-mining OP is already underway - reserving merely doubles an
      // already-committed source (infra built, miner fielded). Treating it as a fresh
      // unit would rank it BELOW opening a brand-new source (1e6+92 < 1e6+100), so the
      // planner would open new sources before reserving one it already mines - the
      // opposite of the intent that reserved mining outranks plain mining. As a
      // started unit it leads all fresh source-opening while still yielding to the
      // higher-value started haulers that move the base energy.
      d.groupId = c.id;
      d.groupStarted = true;
      demands.push(d);
    }
  }
  // Raid guards (spec 13): producer protection at value 105 - above the
  // hauler band's floor, below the reserver 115. The corp's own demand logic
  // is deliberately EXEMPT from hostileRooms() (it exists to enter exactly
  // the rooms the economy flees), so no gate here. Same income-tier
  // treatment as the reserver, for the same measured reason: at base tier
  // the guard starved behind income churn through the whole pre-raid window
  // (def-t4 cell) and the remote fleet it protects died. groupStarted: the
  // income it preserves is already committed (armed meter = we mined 65k+
  // there), so fresh source-openings (blocking) still outrank it while
  // scaling haulers compete with it on value.
  const raidGuardCorps = commissionedCorpsOfKind<RaidGuardCorp>("raidGuard");
  for (const id in raidGuardCorps) {
    const c = raidGuardCorps[id];
    if (c.getSpawnId() !== spawnId || c.retiring) continue;
    for (const d of c.getSpawnDemand(ctx)) {
      d.groupId = c.id;
      d.groupStarted = true;
      demands.push(d);
    }
  }
  // Core busters (spec 13 ph4): the kill+strip mission that reclaims an
  // invader-occupied remote. Same military exemption and income-tier
  // treatment as the guard (value 104 - the mission RESTORES zeroed income),
  // but never blocking: an occupation is a long siege, not a kill window.
  const coreBusterCorps = commissionedCorpsOfKind<CoreBusterCorp>("coreBuster");
  for (const id in coreBusterCorps) {
    const c = coreBusterCorps[id];
    if (c.getSpawnId() !== spawnId || c.retiring) continue;
    for (const d of c.getSpawnDemand(ctx)) {
      d.groupId = c.id;
      d.groupStarted = true;
      demands.push(d);
    }
  }
  // The claim corp (spec 06 expansion): CAPEX, not income - it keeps its
  // investment-tier value (80, below every income corp) and competes here
  // only through its holdToFund flag, banking the indivisible 650 once it
  // tops an otherwise-satisfied queue.
  const claimCorps = commissionedCorpsOfKind<ClaimCorp>("claim");
  for (const id in claimCorps) {
    const c = claimCorps[id];
    if (c.getSpawnId() === spawnId && !c.retiring) demands.push(...c.getSpawnDemand(ctx));
  }

  return demands;
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

/**
 * Publish the NOW plan (docs/specs/11): the ordered acquisition queue this
 * spawn expects to work through, derived from the same demands and ranking
 * the scheduler uses. Observability first - W2N6-class sequencing bugs
 * ("granted 6x minerB against target 1", "reserver waited 1800 ticks")
 * become one-line agenda-vs-actual violations instead of archaeology. The
 * fundingNeed sums the minimum bodies of must-fund demands (blocking,
 * replacement, holdToFund): the energy production is asking for RIGHT NOW,
 * for the flow adapter to route toward the spawn network (spec 11 phase 2).
 * Phase 3: entries carry their transition label (`why`) and precondition,
 * and execution receipts accumulate beside the queue (recordAgendaExecution).
 */
function publishSpawnAgenda(spawnId: string, demands: SpawnDemand[], energyAvailable: number): void {
  if (typeof Memory === "undefined") return;
  const { queue, fundingNeed } = buildAgendaQueue(demands, Game.time, energyAvailable);
  const table = (Memory.spawnAgenda ??= {});
  // Receipts survive the per-tick republish - they are the actual-vs-NOW half.
  const executed = table[spawnId]?.executed;
  table[spawnId] = { tick: Game.time, fundingNeed, queue, ...(executed ? { executed } : {}) };
}

/** Ring size for a spawn's execution receipts (enough for a fidelity window). */
const AGENDA_EXECUTED_MAX = 8;

/** Append an execution receipt beside the spawn's published agenda. */
function recordAgendaExecution(spawnId: string, role: string, corp: string, cost: number): void {
  if (typeof Memory === "undefined") return;
  const entry = Memory.spawnAgenda?.[spawnId];
  if (!entry) return;
  const executed = (entry.executed ??= []);
  executed.push({ tick: Game.time, role, corp, cost });
  if (executed.length > AGENDA_EXECUTED_MAX) executed.splice(0, executed.length - AGENDA_EXECUTED_MAX);
}
