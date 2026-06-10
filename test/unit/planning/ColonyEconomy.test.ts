import { expect } from "chai";
import { colonyEconomy, marginalNodeValue, ColonyNode } from "../../../src/planning/ColonyEconomy";
import { ChainSource } from "../../../src/corps/ChainEvaluator";
import { Position } from "../../../src/types/Position";

function at(x: number, y: number): Position {
  return { x, y, roomName: "W0N0" };
}
const source = (id: string, pos: Position): ChainSource => ({ id, capacity: 3000, pos });

describe("ColonyEconomy", () => {
  it("sums positive net for a colony with sources to mine", () => {
    const nodes: ColonyNode[] = [{ id: "A", hubPos: at(25, 25), controllerPos: at(25, 22) }];
    const value = colonyEconomy(nodes, [source("s", at(25, 28))]);
    expect(value).to.be.greaterThan(0);
  });

  it("assigns each source to exactly one hub (no double counting)", () => {
    // Two hubs equidistant from a single source: it goes to one of them, so the
    // colony total is ONE hub's net, not two.
    const oneHub: ColonyNode[] = [{ id: "A", hubPos: at(18, 25), controllerPos: at(18, 22) }];
    const twoHubs: ColonyNode[] = [
      { id: "A", hubPos: at(18, 25), controllerPos: at(18, 22) },
      { id: "B", hubPos: at(22, 25), controllerPos: at(22, 22) },
    ];
    const sources = [source("s", at(20, 28))]; // equidistant from A and B
    expect(colonyEconomy(twoHubs, sources)).to.be.closeTo(colonyEconomy(oneHub, sources), 1e-9);
  });

  describe("marginalNodeValue (cannibalization)", () => {
    const existing: ColonyNode[] = [{ id: "A", hubPos: at(15, 25), controllerPos: at(15, 22) }];
    const servedSource = source("shared", at(15, 28)); // sits in A's lap

    it("scores ~0 for a candidate that only steals an already-served source", () => {
      // B is farther from the shared source than A, so A keeps mining it.
      const candidate: ColonyNode = { id: "B", hubPos: at(40, 25), controllerPos: at(40, 22) };
      const value = marginalNodeValue(existing, candidate, [servedSource]);
      expect(value).to.be.closeTo(0, 1e-9);
    });

    it("scores positive for a candidate that brings a genuinely new source", () => {
      // B's own source, far from A - unserved without B, served with it.
      const candidate: ColonyNode = { id: "B", hubPos: at(40, 25), controllerPos: at(40, 22) };
      const newSource = source("fresh", at(40, 28));
      const value = marginalNodeValue(existing, candidate, [servedSource, newSource]);
      expect(value).to.be.greaterThan(0);
    });

    it("credits only the improvement when the candidate serves a source better", () => {
      // B sits right on the shared source; A is far. With B the source is served
      // much better, so the marginal value is positive but only the improvement,
      // not the full source value.
      const candidate: ColonyNode = { id: "B", hubPos: at(15, 28), controllerPos: at(15, 31) };
      const marginal = marginalNodeValue(existing, candidate, [servedSource]);
      const inIsolation = colonyEconomy([candidate], [servedSource]);
      expect(marginal).to.be.greaterThan(0);
      expect(marginal).to.be.lessThan(inIsolation); // not the full value - A already had it
    });
  });
});
