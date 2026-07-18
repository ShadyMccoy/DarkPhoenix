import { expect } from "chai";
import { SpawnDemand, scheduleSpawn } from "../../../src/spawn/SpawnScheduler";
import { resetDemandClock, stampDemandAges } from "../../../src/execution/SpawnDirector";

/**
 * The starvation backstop's bounded-time guarantee, pinned at both seams that
 * broke it (flow-handoff regression on the FIFO-among-starved build: ZERO flow
 * creeps by t600, spawn walled behind an unaffordable ancient head while the
 * bootstrap corp drained the bank from its own path).
 *
 * Two mechanisms, two seams:
 *  1. The WALK: an unaffordable starved must-fund demand defers its hold while
 *     the walk is still inside the starved tier - it must not wall out an
 *     affordable starved demand behind it. At the tier boundary the deferred
 *     hold becomes real, so lower (fresh) tiers still bank for it.
 *  2. The CLOCK: demand age measures UNSERVED time. A purchase resets the
 *     stream's clock, restoring STARVED_TIER's documented one-shot contract
 *     ("once the creep exists ... its age resets") for standing multi-creep
 *     demands (live incident t72403765: self-renewing scale-hauler stream held
 *     ancient clocks through four buys in ~160t while tender/upgrader starved).
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

describe("starved tier walk (no walls inside the backstop)", () => {
  it("an unaffordable starved must-fund head defers; an affordable starved demand behind it buys", () => {
    // Cold-start shape: the oldest starved demand is an expensive miner the
    // dribble cannot afford; a younger-but-starved consumer IS affordable.
    // Pre-fix the walk hard-exited (return null at income>0) on the head and
    // the spawn bought nothing, forever.
    const oldMiner = demand({
      buyerCorpId: "mining-old",
      role: "miner",
      blocking: true,
      minCost: 700,
      desiredCost: 700,
      since: 10000 // age 3000 - starved, oldest
    });
    const youngUpgrader = demand({
      buyerCorpId: "upgrading-1",
      role: "upgrader",
      producesIncome: false,
      value: 70,
      minCost: 250,
      desiredCost: 500,
      since: 11500 // age 1500 - starved, younger
    });
    const result = scheduleSpawn([oldMiner, youngUpgrader], {
      energyAvailable: 300,
      energyCapacity: 800,
      energyIncome: 10,
      tick: 13000
    });
    expect(result?.demand.buyerCorpId).to.equal("upgrading-1");
  });

  it("below the tier the deferred hold binds: a fresh demand may not spend the held bank", () => {
    // The hold's protection of LOWER tiers is unchanged: once the walk leaves
    // the starved tier with a pending hold, fresh demands wait (income > 0 =>
    // spawn holds outright) so the bank accumulates toward the starved body.
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
