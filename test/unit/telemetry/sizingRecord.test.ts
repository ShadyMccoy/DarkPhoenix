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

    expect(corps.version).to.equal(4);
    const u = corps.corps.find((c: any) => c.id === "upgrading-W1N1");
    expect(u.sizing).to.deep.equal({ tick: 99, planAllocated: 9, stock: 120, banked: 200000, inflow: 2, allocated: 2, targetCount: 1 });
    const h = corps.corps.find((c: any) => c.id === "harvest-s1");
    expect(h).to.not.have.property("sizing");
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
    expect(s.inflow).to.equal(null);
    expect(s.allocated).to.equal(5); // null stock -> trust the plan
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
