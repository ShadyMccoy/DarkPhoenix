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
import { Position } from "../types/Position";
import { roomLinearDistance } from "../utils/RoomDiscovery";

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
  // anti-starvation backstop). Keyed per ROOM (not per spawn) - see below.
  const firstSeen = Memory.spawnDemandFirstSeen ?? (Memory.spawnDemandFirstSeen = {});
  const seenThisTick = new Set<string>();
  const evaluatedRooms = new Set<string>();

  // corpId -> corp, so a pooled demand can be traced back to its work site for
  // nearest-free-spawn assignment (the distance term of the pool).
  const corpById = new Map<string, Corp>();
  for (const { corp } of allCommissionedCorps()) corpById.set(corp.id, corp);

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    // Let bootstrap own the very early game.
    if (room.controller.level < FLOW_MIN_RCL) continue;

    // POOLED SCHEDULING (owner 2026-07-25: "I don't want spawning distribution
    // to be per room" -> not per SPAWN either). A room's spawns are ONE
    // production pool: demand is NOT pinned to a spawn. Each FREE spawn pulls
    // the next-best affordable demand from the shared pool, so two spawns
    // self-balance across two DISTINCT demands per tick instead of spawn[0]
    // owning every consumer while spawn[1] idles. A busy spawn simply isn't in
    // the pool this tick. With one spawn the pool has one puller, so RCL<=6
    // behaviour is identical to the old per-spawn loop.
    const freeSpawns = spawns.filter(s => !s.spawning);
    // No free spawn: leave every demand's clock intact (a room whose spawns are
    // all busy is exactly where a starved builder must keep ageing).
    if (freeSpawns.length === 0) continue;
    evaluatedRooms.add(roomName);

    const roomSpawnIds = new Set<string>(spawns.map(s => s.id as string));
    const income = estimateIncome(registry, room);
    const demandCtx: SpawnDemandContext = {
      energyCapacity: room.energyCapacityAvailable,
      tick: Game.time
    };

    // The colony pool: every corp served by ANY of the room's spawns, collected
    // ONCE and aged per room+corp+role (a demand's wait is spawn-agnostic now).
    const demands = collectDemandsMatching(id => roomSpawnIds.has(id), demandCtx);
    stampDemandAges(demands, roomName, firstSeen, seenThisTick, Game.time);

    // Storage throttle input (owner 2026-07-24): energy banked ABOVE the
    // reserve target. 0 while the warchest fills (producer-first); positive in
    // surplus, when a consumer buys priority proportional to it. Room-level, so
    // it is the same for every spawn in the pool.
    const banked = room.storage?.my ? room.storage.store[RESOURCE_ENERGY] ?? 0 : 0;
    const bankSurplus = Math.max(0, banked - resolveReserveTarget(Memory.warchestTarget));

    const ctx: ScheduleContext = {
      energyAvailable: room.energyAvailable,
      energyCapacity: room.energyCapacityAvailable,
      energyIncome: income,
      tick: Game.time,
      bankSurplus
    };

    // THE NOW PLAN (spec 11 / spec 17): ONE walk ranks the whole pool and gates
    // each entry; the "buy" entry is this tick's top acquisition. Every free
    // spawn publishes the SAME room agenda - the pool's shared NOW plan.
    const poolPlan = planAcquisitions(demands, ctx);
    for (const spawn of freeSpawns) publishSpawnAgenda(spawn.id, poolPlan, room.energyAvailable);

    // Instrument (spec 14): sample campaign-consumer wall preemptions.
    if (Game.time % 10 === 0) {
      const preempt = detectWallPreemption(poolPlan.agenda);
      if (preempt) {
        blackBox("wallpreempt", {
          spawn: freeSpawns[0].id,
          role: preempt.campaignRole,
          preemptor: preempt.preemptorWhy,
          fleetSecured: preempt.fleetSecured,
          bank: room.energyAvailable
        });
      }
    }
    if (demands.length === 0) continue;

    // ASSIGNMENT: walk the pool top-down. Each buy goes to the FREE spawn
    // nearest that demand's work site, and the demand is CLAIMED so no two
    // spawns build it in the same tick. Re-ranking after each claim lets the
    // next free spawn pick up the next-best demand (self-balance).
    const claimed = new Set<SpawnDemand>();
    const available = [...freeSpawns];
    let boughtAnything = false;
    while (available.length > 0) {
      const remaining = claimed.size === 0 ? demands : demands.filter(d => !claimed.has(d));
      const plan = claimed.size === 0 ? poolPlan : planAcquisitions(remaining, ctx);
      const result = plan.decision;
      if (!result) break;

      const chosen = result.demand;
      const spawn = pickNearestSpawn(available, corpById.get(chosen.buyerCorpId)?.getPosition());
      claimed.add(chosen);
      available.splice(available.indexOf(spawn), 1);

      const spawningCorp = registry.spawningCorps[spawn.id];
      if (!spawningCorp) continue;
      const spawned = spawningCorp.executeSpawn(
        chosen.kind ?? "",
        chosen.role,
        chosen.buyerCorpId,
        result.energyBudget,
        Game.time,
        chosen.bodyParam,
        chosen.haulerRatio,
        chosen.bodyStrategy
      );
      // Execution receipt (actual-vs-NOW): what THIS spawn actually bought,
      // appended beside the published queue for fidelity cells and telemetry.
      if (spawned) {
        boughtAnything = true;
        recordAgendaExecution(spawn.id, chosen.role, chosen.buyerCorpId, result.energyBudget);
        blackBox("spawn", { spawn: spawn.id, role: chosen.role, corp: chosen.buyerCorpId, cost: result.energyBudget });
        resetDemandClock(firstSeen, roomName, chosen.buyerCorpId, chosen.role);
      } else {
        // Couldn't afford at this spawn. Energy is room-level (shared by the
        // pool), so this is a genuine affordability hold, not a spawn mismatch:
        // the rest of the pool waits, exactly as the single-spawn loop did.
        break;
      }
    }

    if (!boughtAnything && Game.time % 25 === 0 && poolPlan.agenda.length > 0) {
      // Flight recorder: a free-spawned room with live demand that bought
      // nothing is the wedge signature the incident pipeline hunts.
      const head = poolPlan.agenda[0];
      blackBox("hold", {
        spawn: freeSpawns[0].id,
        role: head.role,
        corp: head.corp,
        minCost: head.minCost,
        bank: room.energyAvailable
      });
    }
  }

  // Drop timers for demands that no longer appear in a room we evaluated this
  // tick (the creep was spawned, or the work went away), resetting their age.
  // Only for evaluated rooms, so a room whose spawns were all busy keeps its
  // timers intact.
  for (const key in firstSeen) {
    const roomOfKey = key.slice(0, key.indexOf(":"));
    if (evaluatedRooms.has(roomOfKey) && !seenThisTick.has(key)) delete firstSeen[key];
  }
}

/**
 * The free spawn nearest a demand's work site - the distance term of the pool.
 * Same-room spawns compare by Chebyshev (the newborn's walk to its post); a
 * work site in another room falls back to room-linear distance so an in-room
 * spawn is always preferred. Undefined workPos (a corp with no resolved
 * position) keeps the first available spawn.
 */
export function pickNearestSpawn(available: StructureSpawn[], workPos: Position | undefined): StructureSpawn {
  if (!workPos) return available[0];
  let best = available[0];
  let bestDist = Infinity;
  for (const s of available) {
    const dist =
      s.pos.roomName === workPos.roomName
        ? Math.max(Math.abs(s.pos.x - workPos.x), Math.abs(s.pos.y - workPos.y))
        : 50 + 50 * roomLinearDistance(s.pos.roomName, workPos.roomName);
    if (dist < bestDist) {
      best = s;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Clock key for a demand stream - one clock per ROOM+corp+role. Room-scoped,
 * not spawn-scoped: under pooled scheduling a demand isn't tied to a spawn, so
 * its wait ("how long has this corp gone unserved in this colony") is a room
 * fact. With one spawn the room and the spawn are 1:1, so the RCL<=6 clock is
 * unchanged.
 */
function demandClockKey(scope: string, buyerCorpId: string, role: string): string {
  return `${scope}:${buyerCorpId}:${role}`;
}

/**
 * Stamp each demand's first-seen tick (carrying forward a prior one) so the
 * scheduler sees how long it has been waiting. `scope` is the ROOM name.
 * Deliberately stamps precedence-FILTERED demands too: a route's clock starts
 * when its demand appears, not when its miner lands, so a hauler whose source
 * sat unhauled fires starved-lifted soon after the miner arrives. A
 * freeze-while-filtered variant was tried and REVERTED: it delayed the d=22
 * loop's first hauler by ~300 ticks (grid cell plan-t1-single-source-loop went
 * red) - the "aging while unspawnable" encodes the real starvation of the
 * route's energy on the ground.
 *
 * Exported (with {@link resetDemandClock}) so the clock's semantics are
 * unit-pinned: age measures UNSERVED waiting.
 */
export function stampDemandAges(
  demands: SpawnDemand[],
  scope: string,
  firstSeen: { [key: string]: number },
  seenThisTick: Set<string>,
  tick: number
): void {
  for (const d of demands) {
    const key = demandClockKey(scope, d.buyerCorpId, d.role);
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
  scope: string,
  buyerCorpId: string,
  role: string
): void {
  delete firstSeen[demandClockKey(scope, buyerCorpId, role)];
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
