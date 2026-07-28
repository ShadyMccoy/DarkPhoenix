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
  BODY_COSTS,
  CARRY_CAPACITY,
  CLAIM_LIFETIME,
  CREEP_LIFETIME,
  HARVEST_ENERGY_PER_WORK,
  MINER_COST,
  MINER_PARTS,
  RESERVER_DUTY,
  SOURCE_ENERGY_CAPACITY,
  SOURCE_RATE,
  SOURCE_REGEN_TIME,
  SPAWN_PARTS_PER_TICK,
  SPAWN_TIME_PER_PART,
  DEDICATION_MIN_CONSUMPTION,
  dedicationJustified,
  infraSpawnLoad
} from "../../../src/economy/primitives";

// First-principles checks: every number is hand-derived from the game constants
// so a formula change that drifts from the intended physics fails loudly.
describe("economy/primitives", () => {
  // The founding constants are homed HERE since spec 35 phase B (previously
  // pinned via planning/EconomicConstants.test.ts, deleted with its module).
  describe("Screeps ground-truth constants", () => {
    it("pins the full 8-part body-cost table", () => {
      expect(BODY_COSTS.WORK).to.equal(100);
      expect(BODY_COSTS.CARRY).to.equal(50);
      expect(BODY_COSTS.MOVE).to.equal(50);
      expect(BODY_COSTS.ATTACK).to.equal(80);
      expect(BODY_COSTS.RANGED_ATTACK).to.equal(150);
      expect(BODY_COSTS.HEAL).to.equal(250);
      expect(BODY_COSTS.CLAIM).to.equal(600);
      expect(BODY_COSTS.TOUGH).to.equal(10);
    });
    it("pins the lifetime, spawn-rate and source facts", () => {
      expect(CREEP_LIFETIME).to.equal(1500);
      expect(CLAIM_LIFETIME).to.equal(600);
      expect(SPAWN_TIME_PER_PART).to.equal(3);
      expect(SPAWN_PARTS_PER_TICK).to.equal(1 / 3);
      expect(CARRY_CAPACITY).to.equal(50);
      expect(HARVEST_ENERGY_PER_WORK).to.equal(2);
      expect(SOURCE_ENERGY_CAPACITY).to.equal(3000);
      expect(SOURCE_REGEN_TIME).to.equal(300);
      expect(SOURCE_RATE).to.equal(10);
      expect(RESERVER_DUTY).to.equal(0.5);
      expect(MINER_COST).to.equal(650);
      expect(MINER_PARTS).to.equal(8);
    });
  });

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

  describe("dedicationJustified (the reservation is earned by the project)", () => {
    it("a small project's crew (absorb floor, 5 e/t) does not deserve a 10 e/t source", () => {
      expect(dedicationJustified(5, 10)).to.equal(false);
    });
    it("a crew consuming ~the source's output does (>= 80%)", () => {
      expect(dedicationJustified(8, 10)).to.equal(true);
      expect(dedicationJustified(15, 10)).to.equal(true);
    });
    it("boundary sits at DEDICATION_MIN_CONSUMPTION of the source rate", () => {
      expect(dedicationJustified(DEDICATION_MIN_CONSUMPTION * 10, 10)).to.equal(true);
      expect(dedicationJustified(DEDICATION_MIN_CONSUMPTION * 10 - 1e-9, 10)).to.equal(false);
    });
    it("never dedicates against a zero-rate source", () => {
      expect(dedicationJustified(10, 0)).to.equal(false);
    });
  });
});

// Spec 22 estimate: mineral extraction valued in energy terms via the market
// chain (sell the mineral, buy energy). Every number hand-derived from the
// Screeps mineral constants so a formula drift fails loudly.
describe("economy/primitives - mineral extraction (spec 22)", () => {
  const {
    EXTRACTOR_COOLDOWN,
    HARVEST_MINERAL_POWER,
    MINERAL_REGEN_TIME,
    MINERAL_DENSITY_AMOUNT,
    mineralPeakRate,
    mineralExtractionRate,
    marketEnergyPerMineral,
    mineralMinerCost,
    mineralNetEnergy,
    mineralEnergyPerSpawnPart,
    energyPerSpawnPart: energyPerSpawnPartFn
    // eslint-disable-next-line @typescript-eslint/no-var-requires
  } = require("../../../src/economy/primitives");

  it("pins the Screeps mineral constants the formulas derive from", () => {
    expect(EXTRACTOR_COOLDOWN).to.equal(5);
    expect(HARVEST_MINERAL_POWER).to.equal(1);
    expect(MINERAL_REGEN_TIME).to.equal(50_000);
    expect(MINERAL_DENSITY_AMOUNT[1]).to.equal(15_000);
    expect(MINERAL_DENSITY_AMOUNT[2]).to.equal(35_000);
    expect(MINERAL_DENSITY_AMOUNT[3]).to.equal(70_000);
    expect(MINERAL_DENSITY_AMOUNT[4]).to.equal(100_000);
  });

  describe("mineralPeakRate", () => {
    it("is workParts * HARVEST_MINERAL_POWER / EXTRACTOR_COOLDOWN", () => {
      expect(mineralPeakRate(20)).to.equal(4); // 20 / 5
      expect(mineralPeakRate(10)).to.equal(2);
      expect(mineralPeakRate(0)).to.equal(0);
    });
  });

  describe("mineralExtractionRate (REGEN-limited, not miner-limited)", () => {
    it("averages the deposit over drain + regen (density-3, 20W = ~1.037/t)", () => {
      // 70000 / (70000/4 + 50000) = 70000 / 67500
      expect(mineralExtractionRate(20, 70_000)).to.be.closeTo(70_000 / 67_500, 1e-9);
    });
    it("is bounded by amount/REGEN however large the miner (sublinear in W)", () => {
      const ceiling = 70_000 / MINERAL_REGEN_TIME; // 1.4/t
      expect(mineralExtractionRate(20, 70_000)).to.be.lessThan(ceiling);
      expect(mineralExtractionRate(1000, 70_000)).to.be.lessThan(ceiling);
      // doubling WORK does NOT double the long-run rate - the regen dominates
      expect(mineralExtractionRate(40, 70_000)).to.be.lessThan(2 * mineralExtractionRate(20, 70_000));
    });
    it("scales with deposit density", () => {
      expect(mineralExtractionRate(20, 35_000)).to.be.lessThan(mineralExtractionRate(20, 70_000));
      expect(mineralExtractionRate(20, 100_000)).to.be.greaterThan(mineralExtractionRate(20, 70_000));
    });
    it("is zero for an empty deposit or a bodiless miner", () => {
      expect(mineralExtractionRate(20, 0)).to.equal(0);
      expect(mineralExtractionRate(0, 70_000)).to.equal(0);
    });
  });

  describe("marketEnergyPerMineral (the exchange rate)", () => {
    it("is mineralPrice / energyPrice", () => {
      expect(marketEnergyPerMineral(600, 33)).to.be.closeTo(600 / 33, 1e-9); // ~18.2
      expect(marketEnergyPerMineral(148.38, 32.941)).to.be.closeTo(148.38 / 32.941, 1e-9); // O ~4.5
    });
    it("is zero when there is no trade (zero price either side)", () => {
      expect(marketEnergyPerMineral(600, 0)).to.equal(0);
      expect(marketEnergyPerMineral(0, 33)).to.equal(0);
    });
  });

  describe("mineralNetEnergy (energy-equivalent, mirror of netEnergy)", () => {
    it("is the long-run rate valued at the exchange, minus tiny miner+hauler overhead", () => {
      // density-3, 20W, exchange 600/33, hauled 25 tiles: hand-derived ~18.34
      const net = mineralNetEnergy(70_000, 20, 600 / 33, 25);
      expect(net).to.be.closeTo(18.34, 0.02);
      // overhead is small: net sits just under the gross rate*exchange
      const gross = mineralExtractionRate(20, 70_000) * (600 / 33);
      expect(net).to.be.lessThan(gross);
      expect(gross - net).to.be.lessThan(1); // <1 e/t of overhead on a dense mineral
    });
    it("is zero when the mineral has no market (exchange 0)", () => {
      expect(mineralNetEnergy(70_000, 20, 0, 25)).to.equal(0);
    });
    it("a cheap mineral (Zynthium ~44cr) loses to a mid remote source", () => {
      // 44/32.941 ~= 1.34 e/mineral -> ~1 e/t, far below a d=100 source (~6.6)
      expect(mineralNetEnergy(70_000, 20, 44.226 / 32.941, 25)).to.be.lessThan(2);
    });
  });

  describe("mineralEnergyPerSpawnPart (dominates the spawn budget)", () => {
    it("far exceeds the best remote source's shadow price (miner idles free through regen)", () => {
      const mineral = mineralEnergyPerSpawnPart(70_000, 20, 600 / 33, 25);
      expect(mineral).to.be.greaterThan(1000);
      expect(mineral).to.be.greaterThan(energyPerSpawnPartFn(10, 20)); // ~537 e/part best source
    });
  });

  describe("mineralMinerCost", () => {
    it("is workParts WORK + road-ratio MOVE (20W = 2500e)", () => {
      expect(mineralMinerCost(20)).to.equal(2500); // 20*100 + 10*50
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

// Spec 15 P4: the standing-infra deduction the planner subtracts from its
// spawn-parts ledger. Feeder + tender are DEPOT movers - they exist only once
// a room has a storage. Charging them in storageless worlds taxed early game
// ~5-7% of the parts budget for infra that cannot exist there (first P4 gate:
// plan-t1-single-source-loop timed out under the phantom deduction).
describe("infraSpawnLoad (the plan's standing-infra parts deduction)", () => {
  it("charges NOTHING for depot infra in a storageless world", () => {
    expect(infraSpawnLoad(15, 0, 0)).to.equal(0);
  });
  it("reservers charge per mined remote even without a depot", () => {
    expect(infraSpawnLoad(15, 0, 4)).to.be.greaterThan(0);
    expect(infraSpawnLoad(15, 0, 4)).to.be.closeTo((0.5 * 4 * 4) / 540, 1e-9); // duty-priced (P5 shipped)
  });
  it("a depot room adds the feeder shuttle (scaled to the relay) and the tender detail", () => {
    const withDepot = infraSpawnLoad(115, 1, 0);
    expect(withDepot).to.be.greaterThan(72 / 1500); // at least the tender fleet
    expect(infraSpawnLoad(115, 1, 4)).to.be.closeTo(withDepot + (0.5 * 4 * 4) / 540, 1e-9);
  });
});
