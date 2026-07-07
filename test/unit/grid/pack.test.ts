import { expect } from "chai";
import { GridCell } from "../../grid/GridCell";
import { isSkRoomName, packBatch, partition, MAX_BOTS_PER_WORLD } from "../../grid/pack";
import { botLevel, frontier } from "../../grid/report";
import { CellVerdict } from "../../grid/GridCell";

/**
 * The packer enforces the grid's isolation invariant (>= 4 rooms between
 * cells, SK-safe names); a silent packing bug produces verdicts about packing
 * instead of the bot, so violations must throw. The ladder scoring (bot level)
 * is pinned here too - it is the repo's success metric.
 */

const mkCell = (id: string, over: Partial<GridCell> = {}): GridCell => ({
  id,
  tier: 1,
  avenue: "test",
  window: 50,
  rooms: { home: (room) => ({ room, terrain: [], objects: [] }) },
  bot: { x: 25, y: 25 },
  assertions: [],
  ...over,
});

describe("grid packBatch", () => {
  it("assigns stride-5 slots on row N0 (W0N0, W5N0, ...)", () => {
    const batch = packBatch([mkCell("a"), mkCell("b"), mkCell("c")]);
    expect(batch.cells.map((p) => p.rooms.home)).to.deep.equal(["W0N0", "W5N0", "W10N0"]);
  });

  it("resolves adjacent handles by compass direction (E of W5N0 is W4N0)", () => {
    const twoRoom = mkCell("remote", {
      rooms: {
        home: (room) => ({ room, terrain: [], objects: [] }),
        east: (room) => ({ room, terrain: [], objects: [] }),
      },
      adjacency: { east: "E" },
    });
    const batch = packBatch([mkCell("a"), twoRoom]);
    expect(batch.cells[1].rooms.home).to.equal("W5N0");
    expect(batch.cells[1].rooms.east).to.equal("W4N0");
    // Cell 0's home W0N0 is 4 from W4N0: the audit accepts exactly the minimum.
    expect(batch.allRooms).to.include("W4N0");
  });

  it("rejects duplicate ids, missing home rooms, and missing adjacency", () => {
    expect(() => packBatch([mkCell("x"), mkCell("x")])).to.throw(/duplicate/);
    expect(() => packBatch([mkCell("noHome", { rooms: {} as GridCell["rooms"] })])).to.throw(/home/);
    expect(() =>
      packBatch([
        mkCell("dangling", {
          rooms: {
            home: (room) => ({ room, terrain: [], objects: [] }),
            east: (room) => ({ room, terrain: [], objects: [] }),
          },
        }),
      ])
    ).to.throw(/adjacency/);
  });

  it("rejects mixed engine-mod signatures in one batch", () => {
    expect(() => packBatch([mkCell("a"), mkCell("b", { mods: ["freeEconomy"] })])).to.throw(/mod/);
  });

  it("batch window is the max cell window", () => {
    const batch = packBatch([mkCell("a", { window: 30 }), mkCell("b", { window: 120 })]);
    expect(batch.window).to.equal(120);
  });

  it("classifies SK room names by the bot's both-coords-in-4..6 rule", () => {
    expect(isSkRoomName("W4N4")).to.equal(true);
    expect(isSkRoomName("W14N6")).to.equal(true);
    expect(isSkRoomName("W5N5")).to.equal(false); // sector center
    expect(isSkRoomName("W4N0")).to.equal(false);
    expect(isSkRoomName("W0N0")).to.equal(false);
  });
});

describe("grid partition", () => {
  it("splits by mod signature, then chunks to the per-world bot cap", () => {
    const cells = [
      ...Array.from({ length: MAX_BOTS_PER_WORLD + 1 }, (_, i) => mkCell(`plain-${i}`)),
      mkCell("modded", { mods: ["freeEconomy"] }),
    ];
    const batches = partition(cells);
    expect(batches.length).to.equal(3); // cap+1 plain -> 2 worlds, modded -> 1
    for (const b of batches) {
      const sig = JSON.stringify(b[0].mods ?? []);
      expect(b.every((c) => JSON.stringify(c.mods ?? []) === sig)).to.equal(true);
      expect(b.length).to.be.at.most(MAX_BOTS_PER_WORLD);
    }
  });
});

describe("grid ladder scoring", () => {
  const v = (id: string, tier: number, status: CellVerdict["status"]): CellVerdict => ({
    id,
    tier,
    avenue: "test",
    status,
    decidedTick: 1,
    window: 10,
    assertions: [],
  });

  it("bot level is the highest tier with every tier below it fully green", () => {
    expect(botLevel([v("a", 0, "pass"), v("b", 1, "pass"), v("c", 2, "fail")])).to.equal(1);
    // Strict: one red T1 caps the level even when T2+ passes.
    expect(botLevel([v("a", 0, "pass"), v("b", 1, "timeout"), v("c", 2, "pass")])).to.equal(0);
    expect(botLevel([v("a", 0, "fail")])).to.equal(-1);
    // Unpopulated tiers don't cap the ladder.
    expect(botLevel([v("a", 0, "pass"), v("c", 2, "pass")])).to.equal(2);
  });

  it("frontier is the highest tier with any pass at all", () => {
    expect(frontier([v("a", 0, "pass"), v("b", 1, "fail"), v("c", 4, "pass")])).to.equal(4);
    expect(frontier([v("a", 0, "fail")])).to.equal(-1);
  });
});
