import { expect } from "chai";
import {
  BODY_PART_COST,
  CREEP_LIFETIME,
  HARVEST_RATE,
  SOURCE_ENERGY_CAPACITY,
  SOURCE_REGEN_TIME,
  parseRoomCoords,
  calculateTravelTime,
  calculateEffectiveWorkTime,
  calculateBodyCost,
  countBodyParts,
  calculateTotalHarvest,
  calculateCreepCostPerEnergy,
  designMiningCreep,
  calculateOptimalWorkParts,
  calculateSpawnTime,
  BodyPart
} from "../../../src/planning/EconomicConstants";

describe("EconomicConstants", () => {
  describe("BODY_PART_COST", () => {
    it("should have correct costs for all body parts", () => {
      expect(BODY_PART_COST.work).to.equal(100);
      expect(BODY_PART_COST.carry).to.equal(50);
      expect(BODY_PART_COST.move).to.equal(50);
      expect(BODY_PART_COST.attack).to.equal(80);
      expect(BODY_PART_COST.ranged_attack).to.equal(150);
      expect(BODY_PART_COST.heal).to.equal(250);
      expect(BODY_PART_COST.claim).to.equal(600);
      expect(BODY_PART_COST.tough).to.equal(10);
    });
  });

  describe("Game constants", () => {
    it("should have correct standard values", () => {
      expect(CREEP_LIFETIME).to.equal(1500);
      expect(HARVEST_RATE).to.equal(2);
      expect(SOURCE_ENERGY_CAPACITY).to.equal(3000);
      expect(SOURCE_REGEN_TIME).to.equal(300);
    });
  });

  describe("parseRoomCoords()", () => {
    it("should parse W1N1 correctly", () => {
      const coords = parseRoomCoords("W1N1");
      expect(coords).to.not.be.null;
      expect(coords!.rx).to.equal(-2); // W1 = -2
      expect(coords!.ry).to.equal(-2); // N1 = -2
    });

    it("should parse E2S3 correctly", () => {
      const coords = parseRoomCoords("E2S3");
      expect(coords).to.not.be.null;
      expect(coords!.rx).to.equal(2);
      expect(coords!.ry).to.equal(3);
    });

    it("should return null for invalid room names", () => {
      expect(parseRoomCoords("invalid")).to.be.null;
      expect(parseRoomCoords("")).to.be.null;
    });
  });

  describe("calculateTravelTime()", () => {
    it("should calculate same-room Manhattan distance", () => {
      const from = { x: 10, y: 10, roomName: "W1N1" };
      const to = { x: 20, y: 25, roomName: "W1N1" };
      expect(calculateTravelTime(from, to)).to.equal(25); // |20-10| + |25-10| = 25
    });

    it("should return 0 for same position", () => {
      const pos = { x: 25, y: 25, roomName: "W1N1" };
      expect(calculateTravelTime(pos, pos)).to.equal(0);
    });

    it("should add 50 ticks per room boundary", () => {
      const from = { x: 25, y: 25, roomName: "W1N1" };
      const to = { x: 25, y: 25, roomName: "W2N1" };
      // 1 room difference = 50 ticks + 0 in-room distance
      expect(calculateTravelTime(from, to)).to.equal(50);
    });

    it("should handle multi-room travel", () => {
      const from = { x: 25, y: 25, roomName: "W1N1" };
      const to = { x: 25, y: 25, roomName: "W3N1" };
      // 2 rooms = 100 ticks + 0 in-room distance
      expect(calculateTravelTime(from, to)).to.equal(100);
    });
  });

  describe("calculateEffectiveWorkTime()", () => {
    it("should subtract travel time from lifetime", () => {
      const spawn = { x: 25, y: 25, roomName: "W1N1" };
      const work = { x: 10, y: 10, roomName: "W1N1" };
      // Travel: |25-10| + |25-10| = 30 ticks
      // Effective: 1500 - 30 = 1470
      expect(calculateEffectiveWorkTime(spawn, work)).to.equal(1470);
    });

    it("should return 0 when travel time exceeds lifetime", () => {
      const spawn = { x: 25, y: 25, roomName: "W1N1" };
      const work = { x: 25, y: 25, roomName: "W99N99" }; // Very far
      expect(calculateEffectiveWorkTime(spawn, work)).to.equal(0);
    });

    it("should accept custom lifetime", () => {
      const spawn = { x: 25, y: 25, roomName: "W1N1" };
      const work = { x: 25, y: 25, roomName: "W1N1" };
      expect(calculateEffectiveWorkTime(spawn, work, 500)).to.equal(500);
    });
  });

  describe("calculateBodyCost()", () => {
    it("should sum body part costs", () => {
      const body: BodyPart[] = ["work", "work", "carry", "move", "move"];
      // 100 + 100 + 50 + 50 + 50 = 350
      expect(calculateBodyCost(body)).to.equal(350);
    });

    it("should return 0 for empty body", () => {
      expect(calculateBodyCost([])).to.equal(0);
    });
  });

  describe("countBodyParts()", () => {
    it("should count specific part types", () => {
      const body: BodyPart[] = ["work", "work", "carry", "move", "move"];
      expect(countBodyParts(body, "work")).to.equal(2);
      expect(countBodyParts(body, "carry")).to.equal(1);
      expect(countBodyParts(body, "move")).to.equal(2);
      expect(countBodyParts(body, "attack")).to.equal(0);
    });
  });

  describe("calculateTotalHarvest()", () => {
    it("should calculate total energy harvested", () => {
      // 2 work parts × 2 energy/tick × 1000 ticks = 4000
      expect(calculateTotalHarvest(2, 1000)).to.equal(4000);
    });

    it("should return 0 for no work parts", () => {
      expect(calculateTotalHarvest(0, 1000)).to.equal(0);
    });
  });

  describe("calculateCreepCostPerEnergy()", () => {
    it("should calculate cost per energy for local mining", () => {
      const body: BodyPart[] = ["work", "work", "carry", "move", "move"];
      const spawn = { x: 25, y: 25, roomName: "W1N1" };
      const work = { x: 10, y: 10, roomName: "W1N1" };
      // Spawn cost: 350
      // Travel: 30 ticks
      // Effective: 1470 ticks
      // Harvest: 2 work × 2 energy × 1470 = 5880 energy
      // Cost per: 350 / 5880 ≈ 0.0595
      const costPer = calculateCreepCostPerEnergy(body, spawn, work);
      expect(costPer).to.be.closeTo(0.0595, 0.001);
    });

    it("should return higher cost for remote mining", () => {
      const body: BodyPart[] = ["work", "work", "carry", "move", "move"];
      const spawn = { x: 25, y: 25, roomName: "W1N1" };
      const localWork = { x: 10, y: 10, roomName: "W1N1" };
      const remoteWork = { x: 10, y: 10, roomName: "W2N1" };

      const localCost = calculateCreepCostPerEnergy(body, spawn, localWork);
      const remoteCost = calculateCreepCostPerEnergy(body, spawn, remoteWork);

      expect(remoteCost).to.be.greaterThan(localCost);
    });

    it("should return Infinity for unreachable work location", () => {
      const body: BodyPart[] = ["work", "carry", "move"];
      const spawn = { x: 25, y: 25, roomName: "W1N1" };
      const work = { x: 25, y: 25, roomName: "W99N99" };
      expect(calculateCreepCostPerEnergy(body, spawn, work)).to.equal(Infinity);
    });

    it("should return Infinity for body with no work parts", () => {
      const body: BodyPart[] = ["carry", "move"];
      const spawn = { x: 25, y: 25, roomName: "W1N1" };
      const work = { x: 25, y: 25, roomName: "W1N1" };
      expect(calculateCreepCostPerEnergy(body, spawn, work)).to.equal(Infinity);
    });
  });

  describe("designMiningCreep()", () => {
    it("should design creep with 1:1:1 ratio", () => {
      const body = designMiningCreep(3);
      expect(countBodyParts(body, "work")).to.equal(3);
      expect(countBodyParts(body, "carry")).to.equal(3);
      expect(countBodyParts(body, "move")).to.equal(3);
    });

    it("should return empty body for 0 parts", () => {
      expect(designMiningCreep(0)).to.have.length(0);
    });
  });

  describe("calculateOptimalWorkParts()", () => {
    it("should calculate parts needed for full source harvest", () => {
      // 3000 energy / 300 ticks = 10 energy/tick
      // 10 energy/tick / 2 energy/work = 5 work parts
      expect(calculateOptimalWorkParts()).to.equal(5);
    });

    it("should accept custom source parameters", () => {
      // 1500 energy / 300 ticks = 5 energy/tick
      // 5 / 2 = 2.5 → 3 work parts (ceil)
      expect(calculateOptimalWorkParts(1500, 300)).to.equal(3);
    });
  });

  describe("calculateSpawnTime()", () => {
    it("should calculate spawn time correctly", () => {
      const body: BodyPart[] = ["work", "carry", "move"]; // 3 parts
      expect(calculateSpawnTime(body)).to.equal(9); // 3 × 3 ticks
    });

    it("should return 0 for empty body", () => {
      expect(calculateSpawnTime([])).to.equal(0);
    });
  });

  describe("Example from plan", () => {
    it("should match the documented example", () => {
      // Example from plan:
      // Creep: [WORK, WORK, CARRY, MOVE, MOVE]
      // Spawn cost: 100 + 100 + 50 + 50 + 50 = 350 energy
      // Travel time: 500 ticks (let's simulate)
      // Effective lifetime: 1500 - 500 = 1000 ticks
      // Total harvest: 2 WORK × 2 energy/tick × 1000 ticks = 4000 energy
      // Cost per energy: 350 / 4000 = 0.0875 energy/energy

      const body: BodyPart[] = ["work", "work", "carry", "move", "move"];

      // Verify spawn cost
      expect(calculateBodyCost(body)).to.equal(350);

      // Verify harvest calculation
      const workParts = countBodyParts(body, "work");
      expect(calculateTotalHarvest(workParts, 1000)).to.equal(4000);

      // Verify cost per energy (with 500 tick travel time)
      // We need spawn and work locations that produce 500 tick travel
      // 10 rooms = 500 ticks
      const spawn = { x: 25, y: 25, roomName: "W1N1" };
      const work = { x: 25, y: 25, roomName: "W11N1" }; // 10 rooms away

      const costPer = calculateCreepCostPerEnergy(body, spawn, work);
      expect(costPer).to.be.closeTo(0.0875, 0.001);
    });
  });
});
