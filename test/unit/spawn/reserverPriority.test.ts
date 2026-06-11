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

  it("a fresh reserver still ranks below a started income corp (core mining completes first)", () => {
    const reserver = demand({ role: "reserver", value: 92, producesIncome: true, groupId: "reservation-W1N0" });
    const startedHauler = demand({ role: "hauler", value: 100, producesIncome: true, groupId: "src", groupStarted: true });
    expect(spawnPriority(reserver)).to.be.lessThan(spawnPriority(startedHauler));
  });
});
