/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";

/**
 * Spec 34 (owner correction 2026-07-27): "builders don't MOVE the energy. they
 * stay in one place building. then when they move to the next site they empty
 * their carry if necessary for longer routes." The cross-room leg is the
 * "longer route" by definition: before departing, the builder SHEDS its load -
 * hand-off to an adjacent store if one is there, else drop (drop and move are
 * different action groups, so shedding costs zero ticks). Empty CARRY
 * generates no fatigue, so the walk then runs at WORK-only speed (~2.7x
 * faster for the 5W9C4M body than hauling its buffer along).
 */
describe("builder unladen relocation: shed the load before a cross-room leg", () => {
  beforeEach(() => {
    setupGlobals();
    const g = global as any;
    g.FIND_MY_CONSTRUCTION_SITES = 114;
    g.FIND_STRUCTURES = 107;
    g.FIND_DROPPED_RESOURCES = 106;
    g.STRUCTURE_CONTAINER = "container";
    g.STRUCTURE_STORAGE = "storage";
    g.RESOURCE_ENERGY = "energy";
    g.ERR_NOT_IN_RANGE = -9;
    Game.creeps = {};
    Game.getObjectById = () => null;
    (Memory as any).creeps = {};
  });

  function relocate(energy: number, adjacentStore?: any) {
    const actions: string[] = [];
    const workRoom: any = {
      name: "W2N1",
      memory: {},
      find: (t: number) => (t === 114 ? [{ pos: { x: 25, y: 25, roomName: "W2N1" } }] : [])
    };
    const creep: any = {
      name: "b1",
      room: { name: "W1N1" }, // NOT the work room: a cross-room leg is starting
      memory: { workType: "build", working: false },
      store: { energy, [Symbol.for("e")]: 0, getFreeCapacity: () => 400 - energy },
      pos: {
        x: 10,
        y: 10,
        roomName: "W1N1",
        findInRange: (t: number, range: number) =>
          t === 107 && range === 1 && adjacentStore ? [adjacentStore] : [],
        getRangeTo: () => 30
      },
      drop: (res: string) => {
        actions.push(`drop:${res}`);
        return 0;
      },
      transfer: (target: any, res: string) => {
        actions.push(`transfer:${res}`);
        return 0;
      },
      moveTo: () => {
        actions.push("move");
        return 0;
      },
      getActiveBodyparts: () => 0,
      say: () => 0
    };
    creep.store["energy"] = energy;
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    (corp as any).runBuilder(creep, workRoom);
    return actions;
  }

  it("laden + no adjacent store: DROPS the energy and still moves the same tick", () => {
    const actions = relocate(300);
    expect(actions).to.include("drop:energy");
    expect(actions.some(a => a === "move"), "drop and move share the tick").to.equal(true);
  });

  it("laden + adjacent container: hands the load off instead of dropping", () => {
    const container = { structureType: "container", store: { getFreeCapacity: () => 1000 } };
    const actions = relocate(300, container);
    expect(actions).to.include("transfer:energy");
    expect(actions).to.not.include("drop:energy");
  });

  it("already empty: no shed action, just the walk", () => {
    const actions = relocate(0);
    expect(actions).to.not.include("drop:energy");
    expect(actions).to.not.include("transfer:energy");
    expect(actions).to.include("move");
  });
});
