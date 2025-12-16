import { expect } from "chai";
import {
  Chain,
  ChainSegment,
  calculateProfit,
  isViable,
  calculateTotalCost,
  calculateChainROI,
  buildSegment,
  createChain,
  sortByProfit,
  sortByROI,
  filterViable,
  getCorpIds,
  chainsOverlap,
  selectNonOverlapping,
  serializeChain,
  deserializeChain
} from "../../../src/planning/Chain";

describe("Chain", () => {
  const createTestSegment = (
    corpId: string,
    inputCost: number,
    margin: number
  ): ChainSegment => ({
    corpId,
    corpType: "mining",
    resource: "energy",
    quantity: 1000,
    inputCost,
    margin,
    outputPrice: inputCost * (1 + margin)
  });

  const createTestChain = (overrides: Partial<Chain> = {}): Chain => ({
    id: "test-chain",
    segments: [],
    leafCost: 0,
    totalCost: 100,
    mintValue: 150,
    profit: 50,
    funded: false,
    priority: 50,
    age: 0,
    ...overrides
  });

  describe("calculateProfit()", () => {
    it("should calculate profit correctly", () => {
      const chain = createTestChain({ mintValue: 200, totalCost: 120 });
      expect(calculateProfit(chain)).to.equal(80);
    });

    it("should return negative for losing chain", () => {
      const chain = createTestChain({ mintValue: 50, totalCost: 100 });
      expect(calculateProfit(chain)).to.equal(-50);
    });
  });

  describe("isViable()", () => {
    it("should return true for profitable chain", () => {
      const chain = createTestChain({ mintValue: 150, totalCost: 100 });
      expect(isViable(chain)).to.be.true;
    });

    it("should return false for losing chain", () => {
      const chain = createTestChain({ mintValue: 80, totalCost: 100 });
      expect(isViable(chain)).to.be.false;
    });

    it("should return false for break-even chain", () => {
      const chain = createTestChain({ mintValue: 100, totalCost: 100 });
      expect(isViable(chain)).to.be.false;
    });
  });

  describe("calculateTotalCost()", () => {
    it("should return 0 for empty segments", () => {
      expect(calculateTotalCost([])).to.equal(0);
    });

    it("should return last segment output price", () => {
      const segments: ChainSegment[] = [
        createTestSegment("corp1", 0, 0.1),    // 0 * 1.1 = 0
        createTestSegment("corp2", 0, 0.1),    // 0 * 1.1 = 0 (independent)
      ];
      // Fix: segments need to chain properly
      segments[0].outputPrice = 0 * 1.1; // 0
      segments[1].inputCost = 50;
      segments[1].outputPrice = 50 * 1.1; // 55

      expect(calculateTotalCost(segments)).to.be.closeTo(55, 0.001);
    });

    it("should handle chained segments", () => {
      const segments: ChainSegment[] = [
        { ...createTestSegment("corp1", 0, 0.1), outputPrice: 0 },
        { ...createTestSegment("corp2", 0, 0.1), outputPrice: 55 },
        { ...createTestSegment("corp3", 55, 0.1), outputPrice: 60.5 },
      ];

      expect(calculateTotalCost(segments)).to.be.closeTo(60.5, 0.001);
    });
  });

  describe("calculateChainROI()", () => {
    it("should calculate ROI correctly", () => {
      const chain = createTestChain({ mintValue: 200, totalCost: 100 });
      expect(calculateChainROI(chain)).to.equal(1); // (200-100)/100
    });

    it("should return 0 for zero cost", () => {
      const chain = createTestChain({ mintValue: 100, totalCost: 0 });
      expect(calculateChainROI(chain)).to.equal(0);
    });
  });

  describe("buildSegment()", () => {
    it("should build segment with correct output price", () => {
      const segment = buildSegment("corp1", "mining", "energy", 1000, 100, 0.1);
      expect(segment.outputPrice).to.be.closeTo(110, 0.001);
    });

    it("should preserve all fields", () => {
      const segment = buildSegment("corp1", "upgrading", "rcl-progress", 500, 50, 0.05);
      expect(segment.corpId).to.equal("corp1");
      expect(segment.corpType).to.equal("upgrading");
      expect(segment.resource).to.equal("rcl-progress");
      expect(segment.quantity).to.equal(500);
      expect(segment.inputCost).to.equal(50);
      expect(segment.margin).to.equal(0.05);
    });
  });

  describe("createChain()", () => {
    it("should create chain with calculated values", () => {
      const segments: ChainSegment[] = [
        buildSegment("corp1", "mining", "energy", 1000, 0, 0.1),
        buildSegment("corp2", "upgrading", "rcl-progress", 1000, 0, 0.1),
      ];
      // Manually set correct output for second segment
      segments[1].inputCost = 0;
      segments[1].outputPrice = 55;

      const chain = createChain("test", segments, 100);
      expect(chain.totalCost).to.equal(55);
      expect(chain.profit).to.equal(45);
      expect(chain.priority).to.equal(45);
      expect(chain.funded).to.be.false;
    });
  });

  describe("sortByProfit()", () => {
    it("should sort chains by profit descending", () => {
      const chains: Chain[] = [
        createTestChain({ id: "c1", profit: 30 }),
        createTestChain({ id: "c2", profit: 100 }),
        createTestChain({ id: "c3", profit: 50 }),
      ];

      const sorted = sortByProfit(chains);
      expect(sorted[0].profit).to.equal(100);
      expect(sorted[1].profit).to.equal(50);
      expect(sorted[2].profit).to.equal(30);
    });

    it("should not modify original array", () => {
      const chains: Chain[] = [
        createTestChain({ id: "c1", profit: 30 }),
        createTestChain({ id: "c2", profit: 100 }),
      ];

      sortByProfit(chains);
      expect(chains[0].profit).to.equal(30);
    });
  });

  describe("sortByROI()", () => {
    it("should sort chains by ROI descending", () => {
      const chains: Chain[] = [
        createTestChain({ id: "c1", mintValue: 120, totalCost: 100 }), // 20% ROI
        createTestChain({ id: "c2", mintValue: 200, totalCost: 100 }), // 100% ROI
        createTestChain({ id: "c3", mintValue: 150, totalCost: 100 }), // 50% ROI
      ];

      const sorted = sortByROI(chains);
      expect(calculateChainROI(sorted[0])).to.equal(1);
      expect(calculateChainROI(sorted[1])).to.equal(0.5);
      expect(calculateChainROI(sorted[2])).to.equal(0.2);
    });
  });

  describe("filterViable()", () => {
    it("should keep only profitable chains", () => {
      const chains: Chain[] = [
        createTestChain({ id: "c1", mintValue: 150, totalCost: 100 }), // viable
        createTestChain({ id: "c2", mintValue: 80, totalCost: 100 }),  // not viable
        createTestChain({ id: "c3", mintValue: 200, totalCost: 100 }), // viable
      ];

      const viable = filterViable(chains);
      expect(viable).to.have.length(2);
      expect(viable.map(c => c.id)).to.include("c1");
      expect(viable.map(c => c.id)).to.include("c3");
    });
  });

  describe("getCorpIds()", () => {
    it("should extract all corp IDs from segments", () => {
      const chain = createTestChain({
        segments: [
          createTestSegment("corp1", 0, 0.1),
          createTestSegment("corp2", 50, 0.1),
          createTestSegment("corp3", 55, 0.1),
        ]
      });

      const ids = getCorpIds(chain);
      expect(ids).to.deep.equal(["corp1", "corp2", "corp3"]);
    });
  });

  describe("chainsOverlap()", () => {
    it("should return true when chains share corps", () => {
      const chain1 = createTestChain({
        segments: [
          createTestSegment("corp1", 0, 0.1),
          createTestSegment("corp2", 50, 0.1),
        ]
      });
      const chain2 = createTestChain({
        segments: [
          createTestSegment("corp2", 0, 0.1),
          createTestSegment("corp3", 50, 0.1),
        ]
      });

      expect(chainsOverlap(chain1, chain2)).to.be.true;
    });

    it("should return false when chains don't share corps", () => {
      const chain1 = createTestChain({
        segments: [
          createTestSegment("corp1", 0, 0.1),
          createTestSegment("corp2", 50, 0.1),
        ]
      });
      const chain2 = createTestChain({
        segments: [
          createTestSegment("corp3", 0, 0.1),
          createTestSegment("corp4", 50, 0.1),
        ]
      });

      expect(chainsOverlap(chain1, chain2)).to.be.false;
    });
  });

  describe("selectNonOverlapping()", () => {
    it("should select highest profit non-overlapping chains", () => {
      const chains: Chain[] = [
        createTestChain({
          id: "c1",
          profit: 50,
          segments: [createTestSegment("corp1", 0, 0.1)]
        }),
        createTestChain({
          id: "c2",
          profit: 100,
          segments: [createTestSegment("corp1", 0, 0.1)] // overlaps with c1
        }),
        createTestChain({
          id: "c3",
          profit: 30,
          segments: [createTestSegment("corp2", 0, 0.1)]
        }),
      ];

      const selected = selectNonOverlapping(chains);
      expect(selected).to.have.length(2);
      expect(selected[0].id).to.equal("c2"); // highest profit
      expect(selected[1].id).to.equal("c3"); // doesn't overlap
    });
  });

  describe("serialize/deserialize", () => {
    it("should serialize and restore chain", () => {
      const chain = createTestChain({
        id: "test-id",
        funded: true,
        age: 100
      });

      const serialized = serializeChain(chain);
      const restored = deserializeChain(serialized);

      expect(restored.id).to.equal("test-id");
      expect(restored.funded).to.be.true;
      expect(restored.age).to.equal(100);
    });
  });
});
