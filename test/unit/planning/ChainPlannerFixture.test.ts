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
  MiningModel,
  SpawningModel,
  UpgradingModel,
  projectMining,
  projectSpawning,
  projectUpgrading,
  projectAll,
  collectBuys,
  collectSells
} from "../../../src/planning";
import { OfferCollector } from "../../../src/planning/OfferCollector";
import { ChainPlanner } from "../../../src/planning/ChainPlanner";
import { Corp } from "../../../src/corps/Corp";
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

      const miningCorp = result.corps.find((c) => c instanceof MiningModel);
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
        (c) => c instanceof MiningModel
      ) as MiningModel;
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
        (c) => c instanceof MiningModel
      ) as MiningModel;
      const localSpawn = localResult.spawns[0];

      // Remote mining
      resetIdCounter();
      const remoteFixture = loadFixture("remote-mining.json");
      const remoteResult = hydrateFixture(remoteFixture);
      const remoteMining = remoteResult.corps.find(
        (c) => c instanceof MiningModel
      ) as MiningModel;
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
        (c) => c instanceof UpgradingModel
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
      const miningCorp = result.corps.find((c) => c instanceof MiningModel);
      const spawningCorp = result.corps.find((c) => c instanceof SpawningModel);

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

  // =============================================================================
  // Phase 2: CorpState hydration tests
  // =============================================================================
  describe("CorpState Hydration (new approach)", () => {
    it("should hydrate corpStates alongside corps", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      // Should have both corps and corpStates
      expect(result.corps).to.have.length(2);
      expect(result.corpStates).to.have.length(2);
    });

    it("should create matching corp types in corpStates", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      const stateTypes = result.corpStates.map((s) => s.type);
      expect(stateTypes).to.include("spawning");
      expect(stateTypes).to.include("mining");
    });

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

    it("should document differences between corpStates and corps", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      // Get offers from corps (old approach)
      const miningCorp = result.corps.find((c) => c instanceof MiningModel) as MiningModel;
      const corpBuys = miningCorp.buys();
      const corpSells = miningCorp.sells();

      // Get offers from corpStates (new approach)
      const miningState = result.corpStates.find((s) => s.type === "mining") as MiningCorpState;
      const { buys: stateBuys, sells: stateSells } = projectMining(miningState, 0);

      // DIFFERENCE 1: projectMining is a leaf node (no buy offers)
      // MiningModel buys work-ticks, projectMining produces energy without dependencies
      expect(corpBuys).to.have.length(1);
      expect(corpBuys[0].resource).to.equal("work-ticks");
      expect(stateBuys).to.have.length(0);

      // Both sell energy at the source location
      expect(stateSells[0].resource).to.equal(corpSells[0].resource);

      // DIFFERENCE 2: Energy quantity differs - projectMining accounts for travel time
      // - MiningModel: 15000 (5 WORK × 2 harvest × 1500 full lifetime)
      // - projectMining: 14700 (5 WORK × 2 harvest × 1470 effective lifetime)
      // Travel time = 30 ticks (from {25,25} to {10,10})
      // The new approach is MORE ACCURATE because it accounts for travel time
      expect(stateSells[0].quantity).to.be.lessThan(corpSells[0].quantity);
      expect(stateSells[0].quantity).to.equal(14700); // 5 × 2 × (1500 - 30)
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

      // Should have sell offers (mining sells energy, spawning sells work-ticks)
      expect(allSells.length).to.be.greaterThan(0);

      // Verify resources
      const buyResources = allBuys.map((o) => o.resource);
      const sellResources = allSells.map((o) => o.resource);

      // Spawning buys energy
      expect(buyResources).to.include("energy");
      expect(sellResources).to.include("energy");
      expect(sellResources).to.include("work-ticks");
    });
  });

  // =============================================================================
  // Phase 4: ChainPlanner with CorpStates
  // =============================================================================
  describe("ChainPlanner with CorpStates (Phase 4)", () => {
    it("should collect offers from corpStates via OfferCollector", () => {
      const fixture = loadFixture("simple-mining.json");
      const result = hydrateFixture(fixture);

      const collector = new OfferCollector();
      collector.collectFromCorpStates(result.corpStates, 0);

      const stats = collector.getStats();
      expect(stats.totalOffers).to.be.greaterThan(0);

      // Mining sells energy, spawning sells work-ticks
      expect(collector.hasSellOffers("energy")).to.be.true;
      expect(collector.hasSellOffers("work-ticks")).to.be.true;

      // Spawning buys energy (mining is a leaf node with no buy offers)
      expect(collector.hasBuyOffers("energy")).to.be.true;
    });

    it("should register corpStates in ChainPlanner", () => {
      const fixture = loadFixture("complete-room.json");
      const result = hydrateFixture(fixture);

      const collector = new OfferCollector();
      collector.collectFromCorpStates(result.corpStates, 0);

      const planner = new ChainPlanner(collector, DEFAULT_MINT_VALUES);
      planner.registerCorpStates(result.corpStates, 0);

      // Should find viable chains (upgrading sells rcl-progress)
      const chains = planner.findViableChains(0);

      // Should have at least one chain for RCL progress
      expect(chains.length).to.be.greaterThan(0);
    });

    it("should build chains using projection functions", () => {
      const fixture = loadFixture("complete-room.json");
      const result = hydrateFixture(fixture);

      const collector = new OfferCollector();
      collector.collectFromCorpStates(result.corpStates, 0);

      const planner = new ChainPlanner(collector, DEFAULT_MINT_VALUES);
      planner.registerCorpStates(result.corpStates, 0);

      const chains = planner.findViableChains(0);
      expect(chains.length).to.be.greaterThan(0);

      // Check chain structure
      const chain = chains[0];
      expect(chain.segments.length).to.be.greaterThan(0);
      expect(chain.profit).to.be.a("number");

      // Chain should include upgrading (goal), mining (source), and spawning (creep production)
      const corpTypes = chain.segments.map((s) => s.corpType);
      expect(corpTypes).to.include("upgrading");
    });

    it("should document difference: CorpState approach can build chains that Corp approach cannot", () => {
      // This test documents an important difference between the two approaches:
      // - MiningModel buys work-ticks, creating a dependency cycle (Mining → Spawning → Mining)
      // - projectMining is a leaf node (no buys), breaking the cycle
      //
      // The CorpState approach is MORE EFFECTIVE for chain building because it
      // correctly models mining as a raw producer without supply chain dependencies.

      const fixture = loadFixture("complete-room.json");
      const result = hydrateFixture(fixture);

      // Old approach: collect from Corps
      // This fails because MiningModel buys work-ticks, creating a cycle:
      // Upgrading → (needs work-ticks) → Spawning → (needs energy) → Mining → (needs work-ticks) → ???
      const corpCollector = new OfferCollector();
      corpCollector.collect(result.nodes);
      const corpPlanner = new ChainPlanner(corpCollector, DEFAULT_MINT_VALUES);
      corpPlanner.registerNodes(result.nodes);
      const corpChains = corpPlanner.findViableChains(0);

      // Old approach cannot build chains due to dependency cycle
      // (This is expected - it's a limitation of MiningModel's design)
      expect(corpChains.length).to.equal(0);

      // New approach: collect from CorpStates
      // This succeeds because projectMining is a leaf node:
      // Upgrading → (needs work-ticks) → Spawning → (needs energy) → Mining (leaf - done!)
      const stateCollector = new OfferCollector();
      stateCollector.collectFromCorpStates(result.corpStates, 0);
      const statePlanner = new ChainPlanner(stateCollector, DEFAULT_MINT_VALUES);
      statePlanner.registerCorpStates(result.corpStates, 0);
      const stateChains = statePlanner.findViableChains(0);

      // CorpState approach successfully builds chains
      expect(stateChains.length).to.be.greaterThan(0);
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
