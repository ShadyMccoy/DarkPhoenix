/**
 * The dispatch's default run cadence (spec 32 phase D; historically cutover
 * Step B): a kind that declares no run() gets the legacy runRealCorps rhythm
 * from runCorpTick - plan() periodically (every PLANNING_INTERVAL ticks),
 * work() every tick. These tests pin that the default plans on the planning
 * boundary and not in between, over the solver-backed kinds that used to
 * hand-write exactly this cadence.
 */

import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { CorpKind, runCorpTick } from "../../../src/economy/CorpKind";
import { Corp } from "../../../src/corps/Corp";
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
    it(`${kind.kind}: the default cadence plans on the PLANNING_INTERVAL boundary, not in between`, () => {
      const dispatch = kind as unknown as CorpKind;
      expect(dispatch.run, "solver-backed kinds declare no run() - the dispatch default IS their cadence").to.equal(
        undefined
      );
      const corp: Corp = kind.materialize(commission as never, undefined);
      let plans = 0;
      const realPlan = corp.plan.bind(corp);
      corp.plan = (t: number) => {
        plans += 1;
        realPlan(t);
      };

      // Fresh corp has lastPlannedTick 0: shouldPlan(t) = t >= PLANNING_INTERVAL.
      runCorpTick(dispatch, corp, 0);
      runCorpTick(dispatch, corp, PLANNING_INTERVAL - 1);
      expect(plans, "no plan before the first interval elapses").to.equal(0);

      runCorpTick(dispatch, corp, PLANNING_INTERVAL); // boundary reached -> plan, lastPlannedTick = INTERVAL
      expect(plans, "plans at the interval boundary").to.equal(1);

      runCorpTick(dispatch, corp, PLANNING_INTERVAL + 1);
      runCorpTick(dispatch, corp, 2 * PLANNING_INTERVAL - 1);
      expect(plans, "no re-plan within the next interval").to.equal(1);

      runCorpTick(dispatch, corp, 2 * PLANNING_INTERVAL);
      expect(plans, "re-plans once the next interval elapses").to.equal(2);
    });
  }
});
