/**
 * @fileoverview siteValue - value a spawn site (or a whole colony of hubs) with
 * the ONE economy authority, the CorpPlanner.
 *
 * Replaces the market-era chain layer (ChainEvaluator.evaluateSpawnChain +
 * ColonyEconomy.marginalNodeValue, spec 04): "if a spawn stood HERE, what
 * net energy-rate would the colony around it produce?" is exactly what
 * planColony answers, purely, from a ColonyProblem - so node ROI and spawn
 * placement now track the live planner's economics instead of a parallel
 * model with its own formulas.
 *
 * Semantics carried over from the old layer:
 *  - a hub with no controller mints nothing (it contributes no sink);
 *  - cannibalization-aware marginal scoring: a source already served as well
 *    or better by an existing hub nets ~0 for a candidate (nearest-spawn
 *    assignment in producer selection is the same one-source-one-hub rule);
 *  - an unprofitable source (netEnergy <= 0 at its best spawn) contributes
 *    exactly nothing (the planner never commissions it).
 *
 * The score is net energy/tick: delivered minus the full miner+hauler spawn
 * overhead - one coherent unit, no value weighting.
 *
 * @module economy/siteValue
 */

import { Position, chebyshevDistance } from "../types/Position";
import { ColonyProblem, DEFAULT_SINK_VALUE, planColony } from "./CorpPlanner";

/** A base in the colony: its hub centre and the controller it upgrades. */
export interface SiteNode {
  id: string;
  hubPos: Position;
  controllerPos?: Position;
}

/** A source visible to the siting decision. */
export interface SiteSource {
  id: string;
  pos: Position;
  /** Energy per regeneration cycle (e.g. 3000). */
  capacity: number;
  /** Walkable mining spots; defaults to 1 (capacity rarely binds siting). */
  maxMiners?: number;
}

export interface SiteValueOptions {
  /** Distance function (defaults to Chebyshev; pass pathDistance when live). */
  dist?: (a: Position, b: Position) => number;
}

/**
 * Net energy/tick of one hub's local economy: its spawn, the sources assigned
 * to it, and its controller as the sink that mops them up. planColony is the
 * engine - producer selection prices the miners/haulers from primitives and
 * drops unprofitable sources; the score is delivered minus overhead.
 */
function hubValue(hub: SiteNode, assigned: SiteSource[], dist: NonNullable<SiteValueOptions["dist"]>): number {
  if (!hub.controllerPos || assigned.length === 0) return 0;
  const supply = assigned.reduce((sum, s) => sum + s.capacity / 300, 0);
  const problem: ColonyProblem = {
    spawns: [{ id: hub.id, pos: hub.hubPos }],
    sources: assigned.map(s => ({
      id: s.id,
      nodeId: s.id,
      pos: s.pos,
      rate: s.capacity / 300,
      maxMiners: s.maxMiners ?? 1
    })),
    sinks: [
      {
        id: `controller-${hub.id}`,
        kind: "controller" as const,
        pos: hub.controllerPos,
        value: DEFAULT_SINK_VALUE.controller,
        capacity: Math.max(supply, 1)
      }
    ],
    dist
  };
  const plan = planColony(problem);
  return Math.max(0, plan.totalDelivered - plan.totalOverhead);
}

/**
 * Net energy/tick of the whole colony: each source nets at the hub that
 * serves it best (nearest wins - one source, one hub, the rule that stops
 * double counting), each hub solved by planColony over its assignment. A hub
 * with no controller mints nothing and anchors nothing (the old assignSources
 * rule): global sink routing would instead let one hub's sink drain the whole
 * pool and hide a candidate's local-service benefit (measured: a source 3
 * tiles from its new hub scored 0.006 because the incumbent's sink outranked
 * by id and pulled the energy 25 tiles home).
 */
export function colonySiteValue(nodes: SiteNode[], sources: SiteSource[], options: SiteValueOptions = {}): number {
  const dist = options.dist ?? chebyshevDistance;
  const hubs = nodes.filter(n => n.controllerPos);
  if (hubs.length === 0) return 0;

  const byHub = new Map<string, SiteSource[]>(hubs.map(h => [h.id, []]));
  for (const s of sources) {
    let best: SiteNode | undefined;
    let bestDist = Infinity;
    for (const h of hubs) {
      const d = dist(s.pos, h.hubPos);
      if (d < bestDist || (d === bestDist && best && h.id < best.id)) {
        bestDist = d;
        best = h;
      }
    }
    if (best) byHub.get(best.id)!.push(s);
  }

  let total = 0;
  for (const h of hubs) total += hubValue(h, byHub.get(h.id) ?? [], dist);
  return total;
}

/** A source in an adjacent node, known only by its range across the boundary. */
export interface ReachableSiteSource {
  capacity: number;
  /** Walking distance from the spawn to that source. */
  distance: number;
}

/**
 * Score one spawn site in isolation: all given sources credited to it.
 * The drop-in for ChainEvaluator.evaluateSpawnChain. Reachable adjacent-node
 * sources are placed at their true range from the spawn, so their miners and
 * haulers carry the real inter-node travel penalty.
 */
export function spawnSiteValue(
  spawnPos: Position,
  sources: SiteSource[],
  controllerPos: Position | null | undefined,
  options: SiteValueOptions & { reachableSources?: ReachableSiteSource[] } = {}
): number {
  if (!controllerPos) return 0;
  const all: SiteSource[] = [...sources];
  (options.reachableSources ?? []).forEach((rs, i) => {
    all.push({
      id: `reach-${i}`,
      capacity: rs.capacity,
      pos: { x: spawnPos.x + rs.distance, y: spawnPos.y, roomName: spawnPos.roomName }
    });
  });
  return colonySiteValue([{ id: "site", hubPos: spawnPos, controllerPos }], all, options);
}

/**
 * Marginal value of adding `candidate` to the colony: WITH minus WITHOUT over
 * the combined source set. Sources an existing hub already serves as well or
 * better net out (~0); the candidate only scores for new or better-served
 * energy. The drop-in for ColonyEconomy.marginalNodeValue.
 */
export function marginalSiteValue(
  existing: SiteNode[],
  candidate: SiteNode,
  sources: SiteSource[],
  options: SiteValueOptions = {}
): number {
  const without = colonySiteValue(existing, sources, options);
  const withCandidate = colonySiteValue([...existing, candidate], sources, options);
  return withCandidate - without;
}
