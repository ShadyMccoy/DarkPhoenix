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

import { ColonyPlan, ColonyProblem, CommissionedHauler, CommissionedSink, planColony } from "./CorpPlanner";
import { Commission, corpIdFor } from "./Commission";
import { listCorpKinds } from "./CorpKind";
import { constructionWorkSpawnLoad, controllerWorkSpawnLoad } from "./primitives";
import { Position } from "../types/Position";

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

/** Spawn that should build a consumer at sinkPos: same-room if any, else nearest. */
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

/** Map the solver's plan onto Commission envelopes (pure, deterministic). */
export function commissionsFromPlan(problem: ColonyProblem, plan: ColonyPlan): Commission[] {
  const sourceById = new Map(problem.sources.map(s => [s.id, s]));
  const sinkById = new Map(problem.sinks.map(s => [s.id, s]));
  const out: Commission[] = [];

  // PRODUCE - one harvest commission per commissioned miner.
  for (const m of plan.miners) {
    const src = sourceById.get(m.sourceId);
    out.push({
      corpId: corpIdFor("harvest", m.sourceId),
      kind: "harvest",
      shape: "produce",
      consumes: { spawnPartsPerTick: m.spawnParts },
      produces: { energyRate: m.rate, at: src?.pos },
      assignment: m
    });
  }

  // TRANSPORT - one carry commission per SOURCE (a CarryCorp owns all of its
  // source's routes), aggregating that source's haulers.
  const routesBySource = new Map<string, CommissionedHauler[]>();
  for (const h of plan.haulers) {
    const list = routesBySource.get(h.sourceId) ?? [];
    list.push(h);
    routesBySource.set(h.sourceId, list);
  }
  for (const [sourceId, routes] of routesBySource) {
    // Bank sources (spec 03 withdrawal) get NO transport commission: the depot
    // movers already run those legs - the extension tender (bank -> spawn) and
    // the ControllerFeederCorp (bank -> controller input, sized to the same
    // economy/bank primitives). A CarryCorp here would fight the feeder for
    // the input tile and, via the feeder-active redirect, pump the load
    // straight back into the storage it withdrew from.
    if (sourceId.startsWith("bank-")) continue;
    const src = sourceById.get(sourceId);
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
  const nearestSpawnDist = (pos: Position | undefined): number =>
    !pos || problem.spawns.length === 0 ? 0 : Math.min(...problem.spawns.map(s => problem.dist(s.pos, pos)));
  for (const k of plan.sinks) {
    if (k.allocated <= 1e-9) continue;
    const kind = k.kind === "controller" ? "upgrade" : k.kind === "construction" ? "build" : null;
    if (!kind) continue;
    const sink = sinkById.get(k.sinkId);
    const spawnPartsPerTick =
      k.kind === "controller"
        ? controllerWorkSpawnLoad(k.allocated, nearestSpawnDist(sink?.pos))
        : constructionWorkSpawnLoad(k.allocated, nearestSpawnDist(sink?.pos));
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
