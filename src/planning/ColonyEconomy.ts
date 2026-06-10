/**
 * ColonyEconomy - value a node by the colony it would belong to, not in isolation.
 *
 * Scoring a candidate base on its own over-rates it: it claims every source it
 * can reach, even ones a neighbouring base already mines, so a node surrounded
 * by other bases' sources looks great when it would only CANNIBALISE them. The
 * fix is to score the candidate marginally - simulate the whole colony's economy
 * with the candidate and without it, and take the difference. A stolen source
 * just moves from one hub to another, so the colony total barely changes and the
 * candidate scores ~0 for it; it only scores when it adds genuinely new energy
 * or serves a source better than the incumbent.
 *
 * The simulation assigns each source to the hub that serves it best (nearest
 * wins), then sums each hub's net (the corps are ephemeral - built, read,
 * discarded). One source, one hub: that is what stops the double-counting.
 */

import { Position, chebyshevDistance } from "../types/Position";
import { ChainSource, hubNet } from "../corps/ChainEvaluator";

const DEFAULT_ENERGY_CAPACITY = 300;

/** A base in the colony: its hub centre and the controller it upgrades. */
export interface ColonyNode {
  id: string;
  hubPos: Position;
  controllerPos?: Position;
}

export interface ColonyEconomyOptions {
  /** Energy a creep body may cost (defaults to an RCL-1 spawn). */
  energyCapacity?: number;
  /** Distance function (defaults to Chebyshev). */
  dist?: (a: Position, b: Position) => number;
}

/** Assign each source to the hub nearest it - the one that hauls it in cheapest. */
function assignSources(
  nodes: ColonyNode[],
  sources: ChainSource[],
  dist: (a: Position, b: Position) => number
): Map<string, ChainSource[]> {
  const byNode = new Map<string, ChainSource[]>();
  for (const n of nodes) byNode.set(n.id, []);

  for (const s of sources) {
    let best: ColonyNode | undefined;
    let bestDist = Infinity;
    for (const n of nodes) {
      if (!n.controllerPos) continue; // a hub with no controller mints nothing
      const d = dist(s.pos, n.hubPos);
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    if (best) byNode.get(best.id)!.push(s);
  }
  return byNode;
}

/**
 * Total net energy/tick of the whole colony: assign every source to its best
 * hub, then sum each hub's net. Building a fresh, throwaway corp roster.
 */
export function colonyEconomy(
  nodes: ColonyNode[],
  sources: ChainSource[],
  options: ColonyEconomyOptions = {}
): number {
  const dist = options.dist ?? chebyshevDistance;
  const energyCapacity = options.energyCapacity ?? DEFAULT_ENERGY_CAPACITY;

  const assignment = assignSources(nodes, sources, dist);
  let total = 0;
  for (const n of nodes) {
    total += hubNet(
      { pos: n.hubPos, controllerPos: n.controllerPos },
      assignment.get(n.id) ?? [],
      energyCapacity,
      dist
    );
  }
  return total;
}

/**
 * Marginal value of adding `candidate` to the colony: the colony's economy WITH
 * it minus WITHOUT it. Sources already served as well or better by an existing
 * hub contribute ~0 (no cannibalisation); the candidate only scores for new or
 * better-served energy. `sources` must include the candidate's own.
 */
export function marginalNodeValue(
  existing: ColonyNode[],
  candidate: ColonyNode,
  sources: ChainSource[],
  options: ColonyEconomyOptions = {}
): number {
  const without = colonyEconomy(existing, sources, options);
  const withCandidate = colonyEconomy([...existing, candidate], sources, options);
  return withCandidate - without;
}
