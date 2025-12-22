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
  CREEP_LIFETIME,
  projectMining,
  projectSpawning,
  projectUpgrading,
  projectAll,
  collectBuys,
  collectSells
} from "../../../src/planning";
import { OfferCollector } from "../../../src/planning/OfferCollector";
import { ChainPlanner } from "../../../src/planning/ChainPlanner";
import { DEFAULT_MINT_VALUES } from "../../../src/colony/MintValues";
import { MiningCorpState, SpawningCorpState, UpgradingCorpState } from "../../../src/corps/CorpState";

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
  });

  describe("Simple Mining Chain", () => {
    it("should hydrate simple mining fixture correctly", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      expect(result.nodes).to.have.length(2);
      // Now includes: Spawning + Source + Mining + Hauling (clean operation architecture)
      expect(result.corpStates).to.have.length(4);
      expect(result.spawns).to.have.length(1);

      // Check corp types - including the new SourceCorp and HaulingCorp
      const stateTypes = result.corpStates.map((s) => s.type);
      expect(stateTypes).to.include("spawning");
      expect(stateTypes).to.include("source");
      expect(stateTypes).to.include("mining");
      expect(stateTypes).to.include("hauling");
    });

    it("should create corpStates with deterministic IDs and proper dependencies", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      // IDs should be deterministic and show dependency chain
      const corpIds = result.corpStates.map((s) => s.id);
      // Order: Spawning (0) -> Source (1) -> Mining (2) -> Hauling (3)
      expect(corpIds[0]).to.match(/spawning-.*-0/);
      expect(corpIds[1]).to.match(/source-.*-1/);
      expect(corpIds[2]).to.match(/mining-.*-2/);
      expect(corpIds[3]).to.match(/hauling-.*-3/);
    });

    it("should link mining states to nearest spawn", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      const miningState = result.corpStates.find((s) => s.type === "mining") as MiningCorpState;
      expect(miningState).to.not.be.undefined;

      // Mining state should have spawn position set
      expect(miningState.spawnPosition).to.not.be.null;
      expect(miningState.spawnPosition!.x).to.equal(25);
      expect(miningState.spawnPosition!.y).to.equal(25);
    });

    it("should collect offers from hydrated corpStates", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      const collector = new OfferCollector();
      collector.collectFromCorpStates(result.corpStates, 0);

      const stats = collector.getStats();
      expect(stats.totalOffers).to.be.greaterThan(0);

      // SpawningCorp sells spawn-capacity
      // MiningCorp buys spawn-capacity and sells energy
      expect(collector.hasSellOffers("energy")).to.be.true;
      expect(collector.hasSellOffers("spawn-capacity")).to.be.true;
      expect(collector.hasBuyOffers("spawn-capacity")).to.be.true;
    });
  });

  describe("Remote Mining", () => {
    it("should account for travel time in creep cost", () => {
      const fixture = loadFixture("remote-mining.json");
      const result = hydrateFixture(fixture);

      const miningState = result.corpStates.find((s) => s.type === "mining") as MiningCorpState;
      expect(miningState).to.not.be.undefined;

      // Remote mining has longer travel time
      const spawn = result.spawns[0];
      const miningPos = miningState.position;
      const travelTime = calculateTravelTime(spawn, miningPos);

      // Should include room crossing (50 ticks)
      expect(travelTime).to.be.greaterThan(50);
    });

    it("should have higher cost per energy for remote mining", () => {
      // Local mining
      const localFixture = loadFixture("simple-mining.json");
      const localResult = hydrateFixture(localFixture);
      const localMining = localResult.corpStates.find((s) => s.type === "mining") as MiningCorpState;
      const localSpawn = localResult.spawns[0];

      // Remote mining
      resetIdCounter();
      const remoteFixture = loadFixture("remote-mining.json");
      const remoteResult = hydrateFixture(remoteFixture);
      const remoteMining = remoteResult.corpStates.find((s) => s.type === "mining") as MiningCorpState;
      const remoteSpawn = remoteResult.spawns[0];

      // Calculate cost per energy
      const workParts = calculateOptimalWorkParts();
      const body = designMiningCreep(workParts);

      const localCost = calculateCreepCostPerEnergy(
        body,
        localSpawn,
        localMining.position
      );
      const remoteCost = calculateCreepCostPerEnergy(
        body,
        remoteSpawn,
        remoteMining.position
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
      // Now: Spawning(1) + Source(2) + Mining(2) + Hauling(2) + Upgrading(1) = 8 corp states
      expect(result.corpStates).to.have.length(8);

      const stateTypes = result.corpStates.map((s) => s.type);
      expect(stateTypes.filter((t) => t === "source")).to.have.length(2);
      expect(stateTypes.filter((t) => t === "mining")).to.have.length(2);
      expect(stateTypes.filter((t) => t === "hauling")).to.have.length(2);
      expect(stateTypes.filter((t) => t === "spawning")).to.have.length(1);
      expect(stateTypes.filter((t) => t === "upgrading")).to.have.length(1);
    });

    it("should create UpgradingCorpState for controller", () => {
      const fixture = loadFixture("complete-room.json");
      const result = hydrateFixture(fixture);

      const upgradingState = result.corpStates.find((s) => s.type === "upgrading");
      expect(upgradingState).to.not.be.undefined;
      expect(upgradingState!.type).to.equal("upgrading");
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

  describe("CorpState Hydration", () => {
    it("should create MiningCorpState with correct properties", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      const miningState = result.corpStates.find(
        (s) => s.type === "mining"
      ) as MiningCorpState;

      expect(miningState).to.not.be.undefined;
      expect(miningState.sourceCapacity).to.equal(3000);
      expect(miningState.position).to.deep.equal({ x: 10, y: 10, roomName: "W1N1" });
      expect(miningState.spawnPosition).to.deep.equal({ x: 25, y: 25, roomName: "W1N1" });
    });

    it("should create SpawningCorpState with correct properties", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      const spawningState = result.corpStates.find(
        (s) => s.type === "spawning"
      ) as SpawningCorpState;

      expect(spawningState).to.not.be.undefined;
      expect(spawningState.position).to.deep.equal({ x: 25, y: 25, roomName: "W1N1" });
      expect(spawningState.energyCapacity).to.equal(300);
    });

    it("should collect all offers using projectAll", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      const projections = projectAll(result.corpStates, 0);
      const allBuys = collectBuys(projections);
      const allSells = collectSells(projections);

      // Should have buy offers (spawning buys energy)
      // Note: mining is a leaf node (no buy offers)
      expect(allBuys.length).to.be.greaterThan(0);

      // Should have sell offers (mining sells energy, spawning sells spawn-capacity)
      expect(allSells.length).to.be.greaterThan(0);

      // Verify resources
      const buyResources = allBuys.map((o) => o.resource);
      const sellResources = allSells.map((o) => o.resource);

      // Mining buys spawn-capacity, Spawning sells spawn-capacity
      expect(buyResources).to.include("spawn-capacity");
      expect(sellResources).to.include("energy");
      expect(sellResources).to.include("spawn-capacity");
    });
  });

  describe("ChainPlanner with CorpStates", () => {
    it("should collect offers from corpStates via OfferCollector", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      const collector = new OfferCollector();
      collector.collectFromCorpStates(result.corpStates, 0);

      const stats = collector.getStats();
      expect(stats.totalOffers).to.be.greaterThan(0);

      // Mining buys spawn-capacity, sells energy
      // Spawning sells spawn-capacity
      expect(collector.hasSellOffers("energy")).to.be.true;
      expect(collector.hasSellOffers("spawn-capacity")).to.be.true;
      expect(collector.hasBuyOffers("spawn-capacity")).to.be.true;
    });

    it("should register corpStates in ChainPlanner", () => {
      const fixture = loadFixture("complete-room.json");
      const result = hydrateFixture(fixture);

      const collector = new OfferCollector();
      collector.collectFromCorpStates(result.corpStates, 0);

      const planner = new ChainPlanner(collector, DEFAULT_MINT_VALUES);
      planner.registerCorpStates(result.corpStates, 0);

      // Verify registration works - chain is now complete with HaulingCorpState
      // The clean operation architecture:
      // SourceCorp -> MiningOperation -> HaulingOperation -> UpgradingCorp

      // Should have offer collection working
      const stats = collector.getStats();
      expect(stats.totalOffers).to.be.greaterThan(0);

      // SourceCorp sells energy-source, Mining sells energy, Spawning sells spawn-capacity
      // HaulingCorp sells delivered-energy
      expect(collector.hasSellOffers("energy")).to.be.true;
      expect(collector.hasSellOffers("spawn-capacity")).to.be.true;
      expect(collector.hasSellOffers("delivered-energy")).to.be.true;
    });

    it("should collect offers from all corp types", () => {
      const fixture = loadFixture("complete-room.json");
      const result = hydrateFixture(fixture);

      const collector = new OfferCollector();
      collector.collectFromCorpStates(result.corpStates, 0);

      // Verify offer collection works for the clean operation architecture
      // Source sells energy-source (passive)
      expect(collector.hasSellOffers("energy-source")).to.be.true;

      // Mining buys spawn-capacity, sells energy
      expect(collector.hasSellOffers("energy")).to.be.true;
      expect(collector.hasBuyOffers("spawn-capacity")).to.be.true;

      // Spawning sells spawn-capacity
      expect(collector.hasSellOffers("spawn-capacity")).to.be.true;

      // Hauling sells delivered-energy (bridges mining -> upgrading)
      expect(collector.hasSellOffers("delivered-energy")).to.be.true;

      // Upgrading sells rcl-progress (goal corp)
      expect(collector.hasSellOffers("rcl-progress")).to.be.true;
    });

    it("should handle remote mining with CorpStates", () => {
      const fixture = loadFixture("remote-mining.json");
      const result = hydrateFixture(fixture);

      const collector = new OfferCollector();
      collector.collectFromCorpStates(result.corpStates, 0);

      // Remote mining should have reduced output due to travel time
      const miningState = result.corpStates.find((s) => s.type === "mining") as MiningCorpState;
      const { sells } = projectMining(miningState, 0);

      // Remote mining produces less energy (travel time reduces effective lifetime)
      const energySold = sells[0].quantity;
      expect(energySold).to.be.lessThan(15000); // Less than full lifetime output

      // Verify mining offers are collected
      expect(collector.hasSellOffers("energy")).to.be.true;
    });
  });
});
