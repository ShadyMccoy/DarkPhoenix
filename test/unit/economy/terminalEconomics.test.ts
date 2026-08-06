import { expect } from "chai";
import {
  TERMINAL_CAPACITY,
  TERMINAL_COOLDOWN,
  TERMINAL_COST_RANGE,
  TERMINAL_MIN_SEND,
  terminalDeliveredFraction,
  terminalSendCost,
  terminalSpendForDelivery,
  terminalThroughput
} from "../../../src/economy/primitives";

/**
 * THE PRICE OF INTER-ROOM ENERGY (spec 47 phase 1).
 *
 * A terminal is the only mechanism the engine gives us for moving energy
 * between rooms without walking it, and it is what makes the bank pair's
 * cross-hub route real: room A's storage source can reach room B's storage
 * sink. The engine charges a distance-decayed FEE on top of the amount sent
 * (Game.market.calcTransactionCost), so the transfer is not free routing -
 * it is a priced edge, and the value ladder should see that price.
 *
 * Every number below is hand-derived from the engine's own formula so a drift
 * fails loudly.
 */
describe("economy/primitives - terminal transfer economics", () => {
  describe("terminalSendCost: the engine's fee, priced not guessed", () => {
    it("is amount x (1 - exp(-distance/30)) - the calcTransactionCost formula", () => {
      for (const [amount, d] of [
        [1000, 10],
        [500, 3],
        [10_000, 45]
      ] as const) {
        expect(terminalSendCost(amount, d)).to.be.closeTo(amount * (1 - Math.exp(-d / TERMINAL_COST_RANGE)), 1e-9);
      }
    });

    it("a same-room send is free; the fee grows with distance and never reaches the amount", () => {
      expect(terminalSendCost(1000, 0), "distance 0: no decay, no fee").to.equal(0);
      expect(terminalSendCost(1000, 10)).to.be.closeTo(283.47, 0.01); // 1-e^(-1/3)
      expect(terminalSendCost(1000, 30)).to.be.closeTo(632.12, 0.01); // 1-e^(-1)
      expect(terminalSendCost(1000, 90)).to.be.closeTo(950.21, 0.01); // 1-e^(-3)
      // Asymptotic: the fee approaches the amount but never exceeds it. Pinned
      // at 120 - about the width of a Screeps world, so the furthest send any
      // real map can ask for. (Beyond ~700 the exponential underflows to 0 in
      // float64 and the fee EQUALS the amount; true in arithmetic, unreachable
      // in the game, and not worth a guard.)
      expect(terminalSendCost(1000, 120)).to.be.lessThan(1000);
      expect(terminalSendCost(1000, 120)).to.be.closeTo(981.68, 0.01); // 1-e^(-4)
    });

    it("is LINEAR in the amount, so a per-unit tax is exact (the linkTransferTax shape)", () => {
      const perUnit = terminalSendCost(1, 20);
      expect(terminalSendCost(750, 20)).to.be.closeTo(750 * perUnit, 1e-9);
    });

    it("stays fractional - planning math never rounds (the engine ceils at the call, we do not)", () => {
      // carryPartsFor's rule: a ledger that ceils disagrees with itself by a
      // fraction of a body. The runner rounds when it actually sends.
      expect(terminalSendCost(1, 10) % 1).to.not.equal(0);
    });
  });

  describe("terminalSpendForDelivery / terminalDeliveredFraction: what a transfer really costs", () => {
    // The engine deducts amount + fee from the sender and credits amount to
    // the receiver, so DELIVERING d costs d + fee(d) at the source. This is
    // the number the planner must charge - not the amount that lands.
    it("spending to deliver D is D + its fee", () => {
      const d = 20;
      expect(terminalSpendForDelivery(1000, d)).to.be.closeTo(1000 + terminalSendCost(1000, d), 1e-9);
    });

    it("at distance 0 delivery is free of overhead (spend == delivered)", () => {
      expect(terminalSpendForDelivery(1000, 0)).to.be.closeTo(1000, 1e-9);
      expect(terminalDeliveredFraction(0)).to.be.closeTo(1, 1e-9);
    });

    it("the delivered fraction is the inverse: what share of spent energy arrives", () => {
      for (const d of [5, 10, 30, 60]) {
        const spend = terminalSpendForDelivery(1000, d);
        expect(terminalDeliveredFraction(d)).to.be.closeTo(1000 / spend, 1e-9);
      }
    });

    it("the gradient is economically meaningful: near rooms cheap, far rooms brutal", () => {
      // This is what makes the value router prefer a near hub - the whole
      // reason the fee belongs in the plan rather than in the runner. Exact
      // values, so the docstring's percentages cannot drift from the math.
      expect(terminalDeliveredFraction(5)).to.be.closeTo(0.8669, 1e-4); // ~87% arrives
      expect(terminalDeliveredFraction(10)).to.be.closeTo(0.7791, 1e-4); // ~78%
      expect(terminalDeliveredFraction(30)).to.be.closeTo(0.6127, 1e-4); // ~61%
      expect(terminalDeliveredFraction(60)).to.be.closeTo(0.5363, 1e-4); // ~54%
      // strictly monotone: farther is always worse, never a flat spot the
      // router could tie-break arbitrarily on
      let prev = Infinity;
      for (let d = 0; d <= 80; d += 2) {
        const f = terminalDeliveredFraction(d);
        expect(f).to.be.lessThan(prev);
        prev = f;
      }
    });
  });

  describe("terminalThroughput: the cooldown is NOT the binding constraint", () => {
    it("one capacity-sized send per cooldown dwarfs any colony's income", () => {
      expect(terminalThroughput()).to.equal(TERMINAL_CAPACITY / TERMINAL_COOLDOWN);
      expect(terminalThroughput(), "30k e/t - no colony is near this").to.be.greaterThan(1000);
    });

    it("a realistic send is still far above colony income - the STOCK is what binds", () => {
      // Worth pinning: the transfer rate the plan plans is limited by how
      // fast the terminal can be refilled from the storage, never by the
      // engine's cooldown. Anyone tempted to model the cooldown as a cap
      // should see this fail to matter.
      expect(terminalThroughput(TERMINAL_MIN_SEND), "even the MINIMUM send is 10 e/t").to.equal(10);
      expect(terminalThroughput(5000)).to.equal(500);
    });
  });

  describe("the constants are the engine's", () => {
    it("matches Screeps TERMINAL_* values", () => {
      expect(TERMINAL_CAPACITY).to.equal(300_000);
      expect(TERMINAL_COOLDOWN).to.equal(10);
      expect(TERMINAL_MIN_SEND).to.equal(100);
      expect(TERMINAL_COST_RANGE).to.equal(30);
    });
  });
});
