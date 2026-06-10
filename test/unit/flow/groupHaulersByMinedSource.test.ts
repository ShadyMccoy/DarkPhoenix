import { expect } from "chai";
import { groupHaulersByMinedSource } from "../../../src/flow/FlowMaterializer";
import { HaulerAssignment } from "../../../src/flow/FlowTypes";

function hauler(fromId: string, toId: string): HaulerAssignment {
  return {
    edgeId: `${fromId}|${toId}`,
    fromId,
    toId,
    distance: 10,
    carryParts: 2,
    flowRate: 10,
    spawnCostPerTick: 0.1,
    spawnId: "spawn-abc"
  };
}

describe("groupHaulersByMinedSource", () => {
  it("keeps haulers for a source that has a miner", () => {
    const haulers = [hauler("source-A", "spawn-x"), hauler("source-A", "controller-x")];
    const { bySource, orphaned } = groupHaulersByMinedSource(haulers, () => true);

    expect(orphaned).to.have.length(0);
    expect([...bySource.keys()]).to.deep.equal(["A"]);
    expect(bySource.get("A")).to.have.length(2);
  });

  it("drops haulers for a source with no miner (the orphan-hauler bug)", () => {
    // source-B has a miner; source-A (e.g. a remote source we can't see) does not.
    const haulers = [hauler("source-A", "controller-x"), hauler("source-B", "controller-x")];
    const hasMiner = (src: string): boolean => src === "B";

    const { bySource, orphaned } = groupHaulersByMinedSource(haulers, hasMiner);

    expect([...bySource.keys()]).to.deep.equal(["B"]);
    expect(orphaned).to.deep.equal(["A"]);
  });

  it("reports an orphaned source only once even with several routes", () => {
    const haulers = [hauler("source-A", "spawn-x"), hauler("source-A", "controller-x")];
    const { bySource, orphaned } = groupHaulersByMinedSource(haulers, () => false);

    expect(bySource.size).to.equal(0);
    expect(orphaned).to.deep.equal(["A"]);
  });
});
