import { expect } from "chai";
import { RESERVER_BODY_COST } from "../../../src/corps/economics";

/**
 * The smallest reserver body (1 CLAIM + 1 MOVE) costs 650, which is what makes
 * reserving unaffordable below RCL 3 (550 capacity) with no explicit RCL gate:
 * IncrementalAnalysis's couldReserve check compares home capacity against this.
 */
describe("reserver economics", () => {
  it("prices the smallest reserver body (1 CLAIM + 1 MOVE)", () => {
    expect(RESERVER_BODY_COST).to.equal(650);
  });
});
