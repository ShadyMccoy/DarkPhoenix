/**
 * NodeEconomy - value a node's economy through the spawn that would run it.
 *
 * A node is worth what its spawn can sustainably produce: the chain of miners,
 * haulers and upgraders that turn the node's (and its neighbours') source energy
 * into controller points. This bridges a node's raw facts - where its sources,
 * spawn and controller sit, and which sources in adjacent territories a hauler
 * could reach - into a {@link PlannerInput}, then prices the spawn with
 * {@link valuateSpawnCorp}.
 *
 * Reachable sources from adjacent nodes are first-class here: a spawn site is
 * worth more if it can pull energy from a neighbour's source, but less the
 * further that source sits (a longer haul burns more overhead). That inter-node
 * penalty is not a special case - it falls straight out of the planner's
 * distance-based hauler sizing once the far source is placed at its true range.
 *
 * To avoid a cycle with nodes/Node (which calls this from calculateNodeROI),
 * this module takes plain structural data, not a Node. It is pure: distances are
 * injected (default Chebyshev), no Game globals, fully unit-testable.
 */

import { Position, chebyshevDistance } from "../types/Position";
import { PlannerInput, PlannerSink, PlannerSource } from "../flow/EconomyPlanner";
import { CorpValuation, valuateSpawnCorp } from "./CorpValuator";

/** Ticks for a source to regenerate, so capacity -> energy/tick (3000/300 = 10). */
export const SOURCE_REGEN_TICKS = 300;

/** Default strategic sink values. Controller is 1 so value ~= energy/tick of
 * productive work, which is the natural unit for ranking spawn sites. */
export const DEFAULT_NODE_SINK_VALUES = { spawn: 100, controller: 1 } as const;

/** A source in an adjacent node a hauler could reach across the node boundary. */
export interface ReachableSourceInput {
  id?: string;
  /** Energy per regeneration cycle (e.g. 3000). */
  capacity: number;
  /** Walking distance from this node's spawn to that source (tiles). */
  distance: number;
}

/** A source inside this node's own territory. */
export interface LocalSourceInput {
  id: string;
  /** Energy per regeneration cycle (e.g. 3000). */
  capacity: number;
  pos: Position;
}

/** The minimal facts needed to price the spawn that would run a node. */
export interface NodeSpawnValuationInput {
  /** Where the spawn sits - the real spawn, or the peak for a hypothetical one. */
  spawnPos: Position;
  /** Sources inside this node's territory. */
  localSources: LocalSourceInput[];
  /** The controller this node would upgrade (the value sink), if any. */
  controllerPos?: Position;
  /** Sources in adjacent nodes reachable by haulers (inter-node chains). */
  reachableSources?: ReachableSourceInput[];
  /** Strategic sink values (defaults to {@link DEFAULT_NODE_SINK_VALUES}). */
  sinkValues?: { spawn: number; controller: number };
  /** Distance function, injected for purity (default Chebyshev). */
  dist?: (a: Position, b: Position) => number;
}

/** Energy/tick a source of `capacity` yields when fully mined. */
function supplyOf(capacity: number): number {
  return capacity / SOURCE_REGEN_TICKS;
}

/**
 * Build the planner input that prices a node's spawn. Returns null when the
 * spawn could not sustain any productive chain - no sources to mine, or no
 * controller to feed (nowhere for the energy to create value). Such a site is
 * worth nothing on its own and the caller should treat it as zero.
 */
export function buildNodeSpawnInput(
  input: NodeSpawnValuationInput
): PlannerInput | null {
  const { spawnPos, localSources, controllerPos, reachableSources = [] } = input;
  const sinkValues = input.sinkValues ?? DEFAULT_NODE_SINK_VALUES;
  const dist = input.dist ?? chebyshevDistance;

  // No value sink means no chain can mint anything: the spawn is worthless here.
  if (!controllerPos) return null;
  if (localSources.length === 0 && reachableSources.length === 0) return null;

  const sources: PlannerSource[] = localSources.map((s) => ({
    id: s.id,
    supply: supplyOf(s.capacity),
    pos: s.pos,
  }));

  // Place each reachable source at its true range from the spawn so the planner
  // sizes its hauler (and charges its overhead) by the real inter-node distance.
  reachableSources.forEach((rs, i) => {
    sources.push({
      id: rs.id ?? `reach-${i}`,
      supply: supplyOf(rs.capacity),
      pos: { x: spawnPos.x + rs.distance, y: spawnPos.y, roomName: spawnPos.roomName },
    });
  });

  const sinks: PlannerSink[] = [
    { id: "spawn", kind: "spawn", value: sinkValues.spawn, capacity: 0, pos: spawnPos },
    {
      id: "controller",
      kind: "controller",
      value: sinkValues.controller,
      capacity: Number.POSITIVE_INFINITY,
      reserve: 1,
      pos: controllerPos,
    },
  ];

  return { sources, sinks, spawnId: "spawn", dist };
}

/**
 * Value the spawn that would run a node: the full chain of corps it stands up
 * over its own and its neighbours' sources. Null when the site can sustain no
 * productive chain (see {@link buildNodeSpawnInput}).
 */
export function valuateNodeSpawn(
  input: NodeSpawnValuationInput
): CorpValuation | null {
  const plannerInput = buildNodeSpawnInput(input);
  if (!plannerInput) return null;
  return valuateSpawnCorp(plannerInput);
}

/**
 * Scalar economic value of a node's spawn site (its productive energy/tick,
 * weighted by sink value), for ranking expansion candidates. Zero when the site
 * sustains no chain.
 */
export function nodeSpawnValue(input: NodeSpawnValuationInput): number {
  const valuation = valuateNodeSpawn(input);
  return valuation ? valuation.marginalValue : 0;
}
