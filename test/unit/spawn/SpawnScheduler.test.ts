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
