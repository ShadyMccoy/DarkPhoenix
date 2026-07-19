/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";
import { resetGovernor } from "../../../src/execution/CpuGovernor";

/**
 * Builder-corp sizing is sized to the SUM OF ITS PROJECTS (owner 2026-07-19:
 * "size up the builder corp by the sum total of all its projects" - a
 * construction project is a finite tile list with a computable total cost, so
 * a nearly-finished room should field a small crew and a work-heavy room a big
 * one, at the SAME allocation and fuel). Before this, builderPlan sized purely
 * to the flow allocation (supply), work-blind: a room with 500 energy of work
 * left fielded the same crew as one with 30k.
 */
describe("ConstructionCorp builder sizing is work-aware (sum of projects)", () => {
  beforeEach(() => {
    setupGlobals();
    resetGovernor();
    const g = global as any;
    g.FIND_MY_CONSTRUCTION_SITES = 114;
    g.FIND_STRUCTURES = 107;
    g.FIND_DROPPED_RESOURCES = 106;
    g.STRUCTURE_CONTAINER = "container";
    g.STRUCTURE_STORAGE = "storage";
    g.RESOURCE_ENERGY = "energy";
    Game.creeps = {};
    Game.getObjectById = () => null;
    (Memory as any).creeps = {};
  });

  const site = (remaining: number): any => ({
    progressTotal: remaining,
    progress: 0,
    // buildSideStock scans around the first site; no local energy here so the
    // 600k storage surplus below is the (non-binding, large) fuel.
    pos: { findInRange: () => [] }
  });

  const mkRoom = (sites: any[]): any => ({
    name: "W1N1",
    controller: { my: true }, // owned: not a remote pile-fed room
    storage: { my: true, store: { energy: 600_000 } },
    memory: {},
    find: (type: number) => (type === 114 ? sites : [])
  });

  const planFor = (remaining: number): any => {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    corp.setConstructionAllocations([
      { sinkId: "s", sinkType: "construction", allocated: 100, demand: 100, unmet: 0, priority: 50, sourceFlows: [] }
    ] as any);
    return (corp as any).builderPlan(1300, mkRoom([site(remaining)]));
  };

  it("fields a SMALLER crew for a nearly-finished project than a work-heavy one at the same allocation", () => {
    const heavy = planFor(30_000); // a fresh extension/storage set
    const light = planFor(400); // one road tile's worth of work left
    expect(light.partsNeeded, "little work left -> small crew").to.be.lessThan(heavy.partsNeeded);
    expect(light.partsNeeded, "a ~400-energy tail never fields a big crew").to.be.at.most(2);
  });

  it("does NOT throttle a genuinely large project below its allocation (roads still build fast)", () => {
    // 30k of remaining work over the horizon exceeds the 100 e/t allocation, so
    // the allocation stays the binding cap - the work-cap must not shrink it.
    const heavy = planFor(30_000);
    expect(heavy.partsNeeded, "big project stays allocation-sized (100 e/t -> 20 WORK)").to.equal(20);
  });
});
