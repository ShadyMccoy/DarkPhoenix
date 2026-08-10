import { expect } from "chai";
import "../../../src/types/Memory";
import { spawnDirectionsToward } from "../../../src/corps/SpawningCorp";
import { linkKind } from "../../../src/corps/kinds/linkKind";

/**
 * Spawn placement (owner 2026-07-24: "spawn the feeder using the spawn
 * directions right into the feeder spot"). A parked corp names its post; the
 * spawn's `directions` bias the newborn out on that side so it is born on-post
 * with no walk-in dead time. The full 8-direction ring is included as fallback
 * so a blocked preferred tile never PREVENTS the spawn.
 */
describe("spawnDirectionsToward (spawn placement bias)", () => {
  // Screeps direction numbering: TOP=1 clockwise ... TOP_LEFT=8, y grows down.
  it("faces the target tile FIRST, then rings outward to the opposite side", () => {
    // target to the bottom-right of the spawn -> BOTTOM_RIGHT (4) first.
    expect(spawnDirectionsToward({ x: 25, y: 25 }, { x: 26, y: 26 })).to.deep.equal([4, 5, 3, 6, 2, 7, 1, 8]);
    // target straight up -> TOP (1) first, opposite BOTTOM (5) last.
    expect(spawnDirectionsToward({ x: 25, y: 25 }, { x: 25, y: 10 })).to.deep.equal([1, 2, 8, 3, 7, 4, 6, 5]);
  });

  it("always returns all 8 directions (fallback ring never blocks the spawn)", () => {
    const dirs = spawnDirectionsToward({ x: 10, y: 10 }, { x: 5, y: 12 })!;
    expect(dirs).to.have.length(8);
    expect([...new Set(dirs)]).to.have.length(8); // no repeats
  });

  it("returns undefined when the target IS the spawn tile (no bias)", () => {
    expect(spawnDirectionsToward({ x: 25, y: 25 }, { x: 25, y: 25 })).to.equal(undefined);
  });
});

describe("linkKind.spawnTarget (the parked relay post)", () => {
  beforeEach(() => {
    (global as any).FIND_MY_STRUCTURES = 108;
    (global as any).STRUCTURE_LINK = "link";
  });

  function room(opts: { link?: any; storageMy?: boolean }): any {
    const storagePos = { x: 20, y: 20, roomName: "W1N1" };
    return {
      name: "W1N1",
      storage: opts.storageMy
        ? { my: true, pos: { ...storagePos, findInRange: () => (opts.link ? [opts.link] : []) } }
        : undefined
    };
  }

  it("targets the CORE LINK when the room is link-fed (born on-post)", () => {
    const link = { structureType: "link", pos: { x: 21, y: 20, roomName: "W1N1" } };
    const spawn: any = { room: room({ link, storageMy: true }) };
    const target = linkKind.spawnTarget!("feeder", spawn);
    expect(target).to.equal(link.pos);
  });

  it("falls back to the storage depot when there is no core link (walking relay)", () => {
    const spawn: any = { room: room({ storageMy: true }) };
    const target = linkKind.spawnTarget!("feeder", spawn);
    expect(target!.x).to.equal(20);
    expect(target!.y).to.equal(20);
  });

  it("returns null with no storage yet (nothing to relay - default placement)", () => {
    const spawn: any = { room: room({ storageMy: false }) };
    expect(linkKind.spawnTarget!("feeder", spawn)).to.equal(null);
  });
});
