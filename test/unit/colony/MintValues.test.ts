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
      expect(DEFAULT_MINT_VALUES).to.have.property("rcl_upgrade");
      expect(DEFAULT_MINT_VALUES).to.have.property("gcl_upgrade");
      expect(DEFAULT_MINT_VALUES).to.have.property("remote_source_tap");
      expect(DEFAULT_MINT_VALUES).to.have.property("room_claim");
      expect(DEFAULT_MINT_VALUES).to.have.property("container_built");
      expect(DEFAULT_MINT_VALUES).to.have.property("extension_built");
      expect(DEFAULT_MINT_VALUES).to.have.property("road_built");
      expect(DEFAULT_MINT_VALUES).to.have.property("storage_built");
      expect(DEFAULT_MINT_VALUES).to.have.property("enemy_killed");
      expect(DEFAULT_MINT_VALUES).to.have.property("tower_built");
      expect(DEFAULT_MINT_VALUES).to.have.property("link_built");
    });

    it("should have positive values for all achievements", () => {
      for (const key of Object.keys(DEFAULT_MINT_VALUES)) {
        const value = DEFAULT_MINT_VALUES[key as keyof MintValues];
        expect(value).to.be.greaterThan(0, `${key} should be positive`);
      }
    });

    it("should value rcl_upgrade higher than gcl_upgrade", () => {
      // RCL upgrades are more valuable early game
      expect(DEFAULT_MINT_VALUES.rcl_upgrade).to.be.greaterThan(
        DEFAULT_MINT_VALUES.gcl_upgrade
      );
    });

    it("should value room_claim highly", () => {
      // Claiming a room is a major achievement
      expect(DEFAULT_MINT_VALUES.room_claim).to.be.greaterThan(1000);
    });
  });

  describe("EXPANSION_MINT_VALUES", () => {
    it("should value remote sources higher than default", () => {
      expect(EXPANSION_MINT_VALUES.remote_source_tap).to.be.greaterThan(
        DEFAULT_MINT_VALUES.remote_source_tap
      );
    });

    it("should value room claims higher than default", () => {
      expect(EXPANSION_MINT_VALUES.room_claim).to.be.greaterThan(
        DEFAULT_MINT_VALUES.room_claim
      );
    });

    it("should preserve non-expansion values", () => {
      expect(EXPANSION_MINT_VALUES.enemy_killed).to.equal(
        DEFAULT_MINT_VALUES.enemy_killed
      );
    });
  });

  describe("DEFENSIVE_MINT_VALUES", () => {
    it("should value enemy kills higher than default", () => {
      expect(DEFENSIVE_MINT_VALUES.enemy_killed).to.be.greaterThan(
        DEFAULT_MINT_VALUES.enemy_killed
      );
    });

    it("should value towers higher than default", () => {
      expect(DEFENSIVE_MINT_VALUES.tower_built).to.be.greaterThan(
        DEFAULT_MINT_VALUES.tower_built
      );
    });
  });

  describe("getMintValue()", () => {
    it("should return correct value for achievement", () => {
      expect(getMintValue(DEFAULT_MINT_VALUES, "rcl_upgrade")).to.equal(1000);
      expect(getMintValue(DEFAULT_MINT_VALUES, "enemy_killed")).to.equal(200);
    });

    it("should return 0 for undefined achievement", () => {
      const customValues = { ...DEFAULT_MINT_VALUES };
      delete (customValues as any).rcl_upgrade;
      expect(getMintValue(customValues, "rcl_upgrade")).to.equal(0);
    });
  });

  describe("calculateMint()", () => {
    it("should multiply value by quantity", () => {
      expect(calculateMint(DEFAULT_MINT_VALUES, "rcl_upgrade", 10)).to.equal(10000);
    });

    it("should default to quantity 1", () => {
      expect(calculateMint(DEFAULT_MINT_VALUES, "rcl_upgrade")).to.equal(1000);
    });

    it("should return 0 for zero quantity", () => {
      expect(calculateMint(DEFAULT_MINT_VALUES, "rcl_upgrade", 0)).to.equal(0);
    });
  });

  describe("createMintValues()", () => {
    it("should use defaults when no overrides", () => {
      const values = createMintValues({});
      expect(values).to.deep.equal(DEFAULT_MINT_VALUES);
    });

    it("should override specified values", () => {
      const values = createMintValues({ rcl_upgrade: 2000 });
      expect(values.rcl_upgrade).to.equal(2000);
      expect(values.gcl_upgrade).to.equal(DEFAULT_MINT_VALUES.gcl_upgrade);
    });

    it("should allow multiple overrides", () => {
      const values = createMintValues({
        rcl_upgrade: 2000,
        enemy_killed: 500,
        road_built: 5
      });
      expect(values.rcl_upgrade).to.equal(2000);
      expect(values.enemy_killed).to.equal(500);
      expect(values.road_built).to.equal(5);
    });

    it("should not modify DEFAULT_MINT_VALUES", () => {
      const originalValue = DEFAULT_MINT_VALUES.rcl_upgrade;
      createMintValues({ rcl_upgrade: 9999 });
      expect(DEFAULT_MINT_VALUES.rcl_upgrade).to.equal(originalValue);
    });
  });
});
