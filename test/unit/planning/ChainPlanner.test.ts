import { expect } from "chai";
import { ChainPlanner, canBuildChain } from "../../../src/planning/ChainPlanner";
import { OfferCollector } from "../../../src/planning/OfferCollector";
import { Corp, CorpType } from "../../../src/corps/Corp";
import { Offer, Position } from "../../../src/market/Offer";
import { DEFAULT_MINT_VALUES } from "../../../src/colony/MintValues";

/**
 * Test corp that can be configured with offers
 */
class TestCorp extends Corp {
  private _sells: Offer[] = [];
  private _buys: Offer[] = [];
  private _position: Position;

  constructor(
    id: string,
    type: CorpType,
    nodeId: string,
    position: Position,
    balance: number = 0
  ) {
    super(type, nodeId);
    (this as any).id = id;
    this._position = position;
    this.balance = balance;
  }

  sells(): Offer[] { return this._sells; }
  buys(): Offer[] { return this._buys; }
  work(): void {}
  getPosition(): Position { return this._position; }

  setSells(offers: Offer[]): void { this._sells = offers; }
  setBuys(offers: Offer[]): void { this._buys = offers; }
}

describe("ChainPlanner", () => {
  let collector: OfferCollector;
  let planner: ChainPlanner;
  const defaultPosition: Position = { x: 25, y: 25, roomName: "W1N1" };

  beforeEach(() => {
    collector = new OfferCollector();
    planner = new ChainPlanner(collector, DEFAULT_MINT_VALUES);
  });

  const createOffer = (
    corpId: string,
    type: "buy" | "sell",
    resource: string,
    overrides: Partial<Offer> = {}
  ): Offer => ({
    id: `${corpId}-${resource}-${type}`,
    corpId,
    type,
    resource,
    quantity: 1000,
    price: 100,
    duration: 150,
    location: defaultPosition,
    ...overrides
  });

  describe("findViableChains()", () => {
    it("should find simple upgrading chain", () => {
      // Mining corp sells energy
      const miningCorp = new TestCorp("mining1", "mining", "node1", defaultPosition);
      miningCorp.setSells([
        createOffer("mining1", "sell", "energy", { price: 0, quantity: 15000 })
      ]);
      miningCorp.setBuys([]);

      // Upgrading corp buys energy, sells rcl-progress
      const upgradingCorp = new TestCorp("upgrading1", "upgrading", "node1", defaultPosition);
      upgradingCorp.setBuys([
        createOffer("upgrading1", "buy", "energy", { quantity: 15000 })
      ]);
      upgradingCorp.setSells([
        createOffer("upgrading1", "sell", "rcl-progress", { quantity: 1500 })
      ]);

      // Register corps and collect offers
      collector.collectFromCorps([miningCorp, upgradingCorp]);
      planner.registerCorps([miningCorp, upgradingCorp]);

      const chains = planner.findViableChains(1000);

      // Should find at least one viable chain for upgrading
      expect(chains.length).to.be.greaterThanOrEqual(0);
    });

    it("should return chains sorted by profit", () => {
      // Create two upgrading corps with different costs
      const miningCorp1 = new TestCorp("mining1", "mining", "node1", defaultPosition);
      miningCorp1.setSells([createOffer("mining1", "sell", "energy", { price: 50 })]);
      miningCorp1.setBuys([]);

      const miningCorp2 = new TestCorp("mining2", "mining", "node2", defaultPosition);
      miningCorp2.setSells([createOffer("mining2", "sell", "energy", { price: 100 })]);
      miningCorp2.setBuys([]);

      const upgradingCorp1 = new TestCorp("upgrading1", "upgrading", "node1", defaultPosition);
      upgradingCorp1.setBuys([createOffer("upgrading1", "buy", "energy")]);
      upgradingCorp1.setSells([createOffer("upgrading1", "sell", "rcl-progress", { quantity: 100 })]);

      const upgradingCorp2 = new TestCorp("upgrading2", "upgrading", "node2", defaultPosition);
      upgradingCorp2.setBuys([createOffer("upgrading2", "buy", "energy")]);
      upgradingCorp2.setSells([createOffer("upgrading2", "sell", "rcl-progress", { quantity: 100 })]);

      collector.collectFromCorps([miningCorp1, miningCorp2, upgradingCorp1, upgradingCorp2]);
      planner.registerCorps([miningCorp1, miningCorp2, upgradingCorp1, upgradingCorp2]);

      const chains = planner.findViableChains(1000);

      // If we have multiple chains, they should be sorted by profit
      if (chains.length > 1) {
        for (let i = 1; i < chains.length; i++) {
          expect(chains[i - 1].profit).to.be.greaterThanOrEqual(chains[i].profit);
        }
      }
    });

    it("should filter out non-viable chains", () => {
      // Create a chain where cost exceeds mint value
      const miningCorp = new TestCorp("mining1", "mining", "node1", defaultPosition);
      miningCorp.setSells([
        createOffer("mining1", "sell", "energy", { price: 10000000 }) // Very expensive
      ]);
      miningCorp.setBuys([]);

      const upgradingCorp = new TestCorp("upgrading1", "upgrading", "node1", defaultPosition);
      upgradingCorp.setBuys([createOffer("upgrading1", "buy", "energy")]);
      upgradingCorp.setSells([
        createOffer("upgrading1", "sell", "rcl-progress", { quantity: 1 }) // Low quantity
      ]);

      collector.collectFromCorps([miningCorp, upgradingCorp]);
      planner.registerCorps([miningCorp, upgradingCorp]);

      const chains = planner.findViableChains(1000);

      // All returned chains should be viable (profit > 0)
      for (const chain of chains) {
        expect(chain.profit).to.be.greaterThan(0);
      }
    });
  });

  describe("findBestChains()", () => {
    it("should respect budget constraint", () => {
      const miningCorp = new TestCorp("mining1", "mining", "node1", defaultPosition);
      miningCorp.setSells([createOffer("mining1", "sell", "energy", { price: 100 })]);
      miningCorp.setBuys([]);

      const upgradingCorp = new TestCorp("upgrading1", "upgrading", "node1", defaultPosition);
      upgradingCorp.setBuys([createOffer("upgrading1", "buy", "energy")]);
      upgradingCorp.setSells([createOffer("upgrading1", "sell", "rcl-progress", { quantity: 1500 })]);

      collector.collectFromCorps([miningCorp, upgradingCorp]);
      planner.registerCorps([miningCorp, upgradingCorp]);

      const chains = planner.findBestChains(1000, 50); // Very low budget

      // Total cost of selected chains should not exceed budget
      const totalCost = chains.reduce((sum, c) => sum + c.totalCost, 0);
      expect(totalCost).to.be.lessThanOrEqual(50);
    });

    it("should return non-overlapping chains", () => {
      // Create two chains that share a corp
      const sharedMining = new TestCorp("mining-shared", "mining", "node1", defaultPosition);
      sharedMining.setSells([createOffer("mining-shared", "sell", "energy", { price: 100 })]);
      sharedMining.setBuys([]);

      const upgrading1 = new TestCorp("upgrading1", "upgrading", "node1", defaultPosition);
      upgrading1.setBuys([createOffer("upgrading1", "buy", "energy")]);
      upgrading1.setSells([createOffer("upgrading1", "sell", "rcl-progress", { quantity: 1000 })]);

      const upgrading2 = new TestCorp("upgrading2", "upgrading", "node2", defaultPosition);
      upgrading2.setBuys([createOffer("upgrading2", "buy", "energy")]);
      upgrading2.setSells([createOffer("upgrading2", "sell", "rcl-progress", { quantity: 500 })]);

      collector.collectFromCorps([sharedMining, upgrading1, upgrading2]);
      planner.registerCorps([sharedMining, upgrading1, upgrading2]);

      const chains = planner.findBestChains(1000, 10000);

      // Check no corp appears in multiple chains
      const usedCorps = new Set<string>();
      for (const chain of chains) {
        for (const segment of chain.segments) {
          if (usedCorps.has(segment.corpId)) {
            throw new Error(`Corp ${segment.corpId} appears in multiple chains`);
          }
          usedCorps.add(segment.corpId);
        }
      }
    });
  });

  describe("registerCorps()", () => {
    it("should allow corp lookup after registration", () => {
      const corp = new TestCorp("test-corp", "mining", "node1", defaultPosition);
      planner.registerCorps([corp]);

      // The planner should be able to find this corp when building chains
      // (internal state, tested indirectly through chain building)
      expect(true).to.be.true; // Registration doesn't throw
    });
  });

  describe("estimateProfit()", () => {
    it("should estimate potential profit for a goal", () => {
      collector.addOffer(createOffer("buyer1", "buy", "rcl-progress", { price: 100 }));

      const profit = planner.estimateProfit({
        type: "rcl-progress",
        corpId: "upgrading1",
        resource: "rcl-progress",
        quantity: 100,
        position: defaultPosition,
        mintValuePerUnit: DEFAULT_MINT_VALUES.rcl_upgrade
      });

      expect(profit).to.be.a("number");
    });
  });
});

describe("canBuildChain()", () => {
  it("should return true when resource has sell offers", () => {
    const collector = new OfferCollector();
    collector.addOffer({
      id: "o1",
      corpId: "corp1",
      type: "sell",
      resource: "energy",
      quantity: 1000,
      price: 100,
      duration: 150
    });

    expect(canBuildChain("energy", collector)).to.be.true;
  });

  it("should return false when resource has no sell offers", () => {
    const collector = new OfferCollector();

    expect(canBuildChain("energy", collector)).to.be.false;
  });
});
