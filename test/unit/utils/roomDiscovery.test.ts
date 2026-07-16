/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * hostileRooms() - the defense-economics danger lens (v1 defund protocol).
 *
 * Two mark flavors, one set:
 * - hostileUntil: a sighted hostile CREEP's ticksToLive bounds the threat.
 * - invaderReservedUntil: an invader CORE's controller reservation bounds the
 *   occupation. The core is a structure, not a creep, so the creep pass never
 *   sees it - the reservation on the controller is the observable.
 *
 * Both marks persist without vision until their bound and are lifted early by
 * a fresh all-clear sighting. hostileRooms() memoizes per tick, so every
 * distinct observation below bumps Game.time first.
 */
import "../../../src/types/Memory";
import { expect } from "chai";
import { hostileRooms } from "../../../src/utils/RoomDiscovery";

const FIND_HOSTILE_CREEPS = 103;

/** A visible room with optional hostiles and an optional controller reservation. */
function mockRoom(
  name: string,
  opts: { hostiles?: Array<{ ticksToLive: number }>; reservation?: { username: string; ticksToEnd: number } } = {}
): any {
  return {
    name,
    controller: { reservation: opts.reservation },
    find: (type: number) => (type === FIND_HOSTILE_CREEPS ? opts.hostiles ?? [] : [])
  };
}

describe("utils/RoomDiscovery - hostileRooms invader-reservation marking", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any; FIND_HOSTILE_CREEPS?: number };
  let savedGame: unknown;
  let savedMemory: unknown;
  let savedFind: unknown;
  // Monotonic across tests: hostileRooms() memoizes per Game.time at module
  // level, so re-using a tick would replay the previous test's cached set.
  let time = 10_000;

  /** Advance the tick clock (defeats the per-tick memo) and read the set. */
  function observe(rooms: Record<string, any>): Set<string> {
    time += 1;
    g.Game = { time, rooms };
    return hostileRooms();
  }

  beforeEach(() => {
    savedGame = g.Game;
    savedMemory = g.Memory;
    savedFind = g.FIND_HOSTILE_CREEPS;
    g.FIND_HOSTILE_CREEPS = FIND_HOSTILE_CREEPS;
    g.Memory = { roomIntel: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
    g.FIND_HOSTILE_CREEPS = savedFind as number;
  });

  it("marks an invader-reserved room and stamps the reservation-bounded intel", () => {
    const set = observe({ E1N1: mockRoom("E1N1", { reservation: { username: "Invader", ticksToEnd: 4998 } }) });
    expect(set.has("E1N1"), "room is defunded while the Invader holds its controller").to.equal(true);
    expect(g.Memory.roomIntel.E1N1.invaderReservedUntil).to.equal(time + 4998);
  });

  it("does not mark a room we or another player reserve", () => {
    const set = observe({
      E1N1: mockRoom("E1N1", { reservation: { username: "shadymccoy", ticksToEnd: 3000 } }),
      E2N1: mockRoom("E2N1")
    });
    expect(set.has("E1N1")).to.equal(false);
    expect(set.has("E2N1")).to.equal(false);
    expect(g.Memory.roomIntel.E1N1?.invaderReservedUntil).to.equal(undefined);
  });

  it("persists the mark without vision until the reservation bound expires", () => {
    observe({ E1N1: mockRoom("E1N1", { reservation: { username: "Invader", ticksToEnd: 5 } }) });
    const until = g.Memory.roomIntel.E1N1.invaderReservedUntil as number;

    // Vision lost: the mark outlives the sighting...
    expect(observe({}).has("E1N1"), "mark persists blind inside the bound").to.equal(true);

    // ...until the reservation would have run out.
    time = until - 1; // next observe() bumps to `until`: bound reached
    expect(observe({}).has("E1N1"), "bound reached: funding resumes").to.equal(false);
  });

  it("lifts the mark early on a fresh sighting with the reservation gone", () => {
    observe({ E1N1: mockRoom("E1N1", { reservation: { username: "Invader", ticksToEnd: 4998 } }) });
    const set = observe({ E1N1: mockRoom("E1N1") }); // core died / reservation cleared
    expect(set.has("E1N1")).to.equal(false);
    expect(g.Memory.roomIntel.E1N1.invaderReservedUntil).to.equal(undefined);
  });

  it("a controller-less (highway) sighting neither crashes nor marks", () => {
    const room = mockRoom("E5N0");
    room.controller = undefined;
    expect(observe({ E5N0: room }).has("E5N0")).to.equal(false);
  });

  it("keeps the v1 hostile-creep marking, and both marks coexist in one room", () => {
    const set = observe({
      E1N1: mockRoom("E1N1", {
        hostiles: [{ ticksToLive: 200 }],
        reservation: { username: "Invader", ticksToEnd: 4998 }
      })
    });
    expect(set.has("E1N1")).to.equal(true);
    expect(g.Memory.roomIntel.E1N1.hostileUntil).to.equal(time + 200);
    expect(g.Memory.roomIntel.E1N1.invaderReservedUntil).to.equal(time + 4998);

    // The invaders die but the core still holds the controller: the creep
    // mark lifts on the all-clear sighting, the reservation mark holds.
    const after = observe({ E1N1: mockRoom("E1N1", { reservation: { username: "Invader", ticksToEnd: 4996 } }) });
    expect(after.has("E1N1"), "reservation alone keeps the room defunded").to.equal(true);
    expect(g.Memory.roomIntel.E1N1.hostileUntil).to.equal(undefined);
  });
});
