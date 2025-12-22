import { expect } from "chai";
import { CorpStateRegistry, createCorpStateRegistry } from "../../../src/corps/CorpStateRegistry";
import {
  createSourceState,
  createMiningState,
  createSpawningState,
  createUpgradingState,
  createHaulingState,
  AnyCorpState
} from "../../../src/corps/CorpState";
import { Position } from "../../../src/market/Offer";

describe("CorpStateRegistry", () => {
  const spawnPos: Position = { x: 25, y: 25, roomName: "W1N1" };
  const sourcePos: Position = { x: 10, y: 10, roomName: "W1N1" };
  const controllerPos: Position = { x: 40, y: 40, roomName: "W1N1" };

  function createTestStates(): AnyCorpState[] {
    const spawning = createSpawningState("spawning-1", "node-1", spawnPos);
    const source = createSourceState("source-1", "node-1", sourcePos, "source-id", 3000, 1);
    const mining = createMiningState("mining-1", "node-1", "source-1", "spawning-1", sourcePos, 3000, spawnPos);
    const hauling = createHaulingState("hauling-1", "node-1", "mining-1", "spawning-1", sourcePos, controllerPos, 500, spawnPos);
    const upgrading = createUpgradingState("upgrading-1", "node-1", "spawning-1", controllerPos, 1, spawnPos);
    return [spawning, source, mining, hauling, upgrading];
  }

  describe("constructor", () => {
    it("should create empty registry", () => {
      const registry = new CorpStateRegistry();
      expect(registry.size).to.equal(0);
    });

    it("should index states by ID", () => {
      const states = createTestStates();
      const registry = new CorpStateRegistry(states);
      expect(registry.size).to.equal(5);
    });
  });

  describe("get()", () => {
    it("should return state by ID", () => {
      const states = createTestStates();
      const registry = new CorpStateRegistry(states);

      const mining = registry.get("mining-1");
      expect(mining.id).to.equal("mining-1");
      expect(mining.type).to.equal("mining");
    });

    it("should throw for unknown ID", () => {
      const registry = new CorpStateRegistry([]);
      expect(() => registry.get("unknown")).to.throw("Corp state not found: unknown");
    });
  });

  describe("tryGet()", () => {
    it("should return state if found", () => {
      const states = createTestStates();
      const registry = new CorpStateRegistry(states);

      const mining = registry.tryGet("mining-1");
      expect(mining).to.not.be.undefined;
      expect(mining!.id).to.equal("mining-1");
    });

    it("should return undefined if not found", () => {
      const registry = new CorpStateRegistry([]);
      expect(registry.tryGet("unknown")).to.be.undefined;
    });
  });

  describe("has()", () => {
    it("should return true for existing state", () => {
      const states = createTestStates();
      const registry = new CorpStateRegistry(states);
      expect(registry.has("mining-1")).to.be.true;
    });

    it("should return false for unknown state", () => {
      const registry = new CorpStateRegistry([]);
      expect(registry.has("unknown")).to.be.false;
    });
  });

  describe("register()", () => {
    it("should add new state", () => {
      const registry = new CorpStateRegistry();
      const spawning = createSpawningState("spawning-1", "node-1", spawnPos);

      registry.register(spawning);

      expect(registry.has("spawning-1")).to.be.true;
      expect(registry.size).to.equal(1);
    });
  });

  describe("getByType()", () => {
    it("should filter by type", () => {
      const states = createTestStates();
      const registry = new CorpStateRegistry(states);

      const miningStates = registry.getByType("mining");
      expect(miningStates).to.have.length(1);
      expect(miningStates[0].id).to.equal("mining-1");
    });

    it("should return empty array for no matches", () => {
      const registry = new CorpStateRegistry([]);
      expect(registry.getByType("mining")).to.have.length(0);
    });
  });

  describe("dependency helpers", () => {
    it("should get source for mining", () => {
      const states = createTestStates();
      const registry = new CorpStateRegistry(states);
      const mining = registry.get("mining-1");

      const source = registry.getSourceForMining(mining as any);
      expect(source.id).to.equal("source-1");
      expect(source.type).to.equal("source");
    });

    it("should get mining for hauling", () => {
      const states = createTestStates();
      const registry = new CorpStateRegistry(states);
      const hauling = registry.get("hauling-1");

      const mining = registry.getMiningForHauling(hauling as any);
      expect(mining.id).to.equal("mining-1");
      expect(mining.type).to.equal("mining");
    });
  });

  describe("validateDependencies()", () => {
    it("should return empty for valid dependencies", () => {
      const states = createTestStates();
      const registry = new CorpStateRegistry(states);

      const missing = registry.validateDependencies();
      expect(missing).to.have.length(0);
    });

    it("should detect missing source dependency", () => {
      const spawning = createSpawningState("spawning-1", "node-1", spawnPos);
      const mining = createMiningState("mining-1", "node-1", "missing-source", "spawning-1", sourcePos, 3000, spawnPos);
      const registry = new CorpStateRegistry([spawning, mining]);

      const missing = registry.validateDependencies();
      expect(missing).to.have.length(1);
      expect(missing[0]).to.include("missing source");
    });

    it("should detect missing spawning dependency", () => {
      const source = createSourceState("source-1", "node-1", sourcePos, "source-id", 3000, 1);
      const mining = createMiningState("mining-1", "node-1", "source-1", "missing-spawn", sourcePos, 3000, spawnPos);
      const registry = new CorpStateRegistry([source, mining]);

      const missing = registry.validateDependencies();
      expect(missing).to.have.length(1);
      expect(missing[0]).to.include("missing spawning");
    });

    it("should detect multiple missing dependencies", () => {
      const mining = createMiningState("mining-1", "node-1", "missing-source", "missing-spawn", sourcePos, 3000, spawnPos);
      const registry = new CorpStateRegistry([mining]);

      const missing = registry.validateDependencies();
      expect(missing).to.have.length(2);
    });
  });

  describe("isValid()", () => {
    it("should return true for valid registry", () => {
      const states = createTestStates();
      const registry = new CorpStateRegistry(states);
      expect(registry.isValid()).to.be.true;
    });

    it("should return false for invalid registry", () => {
      const mining = createMiningState("mining-1", "node-1", "missing-source", "missing-spawn", sourcePos, 3000, spawnPos);
      const registry = new CorpStateRegistry([mining]);
      expect(registry.isValid()).to.be.false;
    });
  });

  describe("clear()", () => {
    it("should remove all states", () => {
      const states = createTestStates();
      const registry = new CorpStateRegistry(states);

      registry.clear();

      expect(registry.size).to.equal(0);
      expect(registry.has("mining-1")).to.be.false;
    });
  });

  describe("createCorpStateRegistry()", () => {
    it("should create registry from states array", () => {
      const states = createTestStates();
      const registry = createCorpStateRegistry(states);

      expect(registry.size).to.equal(5);
      expect(registry.isValid()).to.be.true;
    });
  });
});
