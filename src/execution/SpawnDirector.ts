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
  ScheduleResult,
  SpawnDemand,
  SpawnDemandContext,
  campaignConsumerLift,
  detectWallPreemption,
  effectivePriority,
  planAcquisitions
} from "../spawn/SpawnScheduler";
import { record as blackBox } from "../telemetry/BlackBox";
import { resolveReserveTarget } from "../economy/bank";
import { DELIVERER_INCOME_RATE } from "../economy/primitives";
import { CorpRegistry } from "./CorpRunner";
import { allCommissionedCorps } from "./CommissionHost";
import { Corp } from "../corps/Corp";
import { DemandWorld, getCorpKind, listCorpKinds } from "../economy/CorpKind";
import { Position } from "../types/Position";
import { roomLinearDistance } from "../utils/RoomDiscovery";
import { pathDistance } from "../nodes/NodeNavigator";

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
  // anti-starvation backstop). Keyed per corp+role - the wait is a colony fact,
  // independent of which spawn eventually serves it.
  const firstSeen = Memory.spawnDemandFirstSeen ?? (Memory.spawnDemandFirstSeen = {});
  const seenThisTick = new Set<string>();

  // corpId -> corp, so a demand can be traced to its work site for the distance
  // term of the global assignment.
  const corpById = new Map<string, Corp>();
  for (const { corp } of allCommissionedCorps()) corpById.set(corp.id, corp);

  // GLOBAL SPAWN POOL (owner 2026-07-25: spawn assignment is NOT room-scoped).
  // Every owned spawn across the empire is ONE production pool. A demand is
  // anchored to its nearest spawn by the planner, but at EXECUTION any free
  // spawn may build any corp: the highest-VALUE demand goes to the nearest free
  // spawn that can afford it. So A1's spawns build A2's (higher-value) corps
  // whenever A1 is nearest OR A2's own spawns are busy, and a room whose spawns
  // are all busy still gets its demand built by another room's free spawn. With
  // a single spawn the pool has one puller over its own demand - RCL<=6 is the
  // old per-spawn behaviour.
  const allDemands: SpawnDemand[] = [];
  const freeSpawns: StructureSpawn[] = [];
  // Per-room execution state: the bank LEFT to spend (decremented as builds
  // commit - spawns in a room share it) and the ctx terms that price a build at
  // that room's spawns.
  const roomState = new Map<string, { energyLeft: number; capacity: number; income: number; bankSurplus: number }>();

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;
    if (room.controller.level < FLOW_MIN_RCL) continue; // bootstrap owns the early game

    // Collect this room's anchored demand at ITS capacity (body sizing follows
    // the planner's nearest-spawn choice), then fold it into the global pool -
    // even if this room has no free spawn right now, another room's free spawn
    // may build it.
    const roomSpawnIds = new Set<string>(spawns.map(s => s.id as string));
    const demands = collectDemandsMatching(id => roomSpawnIds.has(id), {
      energyCapacity: room.energyCapacityAvailable,
      tick: Game.time
    });
    stampDemandAges(demands, firstSeen, seenThisTick, Game.time);
    allDemands.push(...demands);

    // Storage throttle input (owner 2026-07-24): energy banked ABOVE the
    // reserve target. 0 while the warchest fills (producer-first); positive in
    // surplus, when a consumer buys priority proportional to it.
    const banked = room.storage?.my ? room.storage.store[RESOURCE_ENERGY] ?? 0 : 0;
    roomState.set(roomName, {
      energyLeft: room.energyAvailable,
      capacity: room.energyCapacityAvailable,
      income: estimateIncome(registry, room),
      bankSurplus: Math.max(0, banked - resolveReserveTarget(Memory.warchestTarget))
    });
    for (const s of spawns) if (!s.spawning) freeSpawns.push(s);
  }

  const ctxOf = (spawn: StructureSpawn): ScheduleContext => {
    const st = roomState.get(spawn.pos.roomName)!;
    return {
      energyAvailable: st.energyLeft,
      energyCapacity: st.capacity,
      energyIncome: st.income,
      tick: Game.time,
      bankSurplus: st.bankSurplus
    };
  };

  // THE NOW PLAN (spec 11 / spec 17): each free spawn publishes its own-ctx
  // ranking of the global pool, and the wall-preempt instrument samples once.
  let sampled = false;
  for (const spawn of freeSpawns) {
    const plan = planAcquisitions(allDemands, ctxOf(spawn));
    publishSpawnAgenda(spawn.id, plan, ctxOf(spawn).energyAvailable);
    if (!sampled && Game.time % 10 === 0) {
      sampled = true;
      const preempt = detectWallPreemption(plan.agenda);
      if (preempt) {
        blackBox("wallpreempt", {
          spawn: spawn.id,
          role: preempt.campaignRole,
          preemptor: preempt.preemptorWhy,
          fleetSecured: preempt.fleetSecured,
          bank: ctxOf(spawn).energyAvailable
        });
      }
    }
  }

  // GLOBAL ASSIGNMENT. Each round, every free spawn proposes its top affordable
  // buy from the unclaimed pool (real planAcquisitions - holds, miner
  // precedence and per-bank affordability all intact). The globally
  // highest-VALUE proposal wins, broken toward the NEAREST proposing spawn, and
  // its room's bank is decremented so later rounds price against what is left.
  const claimed = new Set<SpawnDemand>();
  const available = [...freeSpawns];
  let boughtAnything = false;
  while (available.length > 0) {
    const unclaimed = claimed.size === 0 ? allDemands : allDemands.filter(d => !claimed.has(d));
    if (unclaimed.length === 0) break;

    // A* PRUNE (owner 2026-07-25). The winner is argmax of (priority, then
    // -distance). A spawn's proposal priority is bounded ABOVE by the richest
    // demand it can afford - `ubPriority` - because planAcquisitions can only
    // return an affordable demand and its holds/precedence only LOWER the pick.
    // So rank the free spawns by that ceiling and evaluate the expensive
    // planAcquisitions in descending order; the moment a spawn's ceiling drops
    // below the best priority already found, no remaining spawn can even tie it
    // - stop. Distance (the tie-break) is the node graph's cached pathDistance,
    // so it never needs a walk of its own.
    const ranked = available
      .map(cand => ({ cand, ceiling: ubPriority(cand, unclaimed, roomState) }))
      .sort((a, b) => b.ceiling - a.ceiling);

    let best: { spawn: StructureSpawn; plan: AcquisitionPlan; result: ScheduleResult; pri: number; dist: number } | null = null;
    for (const { cand, ceiling } of ranked) {
      if (best && ceiling < best.pri - 1e-9) break; // ceiling below best - and only lower from here
      const st = roomState.get(cand.pos.roomName)!;
      const plan = planAcquisitions(unclaimed, ctxOf(cand));
      const decision = plan.decision;
      if (!decision) continue; // this spawn holds / can afford nothing
      const workPos = corpById.get(decision.demand.buyerCorpId)?.getPosition();
      const pri = effectivePriority(decision.demand, Game.time, campaignConsumerLift(st.bankSurplus));
      const dist = workPos ? pathDistance(cand.pos, workPos) : Infinity;
      if (!best || pri > best.pri + 1e-9 || (Math.abs(pri - best.pri) < 1e-9 && dist < best.dist)) {
        best = { spawn: cand, plan, result: decision, pri, dist };
      }
    }
    if (!best) break; // every free spawn holds - nothing buys this tick

    const winner = best.spawn;
    const result = best.result;
    const chosen = result.demand;
    claimed.add(chosen);
    available.splice(available.indexOf(winner), 1);

    // Re-publish the winner's ACTUAL plan (the re-ranked unclaimed pool at its
    // bank) before executing, so the receipt recorded beside it matches its
    // predicting queue's buy-gated entry - spec 17's "one record cannot
    // disagree" invariant, which the agenda-fidelity cells assert. Round 1 this
    // is identical to the plan already published above (same pure inputs);
    // later rounds it replaces a queue whose head another spawn just claimed.
    publishSpawnAgenda(winner.id, best.plan, ctxOf(winner).energyAvailable);

    const spawningCorp = registry.spawningCorps[winner.id];
    const spawned = spawningCorp
      ? spawningCorp.executeSpawn(
          chosen.kind ?? "",
          chosen.role,
          chosen.buyerCorpId,
          result.energyBudget,
          Game.time,
          chosen.bodyParam,
          chosen.haulerRatio,
          chosen.bodyStrategy
        )
      : false;
    // Execution receipt (actual-vs-NOW): what THIS spawn actually bought,
    // appended beside the published queue for fidelity cells and telemetry.
    if (spawned) {
      boughtAnything = true;
      const st = roomState.get(winner.pos.roomName)!;
      st.energyLeft = Math.max(0, st.energyLeft - result.energyBudget);
      recordAgendaExecution(winner.id, chosen.role, chosen.buyerCorpId, result.energyBudget);
      blackBox("spawn", { spawn: winner.id, role: chosen.role, corp: chosen.buyerCorpId, cost: result.energyBudget });
      resetDemandClock(firstSeen, chosen.buyerCorpId, chosen.role);
    }
    // A failed build (lost the intra-tick energy race) leaves the demand claimed
    // to retry next tick; other free spawns keep going.
  }

  if (!boughtAnything && Game.time % 25 === 0 && allDemands.length > 0 && freeSpawns.length > 0) {
    // Flight recorder: free spawns with live demand that bought nothing is the
    // wedge signature the incident pipeline hunts.
    const head = planAcquisitions(allDemands, ctxOf(freeSpawns[0])).agenda[0];
    if (head) {
      blackBox("hold", {
        spawn: freeSpawns[0].id,
        role: head.role,
        corp: head.corp,
        minCost: head.minCost,
        bank: ctxOf(freeSpawns[0]).energyAvailable
      });
    }
  }

  // Age-clock housekeeping: every live demand was stamped this tick, so a key
  // not seen is a demand that spawned or whose work vanished - drop it so its
  // successor's clock starts fresh.
  for (const key in firstSeen) if (!seenThisTick.has(key)) delete firstSeen[key];
}

/**
 * Admissible upper bound on the priority of the demand a spawn could propose:
 * the richest (highest effectivePriority) demand it can afford right now. The
 * real proposal (planAcquisitions) can only pick an AFFORDABLE demand, and its
 * hold / miner-precedence rules only lower the pick, so the true proposal
 * priority never exceeds this ceiling. That makes it safe to prune - a spawn
 * whose ceiling is below the best proposal already found cannot win.
 */
function ubPriority(
  spawn: StructureSpawn,
  unclaimed: SpawnDemand[],
  roomState: Map<string, { energyLeft: number; capacity: number; income: number; bankSurplus: number }>
): number {
  const st = roomState.get(spawn.pos.roomName)!;
  const lift = campaignConsumerLift(st.bankSurplus);
  let max = -Infinity;
  for (const d of unclaimed) {
    if (d.minCost > st.energyLeft) continue; // unaffordable here - planAcquisitions can't pick it
    const p = effectivePriority(d, Game.time, lift);
    if (p > max) max = p;
  }
  return max;
}

/**
 * Distance from a spawn to a work site for the pool's assignment tie-break.
 * Same-room compares by Chebyshev (the newborn's walk to its post); another
 * room falls back to room-linear distance so an in-room spawn always beats a
 * cross-room one. Undefined workPos sorts last (Infinity).
 */
function spawnWorkDistance(spawnPos: RoomPosition, workPos: Position | undefined): number {
  if (!workPos) return Infinity;
  return spawnPos.roomName === workPos.roomName
    ? Math.max(Math.abs(spawnPos.x - workPos.x), Math.abs(spawnPos.y - workPos.y))
    : 50 + 50 * roomLinearDistance(spawnPos.roomName, workPos.roomName);
}

/**
 * The free spawn nearest a demand's work site. Retained for callers that assign
 * a single demand; the global loop inlines {@link spawnWorkDistance}. Undefined
 * workPos keeps the first available spawn.
 */
export function pickNearestSpawn(available: StructureSpawn[], workPos: Position | undefined): StructureSpawn {
  if (!workPos) return available[0];
  let best = available[0];
  let bestDist = Infinity;
  for (const s of available) {
    const dist = spawnWorkDistance(s.pos, workPos);
    if (dist < bestDist) {
      best = s;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Clock key for a demand stream - one clock per corp+role. Under the global
 * pool a demand isn't tied to a spawn OR a room: its wait ("how long has this
 * corp gone unserved") is a colony-wide fact keyed by the buyer alone.
 */
function demandClockKey(buyerCorpId: string, role: string): string {
  return `${buyerCorpId}:${role}`;
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
  firstSeen: { [key: string]: number },
  seenThisTick: Set<string>,
  tick: number
): void {
  for (const d of demands) {
    const key = demandClockKey(d.buyerCorpId, d.role);
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
export function resetDemandClock(firstSeen: { [key: string]: number }, buyerCorpId: string, role: string): void {
  delete firstSeen[demandClockKey(buyerCorpId, role)];
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
 * Collect spawn demands from every commissioned corp whose serving spawn
 * satisfies `spawnMatches` - ONE generic loop over the registry, in kind
 * execution order. Per corp: the uniform (getSpawnId, !retiring) filter, the
 * corp's own getSpawnDemand, then the KIND's declared demandGroup decoration
 * (income-unit grouping: harvest/carry's shared source key, the
 * military/reservation forced-started stamps - see each kind file for the
 * measured rationale, and test/unit/execution/collectDemandsPolicy.test.ts for
 * the pins). Corps without a demand surface (scout self-spawns; bootstrap
 * pre-dates the scheduler) contribute nothing.
 *
 * The director calls this with the whole ROOM's spawn set (the pool); the
 * single-spawn {@link collectDemands} wrapper below is the per-spawn view the
 * decision harness and policy tests drive.
 */
export function collectDemandsMatching(
  spawnMatches: (spawnId: string) => boolean,
  ctx: SpawnDemandContext
): SpawnDemand[] {
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
      if (!spawnMatches(corp.getSpawnId()) || corp.retiring) continue;
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
 * Single-spawn view of the pool: demands from corps served by exactly `spawnId`.
 * Exported so the spawn-decision harness can drive the real grouping logic (not
 * a re-implementation) when freezing "what spawns next" moments.
 */
export function collectDemands(_registry: CorpRegistry, spawnId: string, ctx: SpawnDemandContext): SpawnDemand[] {
  return collectDemandsMatching(id => id === spawnId, ctx);
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
  return deliverers * DELIVERER_INCOME_RATE;
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
