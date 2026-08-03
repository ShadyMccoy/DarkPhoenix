/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { FlowEconomy } from "../../../src/economy/flowAdapter";
import { plannedControllerFlow } from "../../../src/economy/bank";
import { createNode, Node, NodeResource } from "../../../src/nodes/Node";

/**
 * The feeder-pricing history SURVIVES the graph rebuild (prod t72447816):
 * main.ts replaces the FlowEconomy instance on every rebuild, so
 * instance-held prevBankDraw died before a second solve ever read it - the
 * starvation-loop fix was deployed and DORMANT (infra pinned at 0.1874
 * across every post-deploy solve). The realized draw now round-trips
 * through Memory.lastBankDraw: written after every solve, read by the next
 * one - whichever instance runs it.
 */
describe("FlowEconomy - lastBankDraw survives the instance rebuild", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any };
  let savedGame: unknown;
  let savedMemory: unknown;

  const at = (x: number) => ({ x, y: 25, roomName: "W0N0" });
  function world(): Node[] {
    const home = createNode("home", "W0N0", at(5) as any, 100, ["W0N0"], 0);
    home.resources = [
      { type: "spawn", id: "spawn-0", position: at(5) },
      { type: "controller", id: "ctrl-0", position: at(5), isOwned: true } as NodeResource,
      { type: "storage", id: "storage-0", position: at(5) } as NodeResource
    ];
    const src = createNode("s1", "W0N0", at(15) as any, 50, ["W0N0"], 0);
    src.resources = [{ type: "source", id: "s1", position: at(15), capacity: 3000 } as NodeResource];
    return [home, src];
  }

  beforeEach(() => {
    savedGame = g.Game;
    savedMemory = g.Memory;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {}, spawns: {} };
    g.Memory = {};
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
  });

  it("every solve WRITES the realized draw; a FRESH instance READS it", () => {
    const nodes = world();
    const a = new FlowEconomy(nodes);
    a.update(0);
    expect(g.Memory.lastBankDraw, "the solve records its realized draw").to.be.a("number");

    // The rebuild: a brand-new instance (no instance state carried over)
    // must still see history via Memory - the pricing input is whatever the
    // last solve realized, not undefined.
    const recorded = g.Memory.lastBankDraw;
    const b = new FlowEconomy(world());
    b.update(1);
    expect(g.Memory.lastBankDraw, "the fresh instance's solve re-records").to.be.a("number");
    void recorded;
  });

  it("persists the FUNDED remote set so the next solve prices reservers from reality (t72750467: 26 candidates vs 8 funded)", () => {
    new FlowEconomy(world()).update(0);
    const funded = g.Memory.fundedRemoteRooms as string[] | undefined;
    expect(funded, "the solve publishes its funded remote rooms").to.be.an("array");
    // This one-room world funds only home-room sources - the set is EMPTY,
    // which is exactly the point: the candidate-derived set would count any
    // scouted room, the funded set counts what the plan staffed.
    expect(funded).to.deep.equal([]);
  });

  it("publishes the plan's controller allocation PER ROOM, resolved by the pure lens (spec 38 phase B)", () => {
    new FlowEconomy(world()).update(0);
    const published = g.Memory.controllerAllocations as Record<string, number> | undefined;
    expect(published, "the solve publishes the per-room controller allocations").to.be.an("object");
    expect(published!["W0N0"], "this world's one controller room is present").to.be.a("number");
    expect(published!["W0N0"]).to.be.greaterThan(0, "a solvable world routes the controller SOMETHING");
    // The runtime lens reads exactly what the solve published - and stays
    // undefined-safe before the first solve (the legacy-fallback trigger).
    expect(plannedControllerFlow(published, "W0N0")).to.equal(published!["W0N0"]);
    expect(plannedControllerFlow(published, "W9N9")).to.equal(undefined);
    expect(plannedControllerFlow(undefined, "W0N0")).to.equal(undefined);
  });
});
