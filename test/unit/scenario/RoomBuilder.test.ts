import { assert } from "chai";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";
import { threeChamber, singleSource } from "../../integration/scenario/library";

describe("RoomBuilder", () => {
  it("emits a 50x50 all-plain room by default", () => {
    const { terrain, objects } = new RoomBuilder("W0N0").toRoom();
    assert.equal(terrain.length, 50);
    assert.isTrue(terrain.every((row) => row.length === 50));
    assert.isTrue(terrain.every((row) => /^\.{50}$/.test(row)));
    assert.deepEqual(objects, []);
  });

  it("border() walls only the outer edge", () => {
    const { terrain } = new RoomBuilder("W0N0").border().toRoom();
    assert.equal(terrain[0], "#".repeat(50));
    assert.equal(terrain[49], "#".repeat(50));
    assert.equal(terrain[25][0], "#");
    assert.equal(terrain[25][49], "#");
    assert.equal(terrain[25][25], "."); // interior stays plain
  });

  it("vWall() draws a column and leaves the gap open", () => {
    const { terrain } = new RoomBuilder("W0N0").vWall(16, { gap: [24, 25] }).toRoom();
    assert.equal(terrain[10][16], "#"); // wall above the gap
    assert.equal(terrain[24][16], "."); // corridor
    assert.equal(terrain[25][16], "."); // corridor
    assert.equal(terrain[26][16], "#"); // wall below the gap
  });

  it("placing an object forces its tile to plain and records it", () => {
    const { terrain, objects } = new RoomBuilder("W0N0")
      .fill("wall")
      .source(8, 25)
      .toRoom();
    assert.equal(terrain[25][8], "."); // carved out of the wall fill
    assert.deepEqual(objects, [{ type: "source", x: 8, y: 25, attributes: undefined }]);
  });

  it("swamp tiles render as ~", () => {
    const { terrain } = new RoomBuilder("W0N0").rect(5, 5, 7, 7, "swamp").toRoom();
    assert.equal(terrain[6][6], "~");
  });

  it("library: threeChamber isolates source, spawn and controller", () => {
    const s = threeChamber();
    const room = s.rooms[0];
    const source = room.objects.find((o) => o.type === "source")!;
    const controller = room.objects.find((o) => o.type === "controller")!;
    // Source in the west chamber, controller in the east, spawn (bot) in centre.
    assert.isBelow(source.x, 16);
    assert.isAbove(controller.x, 33);
    assert.isAbove(s.bot.x, 17);
    assert.isBelow(s.bot.x, 32);
    // Dividers are walls except the shared corridor row.
    assert.equal(room.terrain[10][16], "#");
    assert.equal(room.terrain[25][16], ".");
  });

  it("library: singleSource places the source at the requested depth", () => {
    const s = singleSource({ sourceY: 42 });
    const source = s.rooms[0].objects.find((o) => o.type === "source")!;
    assert.equal(source.y, 42);
  });
});
