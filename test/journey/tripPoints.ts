/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * tripPoints - the RCL journey's inflection moments (docs/specs/10), defined
 * ONCE and used from both sides of the snapshot loop:
 *
 *   capture (scripts/journey-capture.ts): an ORGANIC long sim watches every
 *   trip point; the first tick one fires, the world state from ~5 ticks
 *   earlier (rolling buffer) is written to test/fixtures/journey/ as a
 *   replayable scenario.
 *
 *   replay (test/grid/cells/journey.ts): each stored snapshot becomes a grid
 *   cell that restores the world just-before-the-moment and asserts the SAME
 *   check fires within a short window - the long organic run is paid once,
 *   at capture time; the grid replays only the core moment forever after.
 *
 * Checks are pure functions of a JourneySample so they run against both the
 * capture harness's world reads and the grid's CellSample.
 */

export interface JourneySample {
  tick: number;
  /** Parsed bot Memory ({} when unparsable). */
  memory: any;
  /** All room objects across the sim's loaded rooms. */
  objects(): any[];
}

export interface TripPoint {
  /** Kebab-case id; also the snapshot's file stem. */
  id: string;
  /** What this moment is, for the doc and the cell comment. */
  description: string;
  /** Fires the first tick the moment has happened. */
  check(s: JourneySample): boolean;
  /**
   * Replay window (ticks) the grid cell gets to re-reach the moment from the
   * T-5 snapshot. Keep small - the snapshot IS the moment minus five ticks;
   * anything past ~10x the lead means the restore lost load-bearing state.
   */
  replayWindow: number;
}

const creepsWith = (s: JourneySample, pred: (mem: any, name: string) => boolean): number =>
  Object.entries(s.memory?.creeps ?? {}).filter(([name, mem]) => pred(mem, name)).length;

const structures = (s: JourneySample, type: string): any[] =>
  s.objects().filter((o: any) => o.type === type);

const controllerLevelAtLeast = (n: number) => (s: JourneySample): boolean =>
  s.objects().some((o: any) => o.type === "controller" && (o.level ?? 0) >= n);

export const TRIP_POINTS: TripPoint[] = [
  {
    id: "first-flow-miner",
    description: "the first flow miner is fielded (bootstrap handover begins)",
    check: (s) => creepsWith(s, (m) => m?.workType === "harvest" && String(m?.corpId ?? "").startsWith("mining-")) >= 1,
    replayWindow: 60,
  },
  {
    id: "first-flow-hauler",
    description: "the first flow hauler is fielded (the delivery loop closes)",
    check: (s) => creepsWith(s, (m) => m?.workType === "haul" && String(m?.corpId ?? "").startsWith("hauling-")) >= 1,
    replayWindow: 60,
  },
  {
    id: "first-upgrader",
    description: "the first flow upgrader is fielded (supply-before-demand gate passed)",
    check: (s) => creepsWith(s, (m) => m?.workType === "upgrade") >= 1,
    // Wider than the fielding trips: restore drops any mid-spawn creep (its
    // spawn-side state is not restorable), and the measured capture caught a
    // hauler mid-build - the replay re-earns and re-spawns it before the
    // upgrader wins the queue again.
    replayWindow: 220,
  },
  {
    id: "first-extension-built",
    description: "the first extension STRUCTURE stands (capacity ladder begins)",
    check: (s) => structures(s, "extension").length >= 1,
    replayWindow: 100,
  },
  {
    id: "extensions-rcl2-cap",
    description: "all 5 RCL2 extensions stand (first capacity rung complete)",
    check: (s) => structures(s, "extension").length >= 5,
    replayWindow: 150,
  },
  {
    id: "first-container-built",
    description: "the first container STRUCTURE stands (pile -> container convergence)",
    check: (s) => structures(s, "container").length >= 1,
    replayWindow: 150,
  },
  {
    id: "rcl3",
    description: "the controller reaches RCL3",
    check: controllerLevelAtLeast(3),
    replayWindow: 60,
  },
  {
    id: "rcl4",
    description: "the controller reaches RCL4",
    check: controllerLevelAtLeast(4),
    replayWindow: 60,
  },
  {
    id: "storage-built",
    description: "the storage STRUCTURE stands (the container's RCL4 successor)",
    check: (s) => structures(s, "storage").length >= 1,
    replayWindow: 200,
  },
  {
    id: "rcl5",
    description: "the controller reaches RCL5",
    check: controllerLevelAtLeast(5),
    replayWindow: 60,
  },
  {
    id: "core-link-built",
    description: "the first link STRUCTURE stands (logistics backbone at RCL5)",
    check: (s) => structures(s, "link").length >= 1,
    replayWindow: 200,
  },
  {
    id: "link-pump-live",
    description: "energy moves through a link (the pump is real, not just built)",
    check: (s) => structures(s, "link").some((o: any) => (o.store?.energy ?? 0) > 0),
    replayWindow: 150,
  },
];

export function tripPoint(id: string): TripPoint {
  const tp = TRIP_POINTS.find((t) => t.id === id);
  if (!tp) throw new Error(`unknown trip point: ${id}`);
  return tp;
}
