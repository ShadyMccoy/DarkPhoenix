import { expect } from "chai";
import { withMinerPrecedence } from "../../../src/spawn/SpawnScheduler";
import { SpawnDemand, SpawnRole } from "../../../src/spawn/SpawnScheduler";

function demand(role: SpawnRole, groupId: string | undefined, value = 100, groupStarted = false): SpawnDemand {
  return {
    buyerCorpId: `${role}-${groupId}`,
    role,
    value,
    blocking: false,
    producesIncome: role === "miner" || role === "hauler",
    groupId,
    groupStarted,
    desiredCost: 300,
    minCost: 150,
    since: 0
  };
}

describe("withMinerPrecedence", () => {
  it("drops a source's haulers while its miner is still unmet", () => {
    const demands = [demand("miner", "srcA"), demand("hauler", "srcA", 110)];
    const out = withMinerPrecedence(demands);

    expect(out.map(d => d.role)).to.deep.equal(["miner"]);
  });

  it("drops an orphan hauler whose source has no miner in the field", () => {
    // srcA has a hauler demand but no miner mining yet (groupStarted false) - e.g.
    // a remote source the miner-profitability gate rejected. The hauler has nothing
    // to carry, so it must be dropped (the "parked at a minerless source" failure).
    const demands = [demand("hauler", "srcA"), demand("upgrader", "roomX")];
    const out = withMinerPrecedence(demands);

    expect(out.map(d => d.role)).to.deep.equal(["upgrader"]);
  });

  it("keeps a source's haulers once its first miner is in the field (groupStarted)", () => {
    // srcA still wants a bigger/second miner, but one is already mining
    // (groupStarted) - so its haulers must NOT be held back. collectDemands stamps
    // every demand of a started source with groupStarted=true.
    const demands = [demand("miner", "srcA", 100, true), demand("hauler", "srcA", 100, true)];
    const out = withMinerPrecedence(demands);

    expect(out.map(d => d.role)).to.deep.equal(["miner", "hauler"]);
  });

  it("holds back haulers of unstarted sources, keeps haulers of a started one", () => {
    const demands = [
      demand("miner", "srcA"), // srcA not mining yet -> its hauler held
      demand("hauler", "srcA"),
      demand("hauler", "srcB", 100, true) // srcB is mining (groupStarted) -> allowed
    ];
    const out = withMinerPrecedence(demands);

    expect(out.map(d => d.buyerCorpId)).to.deep.equal(["miner-srcA", "hauler-srcB"]);
  });

  it("leaves non-mining demands untouched", () => {
    const demands = [demand("upgrader", "roomX"), demand("builder", "roomX"), demand("scout", undefined)];
    expect(withMinerPrecedence(demands)).to.have.length(3);
  });
});
