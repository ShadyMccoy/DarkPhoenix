/**
 * Cutover Step B: the solver-backed kinds' run() must replicate the legacy
 * runRealCorps cadence - plan() periodically (every PLANNING_INTERVAL ticks),
 * work() every tick. These tests pin that each kind's run() invokes plan() on
 * the planning boundary and not in between, so moving them off runRealCorps to
 * the host preserves the planning rhythm.
 */

import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { harvestKind } from "../../../src/corps/kinds/harvestKind";
import { carryKind } from "../../../src/corps/kinds/carryKind";
import { upgradeKind } from "../../../src/corps/kinds/upgradeKind";

const PLANNING_INTERVAL = 100; // Corp.PLANNING_INTERVAL

function installGlobals(): void {
  setupGlobals();
  Game.creeps = {};
  Game.rooms = {};
  Game.getObjectById = () => null;
  (Memory as Record<string, unknown>).creeps = {};
}

const ROOM = "W1N1";
const at = (x: number) => ({ x, y: 25, roomName: ROOM });

const fixtures = [
  {
    kind: harvestKind,
    commission: {
      corpId: "harvest-s",
      kind: "harvest",
      shape: "produce" as const,
      consumes: { spawnPartsPerTick: 0.3 },
      produces: { energyRate: 10, at: at(20) },
      assignment: { sourceId: "src", nodeId: "n", spawnId: "spawn-g", distance: 20, rate: 10, spawnParts: 0.3, netEnergy: 9, efficiency: 90, maxMiners: 1 }
    }
  },
  {
    kind: carryKind,
    commission: {
      corpId: "carry-s",
      kind: "carry",
      shape: "transport" as const,
      consumes: { energyRate: 10, at: at(20), spawnPartsPerTick: 1 },
      produces: { energyRate: 10 },
      assignment: [{ sourceId: "src", sinkId: "k", spawnId: "spawn-g", distance: 20, flowRate: 10, carryParts: 6, spawnParts: 0.4 }]
    }
  },
  {
    kind: upgradeKind,
    commission: {
      corpId: "upgrade-k",
      kind: "upgrade",
      shape: "consume" as const,
      consumes: { energyRate: 9, at: at(40), spawnPartsPerTick: 0 },
      produces: { valuePerTick: 9, at: at(40) },
      assignment: { sink: { sinkId: "k", kind: "controller", value: 1, demand: 12, allocated: 9, sources: [] }, spawnId: "spawn-g" }
    }
  }
];

describe("Step B: solver-backed kinds plan on the planning cadence", () => {
  beforeEach(installGlobals);

  for (const { kind, commission } of fixtures) {
    it(`${kind.kind}: run() plans on the PLANNING_INTERVAL boundary, not in between (legacy cadence)`, () => {
      const corp = kind.materialize(commission as never, undefined);
      let plans = 0;
      const realPlan = corp.plan.bind(corp);
      corp.plan = (t: number) => {
        plans += 1;
        realPlan(t);
      };

      // Fresh corp has lastPlannedTick 0: shouldPlan(t) = t >= PLANNING_INTERVAL.
      kind.run(corp as never, 0);
      kind.run(corp as never, PLANNING_INTERVAL - 1);
      expect(plans, "no plan before the first interval elapses").to.equal(0);

      kind.run(corp as never, PLANNING_INTERVAL); // boundary reached -> plan, lastPlannedTick = INTERVAL
      expect(plans, "plans at the interval boundary").to.equal(1);

      kind.run(corp as never, PLANNING_INTERVAL + 1);
      kind.run(corp as never, 2 * PLANNING_INTERVAL - 1);
      expect(plans, "no re-plan within the next interval").to.equal(1);

      kind.run(corp as never, 2 * PLANNING_INTERVAL);
      expect(plans, "re-plans once the next interval elapses").to.equal(2);
    });
  }
});
