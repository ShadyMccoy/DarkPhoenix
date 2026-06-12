/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, FIND_STRUCTURES, STRUCTURE_CONTAINER, RESOURCE_ENERGY } from "../mock";
import { storeFill, storeLevels } from "../../../src/economy/storeFill";

setupGlobals();

/** A store keyed by resource, with a capacity, mimicking a Screeps Store. */
function store(energy: number, capacity: number): any {
  return {
    [RESOURCE_ENERGY]: energy,
    getCapacity: (_r: string) => capacity
  };
}

/** A fake container at energy/capacity. */
function container(energy: number, capacity = 2000): any {
  return { structureType: STRUCTURE_CONTAINER, store: store(energy, capacity) };
}

/**
 * A minimal fake Room exposing only what storeFill reads: `storage` and
 * `find(FIND_STRUCTURES, {filter})`. Containers are returned through find();
 * storage is the direct property.
 */
function roomWith(opts: { containers?: any[]; storage?: any }): Room {
  const structures = [...(opts.containers ?? [])];
  return {
    storage: opts.storage,
    find: (type: number, filterOpts?: any) => {
      if (type !== FIND_STRUCTURES) return [];
      return filterOpts?.filter ? structures.filter(filterOpts.filter) : structures;
    }
  } as any;
}

describe("storeFill - the energy thermostat reading", () => {
  it("reports 0 ('empty') for a bare room with no reservoir", () => {
    // A cold-start room must never read 'full', or income would gate itself off.
    const room = roomWith({});
    expect(storeFill(room)).to.equal(0);
    expect(storeLevels(room)).to.deep.equal({ energy: 0, capacity: 0 });
  });

  it("reads container-only reservoirs before storage exists (RCL < 4)", () => {
    const room = roomWith({ containers: [container(500, 2000), container(1500, 2000)] });
    // 2000 / 4000 = 0.5
    expect(storeFill(room)).to.be.closeTo(0.5, 1e-9);
  });

  it("reports full when the reservoir is full", () => {
    const room = roomWith({ containers: [container(2000, 2000)] });
    expect(storeFill(room)).to.equal(1);
  });

  it("includes storage in both energy and capacity", () => {
    const room = roomWith({
      containers: [container(0, 2000)],
      storage: { store: store(100000, 1000000) }
    });
    const { energy, capacity } = storeLevels(room);
    expect(energy).to.equal(100000);
    expect(capacity).to.equal(1002000);
    expect(storeFill(room)).to.be.closeTo(100000 / 1002000, 1e-9);
  });

  it("ignores non-container structures returned by find()", () => {
    const wall = { structureType: "constructedWall", store: store(9999, 9999) };
    const room = roomWith({ containers: [container(1000, 2000), wall] });
    // Only the real container counts: 1000 / 2000 = 0.5
    expect(storeFill(room)).to.be.closeTo(0.5, 1e-9);
  });
});
