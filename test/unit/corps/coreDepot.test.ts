/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals } from "../mock";
import { coreDepot } from "../../../src/corps/nodeEnergy";

const FIND_MY_SPAWNS = 112;
const FIND_STRUCTURES = 107;

/**
 * The core depot is the ONE structure haulers dump into and the tender draws
 * from. Storage takes over the role the moment it exists (durable, huge);
 * before that it's a container beside the spawn; before that there is no depot
 * and haulers fill the spawn network directly.
 */
function room(opts: { container?: boolean; storage?: boolean; foreignStorage?: boolean }): any {
  const spawnPos = {
    x: 25,
    y: 25,
    roomName: "W0N0",
    findInRange: (type: number) =>
      type === FIND_STRUCTURES && opts.container
        ? [{ structureType: "container", pos: { x: 24, y: 25 } }]
        : []
  };
  const spawn = { id: "spawn1", pos: spawnPos };
  const storage = opts.storage
    ? { structureType: "storage", my: !opts.foreignStorage, pos: { x: 26, y: 25, roomName: "W0N0" } }
    : undefined;
  return {
    name: "W0N0",
    storage,
    find: (type: number) => (type === FIND_MY_SPAWNS ? [spawn] : [])
  };
}

describe("coreDepot (shared depot resolution)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).FIND_MY_SPAWNS = FIND_MY_SPAWNS;
    (global as any).FIND_STRUCTURES = FIND_STRUCTURES;
    (global as any).STRUCTURE_CONTAINER = "container";
    (global as any).STRUCTURE_STORAGE = "storage";
  });

  it("is null when the room has neither storage nor a spawn-side container", () => {
    expect(coreDepot(room({}))).to.equal(null);
  });

  it("is the container beside the spawn before storage exists", () => {
    const depot = coreDepot(room({ container: true }));
    expect(depot).to.not.equal(null);
    expect((depot as any).structureType).to.equal("container");
  });

  it("is the storage from the moment it exists", () => {
    const depot = coreDepot(room({ storage: true }));
    expect(depot).to.not.equal(null);
    expect((depot as any).structureType).to.equal("storage");
  });

  it("prefers storage over a still-standing container depot (the depot upgrade)", () => {
    const depot = coreDepot(room({ container: true, storage: true }));
    expect((depot as any).structureType).to.equal("storage");
  });

  it("ignores a storage we don't own and falls back to the container", () => {
    const depot = coreDepot(room({ container: true, storage: true, foreignStorage: true }));
    expect((depot as any).structureType).to.equal("container");
  });
});
