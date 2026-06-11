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

  it("ranks in the scaling-income tier: above a fresh source's SECOND miner, below any source's FIRST miner", () => {
    // The reserver optimises an already-producing source (it doubles its regen), so
    // it belongs with scaling income, not on the critical path. As a started, non-
    // blocking income demand it outranks fresh SCALING demands (a second miner)...
    const startedReserver = demand({ role: "reserver", value: 92, producesIncome: true, groupId: "reservation-W1N0", groupStarted: true });
    const freshSecondMiner = demand({ role: "miner", value: 100, blocking: false, producesIncome: true, groupId: "new-src", groupStarted: false });
    expect(spawnPriority(startedReserver)).to.be.greaterThan(spawnPriority(freshSecondMiner));

    // ...but it yields to opening a brand-new source's FIRST miner (blocking, the
    // critical path): get every source producing before optimising existing ones.
    const freshFirstMiner = demand({ role: "miner", value: 100, blocking: true, producesIncome: true, groupId: "new-src", groupStarted: false });
    expect(spawnPriority(startedReserver)).to.be.lessThan(spawnPriority(freshFirstMiner));
  });
});
