import { expect } from "chai";
import {
  valuateSpawnCorp,
  valuateSourceCorp,
  valuateSinkCorp,
} from "../../../src/planning/CorpValuator";
import {
  PlannerInput,
  PlannerSink,
  PlannerSource,
} from "../../../src/flow/EconomyPlanner";
import { Position } from "../../../src/types/Position";

/** Chebyshev distance in a single room - matches the planner's body sizing. */
const dist = (a: Position, b: Position): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function at(x: number, y: number): Position {
  return { x, y, roomName: "W0N0" };
}

/** A spawn that can feed a controller, with `sources` mineable sources. */
function world(sources: PlannerSource[], extraSinks: PlannerSink[] = []): PlannerInput {
  const sinks: PlannerSink[] = [
    { id: "spawn-S", kind: "spawn", value: 100, capacity: 0, pos: at(25, 25) },
    { id: "controller-C", kind: "controller", value: 50, capacity: 1000, reserve: 2, pos: at(25, 20) },
    ...extraSinks,
  ];
  return { sources, sinks, spawnId: "S", dist };
}

describe("CorpValuator", () => {
  describe("valuateSpawnCorp", () => {
    it("values a spawn by the whole chain it would stand up from nothing", () => {
      const v = valuateSpawnCorp(world([{ id: "source-A", supply: 10, pos: at(25, 30) }]));

      // A spawn with a reachable source + controller is worth something: it
      // enables a productive chain that mints controller points.
      expect(v.marginalValue).to.be.greaterThan(0);
      expect(v.marginalThroughput).to.be.greaterThan(0);

      // The enabled chain is the full roster: mine the source, haul it, upgrade.
      const kinds = v.enabledCorps.map((c) => c.kind);
      expect(kinds).to.include("mine");
      expect(kinds).to.include("haul");
      expect(kinds).to.include("upgrade");

      // Baseline is the empty economy.
      expect(v.planWithout.corps).to.have.length(0);
    });

    it("values a spawn reaching two sources above one reaching a single source", () => {
      const one = valuateSpawnCorp(world([{ id: "source-A", supply: 10, pos: at(20, 30) }]));
      const two = valuateSpawnCorp(
        world([
          { id: "source-A", supply: 10, pos: at(20, 30) },
          { id: "source-B", supply: 10, pos: at(30, 30) },
        ])
      );

      // More chains found -> more value and more enabled corps.
      expect(two.marginalValue).to.be.greaterThan(one.marginalValue);
      expect(two.enabledCorps.length).to.be.greaterThan(one.enabledCorps.length);
    });

    it("values a spawn near its sources above an otherwise identical far spawn", () => {
      const near = valuateSpawnCorp(world([{ id: "source-A", supply: 10, pos: at(25, 26) }]));

      // Same world but the controller (and routing) reach a source that is far
      // from the spawn: longer hauls cost more overhead, so less productive
      // energy survives -> lower value.
      const farWorld = world([{ id: "source-A", supply: 10, pos: at(25, 49) }]);
      const far = valuateSpawnCorp(farWorld);

      expect(near.marginalValue).to.be.greaterThan(far.marginalValue);
    });
  });

  describe("valuateSourceCorp", () => {
    it("gives a positive marginal value for a source that opens a new chain", () => {
      const base = world([{ id: "source-A", supply: 10, pos: at(20, 30) }]);
      const v = valuateSourceCorp({ id: "source-B", supply: 10, pos: at(30, 30) }, base);

      expect(v.marginalThroughput).to.be.greaterThan(0);
      expect(v.marginalValue).to.be.greaterThan(0);
      // The new chain mines source-B (and hauls it onward).
      expect(v.enabledCorps.some((c) => c.kind === "mine" && c.sourceId === "source-B")).to.equal(true);
    });

    it("values an extra source at ~0 when every sink is already at capacity", () => {
      // One small-capacity construction sink (cap 5) plus the controller. Cap
      // the controller too so the colony cannot absorb a second source.
      const cappedSinks: PlannerSink[] = [
        { id: "spawn-S", kind: "spawn", value: 100, capacity: 0, pos: at(25, 25) },
        { id: "controller-C", kind: "controller", value: 50, capacity: 5, pos: at(25, 20) },
      ];
      const base: PlannerInput = {
        sources: [{ id: "source-A", supply: 10, pos: at(24, 24) }],
        sinks: cappedSinks,
        spawnId: "S",
        dist,
      };
      const v = valuateSourceCorp({ id: "source-B", supply: 10, pos: at(26, 26) }, base);

      // No sink can absorb the extra energy -> it is unrouted -> no new value.
      expect(v.marginalThroughput).to.be.closeTo(0, 1e-9);
      expect(v.marginalValue).to.be.closeTo(0, 1e-9);
    });
  });

  describe("valuateSinkCorp", () => {
    it("values a high-value sink that pulls energy into productive work", () => {
      // A spawn + source whose controller has a tiny capacity, so most energy
      // is otherwise unrouted. Adding a high-value construction sink gives the
      // colony somewhere valuable to route that energy.
      const base: PlannerInput = {
        sources: [{ id: "source-A", supply: 10, pos: at(25, 30) }],
        sinks: [
          { id: "spawn-S", kind: "spawn", value: 100, capacity: 0, pos: at(25, 25) },
          { id: "controller-C", kind: "controller", value: 50, capacity: 1, reserve: 1, pos: at(25, 20) },
        ],
        spawnId: "S",
        dist,
      };
      const v = valuateSinkCorp(
        { id: "construction-X", kind: "construction", value: 70, capacity: 5, pos: at(25, 30) },
        base
      );

      expect(v.marginalValue).to.be.greaterThan(0);
      expect(v.enabledCorps.some((c) => c.kind === "build" && c.sinkId === "construction-X")).to.equal(true);
    });
  });
});
