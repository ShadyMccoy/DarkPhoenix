import { expect } from "chai";
import { evaluateSpawnChain } from "../../../src/corps/ChainEvaluator";
import { Position } from "../../../src/types/Position";

function at(x: number, y: number): Position {
  return { x, y, roomName: "W0N0" };
}

const source = (id: string, pos: Position) => ({ id, capacity: 3000, pos });

describe("ChainEvaluator", () => {
  it("scores a source + controller chain above zero", () => {
    const v = evaluateSpawnChain({
      spawnPos: at(25, 25),
      sources: [source("a", at(25, 30))],
      controllerPos: at(25, 20),
    });
    expect(v).to.be.greaterThan(0);
  });

  it("is zero with no controller to upgrade", () => {
    expect(
      evaluateSpawnChain({ spawnPos: at(25, 25), sources: [source("a", at(25, 30))] })
    ).to.equal(0);
  });

  it("is zero with no sources to mine", () => {
    expect(
      evaluateSpawnChain({ spawnPos: at(25, 25), sources: [], controllerPos: at(25, 20) })
    ).to.equal(0);
  });

  it("scores two sources above one", () => {
    const one = evaluateSpawnChain({
      spawnPos: at(25, 25),
      sources: [source("a", at(20, 30))],
      controllerPos: at(25, 20),
    });
    const two = evaluateSpawnChain({
      spawnPos: at(25, 25),
      sources: [source("a", at(20, 30)), source("b", at(30, 30))],
      controllerPos: at(25, 20),
    });
    expect(two).to.be.greaterThan(one);
  });

  it("values a spawn near its worksites above a far one (travel cost)", () => {
    const near = evaluateSpawnChain({
      spawnPos: at(25, 22),
      sources: [source("a", at(25, 26))],
      controllerPos: at(25, 20),
    });
    const far = evaluateSpawnChain({
      spawnPos: at(5, 5),
      sources: [source("a", at(25, 26))],
      controllerPos: at(25, 20),
    });
    expect(near).to.be.greaterThan(far);
  });

  it("counts a reachable adjacent source, worth less than a local one", () => {
    const localOnly = evaluateSpawnChain({
      spawnPos: at(25, 25),
      sources: [source("a", at(25, 30))],
      controllerPos: at(25, 20),
    });
    const withReachable = evaluateSpawnChain({
      spawnPos: at(25, 25),
      sources: [source("a", at(25, 30))],
      controllerPos: at(25, 20),
      reachableSources: [{ capacity: 3000, distance: 35 }],
    });
    const withSecondLocal = evaluateSpawnChain({
      spawnPos: at(25, 25),
      sources: [source("a", at(25, 30)), source("b", at(25, 29))],
      controllerPos: at(25, 20),
    });
    expect(withReachable).to.be.greaterThan(localOnly);
    expect(withReachable).to.be.lessThan(withSecondLocal);
  });

  it("values a nearer reachable source above a farther one", () => {
    const near = evaluateSpawnChain({
      spawnPos: at(25, 25),
      sources: [source("a", at(25, 30))],
      controllerPos: at(25, 20),
      reachableSources: [{ capacity: 3000, distance: 15 }],
    });
    const far = evaluateSpawnChain({
      spawnPos: at(25, 25),
      sources: [source("a", at(25, 30))],
      controllerPos: at(25, 20),
      reachableSources: [{ capacity: 3000, distance: 45 }],
    });
    expect(near).to.be.greaterThan(far);
  });
});
