import { expect } from "chai";
import {
  jackBodyForCommute,
  JACK_BODY,
  JACK_COST,
  JACK_LONG_COMMUTE,
  LONG_JACK_BODY,
  LONG_JACK_COST
} from "../../../src/corps/CorpConstants";

// Distance-aware bootstrap sizing (spec 09 phase 1): the 1W1C1M jack was
// tuned on 5-tile synthetic rooms; real-map commutes (path 15-25) get the
// 1W2C2M body - double carry at 1.5 t/tile loaded, ~2.6x throughput.
describe("corps/jackBodyForCommute", () => {
  it("keeps the standard jack for short synthetic-scale commutes", () => {
    for (const d of [0, 5, JACK_LONG_COMMUTE]) {
      const { body, cost } = jackBodyForCommute(d);
      expect(body).to.deep.equal(JACK_BODY);
      expect(cost).to.equal(JACK_COST);
    }
  });

  it("upgrades to the long jack past the commute threshold", () => {
    for (const d of [JACK_LONG_COMMUTE + 1, 20, 40]) {
      const { body, cost } = jackBodyForCommute(d);
      expect(body).to.deep.equal(LONG_JACK_BODY);
      expect(cost).to.equal(LONG_JACK_COST);
    }
  });

  it("the long jack still fits a bare RCL1 spawn (300)", () => {
    expect(LONG_JACK_COST).to.be.at.most(300);
  });
});
