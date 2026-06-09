import { expect } from "chai";
import {
  MintValues,
  DEFAULT_MINT_VALUES,
  EXPANSION_MINT_VALUES,
  DEFENSIVE_MINT_VALUES,
  getMintValue,
  calculateMint,
  createMintValues
} from "../../../src/colony/MintValues";

describe("MintValues", () => {
  describe("DEFAULT_MINT_VALUES", () => {
    it("should have all required properties", () => {
      expect(DEFAULT_MINT_VALUES).to.have.property("rclUpgrade");
      expect(DEFAULT_MINT_VALUES).to.have.property("gclUpgrade");
      expect(DEFAULT_MINT_VALUES).to.have.property("remoteSourceTap");
      expect(DEFAULT_MINT_VALUES).to.have.property("roomClaim");
      expect(DEFAULT_MINT_VALUES).to.have.property("containerBuilt");
      expect(DEFAULT_MINT_VALUES).to.have.property("extensionBuilt");
      expect(DEFAULT_MINT_VALUES).to.have.property("roadBuilt");
      expect(DEFAULT_MINT_VALUES).to.have.property("storageBuilt");
      expect(DEFAULT_MINT_VALUES).to.have.property("enemyKilled");
      expect(DEFAULT_MINT_VALUES).to.have.property("towerBuilt");
      expect(DEFAULT_MINT_VALUES).to.have.property("linkBuilt");
    });

    it("should have positive values for all achievements", () => {
      for (const key of Object.keys(DEFAULT_MINT_VALUES)) {
        const value = DEFAULT_MINT_VALUES[key as keyof MintValues];
        expect(value).to.be.greaterThan(0, `${key} should be positive`);
      }
    });

    it("should value rclUpgrade higher than gclUpgrade", () => {
      // RCL upgrades are more valuable early game
      expect(DEFAULT_MINT_VALUES.rclUpgrade).to.be.greaterThan(
        DEFAULT_MINT_VALUES.gclUpgrade
      );
    });

    it("should value roomClaim highly", () => {
      // Claiming a room is a major achievement
      expect(DEFAULT_MINT_VALUES.roomClaim).to.be.greaterThan(1000);
    });
  });

  describe("EXPANSION_MINT_VALUES", () => {
    it("should value remote sources higher than default", () => {
      expect(EXPANSION_MINT_VALUES.remoteSourceTap).to.be.greaterThan(
        DEFAULT_MINT_VALUES.remoteSourceTap
      );
    });

    it("should value room claims higher than default", () => {
      expect(EXPANSION_MINT_VALUES.roomClaim).to.be.greaterThan(
        DEFAULT_MINT_VALUES.roomClaim
      );
    });

    it("should preserve non-expansion values", () => {
      expect(EXPANSION_MINT_VALUES.enemyKilled).to.equal(
        DEFAULT_MINT_VALUES.enemyKilled
      );
    });
  });

  describe("DEFENSIVE_MINT_VALUES", () => {
    it("should value enemy kills higher than default", () => {
      expect(DEFENSIVE_MINT_VALUES.enemyKilled).to.be.greaterThan(
        DEFAULT_MINT_VALUES.enemyKilled
      );
    });

    it("should value towers higher than default", () => {
      expect(DEFENSIVE_MINT_VALUES.towerBuilt).to.be.greaterThan(
        DEFAULT_MINT_VALUES.towerBuilt
      );
    });
  });

  describe("getMintValue()", () => {
    it("should return correct value for achievement", () => {
      expect(getMintValue(DEFAULT_MINT_VALUES, "rclUpgrade")).to.equal(1000);
      expect(getMintValue(DEFAULT_MINT_VALUES, "enemyKilled")).to.equal(200);
    });

    it("should return 0 for undefined achievement", () => {
      const customValues = { ...DEFAULT_MINT_VALUES };
      delete (customValues as any).rclUpgrade;
      expect(getMintValue(customValues, "rclUpgrade")).to.equal(0);
    });
  });

  describe("calculateMint()", () => {
    it("should multiply value by quantity", () => {
      expect(calculateMint(DEFAULT_MINT_VALUES, "rclUpgrade", 10)).to.equal(10000);
    });

    it("should default to quantity 1", () => {
      expect(calculateMint(DEFAULT_MINT_VALUES, "rclUpgrade")).to.equal(1000);
    });

    it("should return 0 for zero quantity", () => {
      expect(calculateMint(DEFAULT_MINT_VALUES, "rclUpgrade", 0)).to.equal(0);
    });
  });

  describe("createMintValues()", () => {
    it("should use defaults when no overrides", () => {
      const values = createMintValues({});
      expect(values).to.deep.equal(DEFAULT_MINT_VALUES);
    });

    it("should override specified values", () => {
      const values = createMintValues({ rclUpgrade: 2000 });
      expect(values.rclUpgrade).to.equal(2000);
      expect(values.gclUpgrade).to.equal(DEFAULT_MINT_VALUES.gclUpgrade);
    });

    it("should allow multiple overrides", () => {
      const values = createMintValues({
        rclUpgrade: 2000,
        enemyKilled: 500,
        roadBuilt: 5
      });
      expect(values.rclUpgrade).to.equal(2000);
      expect(values.enemyKilled).to.equal(500);
      expect(values.roadBuilt).to.equal(5);
    });

    it("should not modify DEFAULT_MINT_VALUES", () => {
      const originalValue = DEFAULT_MINT_VALUES.rclUpgrade;
      createMintValues({ rclUpgrade: 9999 });
      expect(DEFAULT_MINT_VALUES.rclUpgrade).to.equal(originalValue);
    });
  });
});
