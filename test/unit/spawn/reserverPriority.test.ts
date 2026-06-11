import { expect } from "chai";
import { spawnPriority, SpawnDemand } from "../../../src/spawn/SpawnScheduler";

function demand(over: Partial<SpawnDemand>): SpawnDemand {
  return {
    buyerCorpId: "c",
    role: "miner",
    value: 90,
    blocking: false,
    producesIncome: false,
    desiredCost: 300,
    minCost: 150,
    since: 0,
    ...over
  };
}

/**
 * The reserver is income work - it unlocks +5 e/tick on every source in the remote
 * room it holds. The tiered spawnPriority puts a demand in the income tier only when
 * it has BOTH producesIncome AND a groupId. The reserver declares producesIncome but
 * collectDemands must give it a groupId (it now does) - otherwise it sits at its base
 * value (92), below every income corp and below a blocking consumer, and is starved
 * forever, so the remote never gets reserved and stays at the unreserved half-rate.
 */
describe("reserver spawn priority (income, not starved)", () => {
  it("a grouped reserver outranks discretionary upgrading", () => {
    const reserver = demand({ role: "reserver", value: 92, producesIncome: true, groupId: "reservation-W1N0" });
    const upgrader = demand({ role: "upgrader", value: 90, producesIncome: false });
    expect(spawnPriority(reserver)).to.be.greaterThan(spawnPriority(upgrader));
  });

  it("grouping lifts the reserver above even a BLOCKING consumer (the starvation it fixes)", () => {
    // The bug: an ungrouped reserver (92) is below a blocking first upgrader
    // (90 + the urgent boost), so it never wins while the colony ramps.
    const ungrouped = demand({ role: "reserver", value: 92, producesIncome: true });
    const blockingUpgrader = demand({ role: "upgrader", value: 90, producesIncome: false, blocking: true });
    expect(spawnPriority(ungrouped), "ungrouped reserver is starved").to.be.lessThan(spawnPriority(blockingUpgrader));

    // The fix: with a groupId it joins the income tier, above consumption.
    const grouped = demand({ role: "reserver", value: 92, producesIncome: true, groupId: "reservation-W1N0" });
    expect(spawnPriority(grouped), "grouped reserver is income-tier").to.be.greaterThan(spawnPriority(blockingUpgrader));
  });

  it("a started reserver still yields to a higher-value started hauler (base energy moves first)", () => {
    // The reserver is groupStarted (its remote is already mined), but within the
    // started income tier ranking is by value, so a started hauler (100+) that moves
    // the base energy still outranks the reserver (92). The reserver only doubles the
    // source the hauler is already emptying, so funding the hauler first is right.
    const reserver = demand({ role: "reserver", value: 92, producesIncome: true, groupId: "reservation-W1N0", groupStarted: true });
    const startedHauler = demand({ role: "hauler", value: 100, producesIncome: true, groupId: "src", groupStarted: true });
    expect(spawnPriority(reserver)).to.be.lessThan(spawnPriority(startedHauler));
  });

  it("a started reserver outranks opening a brand-new source (reserved mining beats plain mining)", () => {
    // The headline intent: reserving a remote we ALREADY mine (doubling committed
    // infrastructure) beats opening a fresh source (+5/tick but needs a new miner,
    // haulers and road). The reserver's demand only exists once its remote has a
    // miner, so it is a started unit (1e6+92) and leads any fresh source-opening
    // miner (1e6+100) - which, as a *fresh* reserver (1e6+92 < 1e6+100), it would not.
    const startedReserver = demand({ role: "reserver", value: 92, producesIncome: true, groupId: "reservation-W1N0", groupStarted: true });
    const freshMiner = demand({ role: "miner", value: 100, producesIncome: true, groupId: "new-src" });
    expect(spawnPriority(startedReserver)).to.be.greaterThan(spawnPriority(freshMiner));

    // The contrast that motivates groupStarted: a *fresh* reserver loses to the fresh miner.
    const freshReserver = demand({ role: "reserver", value: 92, producesIncome: true, groupId: "reservation-W1N0" });
    expect(spawnPriority(freshReserver)).to.be.lessThan(spawnPriority(freshMiner));
  });
});
