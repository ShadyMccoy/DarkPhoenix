import { expect } from "chai";
import { setupGlobals } from "../mock";
import { buildBuilderBody } from "../../../src/spawn/BodyBuilder";
import { constructionKind } from "../../../src/corps/kinds/constructionKind";

/**
 * Spec 34 D3: the builder body carries its own BUFFER - WORK from the absorb
 * share, CARRY sized to bridge the refuel interval (bufferCarryParts upstream),
 * MOVE sized for UNLADEN travel (C3: empty CARRY generates no fatigue, so
 * relocation between sites is free for the buffer; laden movement is only the
 * short site hops). Retires the fixed buildUpgraderBody(cap, 2) builder shape -
 * and the old path IGNORED bodyParam entirely (demand said 5 WORK, body came
 * out 2), a demand/body disagreement this pins away.
 */
describe("buildBuilderBody (spec 34 D3: WORK + buffer CARRY + unladen MOVE)", () => {
  before(() => setupGlobals());

  it("full budget: WORK as asked, CARRY = the buffer, MOVE = ceil(W/2)+1 unladen-sized", () => {
    const r = buildBuilderBody(5, 9, 1300);
    expect(r.workParts).to.equal(5);
    expect(r.carryParts).to.equal(9);
    expect(r.body.filter(p => p === "move").length).to.equal(4); // ceil(5/2)+1
    expect(r.cost).to.equal(5 * 100 + 9 * 50 + 4 * 50);
  });

  it("tight budget shrinks WORK and the buffer TOGETHER (ratio preserved - a slower burner needs less buffer)", () => {
    const r = buildBuilderBody(5, 9, 800);
    expect(r.workParts).to.equal(3);
    expect(r.carryParts).to.equal(6); // ceil(9 * 3/5) - the buffer tracks the burn
    expect(r.cost).to.be.at.most(800);
  });

  it("buffer floor: always at least 1 CARRY (a builder that can hold nothing builds nothing)", () => {
    const r = buildBuilderBody(2, 0, 500);
    expect(r.workParts).to.equal(2);
    expect(r.carryParts).to.equal(1);
  });

  it("never exceeds 50 parts (C4) - the squad split is the pressure valve beyond", () => {
    const r = buildBuilderBody(30, 40, 99999);
    expect(r.body.length).to.be.at.most(50);
    expect(r.workParts).to.be.lessThan(30);
    expect(r.workParts).to.be.greaterThan(0);
  });

  it("unaffordable (below 1W 1C 1M): empty body, cost 0", () => {
    const r = buildBuilderBody(2, 2, 150);
    expect(r.body).to.deep.equal([]);
    expect(r.cost).to.equal(0);
  });
});

describe("constructionKind.body honors bodyParam + the bufferCarry hint (spec 34)", () => {
  before(() => setupGlobals());

  it("builder: bodyParam is the WORK, hints.bufferCarry the CARRY - demand and body agree", () => {
    const viaKind = constructionKind.body("builder", 5, 1300, { bufferCarry: 9 });
    expect(viaKind).to.deep.equal(buildBuilderBody(5, 9, 1300).body);
  });

  it("builder defaults (no param/hint): a modest 2-WORK starter with a small buffer", () => {
    const viaKind = constructionKind.body("builder", undefined, 1300, {});
    expect(viaKind).to.deep.equal(buildBuilderBody(2, 2, 1300).body);
  });
});
