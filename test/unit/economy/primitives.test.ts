import { expect } from "chai";
import {
  effectiveLife,
  roundTripTicks,
  carryPartsFor,
  minerOverhead,
  haulerOverhead,
  netEnergy,
  spawnPartsFor,
  miningBudgetPerSpawn,
  CREEP_LIFETIME,
  MINER_COST,
  MINER_PARTS
} from "../../../src/economy/primitives";

// First-principles checks: every number is hand-derived from the game constants
// so a formula change that drifts from the intended physics fails loudly.
describe("economy/primitives", () => {
  describe("effectiveLife", () => {
    it("is full lifetime at distance 0 and loses one tick per tile", () => {
      expect(effectiveLife(0)).to.equal(CREEP_LIFETIME);
      expect(effectiveLife(50)).to.equal(CREEP_LIFETIME - 50);
    });
    it("floors at 1 for absurd distances (never zero/negative)", () => {
      expect(effectiveLife(CREEP_LIFETIME + 1000)).to.equal(1);
    });
  });

  describe("roundTripTicks", () => {
    it("is 2*distance + 2 (out, back, load/unload)", () => {
      expect(roundTripTicks(0)).to.equal(2);
      expect(roundTripTicks(10)).to.equal(22);
      expect(roundTripTicks(25)).to.equal(52);
    });
  });

  describe("carryPartsFor", () => {
    it("keeps rate*roundTrip/50 energy in flight", () => {
      // 10 e/tick over distance 10: 10 * 22 / 50 = 4.4 carry parts
      expect(carryPartsFor(10, 10)).to.be.closeTo(4.4, 1e-9);
      // doubling the rate doubles the carry
      expect(carryPartsFor(20, 10)).to.be.closeTo(8.8, 1e-9);
      // farther sources need proportionally more carry
      expect(carryPartsFor(10, 25)).to.be.closeTo((10 * 52) / 50, 1e-9);
    });
    it("grows monotonically with distance", () => {
      expect(carryPartsFor(10, 30)).to.be.greaterThan(carryPartsFor(10, 10));
    });
  });

  describe("minerOverhead", () => {
    it("is MINER_COST amortised over the effective life", () => {
      expect(minerOverhead(0)).to.be.closeTo(MINER_COST / CREEP_LIFETIME, 1e-9);
      expect(minerOverhead(50)).to.be.closeTo(MINER_COST / (CREEP_LIFETIME - 50), 1e-9);
    });
  });

  describe("haulerOverhead", () => {
    it("is carryParts*(CARRY+MOVE) amortised over the effective life", () => {
      // 4.4 carry at distance 10: 4.4 * 100 / 1490
      expect(haulerOverhead(4.4, 10)).to.be.closeTo((4.4 * 100) / (CREEP_LIFETIME - 10), 1e-9);
    });
  });

  describe("netEnergy", () => {
    it("equals rate minus miner and hauler overhead (hand-computed)", () => {
      const d = 10;
      const carry = carryPartsFor(10, d); // 4.4
      const expected = 10 - MINER_COST / (CREEP_LIFETIME - d) - (carry * 100) / (CREEP_LIFETIME - d);
      expect(netEnergy(10, d)).to.be.closeTo(expected, 1e-9);
    });
    it("is high and near gross for a close source", () => {
      expect(netEnergy(10, 5)).to.be.greaterThan(9); // ~9.5
    });
    it("decreases monotonically with distance", () => {
      expect(netEnergy(10, 50)).to.be.lessThan(netEnergy(10, 10));
      expect(netEnergy(10, 150)).to.be.lessThan(netEnergy(10, 50));
    });
    it("stays positive for adjacent-room distances (hauler cost amortises)", () => {
      // a remote source ~60 tiles out is still worth mining in isolation
      expect(netEnergy(10, 60)).to.be.greaterThan(0);
    });
    it("eventually goes negative when travel dominates the lifetime", () => {
      // far enough out the round-trip carry overwhelms the yield
      expect(netEnergy(10, 320)).to.be.lessThan(0);
    });
  });

  describe("spawnPartsFor", () => {
    it("is (MINER_PARTS + 2*carryParts) / life (hand-computed)", () => {
      const d = 10;
      const carry = carryPartsFor(10, d); // 4.4
      const expected = (MINER_PARTS + 2 * carry) / (CREEP_LIFETIME - d);
      expect(spawnPartsFor(10, d)).to.be.closeTo(expected, 1e-9);
    });
    it("grows with distance (more carry parts, shorter life)", () => {
      expect(spawnPartsFor(10, 60)).to.be.greaterThan(spawnPartsFor(10, 10));
    });
  });

  describe("miningBudgetPerSpawn", () => {
    it("is one third of a part/tick times the mining fraction", () => {
      expect(miningBudgetPerSpawn()).to.be.closeTo((1 / 3) * 0.6, 1e-9);
    });
  });
});
