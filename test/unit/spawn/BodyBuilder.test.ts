import { expect } from "chai";
import { buildTankerBody } from "../../../src/spawn/BodyBuilder";

/** A creep body with zero MOVE parts cannot move at all - it is dead weight that
 * can also wedge itself against the spawn and choke creep production. The
 * CARRY-heavy tanker ratio makes it easy to spend the whole budget on CARRY
 * before any MOVE is added, so the builder must guarantee a MOVE. */
describe("buildTankerBody", () => {
  function moveParts(body: string[]): number {
    return body.filter((p) => p === "move").length;
  }
  function carryParts(body: string[]): number {
    return body.filter((p) => p === "carry").length;
  }

  it("always includes at least one MOVE part, even on a tight budget", () => {
    // Sweep budgets that previously produced all-CARRY (moveless) bodies.
    for (let energy = 100; energy <= 800; energy += 50) {
      for (let carry = 1; carry <= 8; carry++) {
        const { body } = buildTankerBody(carry, energy, false);
        if (body.length === 0) continue; // too poor for any tanker - acceptable
        expect(moveParts(body), `energy=${energy} carry=${carry} body=${body}`).to.be.gte(1);
      }
    }
  });

  it("is CARRY-heavy: more CARRY than MOVE when it can afford to be", () => {
    const { body } = buildTankerBody(6, 600, false);
    expect(carryParts(body)).to.be.greaterThan(moveParts(body));
  });

  it("never exceeds the energy budget", () => {
    for (let energy = 100; energy <= 800; energy += 50) {
      const { cost } = buildTankerBody(8, energy, false);
      expect(cost, `energy=${energy}`).to.be.lte(energy);
    }
  });

  it("returns an empty body when the room cannot afford a minimal tanker", () => {
    const { body, cost } = buildTankerBody(4, 50, false);
    expect(body).to.deep.equal([]);
    expect(cost).to.equal(0);
  });
});
