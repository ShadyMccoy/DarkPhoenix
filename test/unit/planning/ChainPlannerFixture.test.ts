import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  hydrateFixture,
  resetIdCounter,
  Fixture,
  calculateTravelTime,
  calculateCreepCostPerEnergy,
  designMiningCreep,
  calculateOptimalWorkParts,
  CREEP_LIFETIME
} from "../../../src/planning";
import { OfferCollector } from "../../../src/planning/OfferCollector";
import { ChainPlanner } from "../../../src/planning/ChainPlanner";
import { MiningCorp } from "../../../src/corps/MiningCorp";
import { SpawningCorp } from "../../../src/corps/SpawningCorp";
import { UpgradingCorp } from "../../../src/corps/UpgradingCorp";
import { Corp } from "../../../src/corps/Corp";
import { DEFAULT_MINT_VALUES } from "../../../src/colony/MintValues";

// Fixture paths
const FIXTURES_DIR = path.join(__dirname, "../../fixtures");

function loadFixture(name: string): Fixture {
  const filePath = path.join(FIXTURES_DIR, name);
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

describe("ChainPlanner with Fixtures", () => {
  // Reset ID counter before each test for determinism
  beforeEach(() => {
    resetIdCounter();
    Corp.setIdGenerator(Corp.generateTestId);
  });

  afterEach(() => {
    Corp.setIdGenerator(null);
  });

  describe("Simple Mining Chain", () => {
    it("should hydrate simple mining fixture correctly", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      expect(result.nodes).to.have.length(2);
      expect(result.corps).to.have.length(2);
      expect(result.spawns).to.have.length(1);

      // Check corp types
      const corpTypes = result.corps.map((c) => c.type);
      expect(corpTypes).to.include("spawning");
      expect(corpTypes).to.include("mining");
    });

    it("should create corps with deterministic IDs", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      // IDs should be deterministic
      const corpIds = result.corps.map((c) => c.id);
      expect(corpIds[0]).to.match(/spawning-.*-0/);
      expect(corpIds[1]).to.match(/mining-.*-1/);
    });

    it("should link mining corps to nearest spawn", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      const miningCorp = result.corps.find((c) => c instanceof MiningCorp);
      expect(miningCorp).to.not.be.undefined;

      // Mining corp should have spawn location set
      const spawnLocation = (miningCorp as any).spawnLocation;
      expect(spawnLocation).to.not.be.null;
      expect(spawnLocation.x).to.equal(25);
      expect(spawnLocation.y).to.equal(25);
    });

    it("should collect offers from hydrated corps", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      const collector = new OfferCollector();
      collector.collect(result.nodes);

      const stats = collector.getStats();
      expect(stats.totalOffers).to.be.greaterThan(0);

      // SpawningCorp sells work-ticks, carry-ticks, move-ticks
      // MiningCorp sells energy, buys work-ticks
      expect(collector.hasSellOffers("energy")).to.be.true;
      expect(collector.hasSellOffers("work-ticks")).to.be.true;
    });
  });

  describe("Remote Mining", () => {
    it("should account for travel time in creep cost", () => {
      const fixture = loadFixture("remote-mining.json");
      const result = hydrateFixture(fixture);

      const miningCorp = result.corps.find(
        (c) => c instanceof MiningCorp
      ) as MiningCorp;
      expect(miningCorp).to.not.be.undefined;

      // Remote mining has longer travel time
      const spawn = result.spawns[0];
      const miningPos = miningCorp.getPosition();
      const travelTime = calculateTravelTime(spawn, miningPos);

      // Should include room crossing (50 ticks)
      expect(travelTime).to.be.greaterThan(50);
    });

    it("should have higher cost per energy for remote mining", () => {
      // Local mining
      const localFixture = loadFixture("simple-mining.json");
      const localResult = hydrateFixture(localFixture);
      const localMining = localResult.corps.find(
        (c) => c instanceof MiningCorp
      ) as MiningCorp;
      const localSpawn = localResult.spawns[0];

      // Remote mining
      resetIdCounter();
      const remoteFixture = loadFixture("remote-mining.json");
      const remoteResult = hydrateFixture(remoteFixture);
      const remoteMining = remoteResult.corps.find(
        (c) => c instanceof MiningCorp
      ) as MiningCorp;
      const remoteSpawn = remoteResult.spawns[0];

      // Calculate cost per energy
      const workParts = calculateOptimalWorkParts();
      const body = designMiningCreep(workParts);

      const localCost = calculateCreepCostPerEnergy(
        body,
        localSpawn,
        localMining.getPosition()
      );
      const remoteCost = calculateCreepCostPerEnergy(
        body,
        remoteSpawn,
        remoteMining.getPosition()
      );

      // Remote should be more expensive
      expect(remoteCost).to.be.greaterThan(localCost);
    });
  });

  describe("Complete Room", () => {
    it("should hydrate complete room with all corp types", () => {
      const fixture = loadFixture("complete-room.json");
      const result = hydrateFixture(fixture);

      expect(result.nodes).to.have.length(4);
      expect(result.corps).to.have.length(4);

      const corpTypes = result.corps.map((c) => c.type);
      expect(corpTypes.filter((t) => t === "mining")).to.have.length(2);
      expect(corpTypes.filter((t) => t === "spawning")).to.have.length(1);
      expect(corpTypes.filter((t) => t === "upgrading")).to.have.length(1);
    });

    it("should create UpgradingCorp for controller", () => {
      const fixture = loadFixture("complete-room.json");
      const result = hydrateFixture(fixture);

      const upgradingCorp = result.corps.find(
        (c) => c instanceof UpgradingCorp
      );
      expect(upgradingCorp).to.not.be.undefined;
      expect(upgradingCorp!.type).to.equal("upgrading");
    });
  });

  describe("Circular Dependencies", () => {
    it("should handle mining↔spawning circular dependency", () => {
      // Mining needs creeps (from spawning)
      // Spawning needs energy (from mining)
      // This creates a circular dependency

      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      const collector = new OfferCollector();
      collector.collect(result.nodes);

      // Both mining and spawning should have offers
      const miningCorp = result.corps.find((c) => c instanceof MiningCorp);
      const spawningCorp = result.corps.find((c) => c instanceof SpawningCorp);

      expect(miningCorp).to.not.be.undefined;
      expect(spawningCorp).to.not.be.undefined;

      // Mining sells energy
      const miningOffers = collector.getCorpOffers(miningCorp!.id);
      const sellsEnergy = miningOffers.some(
        (o) => o.type === "sell" && o.resource === "energy"
      );
      expect(sellsEnergy).to.be.true;

      // Spawning sells work-ticks
      const spawningOffers = collector.getCorpOffers(spawningCorp!.id);
      const sellsWorkTicks = spawningOffers.some(
        (o) => o.type === "sell" && o.resource === "work-ticks"
      );
      expect(sellsWorkTicks).to.be.true;
    });
  });

  describe("Economic Calculations", () => {
    it("should calculate cost per energy correctly", () => {
      // Using designMiningCreep which uses 1:1:1 ratio:
      // designMiningCreep(2) = [WORK, CARRY, MOVE, WORK, CARRY, MOVE]
      // Spawn cost: 2*100 + 2*50 + 2*50 = 400 energy
      // Travel time: 500 ticks (10 rooms)
      // Effective lifetime: 1500 - 500 = 1000 ticks
      // Total harvest: 2 WORK × 2 energy/tick × 1000 ticks = 4000 energy
      // Cost per energy: 400 / 4000 = 0.1

      const workPartsNeeded = 2;
      const body = designMiningCreep(workPartsNeeded);

      // Spawn position and work position 10 rooms apart (500 ticks)
      const spawn = { x: 25, y: 25, roomName: "W1N1" };
      const work = { x: 25, y: 25, roomName: "W11N1" };

      const costPer = calculateCreepCostPerEnergy(body, spawn, work);

      // With 1:1:1 ratio, cost is 0.1 (not 0.0875)
      expect(costPer).to.be.closeTo(0.1, 0.001);
    });

    it("should calculate effective work time correctly", () => {
      const spawn = { x: 25, y: 25, roomName: "W1N1" };
      const work = { x: 10, y: 10, roomName: "W1N1" };

      // Travel: 30 ticks
      const travelTime = calculateTravelTime(spawn, work);
      expect(travelTime).to.equal(30);

      // Effective: 1500 - 30 = 1470
      const effectiveLifetime = CREEP_LIFETIME - travelTime;
      expect(effectiveLifetime).to.equal(1470);
    });
  });
});
