import { expect } from "chai";
import {
  InvestmentContract,
  InvestmentGoalType,
  createInvestmentContract,
  createInvestmentId,
  remainingBudget,
  expectedUnitsRemaining,
  isInvestmentActive,
  recordInvestmentDelivery,
  createCapitalAllocation,
  commitCapital,
  createSubContract,
  calculatePerformance,
  suggestInvestmentRate
} from "../../../src/market/InvestmentContract";

describe("InvestmentContract", () => {
  const createTestInvestment = (overrides: Partial<InvestmentContract> = {}): InvestmentContract => ({
    id: "inv-test-001",
    bankId: "bank-001",
    recipientCorpId: "upgrading-room1",
    goalType: "rcl-progress" as InvestmentGoalType,
    resource: "rcl-progress",
    ratePerUnit: 10,
    maxBudget: 1000,
    createdAt: 0,
    duration: 1500,
    unitsDelivered: 0,
    creditsPaid: 0,
    priority: 1,
    expectedROI: 0.2,
    ...overrides
  });

  describe("createInvestmentId()", () => {
    it("should create unique ID from bank, recipient, and tick", () => {
      const id = createInvestmentId("bank-001", "upgrading-room1", 1000);
      expect(id).to.include("inv-");
      expect(id).to.include("1000");
    });
  });

  describe("createInvestmentContract()", () => {
    it("should create contract with correct values", () => {
      const contract = createInvestmentContract(
        "bank-001",
        "upgrading-room1",
        "rcl-progress",
        "rcl-progress",
        10,
        1000,
        1500,
        0,
        1,
        0.2
      );

      expect(contract.bankId).to.equal("bank-001");
      expect(contract.recipientCorpId).to.equal("upgrading-room1");
      expect(contract.ratePerUnit).to.equal(10);
      expect(contract.maxBudget).to.equal(1000);
      expect(contract.duration).to.equal(1500);
      expect(contract.unitsDelivered).to.equal(0);
      expect(contract.creditsPaid).to.equal(0);
    });
  });

  describe("remainingBudget()", () => {
    it("should return full budget when nothing paid", () => {
      const investment = createTestInvestment();
      expect(remainingBudget(investment)).to.equal(1000);
    });

    it("should return remaining after partial payment", () => {
      const investment = createTestInvestment({ creditsPaid: 300 });
      expect(remainingBudget(investment)).to.equal(700);
    });

    it("should return 0 when fully paid", () => {
      const investment = createTestInvestment({ creditsPaid: 1000 });
      expect(remainingBudget(investment)).to.equal(0);
    });
  });

  describe("expectedUnitsRemaining()", () => {
    it("should calculate expected units from budget and rate", () => {
      const investment = createTestInvestment();
      // 1000 budget / 10 per unit = 100 units
      expect(expectedUnitsRemaining(investment)).to.equal(100);
    });

    it("should account for already paid credits", () => {
      const investment = createTestInvestment({ creditsPaid: 500 });
      // 500 remaining / 10 per unit = 50 units
      expect(expectedUnitsRemaining(investment)).to.equal(50);
    });
  });

  describe("isInvestmentActive()", () => {
    it("should return true for active investment", () => {
      const investment = createTestInvestment();
      expect(isInvestmentActive(investment, 500)).to.be.true;
    });

    it("should return false when expired", () => {
      const investment = createTestInvestment();
      expect(isInvestmentActive(investment, 2000)).to.be.false;
    });

    it("should return false when budget exhausted", () => {
      const investment = createTestInvestment({ creditsPaid: 1000 });
      expect(isInvestmentActive(investment, 500)).to.be.false;
    });
  });

  describe("recordInvestmentDelivery()", () => {
    it("should calculate payment based on units and rate", () => {
      const investment = createTestInvestment();
      const payment = recordInvestmentDelivery(investment, 10);
      expect(payment).to.equal(100); // 10 units × 10 per unit
      expect(investment.unitsDelivered).to.equal(10);
      expect(investment.creditsPaid).to.equal(100);
    });

    it("should cap payment at remaining budget", () => {
      const investment = createTestInvestment({ creditsPaid: 950 });
      const payment = recordInvestmentDelivery(investment, 100);
      expect(payment).to.equal(50); // Only 50 remaining
    });

    it("should accumulate deliveries", () => {
      const investment = createTestInvestment();
      recordInvestmentDelivery(investment, 5);
      recordInvestmentDelivery(investment, 10);
      expect(investment.unitsDelivered).to.equal(15);
      expect(investment.creditsPaid).to.equal(150);
    });
  });

  describe("createCapitalAllocation()", () => {
    it("should aggregate capital from multiple investments", () => {
      const inv1 = createTestInvestment({ id: "inv-1", maxBudget: 1000 });
      const inv2 = createTestInvestment({ id: "inv-2", maxBudget: 500 });

      const allocation = createCapitalAllocation("corp-1", [inv1, inv2]);

      expect(allocation.corpId).to.equal("corp-1");
      expect(allocation.totalCapital).to.equal(1500);
      expect(allocation.availableCapital).to.equal(1500);
      expect(allocation.committedCapital).to.equal(0);
      expect(allocation.sourceContracts).to.deep.equal(["inv-1", "inv-2"]);
    });

    it("should use remaining budget not max budget", () => {
      const inv = createTestInvestment({ creditsPaid: 300 });
      const allocation = createCapitalAllocation("corp-1", [inv]);
      expect(allocation.totalCapital).to.equal(700);
    });
  });

  describe("commitCapital()", () => {
    it("should commit capital when available", () => {
      const allocation = createCapitalAllocation("corp-1", [createTestInvestment()]);
      const success = commitCapital(allocation, 400);

      expect(success).to.be.true;
      expect(allocation.committedCapital).to.equal(400);
      expect(allocation.availableCapital).to.equal(600);
    });

    it("should reject commitment exceeding available", () => {
      const allocation = createCapitalAllocation("corp-1", [createTestInvestment()]);
      const success = commitCapital(allocation, 1200);

      expect(success).to.be.false;
      expect(allocation.committedCapital).to.equal(0);
      expect(allocation.availableCapital).to.equal(1000);
    });
  });

  describe("createSubContract()", () => {
    it("should create sub-contract with parent reference", () => {
      const subContract = createSubContract(
        "hauling-1",
        "mining-1",
        "energy",
        500,
        100,
        1500,
        0,
        "inv-001"
      );

      expect(subContract.buyerId).to.equal("hauling-1");
      expect(subContract.sellerId).to.equal("mining-1");
      expect(subContract.resource).to.equal("energy");
      expect(subContract.quantity).to.equal(500);
      expect(subContract.price).to.equal(100);
      expect(subContract.parentInvestmentId).to.equal("inv-001");
    });
  });

  describe("calculatePerformance()", () => {
    it("should calculate ROI correctly", () => {
      const investment = createTestInvestment({
        unitsDelivered: 50,
        creditsPaid: 500
      });

      // Mint value of 15 per unit
      // Returns = 50 * 15 = 750
      // Investment = 500
      // ROI = (750 - 500) / 500 = 0.5
      const performance = calculatePerformance(investment, 15);

      expect(performance.investmentId).to.equal(investment.id);
      expect(performance.totalInvested).to.equal(500);
      expect(performance.totalUnitsProduced).to.equal(50);
      expect(performance.actualCostPerUnit).to.equal(10);
      expect(performance.roi).to.equal(0.5);
    });

    it("should calculate efficiency correctly", () => {
      const investment = createTestInvestment({
        maxBudget: 1000,
        ratePerUnit: 10,
        unitsDelivered: 80, // Expected 100 (1000/10)
        creditsPaid: 800
      });

      const performance = calculatePerformance(investment, 15);
      expect(performance.efficiency).to.equal(0.8);
    });
  });

  describe("suggestInvestmentRate()", () => {
    it("should suggest rate allowing supplier costs plus ROI", () => {
      // Mint value: 100, supply chain cost: 50, target ROI: 20%
      const rate = suggestInvestmentRate(100, 50, 0.2);

      // Rate should be at least 55 (50 * 1.1) and at most 80 (100 * 0.8)
      expect(rate).to.be.at.least(55);
      expect(rate).to.be.at.most(80);
    });

    it("should ensure minimum rate covers supply chain costs", () => {
      // High supply chain cost relative to mint value
      const rate = suggestInvestmentRate(100, 90, 0.1);

      // Should at least cover costs with 10% buffer
      expect(rate).to.be.at.least(99); // 90 * 1.1
    });
  });
});

describe("Capital Flow Model", () => {
  it("should demonstrate forward capital flow", () => {
    // 1. Bank creates investment to upgrader
    const investment = createInvestmentContract(
      "bank",
      "upgrader-1",
      "rcl-progress",
      "rcl-progress",
      10, // $10 per upgrade point
      1000, // $1000 budget
      1500,
      0
    );

    // 2. Upgrader now has capital allocation
    const upgraderCapital = createCapitalAllocation("upgrader-1", [investment]);
    expect(upgraderCapital.availableCapital).to.equal(1000);

    // 3. Upgrader can commit capital to pay haulers
    const haulerPayment = 300;
    const committed = commitCapital(upgraderCapital, haulerPayment);
    expect(committed).to.be.true;
    expect(upgraderCapital.availableCapital).to.equal(700);

    // 4. Hauler creates sub-contract with miner
    const subContract = createSubContract(
      "hauler-1",
      "miner-1",
      "energy",
      500,
      haulerPayment,
      1500,
      0,
      investment.id
    );
    expect(subContract.parentInvestmentId).to.equal(investment.id);

    // 5. When upgrader delivers, investment pays out
    recordInvestmentDelivery(investment, 50);
    expect(investment.creditsPaid).to.equal(500); // 50 × $10

    // The key insight: capital flows FORWARD from bank → upgrader → hauler → miner
    // Rather than backward from upgrader demand → hauler → miner → spawner
  });
});
