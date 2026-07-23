/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, RawMemory } from "../mock";
import { Telemetry } from "../../../src/telemetry/Telemetry";

/**
 * The flow segment IS the goal-plan side (segments 0/4 are the measured
 * actual). Miners already carry a plan-side `workParts`; haulers and consumers
 * did not, so their planned body was untellable from telemetry - you had to pull
 * Memory. These assertions pin the plan side for every body-bearing role:
 * hauler carry (solver) and consumer WORK (derived from the sink allocation),
 * so a dashboard can sit each against the actual body in segment 4.
 */
describe("Telemetry flow plan: hauler + consumer planned body (segment 6)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.rooms = {};
    Game.time = 100;
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    (Game as any).shard = { name: "shard1" };
    Game.creeps = {};
  });

  const solution: any = {
    miners: [{ sourceId: "s1", nodeId: "W1N1-1-1", harvestRate: 10, efficiency: 90, spawnDistance: 12 }],
    haulers: [
      { edgeId: "e1", fromId: "s1", toId: "controller-W1N1", distance: 20, carryParts: 8, flowRate: 10, spawnCostPerTick: 0.5, spawnParts: 0.011, spawnId: "spawn1", haulerRatio: "1:1" },
      { edgeId: "e2", fromId: "s1", toId: "spawn-W1N1", distance: 5, carryParts: 3, flowRate: 6, spawnCostPerTick: 0.2, spawnId: "spawn1" }
    ],
    sinkAllocations: [
      { sinkId: "controller-W1N1", sinkType: "controller", allocated: 9, demand: 12, unmet: 3, priority: 60, sourceFlows: [] },
      { sinkId: "site-W1N1", sinkType: "construction", allocated: 10, demand: 10, unmet: 0, priority: 70, sourceFlows: [] },
      { sinkId: "spawn-W1N1", sinkType: "spawn", allocated: 5, demand: 5, unmet: 0, priority: 100, sourceFlows: [] }
    ],
    totalHarvest: 10,
    totalOverhead: 1,
    netEnergy: 9,
    efficiency: 90,
    isSustainable: true,
    unmetDemand: new Map(),
    warnings: [],
    computedAt: 100
  };

  it("exports the solver's PLANNED hauler carry parts (the plan side for haulers)", () => {
    new Telemetry().update(undefined, [], solution);
    const flow = JSON.parse(RawMemory.segments[6]);

    expect(flow.haulers).to.have.length(2);
    const h = flow.haulers.find((x: any) => x.sinkId === "controller-W1N1");
    expect(h.carryParts).to.equal(8);
    expect(h.flowRate).to.equal(10);
    expect(h.distance).to.equal(20);
    expect(h.ratio).to.equal("1:1");
    // v8: the planner's OWN paved-aware parts/tick, carried verbatim so the P4
    // ledger echoes it instead of re-deriving (drift eliminated at the root).
    expect(h.spawnParts).to.equal(0.011);
    // a route the planner left without spawnParts stays absent (never null/0)
    expect(flow.haulers.find((x: any) => x.sinkId === "spawn-W1N1").spawnParts).to.equal(undefined);
    // total planned hauler carry, directly comparable to actual carry in segment 4
    expect(flow.haulers.reduce((a: number, x: any) => a + x.carryParts, 0)).to.equal(11);
  });

  it("derives PLANNED WORK for WORK-driven consumer sinks (upgrade 1:1, build 5:1)", () => {
    new Telemetry().update(undefined, [], solution);
    const flow = JSON.parse(RawMemory.segments[6]);

    // upgrade burns 1 energy/tick per WORK -> 9 allocated => 9 WORK
    const ctrl = flow.sinks.find((s: any) => s.type === "controller");
    expect(ctrl.workParts).to.equal(9);
    // build burns 5 energy/tick per WORK -> 10 allocated => 2 WORK
    const site = flow.sinks.find((s: any) => s.type === "construction");
    expect(site.workParts).to.equal(2);
    // non-WORK sinks (spawn/extension/tower/...) carry no workParts figure
    const spawn = flow.sinks.find((s: any) => s.type === "spawn");
    expect(spawn.workParts).to.be.undefined;
  });

  it("routes miner workParts through the same shared primitive (behaviour preserved)", () => {
    new Telemetry().update(undefined, [], solution);
    const flow = JSON.parse(RawMemory.segments[6]);
    expect(flow.sources[0].workParts).to.equal(5); // ceil(10 / 2 energy-per-WORK)
  });

  it("exports planner source verdicts verbatim as candidates (spec 14 phase 5)", () => {
    const verdicts = [
      { sourceId: "s1", rate: 10, distance: 12, net: 8.1, tax: 0, parts: 9, verdict: "funded" },
      { sourceId: "remote", rate: 10, distance: 54, net: -1.2, tax: 6.5, parts: 12, verdict: "unprofitable" },
      { sourceId: "far", rate: 10, distance: 30, net: 4.0, tax: 0, parts: 11, verdict: "over-budget" }
    ];
    new Telemetry().update(undefined, [], { ...solution, sourceVerdicts: verdicts });
    const flow = JSON.parse(RawMemory.segments[6]);

    expect(flow.candidates).to.deep.equal(verdicts); // verbatim - the pricing the decision read
  });

  it("bumps the flow segment version for the plan fields and candidates", () => {
    new Telemetry().update(undefined, [], solution);
    const flow = JSON.parse(RawMemory.segments[6]);
    expect(flow.version).to.equal(9); // v8 exports haulers[].spawnParts; v9 adds partsLedger.spent/dry (spawn shadow price)
    expect(flow.candidates).to.deep.equal([]); // absent verdicts -> empty, never undefined
  });


  it("threads the fill ledger verbatim: partsLedger + per-sink partsLeft (v4; v9 spent/dry)", () => {
    const ledger = { capacity: 3, minerLoad: 0.9, infra: 0.4, budget: 1.7, spent: 1.7, dry: true };
    const withTrace = {
      ...solution,
      partsLedger: ledger,
      sinkAllocations: solution.sinkAllocations.map((k: any) =>
        k.sinkType === "controller" ? { ...k, partsLeft: 0.25 } : k
      )
    };
    new Telemetry().update(undefined, [], withTrace);
    const flow = JSON.parse(RawMemory.segments[6]);

    // the ledger the fill decision read, verbatim - an allocation collapse is named in one capture
    expect(flow.partsLedger).to.deep.equal(ledger);
    const ctrl = flow.sinks.find((s: any) => s.type === "controller");
    expect(ctrl.partsLeft).to.equal(0.25);
    // sinks the fill never charged carry no partsLeft key at all
    const spawn = flow.sinks.find((s: any) => s.type === "spawn");
    expect(spawn).to.not.have.property("partsLeft");
  });

  it("threads the problem-assembly counts verbatim (v5: names the warmup remote-drop layer)", () => {
    const withAssembly = { ...solution, assembly: { graphSources: 9, mined: 7, transient: 1, bank: 1 } };
    new Telemetry().update(undefined, [], withAssembly);
    const flow = JSON.parse(RawMemory.segments[6]);
    expect(flow.assembly).to.deep.equal({ graphSources: 9, mined: 7, transient: 1, bank: 1 });
  });

  it("omits assembly when the solution predates it", () => {
    new Telemetry().update(undefined, [], solution);
    const flow = JSON.parse(RawMemory.segments[6]);
    expect(flow).to.not.have.property("assembly");
  });

  it("omits the ledger entirely when the planner produced none (old plans stay readable)", () => {
    new Telemetry().update(undefined, [], solution);
    const flow = JSON.parse(RawMemory.segments[6]);
    expect(flow).to.not.have.property("partsLedger");
    for (const s of flow.sinks) expect(s).to.not.have.property("partsLeft");
  });
});
