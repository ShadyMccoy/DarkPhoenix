/**
 * @fileoverview commissionPlan - wrap the solver's plan in Commission envelopes
 * and collect the registered kinds' own proposals.
 *
 * This is strangler step 1 (docs/specs/00-corp-framework.md): planColony stays
 * untouched and keeps emitting its three shapes; this module re-expresses them
 * as commissions so the generic dispatch (CorpKind.ts) can drive any kind that
 * has ported, while unported kinds keep flowing through the legacy plumbing.
 * The golden-master test pins this mapping - intentional changes to it must be
 * their own commit.
 *
 * @module economy/commissionPlan
 */

import {
  ColonyPlan,
  ColonyProblem,
  CommissionedHauler,
  CommissionedMiner,
  CommissionedSink,
  planColony
} from "./CorpPlanner";
import { Commission, corpIdFor } from "./Commission";
import { listCorpKinds } from "./CorpKind";
import { isBankSourceId } from "./ids";
import {
  TANKER_CARRY_PER_MOVE_PLAIN,
  constructionWorkSpawnLoad,
  controllerWorkSpawnLoad,
  minerSpawnLoad,
  operationSpawnLoad
} from "./primitives";
import { vectorSupplyPartsGait } from "./roadEconomics";
import { Position } from "../types/Position";

/**
 * The MINER OPERATION's binding (spec 34 D5): the harvest node and its routed
 * evacuation vector as ONE commission. The routes are the planner's own
 * CommissionedHauler records (per-route distances, paved discounts, deposit
 * legs) - the harvest kind operates them as an internal squad. Empty routes =
 * the haul-of-zero degenerate case (link-served: the vector IS the link
 * network; the miner feeds its source link in place).
 */
export interface MinerOperationAssignment {
  miner: CommissionedMiner;
  routes: CommissionedHauler[];
}

/**
 * The binding a consume commission (upgrade/build) carries: the planner's sink
 * allocation plus the SERVING SPAWN. The planner binds spawns to producers and
 * transporters but not to consumers (sinks are spawn-agnostic), so the spawn is
 * chosen here, purely, from the problem's spawns by the sink's room - matching
 * how the live FlowMaterializer picks the room's spawn. Null only if the colony
 * has no spawns at all.
 */
export interface ConsumeAssignment {
  sink: CommissionedSink;
  spawnId: string | null;
}

/**
 * Spawn that ANCHORS a consumer to its colony: same-room if any, else nearest.
 *
 * This picks the consumer's ROOM (which colony serves it), not the exact spawn
 * that builds its bodies - the SpawnDirector pools a room's spawns and assigns
 * each buy to the nearest free one at spawn time (owner 2026-07-25: spawning
 * distribution is not per-room/per-spawn). So among a room's spawns any one is
 * an equivalent anchor; the first same-room spawn is fine.
 */
function servingSpawnId(problem: ColonyProblem, sinkPos: Position | undefined): string | null {
  if (!sinkPos || problem.spawns.length === 0) return null;
  const sameRoom = problem.spawns.find(s => s.pos.roomName === sinkPos.roomName);
  if (sameRoom) return sameRoom.id;
  let best = problem.spawns[0];
  let bestDist = problem.dist(best.pos, sinkPos);
  for (const s of problem.spawns) {
    const d = problem.dist(s.pos, sinkPos);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best.id;
}

/**
 * The all-in spawn charge of a WORK-driven consumer sink (spec 34 D4/P4):
 * controller = the WORK bodies alone (its mover is the feeder, charged in
 * infraSpawnLoad - a vector here double-counts); construction =
 * operationSpawnLoad(WORK bodies, supply vector). THE one derivation - the
 * commission envelope, the adapter's sink stamp, and (by echo) the telemetry
 * segment and the P4 waste ledger all read this number; none re-derives.
 * Returns null for non-WORK sinks (spawn/storage/tower - delivery targets).
 */
export function consumerSpawnLoad(
  problem: ColonyProblem,
  k: CommissionedSink,
  sinkPos: Position | undefined
): { load: number; dist: number } | null {
  if (k.kind !== "controller" && k.kind !== "construction") return null;
  const dist =
    !sinkPos || problem.spawns.length === 0 ? 0 : Math.min(...problem.spawns.map(s => problem.dist(s.pos, sinkPos)));
  const load =
    k.kind === "controller"
      ? controllerWorkSpawnLoad(k.allocated, dist)
      : // The supply vector priced at the body the runtime FIELDS (spec 34
        // vector-gait follow-up B): the 3C:1M tanker's real loaded gait,
        // unpaved worst case (the commission cannot see paving receipts;
        // over-pricing a paved fuel route is conservative and stated, while
        // the old 1:1 model under-priced every unpaved campaign ~2x and F1
        // booked the fleet as breach).
        operationSpawnLoad(constructionWorkSpawnLoad(k.allocated, dist), [
          {
            rate: k.allocated,
            distance: dist,
            parts: vectorSupplyPartsGait(k.allocated, dist, 0, TANKER_CARRY_PER_MOVE_PLAIN)
          }
        ]);
  return { load, dist };
}

/** Map the solver's plan onto Commission envelopes (pure, deterministic). */
export function commissionsFromPlan(problem: ColonyProblem, plan: ColonyPlan): Commission[] {
  const sourceById = new Map(problem.sources.map(s => [s.id, s]));
  const sinkById = new Map(problem.sinks.map(s => [s.id, s]));
  const out: Commission[] = [];

  const routesBySource = new Map<string, CommissionedHauler[]>();
  for (const h of plan.haulers) {
    const list = routesBySource.get(h.sourceId) ?? [];
    list.push(h);
    routesBySource.set(h.sourceId, list);
  }

  // PRODUCE - one MINER OPERATION per commissioned miner (spec 34 D5): the
  // harvest node and its routed evacuation vector in ONE envelope with ONE
  // all-in price. The node term is the canonical minerSpawnLoad; the vector
  // term is the SUM of the planner's own routed spawnParts (paved discounts
  // and deposit legs included) - never the pre-solve nominal estimate
  // (m.spawnParts stays on the assignment for the funding-gate record, but
  // it priced hauler pairs at full rate/nearest spawn and the routed truth
  // used to live in a second envelope: two declarations, neither honest).
  // A LINK-SERVED source (haulPos set) is the haul-of-zero degenerate case:
  // routes drop entirely - the link network is its vector (the old carry
  // suppression, now expressed as an empty vector set instead of a missing
  // commission; the storage->core->storage thrash rationale is unchanged).
  for (const m of plan.miners) {
    const src = sourceById.get(m.sourceId);
    const routes = src?.haulPos ? [] : routesBySource.get(m.sourceId) ?? [];
    routesBySource.delete(m.sourceId);
    out.push({
      corpId: corpIdFor("harvest", m.sourceId),
      kind: "harvest",
      shape: "produce",
      consumes: {
        spawnPartsPerTick: minerSpawnLoad(m.distance) + routes.reduce((s, r) => s + r.spawnParts, 0)
      },
      produces: { energyRate: m.rate, at: src?.pos },
      assignment: { miner: m, routes } as MinerOperationAssignment
    });
  }

  // TRANSPORT - the MINERLESS leftovers (scavenge stocks: the energy is
  // already on the ground, a pure-vector operation with no node half to
  // merge into) keep the carry path, one commission per source.
  for (const [sourceId, routes] of routesBySource) {
    // Bank sources (spec 03 withdrawal) get NO transport commission: the depot
    // movers already run those legs - the extension tender (bank -> spawn) and
    // the ControllerFeederCorp (bank -> controller input, sized to the same
    // economy/bank primitives). A CarryCorp here would fight the feeder for
    // the input tile and, via the feeder-active redirect, pump the load
    // straight back into the storage it withdrew from.
    if (isBankSourceId(sourceId)) continue;
    const src = sourceById.get(sourceId);
    // LINK-SERVED sources get NO walking carry commission either (spec 02
    // feeder-router, owner 2026-07-26): a source whose energy EMERGES at the
    // core link (haulPos set by detectLinkHaulPositions) is transported by the
    // link network + the ControllerFeederCorp - the sole bidirectional core-link
    // operator (source link -> core link fire, then the feeder banks/relays).
    // A CarryCorp here would drain the very core link the feeder loads - the
    // storage->core->storage thrash (t72595372). This is the EMERGENT
    // kind-selection spec 00/17 prescribe: the route picks one transport kind
    // and the loser is not commissioned, read from the planner's own haulPos
    // lens (not a bolt-on to CarryCorp). A fresh-link transition pile at the
    // source is still collected by the scavenge path (a distinct `-scavenge`
    // route, never suppressed), so nothing rots. (The generic linkHaul kind in
    // the full spec-02 design supersedes this targeted suppression.)
    if (src?.haulPos) continue;
    const flow = routes.reduce((s, r) => s + r.flowRate, 0);
    out.push({
      corpId: corpIdFor("carry", sourceId),
      kind: "carry",
      shape: "transport",
      consumes: {
        energyRate: flow,
        at: src?.haulPos ?? src?.pos,
        spawnPartsPerTick: routes.reduce((s, r) => s + r.spawnParts, 0)
      },
      produces: { energyRate: flow },
      assignment: routes
    });
  }

  // CONSUME - one commission per sink that turns energy into value. Spawn and
  // storage sinks are delivery TARGETS (the transport commissions end there),
  // not corps, so they emit nothing here.
  //
  // The envelope's spawnPartsPerTick is the SAME charge the planner's parts
  // ledger paid for this sink (spec 15 P4: workSpawnLoad at the nearest-spawn
  // distance, linear in the allocation) - the commission is the economics
  // record variance/telemetry read, so it must not under-report (the audit
  // found it hardcoded 0 under a stale "not yet budgeted" comment).
  for (const k of plan.sinks) {
    if (k.allocated <= 1e-9) continue;
    const kind = k.kind === "controller" ? "upgrade" : k.kind === "construction" ? "build" : null;
    if (!kind) continue;
    const sink = sinkById.get(k.sinkId);
    // The all-in consumer charge (spec 34 D4/P4) - see consumerSpawnLoad,
    // the ONE derivation this envelope and the adapter's sink stamp share.
    const spawnPartsPerTick = consumerSpawnLoad(problem, k, sink?.pos)?.load ?? 0;
    out.push({
      corpId: corpIdFor(kind, k.sinkId),
      kind,
      shape: "consume",
      consumes: {
        energyRate: k.allocated,
        at: sink?.pos,
        spawnPartsPerTick
      },
      produces: { valuePerTick: k.allocated * k.value, at: sink?.pos },
      assignment: { sink: k, spawnId: servingSpawnId(problem, sink?.pos) } as ConsumeAssignment
    });
  }

  return out;
}

/**
 * The framework's planning entry point: solve the colony, wrap the plan in
 * commissions, then let every registered kind propose its own (auxiliaries'
 * triggers read the draft for preconditions). Pure given a pure problem.
 */
export function planCommissions(problem: ColonyProblem): { plan: ColonyPlan; commissions: Commission[] } {
  const plan = planColony(problem);
  const commissions = commissionsFromPlan(problem, plan);
  for (const kind of listCorpKinds()) {
    commissions.push(...kind.propose(problem, commissions));
  }
  return { plan, commissions };
}
