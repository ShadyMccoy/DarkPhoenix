/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { FlowEconomy, fundedRemoteFlowsOf } from "../../../src/economy/flowAdapter";
import { createNode, Node, NodeResource } from "../../../src/nodes/Node";

/**
 * PER-ROOM FUNDED FLOW is a PUBLISHED number, not an inference (owner
 * 2026-08-10: the edge link is placed to offset the whole fleet, subject to
 * the total throughput of the sources that will drop off at it - which makes
 * per-room mined rate a placement INPUT, and placement may never derive it
 * from creeps or vision).
 *
 * One walk serves both views: `fundedRemoteRoomsOf` is these flows' keys,
 * sorted, so "which rooms are funded" and "at what rate" cannot disagree -
 * the same one-lens discipline as portPosts/isPortBuffer (spec 56).
 */
describe("fundedRemoteFlowsOf - the funded mined rate per remote room", () => {
  const at = (roomName: string) => ({ x: 25, y: 25, roomName });

  const problem = {
    spawns: [{ pos: at("W0N0") }],
    sources: [
      { id: "home", pos: at("W0N0") },
      { id: "ra", pos: at("W1N0") },
      { id: "rb", pos: at("W1N0") },
      { id: "rc", pos: at("W2N0") }
    ]
  } as any;

  it("sums funded miners' rates by remote room; spawn rooms are excluded", () => {
    const flows = fundedRemoteFlowsOf(problem, {
      miners: [
        { sourceId: "home", rate: 10 },
        { sourceId: "ra", rate: 10 },
        { sourceId: "rb", rate: 7.5 },
        { sourceId: "rc", rate: 5 }
      ]
    });
    expect(flows).to.deep.equal({ W1N0: 17.5, W2N0: 5 });
  });

  it("an unfunded room simply has no key - the keys ARE the funded remote set", () => {
    const flows = fundedRemoteFlowsOf(problem, { miners: [{ sourceId: "home", rate: 10 }] });
    expect(flows).to.deep.equal({});
  });
});

describe("FlowEconomy publishes Memory.fundedRemoteFlows beside the funded room set", () => {
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

  it("every solve writes the flow map, keyed exactly by the funded room set", () => {
    new FlowEconomy(world()).update(0);
    const flows = g.Memory.fundedRemoteFlows as Record<string, number> | undefined;
    const rooms = g.Memory.fundedRemoteRooms as string[] | undefined;
    expect(flows, "the solve publishes per-room funded flows").to.be.an("object");
    expect(rooms, "beside the room set").to.be.an("array");
    // The home-only world funds no remote: the honest answer is an EMPTY map,
    // and the two publications agree by construction (one walk, two views).
    expect(Object.keys(flows!).sort()).to.deep.equal(rooms);
    expect(flows).to.deep.equal({});
  });
});
