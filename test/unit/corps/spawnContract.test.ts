import { expect } from "chai";
import {
  CREATE_CREEP_MESSAGE,
  MEMORY_CONTRACT_MESSAGE,
  NAKED_SPAWN_MESSAGE,
  PurchaseContext,
  armSpawnContractBypass,
  contractSpawn,
  installSpawnContractGuard
} from "../../../src/corps/spawnContract";
import { resetSpawnLedger, spawnSpendView } from "../../../src/telemetry/spawnLedger";
import { reset as resetBlackBox, rows as blackBoxRows } from "../../../src/telemetry/BlackBox";

/** Valid contract params - the memory contract satisfied, a plain purchase. */
const validOpts = (): SpawnOptions => ({ memory: { corpId: "corp-1", workType: "work" } as CreepMemory });
const validPurchase = (over: Partial<PurchaseContext> = {}): PurchaseContext => ({ role: "tester", ...over });

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
      public id = "sp-fake";
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
    const result = contractSpawn(spawn, [WORK, MOVE], "bought-1", validOpts(), validPurchase());
    expect(result).to.equal(OK);
    expect(calls).to.have.length(1);
    expect(calls[0].name).to.equal("bought-1");
    expect(calls[0].body).to.deep.equal([WORK, MOVE]);
  });

  it("the guard stays armed after a contract call (the flag never leaks)", () => {
    const { ctor, spawn } = makeSpawnClass();
    installSpawnContractGuard(ctor);
    contractSpawn(spawn, [WORK], "bought-2", validOpts(), validPurchase());
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
    expect(() => contractSpawn(spawn, [WORK], "boom", validOpts(), validPurchase())).to.throw("engine exploded");
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
    contractSpawn(spawn, [MOVE], "bought-3", validOpts(), validPurchase());
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

/**
 * SPEC 60 PHASE A - the purchase books itself at the door. contractSpawn is
 * no longer a pass-through: an OK spawn accrues the cumulative spend ledger
 * AND files the forensic BlackBox "spawn" row, from the body actually bought,
 * so the ring and the account cover the same creep population by
 * construction (BootstrapCorp's hand-booking used to skip the ring). The
 * memory contract is enforced at the same seam: a creep born without corpId
 * or workType is unaccountable, so nothing reaches the engine.
 */
describe("corps/spawnContract - the purchase books itself at the door (spec 60 A)", () => {
  beforeEach(() => {
    resetSpawnLedger();
    resetBlackBox();
  });

  function makeSpawn(code: ScreepsReturnCode): { spawn: StructureSpawn; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const spawn = {
      id: "sp-book",
      spawnCreep: (...args: unknown[]) => {
        calls.push(args);
        return code;
      }
    } as unknown as StructureSpawn;
    return { spawn, calls };
  }

  it("an OK spawn increments the ledger with the body's true cost/parts and files the spawn row", () => {
    const { spawn } = makeSpawn(OK);
    // 1 WORK + 1 CARRY + 2 MOVE = 100 + 50 + 50 + 50 = 250e, 4 parts.
    const result = contractSpawn(spawn, [WORK, CARRY, MOVE, MOVE], "jack-1", validOpts(), { role: "jack" });
    expect(result).to.equal(OK);
    const view = spawnSpendView();
    expect(view.energyByRole.jack).to.equal(250);
    expect(view.partsByRole.jack).to.equal(4);
    const spawnRows = blackBoxRows().filter(r => r.k === "spawn");
    expect(spawnRows, "the door files exactly one forensic row per purchase").to.have.length(1);
    expect(spawnRows[0].d).to.deep.include({
      spawn: "sp-book",
      role: "jack",
      corp: "corp-1",
      cost: 250,
      parts: 4
    });
  });

  it("a failed spawn books nothing - no ledger accrual, no ring row", () => {
    const { spawn } = makeSpawn(-6 as ScreepsReturnCode); // ERR_NOT_ENOUGH_ENERGY
    const result = contractSpawn(spawn, [WORK, MOVE], "jack-2", validOpts(), { role: "jack" });
    expect(result).to.equal(-6);
    expect(spawnSpendView().energy).to.equal(0);
    expect(blackBoxRows().filter(r => r.k === "spawn")).to.have.length(0);
  });

  it("a scavenge purchase accrues the recovery sub-counter beside its role total", () => {
    const { spawn } = makeSpawn(OK);
    contractSpawn(spawn, [CARRY, MOVE], "hauler-1", validOpts(), { role: "hauler", scavenge: true });
    const view = spawnSpendView();
    expect(view.energyByRole.hauler).to.equal(100);
    expect(view.scavengeEnergy).to.equal(100);
    expect(view.scavengeParts).to.equal(2);
  });

  it("caller receipt context merges into the row; the seam's own fields win a collision", () => {
    const { spawn } = makeSpawn(OK);
    contractSpawn(spawn, [MOVE], "scout-1", validOpts(), {
      role: "scout",
      receipt: { grant: 300, why: "new-unit", cost: 999999 } // cost collides: the seam's debit must win
    });
    const row = blackBoxRows().filter(r => r.k === "spawn")[0];
    expect(row.d.grant).to.equal(300);
    expect(row.d.why).to.equal("new-unit");
    expect(row.d.cost, "the seam's measured debit outranks caller context").to.equal(50);
  });

  it("memory missing corpId throws the contract message; nothing reaches the engine", () => {
    const { spawn, calls } = makeSpawn(OK);
    expect(() =>
      contractSpawn(spawn, [WORK], "anon-1", { memory: { workType: "work" } as CreepMemory }, validPurchase())
    ).to.throw(MEMORY_CONTRACT_MESSAGE);
    expect(calls).to.have.length(0);
    expect(spawnSpendView().energy).to.equal(0);
  });

  it("memory missing workType throws the contract message; nothing reaches the engine", () => {
    const { spawn, calls } = makeSpawn(OK);
    expect(() =>
      contractSpawn(spawn, [WORK], "anon-2", { memory: { corpId: "corp-1" } as CreepMemory }, validPurchase())
    ).to.throw(MEMORY_CONTRACT_MESSAGE);
    expect(calls).to.have.length(0);
    expect(spawnSpendView().energy).to.equal(0);
  });

  it("absent memory entirely throws the contract message", () => {
    const { spawn, calls } = makeSpawn(OK);
    expect(() => contractSpawn(spawn, [WORK], "anon-3", {}, validPurchase())).to.throw(MEMORY_CONTRACT_MESSAGE);
    expect(calls).to.have.length(0);
  });
});
