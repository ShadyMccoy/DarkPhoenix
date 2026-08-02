/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, RawMemory } from "../mock";
import { Telemetry, CorpCensusEntry } from "../../../src/telemetry/Telemetry";
import { UpgradingCorp } from "../../../src/corps/UpgradingCorp";
import { ControllerFeederCorp } from "../../../src/corps/ControllerFeederCorp";
import { ExtensionTenderCorp } from "../../../src/corps/ExtensionTenderCorp";
import { SinkAllocation } from "../../../src/flow/FlowTypes";

/**
 * Spec 14 phase 2 - sizing records, the decision-symmetry contract: a corp
 * stamps the INPUTS of its last sizing decision at the decision site
 * (getSpawnDemand), and telemetry exports the stamp verbatim. "Why is the
 * upgrader 2 WORK" must be answerable from a capture: planAllocated vs stock
 * vs inflow vs the allocation that won. Telemetry never recomputes an input -
 * recomputation can drift from the decision (the staffsPost bug class).
 */
describe("Telemetry sizing records (segment 4, spec 14 phase 2)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.rooms = {};
    Game.time = 100;
    Game.creeps = {};
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    (Game as any).shard = { name: "shard1" };
  });

  it("exports a corp's lastSizing verbatim as `sizing`; corps without one carry none", () => {
    const sized: CorpCensusEntry = {
      corpId: "upgrading-W1N1",
      kind: "upgrade",
      corp: {
        id: "upgrading-W1N1",
        type: "upgrading",
        nodeId: "W1N1",
        createdAt: 0,
        lastActivityTick: 0,
        getCreepCount: () => 1,
        lastSizing: { tick: 99, planAllocated: 9, stock: 120, banked: 200000, inflow: 2, allocated: 2, targetCount: 1 }
      } as any
    };
    const unsized: CorpCensusEntry = {
      corpId: "harvest-s1",
      kind: "harvest",
      corp: { id: "harvest-s1", type: "mining", nodeId: "W1N1-1-1", createdAt: 0, lastActivityTick: 0, getCreepCount: () => 1 } as any
    };

    new Telemetry().update(undefined, [sized, unsized], undefined);
    const corps = JSON.parse(RawMemory.segments[4]);

    expect(corps.version).to.equal(13); // v13: upgrader fieldedWork stamp (2026-08-01)
    const u = corps.corps.find((c: any) => c.id === "upgrading-W1N1");
    expect(u.sizing).to.deep.equal({ tick: 99, planAllocated: 9, stock: 120, banked: 200000, inflow: 2, allocated: 2, targetCount: 1 });
    const h = corps.corps.find((c: any) => c.id === "harvest-s1");
    expect(h).to.not.have.property("sizing");
  });

  // ---------------------------------------------------------------------
  // INTERNAL ENGINES (production audit 2026-07-31, t72695674). The miner
  // operation owns its evacuation haulers, so `mining-*` corps carried 85% of
  // the colony's hauler spawn spend while exporting only the MINER's stamp.
  // The haul vector's rich record (routes / carryNeeded / staged / duty) was
  // stamped at the decision site and died there - so every hauler diagnosis
  // was blind on exactly the corps that dominate the spend. Decision symmetry
  // (spec 14) says the stamp must leave the runtime.
  // ---------------------------------------------------------------------
  it("exports the sizing stamps of a corp's INTERNAL ENGINES (the miner operation's haul vector)", () => {
    const haulStamp = { tick: 99, routes: 1, creeps: 1, carryNeeded: 7, staged: 2144, duty: 0.931 };
    const operation: CorpCensusEntry = {
      corpId: "mining-W1N1-harvest-abcd",
      kind: "harvest",
      corp: {
        id: "mining-W1N1-harvest-abcd",
        type: "mining",
        nodeId: "W1N1-harvest-abcd",
        createdAt: 0,
        lastActivityTick: 0,
        getCreepCount: () => 2,
        lastSizing: { tick: 99, gate: "clear", buffered: 847, staffing: 1, target: 1 },
        innerCorps: () => [
          { type: "hauling", nodeId: "W1N1-harvest-abcd", lastSizing: haulStamp },
          // an engine that has not stamped yet contributes no row
          { type: "hauling", nodeId: "W1N1-harvest-quiet" }
        ]
      } as any
    };
    // A corp with no engines at all carries no `innerSizing` key.
    const plain: CorpCensusEntry = {
      corpId: "upgrading-W1N1",
      kind: "upgrade",
      corp: {
        id: "upgrading-W1N1",
        type: "upgrading",
        nodeId: "W1N1",
        createdAt: 0,
        lastActivityTick: 0,
        getCreepCount: () => 1,
        innerCorps: () => []
      } as any
    };

    new Telemetry().update(undefined, [operation, plain], undefined);
    const corps = JSON.parse(RawMemory.segments[4]);

    const op = corps.corps.find((c: any) => c.id === "mining-W1N1-harvest-abcd");
    expect(op.innerSizing).to.deep.equal([
      { type: "hauling", nodeId: "W1N1-harvest-abcd", sizing: haulStamp }
    ]);
    // The operation's OWN stamp is untouched - the miner decision and the haul
    // decision are two records, and neither may overwrite the other.
    expect(op.sizing.gate).to.equal("clear");
    expect(corps.corps.find((c: any) => c.id === "upgrading-W1N1")).to.not.have.property("innerSizing");
  });

  it("UpgradingCorp stamps its sizing inputs at the decision site (plan-trusted path)", () => {
    // Game-free harness: no spawn resolves, so stock/banked are unmeasurable
    // (null) and the decision trusts the plan - the stamp must record exactly
    // that, not zeros.
    const corp = new UpgradingCorp("W1N1-upgrading", "spawn1");
    corp.setSinkAllocation({
      sinkId: "controller-x",
      sinkType: "controller",
      allocated: 5,
      demand: 5,
      unmet: 0,
      priority: 65
    } as SinkAllocation);

    corp.getSpawnDemand({ energyCapacity: 550, tick: 100 });

    const s = corp.lastSizing!;
    expect(s.tick).to.equal(100);
    expect(s.planAllocated).to.equal(5);
    expect(s.stock).to.equal(null);
    expect(s.banked).to.equal(null);
    // The plan IS the inflow now (owner 2026-08-02: sizing consolidated behind
    // the plan). There is no second rate left to report, so the stamp carries
    // the one number the decision read rather than a null placeholder.
    expect(s.inflow).to.equal(5);
    expect(s.allocated).to.equal(5); // the plan, full stop
    expect(s.targetCount).to.be.a("number");
  });

  /**
   * Gate stamps: for infrastructure corps the GATES are the decision - "why
   * are there zero feeders with 549k banked" is a gate verdict, so every
   * early return stamps which gate fired and the inputs it read (live
   * incident 2026-07-18: feeder+tender at 0 creeps across consecutive
   * captures, cause invisible because gates stamped nothing).
   */
  it("ControllerFeederCorp stamps the gate that blocked it (no-spawn path)", () => {
    const corp = new ControllerFeederCorp("W1N1-controllerFeeder", "spawn1");
    corp.getSpawnDemand({ energyCapacity: 550, tick: 100 });
    expect(corp.lastSizing).to.deep.include({ tick: 100, gate: "no-spawn" });
  });

  it("ControllerFeederCorp stamps banked + hasMiner on the no-miner gate (the live suspect)", () => {
    const room: any = {
      name: "W1N1",
      controller: { my: true },
      storage: { my: true, store: { energy: 549000 } },
      memory: {}
    };
    (Game as any).getObjectById = () => ({ id: "spawn1", room, pos: { getRangeTo: () => 6 } });
    Game.creeps = {}; // no harvest creep STANDS in the room -> gate closes

    const corp = new ControllerFeederCorp("W1N1-controllerFeeder", "spawn1");
    corp.getSpawnDemand({ energyCapacity: 1800, tick: 100 });

    const s = corp.lastSizing!;
    expect(s.gate).to.equal("no-miner");
    expect(s.banked).to.equal(549000);
    expect(s.hasMiner).to.equal(false);
  });

  it("ExtensionTenderCorp stamps extensions + hasMiner on the no-miner gate", () => {
    (global as any).FIND_MY_STRUCTURES = 108;
    (global as any).STRUCTURE_EXTENSION = "extension";
    const room: any = {
      name: "W1N1",
      memory: {},
      find: () => [{ structureType: "extension" }]
    };
    (Game as any).getObjectById = () => ({ id: "spawn1", room, pos: { getRangeTo: () => 2 } });
    Game.creeps = {};

    const corp = new ExtensionTenderCorp("W1N1-tender", "spawn1");
    corp.getSpawnDemand({ energyCapacity: 1800, tick: 100 });

    const s = corp.lastSizing!;
    expect(s.gate).to.equal("no-miner");
    expect(s.extensions).to.equal(1);
    expect(s.hasMiner).to.equal(false);
  });
});
