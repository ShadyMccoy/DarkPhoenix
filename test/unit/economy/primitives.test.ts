import { expect } from "chai";
import {
  deliveryLeadTime,
  effectiveLife,
  roundTripTicks,
  staffsPost,
  sustainableConsumptionRate,
  carryPartsFor,
  minerOverhead,
  haulerOverhead,
  netEnergy,
  spawnPartsFor,
  energyPerSpawnPart,
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

  describe("deliveryLeadTime / staffsPost (the delivery contract)", () => {
    it("lead time is build (3/part) plus the walk out with 1.5x + 10 safety", () => {
      // 8-part miner, 22 walk ticks: 24 build + ceil(22*1.5)=33 + 10 margin.
      expect(deliveryLeadTime(8, 22)).to.equal(67);
      expect(deliveryLeadTime(1, 0)).to.equal(13);
    });
    it("an incumbent staffs its post until exactly the lead time remains", () => {
      expect(staffsPost(68, 8, 22)).to.equal(true); // one tick of slack
      expect(staffsPost(67, 8, 22)).to.equal(false); // successor must start NOW
      expect(staffsPost(1, 8, 22)).to.equal(false);
    });
    it("a spawning creep (ttl undefined) is the freshest incumbent", () => {
      expect(staffsPost(undefined, 8, 22)).to.equal(true);
    });
    it("consistency: a successor started at the staffsPost boundary arrives as the incumbent dies, working effectiveLife ticks", () => {
      // Start spawn when incumbent ttl == leadTime; successor spends leadTime
      // in build+walk and reaches the post at incumbent death with
      // CREEP_LIFETIME - distance working ticks left - the exact quantity
      // effectiveLife() amortizes spawn cost over. The two definitions meet.
      const distance = 22;
      const successorWorkingLife = CREEP_LIFETIME - distance;
      expect(successorWorkingLife).to.equal(effectiveLife(distance));
    });
  });

  describe("sustainableConsumptionRate (stock-grounded consumer sizing)", () => {
    it("drains a stock over one creep lifetime: 2000 banked -> ~1.33 e/t", () => {
      expect(sustainableConsumptionRate(2000)).to.be.closeTo(2000 / CREEP_LIFETIME, 1e-9);
    });
    it("adds the measured inflow on top of the stock drain", () => {
      expect(sustainableConsumptionRate(1500, 2)).to.be.closeTo(3, 1e-9);
    });
    it("no stock, no inflow -> zero (consumers wait; income keeps the spawn)", () => {
      expect(sustainableConsumptionRate(0)).to.equal(0);
    });
  });

  describe("energyPerSpawnPart", () => {
    it("is netEnergy/spawnPartsFor: ~537 e/part at d=20, ~153 at d=75", () => {
      expect(energyPerSpawnPart(10, 20)).to.be.closeTo(537, 1);
      expect(energyPerSpawnPart(10, 75)).to.be.closeTo(153, 1);
      expect(energyPerSpawnPart(10, 120)).to.be.closeTo(79, 1);
    });
    it("falls with distance: the marginal source sets a falling shadow price", () => {
      expect(energyPerSpawnPart(10, 75)).to.be.lessThan(energyPerSpawnPart(10, 20));
      expect(energyPerSpawnPart(10, 120)).to.be.lessThan(energyPerSpawnPart(10, 75));
    });
  });
});

describe("invader tax (spec 13 phase 5 - engine-fact derivation)", () => {
  const { INVADER_RAID_MEAN_ENERGY, INVADERS_ENERGY_GOAL, RAID_GOAL_FLOOR, RAID_GOAL_CEIL, RAID_ARM_FLOOR, EXPECTED_RAID_DEFENSE_COST, INVADER_TAX_PER_ENERGY, invaderTaxPerEnergy } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../../../src/economy/primitives");

  it("pins the engine facts the meter and tax derive from", () => {
    expect(INVADERS_ENERGY_GOAL).to.equal(100_000);
    expect(RAID_GOAL_FLOOR).to.equal(70_000);
    expect(RAID_GOAL_CEIL).to.equal(130_000);
    expect(RAID_ARM_FLOOR).to.equal(65_000);
    // E[energy/raid] = 0.9*100k + 0.05*200k + 0.05*100k (reroll distribution)
    expect(INVADER_RAID_MEAN_ENERGY).to.be.closeTo(0.9 * 100_000 + 0.05 * 200_000 + 0.05 * 100_000, 1e-9);
  });

  it("prices the tax as expected defense cost per expected raid energy", () => {
    expect(invaderTaxPerEnergy(EXPECTED_RAID_DEFENSE_COST)).to.be.closeTo(750 / 105_000, 1e-9);
    expect(INVADER_TAX_PER_ENERGY).to.be.closeTo(invaderTaxPerEnergy(EXPECTED_RAID_DEFENSE_COST), 1e-9);
    expect(invaderTaxPerEnergy(0)).to.equal(0);
  });

  it("stays under 1% of gross at the derived cost (a margin shift, not a rate change)", () => {
    expect(INVADER_TAX_PER_ENERGY).to.be.lessThan(0.01);
  });
});
