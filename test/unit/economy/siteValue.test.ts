import { expect } from "chai";
import { SiteNode, colonySiteValue, marginalSiteValue, spawnSiteValue } from "../../../src/economy/siteValue";
import { netEnergy } from "../../../src/economy/primitives";
import { Position } from "../../../src/types/Position";

/**
 * Spec 04 acceptance: site valuation re-based on the CorpPlanner. Ordering
 * semantics ported from the chain layer's pins, expected values re-derived
 * from economy/primitives (never carried over from the old layer).
 */
function at(x: number, y: number): Position {
  return { x, y, roomName: "W0N0" };
}
const source = (id: string, pos: Position) => ({ id, capacity: 3000, pos });

describe("spawnSiteValue", () => {
  it("is monotonic in source distance (closer spawn wins)", () => {
    const src = source("s", at(10, 25));
    const near = spawnSiteValue(at(20, 25), [src], at(20, 22)); // d=10
    const far = spawnSiteValue(at(50, 25) as Position, [src], at(50, 22) as Position); // d=40
    expect(near).to.be.greaterThan(0);
    expect(far).to.be.greaterThan(0);
    expect(near).to.be.greaterThan(far);
  });

  it("nets exactly zero for an unprofitable source (netEnergy <= 0 cutoff)", () => {
    // d=320 is past the profitability cutoff for a 10 e/t source: the planner
    // never commissions its miner, so nothing is delivered and nothing spent.
    expect(netEnergy(10, 320)).to.be.at.most(0); // the premise, from primitives
    const value = spawnSiteValue(at(0, 25), [{ id: "s", capacity: 3000, pos: { x: 320, y: 25, roomName: "W0N0" } }], at(0, 22), {
      dist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
    });
    expect(value).to.equal(0);
  });

  it("mints nothing without a controller", () => {
    expect(spawnSiteValue(at(20, 25), [source("s", at(10, 25))], null)).to.equal(0);
  });
});

describe("colonySiteValue", () => {
  it("assigns each source to exactly one hub (no double counting)", () => {
    const oneHub: SiteNode[] = [{ id: "A", hubPos: at(18, 25), controllerPos: at(18, 22) }];
    const twoHubs: SiteNode[] = [
      { id: "A", hubPos: at(18, 25), controllerPos: at(18, 22) },
      { id: "B", hubPos: at(22, 25), controllerPos: at(22, 22) }
    ];
    const sources = [source("s", at(20, 28))]; // equidistant from A and B
    expect(colonySiteValue(twoHubs, sources)).to.be.closeTo(colonySiteValue(oneHub, sources), 1e-9);
  });
});

describe("marginalSiteValue (cannibalization)", () => {
  const existing: SiteNode[] = [{ id: "A", hubPos: at(15, 25), controllerPos: at(15, 22) }];
  const servedSource = source("shared", at(15, 28)); // sits in A's lap

  it("scores ~0 for a candidate that only steals an already-served source", () => {
    // B is farther from the shared source than A, so A keeps mining it.
    const candidate: SiteNode = { id: "B", hubPos: at(40, 25), controllerPos: at(40, 22) };
    expect(marginalSiteValue(existing, candidate, [servedSource])).to.be.closeTo(0, 1e-6);
  });

  it("scores a genuinely new source by the service improvement it brings", () => {
    // Without B, hub A still serves `fresh` (25 tiles - profitable, just
    // costly); with B beside it the same source nets more. The marginal is
    // that improvement: positive, but well below the source's standalone
    // value (the spec's "closeTo standalone" only holds when the source is
    // unservable without the candidate, which in-room distances never make
    // true - re-derived from primitives: netEnergy(10,25)≈8.9 vs ≈9.4 at 3).
    const candidate: SiteNode = { id: "B", hubPos: at(40, 25), controllerPos: at(40, 22) };
    const newSource = source("fresh", at(40, 28));
    const marginal = marginalSiteValue(existing, candidate, [servedSource, newSource]);
    const alone = colonySiteValue([candidate], [newSource]);
    expect(marginal).to.be.greaterThan(0);
    expect(marginal).to.be.lessThan(alone);
  });

  it("credits only the improvement when the candidate serves a source better", () => {
    // B sits right on the shared source; A is far. The marginal value is the
    // service improvement, not the source's full standalone value.
    const candidate: SiteNode = { id: "B", hubPos: at(15, 28), controllerPos: at(15, 31) };
    const marginal = marginalSiteValue(existing, candidate, [servedSource]);
    const inIsolation = colonySiteValue([candidate], [servedSource]);
    expect(marginal).to.be.greaterThan(0);
    expect(marginal).to.be.lessThan(inIsolation);
  });

  it("a controllerless candidate mints nothing", () => {
    const candidate: SiteNode = { id: "B", hubPos: at(40, 25) };
    expect(marginalSiteValue(existing, candidate, [servedSource, source("fresh", at(40, 28))])).to.equal(0);
  });
});
