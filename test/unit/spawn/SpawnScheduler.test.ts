import { expect } from "chai";
import {
  scheduleSpawn,
  spawnPriority,
  starvationBoost,
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

    describe("breadth-first-on-the-critical-path strategy", () => {
      it("finishes a started source's SCALING hauler before opening a fresh source's SCALING demand", () => {
        // Both demands are scaling (non-blocking): A is already mined and wants
        // another hauler, B wants a second miner. Among scaling demands the started
        // source is finished first, so A's extra hauler beats B's extra miner.
        const startedHauler = demand({
          buyerCorpId: "haulA", role: "hauler", value: 90,
          producesIncome: true, groupId: "A", groupStarted: true,
        });
        const freshScaling = demand({
          buyerCorpId: "minerB", role: "miner", value: 100,
          producesIncome: true, groupId: "B", groupStarted: false,
        });
        const result = scheduleSpawn([freshScaling, startedHauler], ctx({ energyAvailable: 300 }));
        expect(result?.demand.buyerCorpId).to.equal("haulA");
      });

      it("opens a fresh source's FIRST MINER before scaling up an already-hauled source", () => {
        // The bug fix: source A is mined AND already has its first hauler, so its
        // remaining demand is a SCALING hauler (non-blocking). Source B has never
        // been mined - its first miner is blocking. Opening B (the critical path of a
        // whole second source) must beat topping up A, otherwise A monopolises the
        // spawn and B stays at zero income forever (the user-reported "other source
        // has no miner" while the first piles up).
        const scalingHaulerA = demand({
          buyerCorpId: "haulA", role: "hauler", value: 110, blocking: false,
          producesIncome: true, groupId: "A", groupStarted: true,
        });
        const freshBlockingMinerB = demand({
          buyerCorpId: "minerB", role: "miner", value: 100, blocking: true,
          producesIncome: true, groupId: "B", groupStarted: false,
        });
        const result = scheduleSpawn([scalingHaulerA, freshBlockingMinerB], ctx({ energyAvailable: 300 }));
        expect(result?.demand.buyerCorpId).to.equal("minerB");
      });

      it("still staffs a started source's FIRST HAULER before opening a fresh source's miner", () => {
        // The good half of the old strategy, preserved: a started source whose energy
        // is stranding (its FIRST hauler is blocking) is unstranded before a fresh
        // source's first miner opens, so we never leave a producing source un-hauled.
        const blockingFirstHaulerA = demand({
          buyerCorpId: "haulA", role: "hauler", value: 90, blocking: true,
          producesIncome: true, groupId: "A", groupStarted: true,
        });
        const freshBlockingMinerB = demand({
          buyerCorpId: "minerB", role: "miner", value: 100, blocking: true,
          producesIncome: true, groupId: "B", groupStarted: false,
        });
        const result = scheduleSpawn([freshBlockingMinerB, blockingFirstHaulerA], ctx({ energyAvailable: 300 }));
        expect(result?.demand.buyerCorpId).to.equal("haulA");
      });

      it("opens a fresh source once no started-source critical demand remains", () => {
        const freshMiner = demand({
          buyerCorpId: "minerB", role: "miner", value: 100, blocking: true,
          producesIncome: true, groupId: "B", groupStarted: false,
        });
        const result = scheduleSpawn([freshMiner], ctx({ energyAvailable: 300 }));
        expect(result?.demand.buyerCorpId).to.equal("minerB");
      });
    });

  });

  describe("spawnPriority()", () => {
    it("ranks any income corp above consumption, even a higher-value consumer", () => {
      const income = demand({ role: "miner", value: 100, producesIncome: true, groupId: "A" });
      const consumer = demand({ role: "upgrader", value: 110, blocking: true }); // no groupId
      expect(spawnPriority(income)).to.be.greaterThan(spawnPriority(consumer));
    });

    it("ranks a fresh source's FIRST MINER (blocking) above a started source's SCALING hauler", () => {
      // The critical-path fix: opening a new source beats topping up an old one.
      const freshFirstMiner = demand({ role: "miner", value: 100, blocking: true, producesIncome: true, groupId: "B", groupStarted: false });
      const startedScalingHauler = demand({ role: "hauler", value: 110, blocking: false, producesIncome: true, groupId: "A", groupStarted: true });
      expect(spawnPriority(freshFirstMiner)).to.be.greaterThan(spawnPriority(startedScalingHauler));
    });

    it("ranks a started source's FIRST HAULER (blocking) above a fresh source's first miner", () => {
      // ...but a producing source's stranded energy is hauled before a new source opens.
      const startedFirstHauler = demand({ role: "hauler", value: 90, blocking: true, producesIncome: true, groupId: "A", groupStarted: true });
      const freshFirstMiner = demand({ role: "miner", value: 100, blocking: true, producesIncome: true, groupId: "B", groupStarted: false });
      expect(spawnPriority(startedFirstHauler)).to.be.greaterThan(spawnPriority(freshFirstMiner));
    });

    it("ranks a started scaling demand above a fresh scaling demand (finish a started source first)", () => {
      const started = demand({ role: "hauler", value: 90, producesIncome: true, groupId: "A", groupStarted: true });
      const fresh = demand({ role: "miner", value: 100, producesIncome: true, groupId: "B", groupStarted: false });
      expect(spawnPriority(started)).to.be.greaterThan(spawnPriority(fresh));
    });

    it("nudges the urgent (blocking) demand ahead within a tier", () => {
      const urgent = demand({ role: "hauler", value: 90, blocking: true, producesIncome: true, groupId: "A", groupStarted: true });
      const scaling = demand({ role: "miner", value: 90, blocking: false, producesIncome: true, groupId: "A", groupStarted: true });
      expect(spawnPriority(urgent)).to.be.greaterThan(spawnPriority(scaling));
    });
  });

  describe("anti-starvation aging", () => {
    it("does not boost an unstamped demand (since=0) or one within the threshold", () => {
      const fresh = demand({ role: "builder", value: 95 }); // since defaults to 0
      expect(starvationBoost(fresh, 100_000)).to.equal(0);
      const stampedRecent = demand({ role: "builder", value: 95, since: 1000 });
      expect(starvationBoost(stampedRecent, 1200)).to.equal(0); // 200 < 300 threshold
    });

    it("a long-starved builder is lifted above the income tier after the threshold", () => {
      const starvedBuilder = demand({ role: "builder", value: 95, since: 1000 });
      const income = demand({ role: "miner", value: 100, blocking: true, producesIncome: true, groupId: "A" });
      const tick = 1000 + 300; // exactly the threshold
      const eff = (d: SpawnDemand): number => spawnPriority(d) + starvationBoost(d, tick);
      expect(eff(starvedBuilder)).to.be.greaterThan(eff(income));
    });

    it("scheduleSpawn picks a long-starved consumer over an affordable blocking income demand", () => {
      // Reproduces the stuck-construction bug: a value-95 builder that the income
      // tier has out-ranked for >300 ticks finally wins its one spawn slot.
      const tick = 5000;
      const builder = demand({ role: "builder", value: 95, minCost: 200, desiredCost: 300, since: tick - 300 });
      const miner = demand({ role: "miner", value: 100, blocking: true, producesIncome: true, groupId: "A", minCost: 200, desiredCost: 300, since: tick });
      const result = scheduleSpawn([miner, builder], ctx({ energyAvailable: 300, energyCapacity: 300, tick }));
      expect(result?.demand.role).to.equal("builder");
    });

    it("without starvation the income demand still wins (no regression)", () => {
      const tick = 5000;
      const builder = demand({ role: "builder", value: 95, minCost: 200, desiredCost: 300, since: tick - 10 });
      const miner = demand({ role: "miner", value: 100, blocking: true, producesIncome: true, groupId: "A", minCost: 200, desiredCost: 300, since: tick });
      const result = scheduleSpawn([builder, miner], ctx({ energyAvailable: 300, energyCapacity: 300, tick }));
      expect(result?.demand.role).to.equal("miner");
    });
  });
});

/**
 * The starved-hold fix (grid cell plan-t1-single-source-loop): a demand past
 * the starvation threshold gains HOLD semantics, not just the rank lift.
 * Without it, an unaffordable non-blocking demand is skipped no matter its
 * rank, and every cheaper demand keeps eating the 200-299 energy band first -
 * measured: at 300 capacity a scaling hauler (min 300) lost the band to
 * miners/tankers/upgraders for 700+ ticks while the controller starved at
 * progress 0.
 *
 * Mutation check: revert `mustFund` to `demand.blocking` and exactly these
 * cases fail.
 */
describe("starved demands hold the spawn (controller-starve guard)", () => {
  const STARVED_SINCE = 1; // with tick 1000, far past the 300-tick threshold

  it("holds outright (income > 0) instead of funding a cheaper demand", () => {
    const starvedHauler = demand({
      buyerCorpId: "carry",
      role: "hauler",
      producesIncome: true,
      minCost: 300,
      desiredCost: 800,
      since: STARVED_SINCE,
    });
    const cheapMiner = demand({ buyerCorpId: "mine", role: "miner", producesIncome: true, minCost: 250 });
    const result = scheduleSpawn(
      [cheapMiner, starvedHauler],
      ctx({ energyAvailable: 260, energyCapacity: 300, energyIncome: 10, tick: 1000 })
    );
    expect(result).to.equal(null); // the bank accumulates for the starved body
  });

  it("without starvation the same demand is skipped and the cheaper one spawns", () => {
    const freshHauler = demand({
      buyerCorpId: "carry",
      role: "hauler",
      producesIncome: true,
      minCost: 300,
      desiredCost: 800,
      since: 900, // seen recently: 100 ticks < threshold
    });
    const cheapMiner = demand({ buyerCorpId: "mine", role: "miner", producesIncome: true, minCost: 250 });
    const result = scheduleSpawn(
      [cheapMiner, freshHauler],
      ctx({ energyAvailable: 260, energyCapacity: 300, energyIncome: 10, tick: 1000 })
    );
    expect(result?.demand.buyerCorpId).to.equal("mine");
  });

  it("spawns the starved demand itself the moment it is affordable", () => {
    const starvedHauler = demand({
      buyerCorpId: "carry",
      role: "hauler",
      producesIncome: true,
      minCost: 300,
      desiredCost: 800,
      since: STARVED_SINCE,
    });
    const result = scheduleSpawn([starvedHauler], ctx({ energyAvailable: 300, energyCapacity: 300, tick: 1000 }));
    expect(result?.demand.buyerCorpId).to.equal("carry");
    expect(result?.energyBudget).to.equal(300);
  });

  it("never holds for a starved demand the room cannot ever afford", () => {
    const impossible = demand({ buyerCorpId: "dream", minCost: 900, desiredCost: 900, since: STARVED_SINCE });
    const affordable = demand({ buyerCorpId: "mine", minCost: 250 });
    const result = scheduleSpawn(
      [affordable, impossible],
      ctx({ energyAvailable: 260, energyCapacity: 300, tick: 1000 })
    );
    expect(result?.demand.buyerCorpId).to.equal("mine");
  });
});
