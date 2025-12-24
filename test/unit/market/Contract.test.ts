import { expect } from "chai";
import {
  Contract,
  isActive,
  isComplete,
  isExpired,
  remainingQuantity,
  remainingPayment,
  deliveryProgress,
  paymentProgress,
  expectedDeliveryRate,
  actualDeliveryRate,
  isOnTrack,
  getStatus,
  paymentDue,
  createContract,
  recordDelivery,
  recordPayment
} from "../../../src/market/Contract";

describe("Contract", () => {
  const createTestContract = (overrides: Partial<Contract> = {}): Contract => ({
    id: "test-contract",
    sellerId: "seller1",
    buyerId: "buyer1",
    resource: "energy",
    quantity: 1000,
    price: 100,
    duration: 100,
    startTick: 0,
    delivered: 0,
    paid: 0,
    creepIds: [],
    maxCreeps: 1,
    pendingRequests: 0,
    claimed: 0,
    travelTime: 0,
    ...overrides
  });

  describe("isActive()", () => {
    it("should return true for active contract", () => {
      const contract = createTestContract();
      expect(isActive(contract, 50)).to.be.true;
    });

    it("should return false when expired", () => {
      const contract = createTestContract();
      expect(isActive(contract, 150)).to.be.false;
    });

    it("should return false when complete", () => {
      const contract = createTestContract({ delivered: 1000 });
      expect(isActive(contract, 50)).to.be.false;
    });
  });

  describe("isComplete()", () => {
    it("should return false when partially delivered", () => {
      const contract = createTestContract({ delivered: 500 });
      expect(isComplete(contract)).to.be.false;
    });

    it("should return true when fully delivered", () => {
      const contract = createTestContract({ delivered: 1000 });
      expect(isComplete(contract)).to.be.true;
    });

    it("should return true when over-delivered", () => {
      const contract = createTestContract({ delivered: 1500 });
      expect(isComplete(contract)).to.be.true;
    });
  });

  describe("isExpired()", () => {
    it("should return false while active", () => {
      const contract = createTestContract();
      expect(isExpired(contract, 50)).to.be.false;
    });

    it("should return true when past duration", () => {
      const contract = createTestContract();
      expect(isExpired(contract, 100)).to.be.true;
    });

    it("should return false if completed before expiry", () => {
      const contract = createTestContract({ delivered: 1000 });
      expect(isExpired(contract, 150)).to.be.false;
    });
  });

  describe("remainingQuantity()", () => {
    it("should return full quantity when nothing delivered", () => {
      const contract = createTestContract();
      expect(remainingQuantity(contract)).to.equal(1000);
    });

    it("should return remaining after partial delivery", () => {
      const contract = createTestContract({ delivered: 400 });
      expect(remainingQuantity(contract)).to.equal(600);
    });

    it("should return 0 when fully delivered", () => {
      const contract = createTestContract({ delivered: 1000 });
      expect(remainingQuantity(contract)).to.equal(0);
    });
  });

  describe("remainingPayment()", () => {
    it("should return full price when nothing paid", () => {
      const contract = createTestContract();
      expect(remainingPayment(contract)).to.equal(100);
    });

    it("should return remaining after partial payment", () => {
      const contract = createTestContract({ paid: 30 });
      expect(remainingPayment(contract)).to.equal(70);
    });

    it("should return 0 when fully paid", () => {
      const contract = createTestContract({ paid: 100 });
      expect(remainingPayment(contract)).to.equal(0);
    });
  });

  describe("deliveryProgress()", () => {
    it("should return 0 when nothing delivered", () => {
      const contract = createTestContract();
      expect(deliveryProgress(contract)).to.equal(0);
    });

    it("should return 0.5 at 50% delivery", () => {
      const contract = createTestContract({ delivered: 500 });
      expect(deliveryProgress(contract)).to.equal(0.5);
    });

    it("should return 1 when fully delivered", () => {
      const contract = createTestContract({ delivered: 1000 });
      expect(deliveryProgress(contract)).to.equal(1);
    });

    it("should cap at 1 for over-delivery", () => {
      const contract = createTestContract({ delivered: 1500 });
      expect(deliveryProgress(contract)).to.equal(1);
    });
  });

  describe("paymentProgress()", () => {
    it("should return 0 when nothing paid", () => {
      const contract = createTestContract();
      expect(paymentProgress(contract)).to.equal(0);
    });

    it("should return correct percentage", () => {
      const contract = createTestContract({ paid: 25 });
      expect(paymentProgress(contract)).to.equal(0.25);
    });
  });

  describe("expectedDeliveryRate()", () => {
    it("should calculate rate correctly", () => {
      const contract = createTestContract();
      expect(expectedDeliveryRate(contract)).to.equal(10); // 1000 / 100
    });

    it("should return 0 for zero duration", () => {
      const contract = createTestContract({ duration: 0 });
      expect(expectedDeliveryRate(contract)).to.equal(0);
    });
  });

  describe("actualDeliveryRate()", () => {
    it("should calculate rate from elapsed time", () => {
      const contract = createTestContract({
        startTick: 0,
        delivered: 500
      });
      expect(actualDeliveryRate(contract, 50)).to.equal(10); // 500 / 50
    });

    it("should return 0 at start", () => {
      const contract = createTestContract();
      expect(actualDeliveryRate(contract, 0)).to.equal(0);
    });
  });

  describe("isOnTrack()", () => {
    it("should return true when meeting expected delivery", () => {
      const contract = createTestContract({
        startTick: 0,
        delivered: 500
      });
      expect(isOnTrack(contract, 50)).to.be.true;
    });

    it("should return true within 10% tolerance", () => {
      const contract = createTestContract({
        startTick: 0,
        delivered: 460 // 92% of expected 500
      });
      expect(isOnTrack(contract, 50)).to.be.true;
    });

    it("should return false when significantly behind", () => {
      const contract = createTestContract({
        startTick: 0,
        delivered: 200 // 40% of expected 500
      });
      expect(isOnTrack(contract, 50)).to.be.false;
    });
  });

  describe("getStatus()", () => {
    it("should return active for ongoing contract", () => {
      const contract = createTestContract();
      expect(getStatus(contract, 50)).to.equal("active");
    });

    it("should return complete when fully delivered", () => {
      const contract = createTestContract({ delivered: 1000 });
      expect(getStatus(contract, 50)).to.equal("complete");
    });

    it("should return expired for late completion", () => {
      const contract = createTestContract({ delivered: 600 });
      expect(getStatus(contract, 150)).to.equal("expired");
    });

    it("should return defaulted for significant under-delivery", () => {
      const contract = createTestContract({ delivered: 200 });
      expect(getStatus(contract, 150)).to.equal("defaulted");
    });
  });

  describe("paymentDue()", () => {
    it("should return 0 when nothing delivered", () => {
      const contract = createTestContract();
      expect(paymentDue(contract)).to.equal(0);
    });

    it("should return proportional payment for delivery", () => {
      const contract = createTestContract({ delivered: 500 });
      // Delivered 50% of 1000, price per unit = 100/1000 = 0.1
      // Payment due = 0.1 * 500 = 50
      expect(paymentDue(contract)).to.equal(50);
    });

    it("should subtract already paid amount", () => {
      const contract = createTestContract({ delivered: 500, paid: 30 });
      expect(paymentDue(contract)).to.equal(20);
    });
  });

  describe("createContract()", () => {
    it("should create contract with correct values", () => {
      const contract = createContract(
        "seller1",
        "buyer1",
        "energy",
        1000,
        100,
        150,
        5000
      );

      expect(contract.sellerId).to.equal("seller1");
      expect(contract.buyerId).to.equal("buyer1");
      expect(contract.resource).to.equal("energy");
      expect(contract.quantity).to.equal(1000);
      expect(contract.price).to.equal(100);
      expect(contract.duration).to.equal(150);
      expect(contract.startTick).to.equal(5000);
      expect(contract.delivered).to.equal(0);
      expect(contract.paid).to.equal(0);
    });
  });

  describe("recordDelivery()", () => {
    it("should increase delivered amount", () => {
      const contract = createTestContract();
      recordDelivery(contract, 100);
      expect(contract.delivered).to.equal(100);
    });

    it("should accumulate deliveries", () => {
      const contract = createTestContract();
      recordDelivery(contract, 100);
      recordDelivery(contract, 200);
      expect(contract.delivered).to.equal(300);
    });

    it("should cap at quantity", () => {
      const contract = createTestContract();
      recordDelivery(contract, 1500);
      expect(contract.delivered).to.equal(1000);
    });
  });

  describe("recordPayment()", () => {
    it("should increase paid amount", () => {
      const contract = createTestContract();
      recordPayment(contract, 25);
      expect(contract.paid).to.equal(25);
    });

    it("should cap at price", () => {
      const contract = createTestContract();
      recordPayment(contract, 150);
      expect(contract.paid).to.equal(100);
    });
  });
});
