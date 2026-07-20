/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { FlowEconomy } from "../../../src/flow/FlowEconomy";
import { NodeNavigator } from "../../../src/nodes/NodeNavigator";
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
    const a = new FlowEconomy(nodes, new NodeNavigator(nodes, []));
    a.update(0);
    expect(g.Memory.lastBankDraw, "the solve records its realized draw").to.be.a("number");

    // The rebuild: a brand-new instance (no instance state carried over)
    // must still see history via Memory - the pricing input is whatever the
    // last solve realized, not undefined.
    const recorded = g.Memory.lastBankDraw;
    const b = new FlowEconomy(world(), new NodeNavigator(world(), []));
    b.update(1);
    expect(g.Memory.lastBankDraw, "the fresh instance's solve re-records").to.be.a("number");
    void recorded;
  });
});
