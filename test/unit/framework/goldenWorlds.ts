/**
 * The three standard pure worlds the golden master pins, mirroring the
 * integration scenario library's shapes (singleSource / twoSourceRcl3 /
 * threeChamber) as ColonyProblems - Manhattan distance, hand-derivable.
 * Shared by planEquivalence.test.ts and generateSnapshot.ts so the pin and
 * the regenerator can never drift apart.
 */

import { Position } from "../../../src/types/Position";
import { ColonyProblem, DEFAULT_SINK_VALUE } from "../../../src/economy/CorpPlanner";
import { Commission } from "../../../src/economy/Commission";
import { planCommissions } from "../../../src/economy/commissionPlan";

const ROOM = "W0N0";
const at = (x: number, y = 0): Position => ({ x, y, roomName: ROOM });
const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** singleSource: spawn centre, source 20 out, controller 15 the other way. */
function singleSource(): ColonyProblem {
  return {
    spawns: [{ id: "spawn1", pos: at(0) }],
    sources: [{ id: "srcA", nodeId: "node-A", pos: at(20), rate: 10, maxMiners: 1 }],
    sinks: [
      { id: "sink-spawn", kind: "spawn", pos: at(0), value: DEFAULT_SINK_VALUE.spawn, capacity: 4 },
      { id: "sink-ctrl", kind: "controller", pos: at(-15), value: DEFAULT_SINK_VALUE.controller, capacity: 1000, reserve: 2 }
    ],
    dist: manhattan
  };
}

/** twoSourceRcl3: two sources flanking the spawn, controller north-ish. */
function twoSourceRcl3(): ColonyProblem {
  return {
    spawns: [{ id: "spawn1", pos: at(0) }],
    sources: [
      { id: "srcA", nodeId: "node-A", pos: at(-12), rate: 10, maxMiners: 2 },
      { id: "srcB", nodeId: "node-B", pos: at(12), rate: 10, maxMiners: 2 }
    ],
    sinks: [
      { id: "sink-spawn", kind: "spawn", pos: at(0), value: DEFAULT_SINK_VALUE.spawn, capacity: 6 },
      { id: "sink-ctrl", kind: "controller", pos: at(-18), value: DEFAULT_SINK_VALUE.controller, capacity: 1000, reserve: 2 },
      { id: "sink-build", kind: "construction", pos: at(4), value: DEFAULT_SINK_VALUE.construction, capacity: 5 }
    ],
    dist: manhattan
  };
}

/** threeChamber: source far west, spawn centre, controller far east. */
function threeChamber(): ColonyProblem {
  return {
    spawns: [{ id: "spawn1", pos: at(0) }],
    sources: [{ id: "srcA", nodeId: "node-A", pos: at(-30), rate: 10, maxMiners: 1 }],
    sinks: [
      { id: "sink-spawn", kind: "spawn", pos: at(0), value: DEFAULT_SINK_VALUE.spawn, capacity: 4 },
      { id: "sink-ctrl", kind: "controller", pos: at(30), value: DEFAULT_SINK_VALUE.controller, capacity: 1000, reserve: 2 }
    ],
    dist: manhattan
  };
}

export const goldenWorlds: Record<string, () => ColonyProblem> = {
  singleSource,
  twoSourceRcl3,
  threeChamber
};

/** Stable, diff-friendly commission normal form (sorted, rounded). */
export function normalizedCommissions(problem: ColonyProblem): unknown[] {
  const round = (n: number | undefined): number | undefined =>
    n === undefined ? undefined : Math.round(n * 1e6) / 1e6;
  return planCommissions(problem)
    .commissions.map(c => normalize(c, round))
    .sort((a, b) => (a.corpId < b.corpId ? -1 : 1));
}

function normalize(
  c: Commission,
  round: (n: number | undefined) => number | undefined
): { corpId: string; kind: string; shape: string; consumes: unknown; produces: unknown; assignment: unknown } {
  return {
    corpId: c.corpId,
    kind: c.kind,
    shape: c.shape,
    consumes: {
      energyRate: round(c.consumes.energyRate),
      at: c.consumes.at ?? null,
      spawnPartsPerTick: round(c.consumes.spawnPartsPerTick)
    },
    produces: {
      energyRate: round(c.produces.energyRate),
      at: c.produces.at ?? null,
      valuePerTick: round(c.produces.valuePerTick)
    },
    // assignments are part of the pin: round their numeric leaves via JSON walk
    assignment: JSON.parse(
      JSON.stringify(c.assignment, (_k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v))
    )
  };
}
