/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";

/**
 * The construction tanker STORAGE FALLBACK for a dry link-served source (owner
 * 2026-07-27, the link-fed build-stall, t72597918): a link-served source feeds
 * its link - never a container/pile - so once the warchest drops out of surplus
 * the tanker used to wait at the dry source forever and the builder starved
 * (3 sites, a 2-WORK builder, 0 built, storage ~55k at the reserve). It must
 * fall back to drawing the plan-allocated build fuel from the BANK.
 */
describe("ConstructionCorp tanker draws from the bank when the committed source is DRY", () => {
  beforeEach(() => {
    setupGlobals();
    const g = global as any;
    g.FIND_SOURCES = 105;
    g.FIND_STRUCTURES = 107;
    g.FIND_DROPPED_RESOURCES = 106;
    g.STRUCTURE_CONTAINER = "container";
    g.RESOURCE_ENERGY = "energy";
    g.ERR_NOT_IN_RANGE = -9;
    Game.creeps = {};
    (Memory as any).creeps = {};
    // Reserve target ABOVE the staged storage, so we are BELOW surplus (the
    // live shape: storage ~55k sitting at the dynamic ~56k reserve). This forces
    // the non-surplus path where the old code stalled at the dry source.
    (Memory as any).warchestTarget = 60_000;
  });
  afterEach(() => {
    Game.getObjectById = () => null;
  });

  function run(storageEnergy: number) {
    const withdrawn: any[] = [];
    const source: any = {
      id: "src1",
      pos: { x: 40, y: 25, roomName: "W1N1", getRangeTo: () => 1, findInRange: () => [] } // DRY: link-served
    };
    Game.getObjectById = ((id: string) => (id === "src1" ? source : null)) as any;
    const storage: any = {
      my: true,
      store: { energy: storageEnergy, getFreeCapacity: () => 0 },
      pos: { x: 24, y: 24, roomName: "W1N1" }
    };
    const room: any = {
      name: "W1N1",
      storage,
      memory: {},
      find: (t: number) => (t === 105 ? [source] : [])
    };
    const creep: any = {
      memory: { workType: "tank", working: false, assignedSourceId: "src1" },
      store: { energy: 0, getFreeCapacity: () => 200, [Symbol.for("e")]: 0 },
      pos: { x: 24, y: 25, roomName: "W1N1", getRangeTo: () => 1 },
      withdraw: (target: any) => {
        withdrawn.push(target);
        return 0;
      },
      pickup: () => 0,
      moveTo: () => 0
    };
    creep.store[(global as any).RESOURCE_ENERGY] = 0;
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    (corp as any).runTanker(creep, room);
    return { withdrawn, storage };
  }

  it("DRY source (link-served) + bank has energy (below surplus) -> withdraws from the BANK, not idle", () => {
    const { withdrawn, storage } = run(55_000); // below the ~56k reserve: NOT surplus
    expect(withdrawn, "the tanker fuels from the bank").to.deep.equal([storage]);
  });

  it("DRY source + EMPTY bank -> does not withdraw (nothing to draw; waits)", () => {
    const { withdrawn } = run(0);
    expect(withdrawn, "no phantom withdraw from an empty bank").to.have.length(0);
  });
});
