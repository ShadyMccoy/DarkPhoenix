import { expect } from "chai";
import {
  CREATE_CREEP_MESSAGE,
  NAKED_SPAWN_MESSAGE,
  armSpawnContractBypass,
  contractSpawn,
  installSpawnContractGuard
} from "../../../src/corps/spawnContract";

/**
 * The spawn contract's RUNTIME half (the static half is the spawn-authority
 * ratchet in test/unit/framework/spawnAuthority.test.ts): once the guard is
 * installed on a spawn prototype, a naked spawnCreep throws the contract
 * message, while the sanctioned contractSpawn seam still reaches the engine.
 *
 * The real install target is the global StructureSpawn (absent under mocha -
 * the installer no-ops), so these tests inject a stand-in class shaped like
 * the engine's: spawnCreep on the prototype, instances created from it.
 */
describe("corps/spawnContract - the runtime spawn guard", () => {
  /** A fresh engine-shaped spawn class per test (prototype method + instances). */
  function makeSpawnClass(): {
    ctor: { prototype: { spawnCreep: (body: BodyPartConstant[], name: string, opts?: SpawnOptions) => ScreepsReturnCode; createCreep?: (...args: unknown[]) => unknown } };
    spawn: StructureSpawn;
    calls: { body: BodyPartConstant[]; name: string; opts?: SpawnOptions }[];
  } {
    const calls: { body: BodyPartConstant[]; name: string; opts?: SpawnOptions }[] = [];
    class FakeSpawn {
      public spawnCreep(body: BodyPartConstant[], name: string, opts?: SpawnOptions): ScreepsReturnCode {
        calls.push({ body, name, opts });
        return OK;
      }
      public createCreep(): number {
        return OK;
      }
    }
    const ctor = FakeSpawn as unknown as {
      prototype: {
        spawnCreep: (body: BodyPartConstant[], name: string, opts?: SpawnOptions) => ScreepsReturnCode;
        createCreep?: (...args: unknown[]) => unknown;
      };
    };
    return { ctor, spawn: new FakeSpawn() as unknown as StructureSpawn, calls };
  }

  it("a naked spawnCreep throws the contract message; nothing reaches the engine", () => {
    const { ctor, spawn, calls } = makeSpawnClass();
    installSpawnContractGuard(ctor);
    expect(() => spawn.spawnCreep([WORK], "naked-1")).to.throw(NAKED_SPAWN_MESSAGE);
    expect(calls).to.have.length(0);
  });

  it("contractSpawn passes through to the engine call and returns its code", () => {
    const { ctor, spawn, calls } = makeSpawnClass();
    installSpawnContractGuard(ctor);
    const result = contractSpawn(spawn, [WORK, MOVE], "bought-1", { memory: { corpId: "c1" } as CreepMemory });
    expect(result).to.equal(OK);
    expect(calls).to.have.length(1);
    expect(calls[0].name).to.equal("bought-1");
    expect(calls[0].body).to.deep.equal([WORK, MOVE]);
  });

  it("the guard stays armed after a contract call (the flag never leaks)", () => {
    const { ctor, spawn } = makeSpawnClass();
    installSpawnContractGuard(ctor);
    contractSpawn(spawn, [WORK], "bought-2");
    expect(() => spawn.spawnCreep([WORK], "naked-2")).to.throw(NAKED_SPAWN_MESSAGE);
  });

  it("the flag resets even when the engine call throws (finally semantics)", () => {
    const { ctor, spawn } = makeSpawnClass();
    installSpawnContractGuard(ctor);
    ctor.prototype.spawnCreep = () => {
      throw new Error("engine exploded");
    };
    // Re-install on a fresh class is not needed: contractSpawn calls the
    // instance's (replaced) method; what matters is the contract flag drops.
    expect(() => contractSpawn(spawn, [WORK], "boom")).to.throw("engine exploded");
    const fresh = makeSpawnClass();
    installSpawnContractGuard(fresh.ctor);
    expect(() => fresh.spawn.spawnCreep([WORK], "naked-3")).to.throw(NAKED_SPAWN_MESSAGE);
  });

  it("armSpawnContractBypass admits exactly the counted naked calls", () => {
    const { ctor, spawn, calls } = makeSpawnClass();
    installSpawnContractGuard(ctor);
    armSpawnContractBypass(2);
    expect(spawn.spawnCreep([CARRY], "rescue-1")).to.equal(OK);
    expect(spawn.spawnCreep([CARRY], "rescue-2")).to.equal(OK);
    expect(() => spawn.spawnCreep([CARRY], "rescue-3")).to.throw(NAKED_SPAWN_MESSAGE);
    expect(calls).to.have.length(2);
  });

  it("double install is a no-op (no double-wrapping)", () => {
    const { ctor, spawn, calls } = makeSpawnClass();
    installSpawnContractGuard(ctor);
    const wrapped = ctor.prototype.spawnCreep;
    installSpawnContractGuard(ctor);
    expect(ctor.prototype.spawnCreep).to.equal(wrapped);
    contractSpawn(spawn, [MOVE], "bought-3");
    expect(calls).to.have.length(1);
  });

  it("createCreep always throws - the API is retired here", () => {
    const { ctor, spawn } = makeSpawnClass();
    installSpawnContractGuard(ctor);
    const legacy = spawn as unknown as { createCreep: (...args: unknown[]) => unknown };
    expect(() => legacy.createCreep([WORK], "legacy-1")).to.throw(CREATE_CREEP_MESSAGE);
  });

  it("install without a StructureSpawn global is a safe no-op", () => {
    expect(typeof StructureSpawn).to.equal("undefined");
    expect(() => installSpawnContractGuard()).to.not.throw();
  });
});
