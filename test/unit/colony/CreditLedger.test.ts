import { expect } from "chai";
import { CreditLedger } from "../../../src/colony/CreditLedger";

describe("CreditLedger", () => {
  let ledger: CreditLedger;

  beforeEach(() => {
    ledger = new CreditLedger();
  });

  describe("mint()", () => {
    it("should increase treasury when minting credits", () => {
      ledger.mint(1000, "test");
      expect(ledger.getBalance()).to.equal(1000);
    });

    it("should accumulate multiple mints", () => {
      ledger.mint(500, "first");
      ledger.mint(300, "second");
      expect(ledger.getBalance()).to.equal(800);
    });

    it("should track total minted amount", () => {
      ledger.mint(1000, "test1");
      ledger.mint(500, "test2");
      const supply = ledger.getMoneySupply();
      expect(supply.minted).to.equal(1500);
    });

    it("should record mint history", () => {
      ledger.mint(100, "upgrade");
      ledger.mint(200, "bounty");
      const history = ledger.getMintHistory();
      expect(history).to.have.length(2);
      expect(history[0].reason).to.equal("upgrade");
      expect(history[1].reason).to.equal("bounty");
    });

    it("should ignore non-positive amounts", () => {
      ledger.mint(0, "zero");
      ledger.mint(-100, "negative");
      expect(ledger.getBalance()).to.equal(0);
    });
  });

  describe("spend()", () => {
    it("should decrease treasury when spending", () => {
      ledger.mint(1000, "initial");
      const success = ledger.spend(400);
      expect(success).to.be.true;
      expect(ledger.getBalance()).to.equal(600);
    });

    it("should fail when spending more than balance", () => {
      ledger.mint(500, "initial");
      const success = ledger.spend(600);
      expect(success).to.be.false;
      expect(ledger.getBalance()).to.equal(500);
    });

    it("should allow spending exact balance", () => {
      ledger.mint(1000, "initial");
      const success = ledger.spend(1000);
      expect(success).to.be.true;
      expect(ledger.getBalance()).to.equal(0);
    });

    it("should succeed for zero or negative amounts", () => {
      ledger.mint(100, "initial");
      expect(ledger.spend(0)).to.be.true;
      expect(ledger.spend(-50)).to.be.true;
      expect(ledger.getBalance()).to.equal(100);
    });
  });

  describe("recordTaxDestroyed()", () => {
    it("should track destroyed tax", () => {
      ledger.recordTaxDestroyed(100);
      const supply = ledger.getMoneySupply();
      expect(supply.taxed).to.equal(100);
    });

    it("should accumulate tax records", () => {
      ledger.recordTaxDestroyed(50);
      ledger.recordTaxDestroyed(30);
      const supply = ledger.getMoneySupply();
      expect(supply.taxed).to.equal(80);
    });

    it("should ignore non-positive amounts", () => {
      ledger.recordTaxDestroyed(0);
      ledger.recordTaxDestroyed(-10);
      const supply = ledger.getMoneySupply();
      expect(supply.taxed).to.equal(0);
    });
  });

  describe("getMoneySupply()", () => {
    it("should calculate net money supply correctly", () => {
      ledger.mint(1000, "initial");
      ledger.recordTaxDestroyed(200);

      const supply = ledger.getMoneySupply();
      expect(supply.minted).to.equal(1000);
      expect(supply.taxed).to.equal(200);
      expect(supply.net).to.equal(800);
    });

    it("should track treasury separately from net", () => {
      ledger.mint(1000, "initial");
      ledger.spend(300);
      ledger.recordTaxDestroyed(100);

      const supply = ledger.getMoneySupply();
      expect(supply.treasury).to.equal(700);
      expect(supply.net).to.equal(900); // minted - taxed
    });
  });

  describe("canAfford()", () => {
    it("should return true when balance is sufficient", () => {
      ledger.mint(1000, "initial");
      expect(ledger.canAfford(500)).to.be.true;
      expect(ledger.canAfford(1000)).to.be.true;
    });

    it("should return false when balance is insufficient", () => {
      ledger.mint(500, "initial");
      expect(ledger.canAfford(600)).to.be.false;
    });
  });

  describe("transferTo()", () => {
    it("should transfer requested amount", () => {
      ledger.mint(1000, "initial");
      const transferred = ledger.transferTo(300);
      expect(transferred).to.equal(300);
      expect(ledger.getBalance()).to.equal(700);
    });

    it("should transfer only available balance", () => {
      ledger.mint(500, "initial");
      const transferred = ledger.transferTo(800);
      expect(transferred).to.equal(500);
      expect(ledger.getBalance()).to.equal(0);
    });

    it("should return 0 for non-positive amounts", () => {
      ledger.mint(1000, "initial");
      expect(ledger.transferTo(0)).to.equal(0);
      expect(ledger.transferTo(-100)).to.equal(0);
    });
  });

  describe("serialize/deserialize", () => {
    it("should serialize and restore state", () => {
      ledger.mint(1000, "test");
      ledger.spend(200);
      ledger.recordTaxDestroyed(50);

      const serialized = ledger.serialize();
      const newLedger = new CreditLedger();
      newLedger.deserialize(serialized);

      expect(newLedger.getBalance()).to.equal(800);
      const supply = newLedger.getMoneySupply();
      expect(supply.minted).to.equal(1000);
      expect(supply.taxed).to.equal(50);
    });

    it("should handle empty/undefined data gracefully", () => {
      ledger.deserialize({} as any);
      expect(ledger.getBalance()).to.equal(0);
    });
  });
});
