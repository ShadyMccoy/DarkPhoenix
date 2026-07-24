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
  AcquisitionPlan,
  ScheduleContext,
  SpawnDemand,
  SpawnDemandContext,
  detectWallPreemption,
  planAcquisitions
} from "../spawn/SpawnScheduler";
import { record as blackBox } from "../telemetry/BlackBox";
import { resolveReserveTarget } from "../economy/bank";
import { CorpRegistry } from "./CorpRunner";
import { allCommissionedCorps } from "./CommissionHost";
import { Corp } from "../corps/Corp";
import { DemandWorld, getCorpKind, listCorpKinds } from "../economy/CorpKind";

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
      stampDemandAges(demands, spawn.id, firstSeen, seenThisTick, Game.time);

      // Storage throttle input (owner 2026-07-24): energy banked ABOVE the
      // reserve target. 0 while the warchest fills (producer-first); positive in
      // surplus, when a consumer buys priority proportional to it.
      const banked = room.storage?.my ? room.storage.store[RESOURCE_ENERGY] ?? 0 : 0;
      const bankSurplus = Math.max(0, banked - resolveReserveTarget(Memory.warchestTarget));

      const ctx: ScheduleContext = {
        energyAvailable: room.energyAvailable,
        energyCapacity: room.energyCapacityAvailable,
        energyIncome: income,
        tick: Game.time,
        bankSurplus
      };

      // THE NOW PLAN (spec 11 / spec 17): ONE planner call yields both the
      // published acquisition queue - each entry annotated with the decision
      // walk's own gate verdict - and this tick's buy, which is by
      // construction the entry gated "buy". The director executes the plan
      // mechanically; it holds no decision logic of its own.
      const plan = planAcquisitions(demands, ctx);
      publishSpawnAgenda(spawn.id, plan, room.energyAvailable);
      // Instrument (spec 14, owner 2026-07-24): sample campaign-consumer wall
      // preemptions - the E4/P7 freeze where a holdToFund upgrader walls while
      // income buys through the non-strict hold. `fleetSecured` says whether the
      // conditioned windfall gate would safely fire (only replacements left).
      // Sampled (every 10t) so the ring keeps room for other traffic.
      if (Game.time % 10 === 0) {
        const preempt = detectWallPreemption(plan.agenda);
        if (preempt) {
          blackBox("wallpreempt", {
            spawn: spawn.id,
            role: preempt.campaignRole,
            preemptor: preempt.preemptorWhy,
            fleetSecured: preempt.fleetSecured,
            bank: room.energyAvailable
          });
        }
      }
      if (demands.length === 0) continue;

      const result = plan.decision;
      if (!result) {
        // Flight recorder (rate-limited): an evaluated spawn with live
        // demands that bought nothing is the wedge signature the incident
        // pipeline hunts - record WHAT was waiting and on how much bank.
        // The agenda head IS the walk's own ranking.
        if (Game.time % 25 === 0 && plan.agenda.length > 0) {
          const head = plan.agenda[0];
          blackBox("hold", {
            spawn: spawn.id,
            role: head.role,
            corp: head.corp,
            minCost: head.minCost,
            bank: room.energyAvailable
          });
        }
        continue;
      }

      const d = result.demand;
      const spawned = spawningCorp.executeSpawn(
        d.kind ?? "",
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
        resetDemandClock(firstSeen, spawn.id, d.buyerCorpId, d.role);
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

/** Clock key for a demand stream at a spawn - one clock per spawn+corp+role. */
function demandClockKey(spawnId: string, buyerCorpId: string, role: string): string {
  return `${spawnId}:${buyerCorpId}:${role}`;
}

/**
 * Stamp each demand's first-seen tick (carrying forward a prior one) so the
 * scheduler sees how long it has been waiting. Deliberately stamps
 * precedence-FILTERED demands too: a route's clock starts when its demand
 * appears, not when its miner lands, so a hauler whose source sat unhauled
 * fires starved-lifted soon after the miner arrives. A freeze-while-filtered
 * variant was tried and REVERTED: it delayed the d=22 loop's first hauler by
 * ~300 ticks (grid cell plan-t1-single-source-loop went red) - the "aging
 * while unspawnable" encodes the real starvation of the route's energy on
 * the ground.
 *
 * Exported (with {@link resetDemandClock}) so the clock's semantics are
 * unit-pinned: age measures UNSERVED waiting.
 */
export function stampDemandAges(
  demands: SpawnDemand[],
  spawnId: string,
  firstSeen: { [key: string]: number },
  seenThisTick: Set<string>,
  tick: number
): void {
  for (const d of demands) {
    const key = demandClockKey(spawnId, d.buyerCorpId, d.role);
    seenThisTick.add(key);
    const first = firstSeen[key] ?? (firstSeen[key] = tick);
    d.since = first;
  }
}

/**
 * Reset a demand stream's age clock after its spawn bought it a creep: age
 * must measure UNSERVED waiting, not time-since-first-request. A standing
 * multi-creep demand (a scaling hauler fleet, a 3-tanker tender) keeps its
 * key alive across purchases, so without the reset its clock is "the whole
 * era" and - under FIFO-among-starved - a stream that is being served every
 * ~100 ticks permanently outranks a demand that has NEVER been served (live
 * incident t72403765: four hauler buys in ~160t while the tender, age 1371,
 * and the upgrader, age 1023, starved behind them; sim: flow-handoff's
 * bootstrap-era demands walled out the whole flow fleet). The reset restores
 * STARVED_TIER's documented one-shot contract: served means the meter starts
 * over.
 */
export function resetDemandClock(
  firstSeen: { [key: string]: number },
  spawnId: string,
  buyerCorpId: string,
  role: string
): void {
  delete firstSeen[demandClockKey(spawnId, buyerCorpId, role)];
}

/** The shape a corp must expose to participate in the demand pipeline. */
interface DemandingCorp extends Corp {
  getSpawnId(): string;
  getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[];
  getCreepCount?(): number;
}

function isDemandingCorp(corp: Corp): corp is DemandingCorp {
  const c = corp as Partial<DemandingCorp>;
  return typeof c.getSpawnId === "function" && typeof c.getSpawnDemand === "function";
}

/**
 * The cross-kind execution facts kinds' demandGroup policies may read, built
 * once per collection from the commission store. "Mined" is declared, not
 * hardcoded: any kind whose sourceOf names a source contributes when its corp
 * has a creep in the field (getCreepCount > 0 - which counts recycling creeps,
 * per the trap list). Global across spawns, exactly like the pre-spec-17
 * minedSources set: a source mined from another spawn still counts as started.
 */
function buildDemandWorld(): DemandWorld {
  const mined = new Set<string>();
  for (const { kind: kindName, corp } of allCommissionedCorps()) {
    const kind = getCorpKind(kindName);
    if (!kind?.sourceOf) continue;
    const sourceId = (kind.sourceOf as (c: Corp) => string | null)(corp);
    if (!sourceId) continue;
    const count = (corp as Partial<DemandingCorp>).getCreepCount?.() ?? 0;
    if (count > 0) mined.add(sourceId);
  }
  return { isSourceMined: id => mined.has(id) };
}

/**
 * Collect spawn demands from every commissioned corp that spawns at the given
 * spawn - ONE generic loop over the registry, in kind execution order. Per
 * corp: the uniform (getSpawnId, !retiring) filter, the corp's own
 * getSpawnDemand, then the KIND's declared demandGroup decoration (income-unit
 * grouping: harvest/carry's shared source key, the military/reservation
 * forced-started stamps - see each kind file for the measured rationale, and
 * test/unit/execution/collectDemandsPolicy.test.ts for the pins). Corps
 * without a demand surface (scout self-spawns; bootstrap pre-dates the
 * scheduler) contribute nothing, exactly as before.
 *
 * Exported so the spawn-decision harness can drive the real grouping logic
 * (not a re-implementation) when freezing "what spawns next" moments.
 */
export function collectDemands(_registry: CorpRegistry, spawnId: string, ctx: SpawnDemandContext): SpawnDemand[] {
  const demands: SpawnDemand[] = [];
  const world = buildDemandWorld();
  const byKind = new Map<string, { corpId: string; corp: Corp }[]>();
  for (const entry of allCommissionedCorps()) {
    const list = byKind.get(entry.kind) ?? [];
    list.push(entry);
    byKind.set(entry.kind, list);
  }

  for (const kind of listCorpKinds()) {
    for (const { corpId, corp } of byKind.get(kind.kind) ?? []) {
      if (!isDemandingCorp(corp)) continue;
      if (corp.getSpawnId() !== spawnId || corp.retiring) continue;
      const group = kind.demandGroup ? (kind.demandGroup as (c: Corp, id: string, w: DemandWorld) => { groupId: string; started: boolean } | null)(corp, corpId, world) : null;
      for (const d of corp.getSpawnDemand(ctx)) {
        if (group) {
          d.groupId = group.groupId;
          d.groupStarted = group.started;
        }
        d.kind = kind.kind;
        demands.push(d);
      }
    }
  }

  return demands;
}

/**
 * Crude estimate of energy delivery into the spawn network: any creep of a
 * role declared deliversEnergy (today: the flow hauler) or a bootstrap jack
 * counts as a deliverer. The scheduler only needs a positive/zero signal
 * (whether it is safe to wait for a blocking demand to become affordable,
 * versus needing to spawn an income producer first).
 */
function estimateIncome(registry: CorpRegistry, room: Room): number {
  const deliveringWorkTypes = new Set<string>();
  for (const kind of listCorpKinds()) {
    for (const role in kind.roles) {
      if (kind.roles[role].deliversEnergy) deliveringWorkTypes.add(kind.roles[role].workType);
    }
  }
  let deliverers = 0;
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (creep.room.name !== room.name) continue;
    if (creep.memory.workType && deliveringWorkTypes.has(creep.memory.workType)) deliverers++;
  }
  const bootstrap = registry.bootstrapCorps[room.name];
  if (bootstrap) deliverers += bootstrap.getCreepCount();
  return deliverers * 10;
}

/**
 * Publish the NOW plan (docs/specs/11, prescriptive since spec 17): the
 * acquisition queue this spawn works through, straight from planAcquisitions -
 * so the published order, gate verdicts, and this tick's buy are ONE record
 * that cannot disagree with what the spawn does. W2N6-class sequencing bugs
 * ("granted 6x minerB against target 1", "reserver waited 1800 ticks") read
 * as one-line agenda-vs-actual violations instead of archaeology. The
 * fundingNeed sums the minimum bodies of must-fund demands (blocking,
 * replacement, holdToFund): the energy production is asking for RIGHT NOW,
 * for the flow adapter to route toward the spawn network (spec 11 phase 2).
 * Execution receipts accumulate beside the queue (recordAgendaExecution).
 */
function publishSpawnAgenda(spawnId: string, plan: AcquisitionPlan, _energyAvailable: number): void {
  if (typeof Memory === "undefined") return;
  const table = (Memory.spawnAgenda ??= {});
  // Receipts survive the per-tick republish - they are the actual-vs-NOW half.
  const executed = table[spawnId]?.executed;
  table[spawnId] = {
    tick: Game.time,
    fundingNeed: plan.fundingNeed,
    queue: plan.agenda,
    ...(executed ? { executed } : {})
  };
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
