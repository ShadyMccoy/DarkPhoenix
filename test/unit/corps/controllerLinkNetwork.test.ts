/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { controllerLink } from "../../../src/corps/nodeEnergy";
import { runLinks } from "../../../src/execution/LinkRunner";
import { infraSpawnLoad } from "../../../src/economy/primitives";

/**
 * The controller link network (spec 24 rung 3, owner 2026-07-20: "Creating a
 * link though near the controller would make sense though right?"). The
 * feeder's 6-tile shuttle leg (64p of plan pricing, ~13% of the spawn
 * ceiling) collapses to storage -> core link -> controller link: one shared
 * lens (controllerLink) read by the corp's sizing, the plan's pricing, the
 * LinkRunner's send rule, and the input election.
 */

function mkLink(id: string, x: number, y: number, store = 0, cooldown = 0): any {
  const link: any = {
    id,
    structureType: "link",
    pos: { x, y, roomName: "W1N1" },
    cooldown,
    store: {
      energy: store,
      getFreeCapacity: () => 800 - store
    },
    fired: [] as string[]
  };
  link.store["energy"] = store;
  link.transferEnergy = (target: any) => {
    link.fired.push(target.id);
    return 0;
  };
  return link;
}

function mkRoom(opts: { core?: any; ctrl?: any; others?: any[] }): any {
  const links = [opts.core, opts.ctrl, ...(opts.others ?? [])].filter(Boolean);
  const room: any = {
    name: "W1N1",
    storage: opts.core
      ? { my: true, pos: { findInRange: (_t: number, _r: number, _o?: any) => [opts.core] } }
      : undefined,
    find: (_t: number, _o?: any) => links,
    controller: undefined
  };
  room.controller = {
    my: true,
    pos: {
      x: 40,
      y: 32,
      roomName: "W1N1",
      findInRange: (_t: number, range: number, o?: any) => {
        const near = links.filter(l => Math.max(Math.abs(l.pos.x - 40), Math.abs(l.pos.y - 32)) <= range);
        return o?.filter ? near.filter(o.filter) : near;
      }
    }
  };
  return room;
}

describe("controller link network (spec 24 rung 3)", () => {
  beforeEach(() => {
    (global as any).FIND_MY_STRUCTURES = 108;
    (global as any).STRUCTURE_LINK = "link";
    (global as any).RESOURCE_ENERGY = "energy";
  });

  it("controllerLink: a built link within range 3, never the core link", () => {
    const core = mkLink("core", 41, 33); // core parked inside controller range (tight map)
    const ctrl = mkLink("ctrl", 42, 32);
    const room = mkRoom({ core, ctrl });
    expect(controllerLink(room)!.id, "the non-core link wins").to.equal("ctrl");
    const onlyCore = mkRoom({ core });
    expect(controllerLink(onlyCore), "the core alone is not a controller link").to.equal(null);
  });

  it("runLinks: the core FIRES INTO the controller link; the controller link never fires", () => {
    const core = mkLink("core", 20, 20, 400);
    const ctrl = mkLink("ctrl", 42, 32, 400); // holds energy - must NOT send it back
    const room = mkRoom({ core, ctrl });
    (global as any).Game = { rooms: { W1N1: room } };

    runLinks();
    expect(core.fired, "core -> controller link").to.deep.equal(["ctrl"]);
    expect(ctrl.fired, "the sink never sends (no 3%-per-hop ping-pong)").to.deep.equal([]);
  });

  it("runLinks: source links still feed the core alongside the controller send", () => {
    const core = mkLink("core", 20, 20, 400);
    const ctrl = mkLink("ctrl", 42, 32, 0);
    const src = mkLink("src", 5, 5, 300);
    const room = mkRoom({ core, ctrl, others: [src] });
    (global as any).Game = { rooms: { W1N1: room } };

    runLinks();
    expect(src.fired).to.deep.equal(["core"]);
    expect(core.fired).to.deep.equal(["ctrl"]);
  });

  it("infraSpawnLoad: a link-fed depot prices the feeder at the 1-tile leg (~1/6th)", () => {
    const walked = infraSpawnLoad(115, 1, 4, 0);
    const linked = infraSpawnLoad(115, 1, 4, 1);
    // Only the feeder term changes; it must shrink hard (measured target:
    // 64p -> ~22p of standing feeder at relay 115).
    expect(linked).to.be.lessThan(walked);
    expect(walked - linked, "the whole saving is the feeder leg").to.be.greaterThan(0.02);
  });
});

describe("findMissingLink's controller step reads the SHARED lens (the core-adjacency deadlock)", () => {
  beforeEach(() => {
    (global as any).FIND_MY_STRUCTURES = 108;
    (global as any).FIND_MY_CONSTRUCTION_SITES = 114;
    (global as any).STRUCTURE_LINK = "link";
    (global as any).LOOK_STRUCTURES = "structure";
    (global as any).LOOK_CONSTRUCTION_SITES = "constructionSite";
    (global as any).TERRAIN_MASK_WALL = 1;
  });

  it("places the controller link even when the CORE link sits within 3 of the controller", () => {
    // Live deadlock (t72462700-t72463749, three captures, zero sites): the
    // ladder's linkNear(ctrl,3) counted ANY link - the core included - while
    // the controllerLink lens excludes the core. Ladder said "served", lens
    // said "not link-fed", nobody placed. Same-lens discipline: the ladder
    // must ask controllerLink(), not proximity-to-anything.
    const { ConstructionCorp } = require("../../../src/corps/ConstructionCorp");
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    const core = {
      id: "core",
      structureType: "link",
      pos: { x: 27, y: 31, roomName: "W1N1", inRangeTo: (p: any, r: number) => Math.max(Math.abs(27 - p.x), Math.abs(31 - p.y)) <= r }
    };
    const ctrlPos = {
      x: 25,
      y: 32,
      roomName: "W1N1",
      findInRange: (_t: number, range: number, o: any) => {
        const list = [core].filter(l => Math.max(Math.abs(l.pos.x - 25), Math.abs(l.pos.y - 32)) <= range);
        return o?.filter ? list.filter(o.filter) : list;
      }
    };
    const room: any = {
      name: "W1N1",
      storage: {
        my: true,
        pos: {
          x: 26,
          y: 31,
          roomName: "W1N1",
          findInRange: (_t: number, range: number, o?: any) => {
            const list = [core].filter(l => Math.max(Math.abs(l.pos.x - 26), Math.abs(l.pos.y - 31)) <= range);
            return o?.filter ? list.filter(o.filter) : list;
          },
          inRangeTo: () => false
        }
      },
      controller: { my: true, pos: ctrlPos },
      getTerrain: () => ({ get: () => 0 }),
      lookForAt: () => [],
      find: (t: number) => (t === 108 ? [core] : t === 114 ? [] : [])
    };
    room.controller.room = room;
    (global as any).Game = { rooms: { W1N1: room } };

    const tile = (corp as any).findMissingLink(room, 6);
    expect(tile, "the controller link must still be wanted").to.not.equal(null);
    expect(Math.max(Math.abs(tile.x - 25), Math.abs(tile.y - 32)), "placed in the controller's range-2 ring").to.be.at.most(2);
  });
});
