import { expect } from "chai";
import {
  scheduleSpawn,
  effectiveValue,
  SpawnDemand,
  ScheduleContext,
} from "../../../src/spawn/SpawnScheduler";

function demand(overrides: Partial<SpawnDemand>): SpawnDemand {
  return {
    buyerCorpId: "corp",
    role: "miner",
    value: 10,
    blocking: false,
    producesIncome: false,
    desiredCost: 300,
    minCost: 150,
    since: 0,
    ...overrides,
  };
}

function ctx(overrides: Partial<ScheduleContext>): ScheduleContext {
  return {
    energyAvailable: 300,
    energyCapacity: 300,
    energyIncome: 10,
    tick: 0,
    ...overrides,
  };
}

describe("SpawnScheduler", () => {
  describe("scheduleSpawn()", () => {
    it("returns null when there are no demands", () => {
      expect(scheduleSpawn([], ctx({}))).to.equal(null);
    });

    it("spawns the highest-value affordable demand", () => {
      const low = demand({ buyerCorpId: "low", value: 5 });
      const high = demand({ buyerCorpId: "high", value: 50 });
      const result = scheduleSpawn([low, high], ctx({ energyAvailable: 300 }));
      expect(result?.demand.buyerCorpId).to.equal("high");
    });

    it("caps the energy budget at desired cost when energy is plentiful", () => {
      const d = demand({ desiredCost: 250, minCost: 150 });
      const result = scheduleSpawn([d], ctx({ energyAvailable: 550, energyCapacity: 550 }));
      expect(result?.energyBudget).to.equal(250);
      expect(result?.reason).to.equal("afford-desired");
    });

    it("scales the body down to available energy when below desired cost", () => {
      const d = demand({ desiredCost: 400, minCost: 150 });
      const result = scheduleSpawn([d], ctx({ energyAvailable: 300, energyCapacity: 550 }));
      expect(result?.energyBudget).to.equal(300);
      expect(result?.reason).to.equal("afford-min-scaled");
    });

    it("skips a demand it cannot afford and spawns a cheaper affordable one", () => {
      const expensive = demand({ buyerCorpId: "exp", value: 100, minCost: 500, desiredCost: 500 });
      const cheap = demand({ buyerCorpId: "cheap", value: 10, minCost: 150, desiredCost: 200 });
      const result = scheduleSpawn([expensive, cheap], ctx({ energyAvailable: 300, energyCapacity: 550 }));
      expect(result?.demand.buyerCorpId).to.equal("cheap");
    });

    describe("wait-for-blocking behavior", () => {
      it("waits (spawns nothing) for an unaffordable blocking demand when income is flowing", () => {
        // The upgrader is blocking + high value but cannot be afforded yet; a
        // cheap miner is affordable. With energy flowing in we should hold the
        // spawn for the upgrader rather than spend on the miner.
        const upgrader = demand({
          buyerCorpId: "upgrader", role: "upgrader", value: 80, blocking: true,
          minCost: 400, desiredCost: 500,
        });
        const miner = demand({
          buyerCorpId: "miner", role: "miner", value: 30, producesIncome: true,
          minCost: 150, desiredCost: 300,
        });
        const result = scheduleSpawn([upgrader, miner], ctx({
          energyAvailable: 300, energyCapacity: 550, energyIncome: 10,
        }));
        expect(result).to.equal(null);
      });

      it("does NOT wait when no energy is coming in - spawns an affordable income producer instead", () => {
        // Bootstrap case: nothing is delivering energy yet, so waiting for the
        // blocking upgrader would deadlock. Spawn the affordable miner to start
        // the economy.
        const upgrader = demand({
          buyerCorpId: "upgrader", role: "upgrader", value: 80, blocking: true,
          minCost: 400, desiredCost: 500,
        });
        const miner = demand({
          buyerCorpId: "miner", role: "miner", value: 30, producesIncome: true,
          minCost: 150, desiredCost: 300,
        });
        const result = scheduleSpawn([upgrader, miner], ctx({
          energyAvailable: 300, energyCapacity: 550, energyIncome: 0,
        }));
        expect(result?.demand.buyerCorpId).to.equal("miner");
      });

      it("holds for a blocking income PRODUCER at income==0 instead of funding more producers", () => {
        // The first hauler deadlock: a freshly-mining source's blocking hauler
        // costs more than the drained spawn holds, and income is 0 (bootstrap
        // delivers separately). Spawning the affordable extra miner would bleed
        // the spawn and the hauler's body would never accumulate - energy is
        // already being mined, it just needs moving. So we hold (spawn nothing).
        const hauler = demand({
          buyerCorpId: "hauler", role: "hauler", value: 100, blocking: true,
          producesIncome: true, minCost: 300, desiredCost: 500,
        });
        const extraMiner = demand({
          buyerCorpId: "miner2", role: "miner", value: 30, producesIncome: true,
          minCost: 150, desiredCost: 250,
        });
        const result = scheduleSpawn([hauler, extraMiner], ctx({
          energyAvailable: 200, energyCapacity: 550, energyIncome: 0,
        }));
        expect(result).to.equal(null);
      });

      it("still spawns a lower-ranked blocking demand while holding for an unaffordable one", () => {
        // Holding for one blocking producer must not block ANOTHER source's
        // affordable first miner - that makes real progress (more income).
        const hauler = demand({
          buyerCorpId: "hauler", role: "hauler", value: 100, blocking: true,
          producesIncome: true, minCost: 300, desiredCost: 500,
        });
        const firstMiner = demand({
          buyerCorpId: "minerB", role: "miner", value: 90, blocking: true,
          producesIncome: true, minCost: 150, desiredCost: 250,
        });
        const result = scheduleSpawn([hauler, firstMiner], ctx({
          energyAvailable: 200, energyCapacity: 550, energyIncome: 0,
        }));
        expect(result?.demand.buyerCorpId).to.equal("minerB");
      });

      it("does NOT wait for a blocking demand the room can never afford", () => {
        const tooBig = demand({
          buyerCorpId: "toobig", role: "upgrader", value: 80, blocking: true,
          minCost: 800, desiredCost: 800,
        });
        const miner = demand({
          buyerCorpId: "miner", value: 30, producesIncome: true, minCost: 150, desiredCost: 300,
        });
        const result = scheduleSpawn([tooBig, miner], ctx({
          energyAvailable: 300, energyCapacity: 550, energyIncome: 10,
        }));
        expect(result?.demand.buyerCorpId).to.equal("miner");
      });

      it("spawns the blocking demand once the spawn has filled enough", () => {
        const upgrader = demand({
          buyerCorpId: "upgrader", role: "upgrader", value: 80, blocking: true,
          minCost: 400, desiredCost: 500,
        });
        const miner = demand({
          buyerCorpId: "miner", value: 30, producesIncome: true, minCost: 150, desiredCost: 300,
        });
        const result = scheduleSpawn([upgrader, miner], ctx({
          energyAvailable: 450, energyCapacity: 550, energyIncome: 10,
        }));
        expect(result?.demand.buyerCorpId).to.equal("upgrader");
        expect(result?.energyBudget).to.equal(450);
      });
    });

    describe("fund-one-corp-fully strategy", () => {
      it("finishes a started source's haulers before opening a fresh source's miner", () => {
        // Source A is already mined (groupStarted) and still wants a second
        // hauler; source B's first miner is fresh. Even though the fresh miner
        // has a slightly higher base value, completing the started unit wins, so
        // A's energy gets hauled home before B is opened.
        const startedHauler = demand({
          buyerCorpId: "haulA", role: "hauler", value: 90,
          producesIncome: true, groupId: "A", groupStarted: true,
        });
        const freshMiner = demand({
          buyerCorpId: "minerB", role: "miner", value: 100,
          producesIncome: true, groupId: "B", groupStarted: false,
        });
        const result = scheduleSpawn([freshMiner, startedHauler], ctx({ energyAvailable: 300 }));
        expect(result?.demand.buyerCorpId).to.equal("haulA");
      });

      it("opens a fresh source once the started one is fully staffed", () => {
        // No started-unit demand remains (A is done); only B's fresh miner is
        // left, so the spawn moves on and opens it.
        const freshMiner = demand({
          buyerCorpId: "minerB", role: "miner", value: 100,
          producesIncome: true, groupId: "B", groupStarted: false,
        });
        const result = scheduleSpawn([freshMiner], ctx({ energyAvailable: 300 }));
        expect(result?.demand.buyerCorpId).to.equal("minerB");
      });

      it("still lets a blocking bootstrap demand outrank a started unit's completion", () => {
        const bootstrapMiner = demand({
          buyerCorpId: "boot", role: "miner", value: 100, blocking: true,
          producesIncome: true, groupId: "A", groupStarted: false,
        });
        const startedHauler = demand({
          buyerCorpId: "haulB", role: "hauler", value: 110,
          producesIncome: true, groupId: "B", groupStarted: true,
        });
        const result = scheduleSpawn([startedHauler, bootstrapMiner], ctx({ energyAvailable: 300 }));
        expect(result?.demand.buyerCorpId).to.equal("boot");
      });
    });

    describe("anti-starvation aging", () => {
      it("lets a long-waiting demand overtake a higher-base-value newcomer", () => {
        const newcomer = demand({ buyerCorpId: "new", value: 100, since: 1000 });
        const oldcomer = demand({ buyerCorpId: "old", value: 10, since: 0 });
        // After enough ticks, aging on the old demand exceeds the value gap.
        const result = scheduleSpawn([newcomer, oldcomer], ctx({ tick: 1000, energyAvailable: 300 }));
        expect(result?.demand.buyerCorpId).to.equal("old");
      });
    });
  });

  describe("effectiveValue()", () => {
    it("boosts blocking demands above non-blocking ones", () => {
      const block = demand({ blocking: true, value: 1 });
      const noblock = demand({ blocking: false, value: 1 });
      expect(effectiveValue(block, 0)).to.be.greaterThan(effectiveValue(noblock, 0));
    });

    it("increases with age", () => {
      const d = demand({ value: 10, since: 0 });
      expect(effectiveValue(d, 100)).to.be.greaterThan(effectiveValue(d, 0));
    });
  });
});
