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

  it("keeps haulers once their source has no pending miner demand", () => {
    // srcA's miner is fully staffed (no miner demand), so its haulers proceed.
    const demands = [demand("hauler", "srcA"), demand("upgrader", "roomX")];
    const out = withMinerPrecedence(demands);

    expect(out).to.have.length(2);
  });

  it("keeps a source's haulers once its first miner is in the field (groupStarted)", () => {
    // srcA still wants a bigger/second miner, but one is already mining
    // (groupStarted) - so its haulers must NOT be held back.
    const demands = [demand("miner", "srcA", 100, true), demand("hauler", "srcA")];
    const out = withMinerPrecedence(demands);

    expect(out.map(d => d.role)).to.deep.equal(["miner", "hauler"]);
  });

  it("only holds back haulers of the same source, not other sources", () => {
    const demands = [
      demand("miner", "srcA"),
      demand("hauler", "srcA"),
      demand("hauler", "srcB") // srcB has no pending miner -> allowed
    ];
    const out = withMinerPrecedence(demands);

    expect(out.map(d => d.buyerCorpId)).to.deep.equal(["miner-srcA", "hauler-srcB"]);
  });

  it("leaves non-mining demands untouched", () => {
    const demands = [demand("upgrader", "roomX"), demand("builder", "roomX"), demand("scout", undefined)];
    expect(withMinerPrecedence(demands)).to.have.length(3);
  });
});
