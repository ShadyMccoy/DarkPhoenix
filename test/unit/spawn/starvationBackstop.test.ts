import { expect } from "chai";
import { SpawnDemand, effectivePriority, scheduleSpawn } from "../../../src/spawn/SpawnScheduler";
import { resetDemandClock, stampDemandAges } from "../../../src/execution/SpawnDirector";

/**
 * The starvation backstop's bounded-time guarantee, pinned at the seams the
 * flow-handoff regression exposed (first FIFO build: zero flow haulers by
 * t600; instrumented agenda-mirror draw named both mechanisms).
 *
 * Settled semantics:
 *  1. RANKING: the starved tier ranks by age BUCKET (age / STARVATION_
 *     THRESHOLD); within a bucket the value doctrine still orders the buys.
 *     Raw-age FIFO degenerated in cold start (every demand seeds the same
 *     tick, so "oldest" = collection order and miner buys round-robin across
 *     sources - no source completes, no hauler ever unlocks).
 *  2. THE WALK KEEPS ITS WALLS, starved tier included: an unaffordable
 *     blocking body funds precisely BECAUSE lower demands may not spend the
 *     accumulating bank (measured: a no-walls variant let the tier's builder
 *     eat the bank at 200 while the blocking hauler waited on 300 -
 *     receipts builder@325, hauler never).
 *  3. The CLOCK measures UNSERVED time. A purchase resets the stream's
 *     clock, restoring STARVED_TIER's documented one-shot contract for
 *     standing multi-creep demands (live t72403765: scale-hauler stream held
 *     ancient clocks through four buys in ~160t while tender/upgrader
 *     starved INSIDE the backstop).
 */
function demand(overrides: Partial<SpawnDemand>): SpawnDemand {
  return {
    buyerCorpId: "corp-x",
    role: "miner",
    value: 100,
    blocking: false,
    producesIncome: true,
    desiredCost: 500,
    minCost: 250,
    since: 0,
    ...overrides
  };
}

describe("starved tier ranking (bucketed FIFO: age bucket first, value within)", () => {
  it("a full-threshold-older demand outranks income regardless of value (live t72403765 shape)", () => {
    // Tender age 1371 = bucket 4; income hauler age 1134 = bucket 3. The
    // flat-boost ranking kept the hauler above the tender forever; a whole
    // extra bucket of starvation must win outright.
    const tender = demand({
      buyerCorpId: "moving-tender",
      role: "tanker",
      producesIncome: false,
      value: 96,
      since: 11629 // age 1371
    });
    const hauler = demand({
      buyerCorpId: "hauling-1",
      role: "hauler",
      groupId: "s1",
      groupStarted: true,
      value: 110,
      since: 11866 // age 1134 - income tier, but a bucket younger
    });
    expect(effectivePriority(tender, 13000)).to.be.greaterThan(effectivePriority(hauler, 13000));
  });

  it("within one bucket the value doctrine still orders (cold-start concentration)", () => {
    // Cold start seeds every demand in the same tick, so all share bucket 1.
    // Raw-age FIFO made this a tie broken by collection order (round-robin
    // across sources); within a bucket the started-source income demand must
    // outrank the consumer, so one source completes and unlocks its hauler.
    const startedHauler = demand({
      buyerCorpId: "hauling-1",
      role: "hauler",
      groupId: "s1",
      groupStarted: true,
      blocking: true,
      value: 110,
      since: 25
    });
    const builder = demand({
      buyerCorpId: "building-1",
      role: "builder",
      producesIncome: false,
      value: 95,
      since: 25 // same seed tick, same bucket
    });
    expect(effectivePriority(startedHauler, 400)).to.be.greaterThan(effectivePriority(builder, 400));
  });
});

describe("starved tier walk (the walls stay up)", () => {
  it("an affordable starved consumer may NOT spend the bank held for a starved blocking body", () => {
    // The builder-steal regression (instrumented flow-handoff draw): blocking
    // hauler waiting on bank>=300, builder affordable at 200 the moment both
    // crossed the starvation threshold. A no-walls variant bought the builder
    // (receipts builder@325) and the hauler never funded. The wall must hold:
    // spawn nothing, let the bank climb.
    const blockingHauler = demand({
      buyerCorpId: "hauling-1",
      role: "hauler",
      groupId: "s1",
      groupStarted: true,
      blocking: true,
      minCost: 300,
      desiredCost: 300,
      since: 25 // starved
    });
    const builder = demand({
      buyerCorpId: "building-1",
      role: "builder",
      producesIncome: false,
      value: 95,
      minCost: 200,
      desiredCost: 200,
      since: 25 // starved, same bucket, lower value
    });
    const result = scheduleSpawn([blockingHauler, builder], {
      energyAvailable: 230,
      energyCapacity: 550,
      energyIncome: 0, // nothing hauls yet - the cold-start regime
      tick: 400
    });
    expect(result).to.equal(null);
  });

  it("the hold binds below the tier too: a fresh demand may not spend the held bank", () => {
    const oldMiner = demand({
      buyerCorpId: "mining-old",
      role: "miner",
      blocking: true,
      minCost: 700,
      desiredCost: 700,
      since: 10000 // starved
    });
    const freshHauler = demand({
      buyerCorpId: "hauling-fresh",
      role: "hauler",
      groupId: "s1",
      groupStarted: true,
      minCost: 200,
      desiredCost: 400,
      since: 12950 // age 50 - NOT starved
    });
    const result = scheduleSpawn([oldMiner, freshHauler], {
      energyAvailable: 300,
      energyCapacity: 800,
      energyIncome: 10,
      tick: 13000
    });
    expect(result).to.equal(null);
  });
});

describe("demand age clock (unserved time, not time-since-first-request)", () => {
  const SPAWN = "spawn1";

  it("a purchase resets the stream's clock - the next registration starts fresh", () => {
    const firstSeen: { [key: string]: number } = {};
    const stamp = (tick: number): SpawnDemand => {
      const d = demand({ buyerCorpId: "hauling-1", role: "hauler" });
      stampDemandAges([d], SPAWN, firstSeen, new Set(), tick);
      return d;
    };

    expect(stamp(1000).since).to.equal(1000); // seeded
    expect(stamp(2000).since).to.equal(1000); // carried while unserved
    resetDemandClock(firstSeen, SPAWN, "hauling-1", "hauler"); // the spawn bought one
    expect(stamp(2001).since).to.equal(2001); // served stream starts FRESH
  });

  it("an unserved stream keeps its original clock while served streams reset around it", () => {
    // The t72403765 shape in miniature: the hauler stream is served over and
    // over (clock resets each buy); the tender is never served (clock ages).
    const firstSeen: { [key: string]: number } = {};
    const stampBoth = (tick: number): { hauler: SpawnDemand; tender: SpawnDemand } => {
      const hauler = demand({ buyerCorpId: "hauling-1", role: "hauler" });
      const tender = demand({ buyerCorpId: "moving-tender", role: "tanker", producesIncome: false, value: 96 });
      stampDemandAges([hauler, tender], SPAWN, firstSeen, new Set(), tick);
      return { hauler, tender };
    };

    stampBoth(1000);
    for (const buyTick of [1100, 1200, 1300]) {
      resetDemandClock(firstSeen, SPAWN, "hauling-1", "hauler");
      const { hauler, tender } = stampBoth(buyTick);
      expect(hauler.since).to.equal(buyTick); // reset by each purchase
      expect(tender.since).to.equal(1000); // still waiting since the start
    }
  });
});
