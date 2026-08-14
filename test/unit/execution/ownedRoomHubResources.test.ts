/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * attachOwnedRoomHubResources - owned-room HUB structures (storage, spawns,
 * the owned controller) join their node from GUARANTEED vision, with NO
 * territory cache required.
 *
 * THE INCIDENT (t72968647, the frozen-graph audit): the full terrain analysis
 * runs only at zero nodes, and re-analysis at established-colony scale is
 * held behind Memory.analysisGo (the 2026-08-11 crash-loop hold). Every
 * deploy wipes the heap territory cache, so refreshNodeResourcesFromCache
 * no-ops and the node graph FREEZES at its Memory snapshot. Measured cost:
 * W43N24's storage (completed ~32k ticks earlier) never became a resource,
 * so discoverSinks never emitted its sink, the colony's sink capacity
 * collapsed at RCL 8, and the planner defunded 10 sources (no-sink /
 * unrouted) while their mouths rotted 12.98 e/t (the L1 top line). W43N21's
 * claimed controller likewise never joined, so the new room had no local
 * sink at all.
 *
 * Hub structures need no territory partitioning: an owned room's storage /
 * spawn / controller belongs to the node already anchored in that room (the
 * attachOwnedSpawnsToNodes precedent - spawns sit on structure-blocked tiles
 * the territory division skips, so they ALWAYS needed this path). Owned
 * rooms always have vision (the controller is an owned structure), so the
 * read is durable, not a creep-vision read (trap-list compliant).
 */
import "../../../src/types/Memory";
import { expect } from "chai";
import { Game as MockGame, FIND_MY_SPAWNS } from "../mock";
import { Colony } from "../../../src/colony/Colony";
import { createNode } from "../../../src/nodes/Node";
import { attachOwnedRoomHubResources } from "../../../src/execution/IncrementalAnalysis";

/** An owned, visible room with optional storage / spawns / controller level. */
function ownedRoom(
  name: string,
  opts: {
    storage?: { id: string; x: number; y: number; capacity?: number };
    spawns?: { id: string; x: number; y: number }[];
    controller?: { id: string; x: number; y: number; level: number };
  }
): any {
  return {
    name,
    controller: opts.controller
      ? {
          id: opts.controller.id,
          my: true,
          level: opts.controller.level,
          pos: { x: opts.controller.x, y: opts.controller.y, roomName: name }
        }
      : { my: true, level: 4, pos: { x: 25, y: 25, roomName: name } },
    storage: opts.storage
      ? {
          id: opts.storage.id,
          my: true,
          pos: { x: opts.storage.x, y: opts.storage.y, roomName: name },
          store: { getCapacity: () => opts.storage!.capacity ?? 1_000_000 }
        }
      : undefined,
    find: (type: number) =>
      type === FIND_MY_SPAWNS
        ? (opts.spawns ?? []).map(s => ({ id: s.id, pos: { x: s.x, y: s.y, roomName: name } }))
        : []
  };
}

function install(rooms: Record<string, any>): void {
  (global as any).FIND_MY_SPAWNS = FIND_MY_SPAWNS;
  (global as any).RESOURCE_ENERGY = "energy";
  (global as any).Game = { ...MockGame, creeps: {}, rooms, spawns: {}, time: 500 };
  (global as any).Memory = { creeps: {}, rooms: {} };
}

describe("attachOwnedRoomHubResources (the frozen-graph hub fix, t72968647)", () => {
  afterEach(() => {
    (global as any).Game = { ...MockGame, creeps: {}, rooms: {}, spawns: {}, time: 100 };
    (global as any).Memory = { creeps: {}, rooms: {} };
  });

  it("attaches a storage completed AFTER the last analysis to the room's nearest node - no territories needed", () => {
    // The W43N24 shape: the node holds controller+spawn from the old analysis;
    // the storage stood later and never joined (32k ticks measured).
    const colony = new Colony();
    const node = createNode("W43N24-34-27", "W43N24", { x: 34, y: 27, roomName: "W43N24" }, 40, ["W43N24"], 100);
    node.resources.push({
      type: "controller",
      id: "ctrl-cd8c",
      position: { x: 36, y: 20, roomName: "W43N24" },
      isOwned: true
    } as any);
    colony.addNode(node);
    install({ W43N24: ownedRoom("W43N24", { storage: { id: "stor-24", x: 33, y: 28 } }) });

    attachOwnedRoomHubResources(colony);

    const storages = node.resources.filter(r => r.type === "storage");
    expect(storages, "the completed storage joins its room's node").to.have.length(1);
    expect(storages[0].id).to.equal("stor-24");
    expect(storages[0].position).to.deep.equal({ x: 33, y: 28, roomName: "W43N24" });
  });

  it("attaches a newly-claimed room's controller as OWNED to the nearest node spanning it (the W43N21 shape)", () => {
    // W43N21's nodes carried only intel sources - the claim never joined, so
    // the room had no controller sink and its sources stayed priced as remotes.
    const colony = new Colony();
    const node = createNode("W43N21-22-11", "W43N21", { x: 22, y: 11, roomName: "W43N21" }, 40, ["W43N21"], 100);
    colony.addNode(node);
    install({ W43N21: ownedRoom("W43N21", { controller: { id: "ctrl-21", x: 28, y: 19, level: 1 } }) });

    attachOwnedRoomHubResources(colony);

    const controllers = node.resources.filter(r => r.type === "controller");
    expect(controllers, "the claimed controller joins the graph").to.have.length(1);
    expect(controllers[0].id).to.equal("ctrl-21");
    expect(controllers[0].isOwned, "sink emission gates on isOwned").to.equal(true);
    expect(controllers[0].level).to.equal(1);
  });

  it("upgrades a STALE controller resource in place: ownership and level refresh, no duplicate", () => {
    // Intel-era controller resource (isOwned false) must flip when the live
    // room shows controller.my - and an rcl-up refreshes level.
    const colony = new Colony();
    const node = createNode("W43N21-22-11", "W43N21", { x: 22, y: 11, roomName: "W43N21" }, 40, ["W43N21"], 100);
    node.resources.push({
      type: "controller",
      id: "ctrl-21",
      position: { x: 28, y: 19, roomName: "W43N21" },
      isOwned: false
    } as any);
    colony.addNode(node);
    install({ W43N21: ownedRoom("W43N21", { controller: { id: "ctrl-21", x: 28, y: 19, level: 2 } }) });

    attachOwnedRoomHubResources(colony);

    const controllers = node.resources.filter(r => r.type === "controller");
    expect(controllers, "updated in place, not duplicated").to.have.length(1);
    expect(controllers[0].isOwned).to.equal(true);
    expect(controllers[0].level).to.equal(2);
  });

  it("is idempotent: a second pass adds nothing", () => {
    const colony = new Colony();
    const node = createNode("W43N24-34-27", "W43N24", { x: 34, y: 27, roomName: "W43N24" }, 40, ["W43N24"], 100);
    colony.addNode(node);
    install({
      W43N24: ownedRoom("W43N24", {
        storage: { id: "stor-24", x: 33, y: 28 },
        spawns: [{ id: "spawn-db0f", x: 35, y: 27 }]
      })
    });

    attachOwnedRoomHubResources(colony);
    attachOwnedRoomHubResources(colony);

    expect(node.resources.filter(r => r.type === "storage")).to.have.length(1);
    expect(node.resources.filter(r => r.type === "spawn")).to.have.length(1);
  });

  it("prunes a hub resource whose structure is GONE from a visible owned room", () => {
    // The inverse freeze: a destroyed storage must not stay a sink forever.
    const colony = new Colony();
    const node = createNode("W43N24-34-27", "W43N24", { x: 34, y: 27, roomName: "W43N24" }, 40, ["W43N24"], 100);
    node.resources.push({
      type: "storage",
      id: "stor-dead",
      position: { x: 33, y: 28, roomName: "W43N24" }
    } as any);
    colony.addNode(node);
    install({ W43N24: ownedRoom("W43N24", {}) }); // no storage in the live room

    attachOwnedRoomHubResources(colony);

    expect(
      node.resources.filter(r => r.type === "storage"),
      "a dead storage resource is pruned from the graph"
    ).to.have.length(0);
  });

  it("touches nothing outside owned-and-visible rooms (remote/intel resources are not its business)", () => {
    // A remote node's intel-sourced resources must survive untouched - the
    // attacher's scope is hub structures in rooms we own with guaranteed
    // vision, never the scouted world.
    const colony = new Colony();
    const remote = createNode("W44N23-37-22", "W44N23", { x: 37, y: 22, roomName: "W44N23" }, 40, ["W44N23"], 100);
    remote.resources.push({
      type: "source",
      id: "src-remote",
      position: { x: 33, y: 29, roomName: "W44N23" },
      capacity: 3000
    } as any);
    remote.resources.push({
      type: "storage",
      id: "stor-phantom",
      position: { x: 20, y: 20, roomName: "W44N23" }
    } as any);
    colony.addNode(remote);
    install({}); // no vision anywhere

    attachOwnedRoomHubResources(colony);

    expect(remote.resources.filter(r => r.type === "source"), "intel sources untouched").to.have.length(1);
    expect(
      remote.resources.filter(r => r.type === "storage"),
      "no pruning without owned-room vision"
    ).to.have.length(1);
  });
});
