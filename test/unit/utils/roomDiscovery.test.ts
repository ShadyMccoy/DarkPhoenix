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
import { hostileRooms, routeIsDangerous, routeRooms } from "../../../src/utils/RoomDiscovery";
import { rows } from "../../../src/telemetry/BlackBox";

const FIND_HOSTILE_CREEPS = 103;
const FIND_HOSTILE_STRUCTURES = 121;

/** A visible room with optional hostiles and an optional controller reservation. */
function mockRoom(
  name: string,
  opts: {
    hostiles?: Array<{ ticksToLive: number }>;
    reservation?: { username: string; ticksToEnd: number };
    hostileStructures?: Array<{ structureType: string }>;
  } = {}
): any {
  return {
    name,
    controller: { reservation: opts.reservation },
    find: (type: number) => {
      if (type === FIND_HOSTILE_CREEPS) return opts.hostiles ?? [];
      if (type === FIND_HOSTILE_STRUCTURES) return opts.hostileStructures ?? [];
      return [];
    }
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
    (globalThis as any).FIND_HOSTILE_STRUCTURES = FIND_HOSTILE_STRUCTURES;
    (globalThis as any).STRUCTURE_INVADER_CORE = "invaderCore";
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

describe("utils/RoomDiscovery - raid sighting resets the raid meter (spec 13)", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any; FIND_HOSTILE_CREEPS?: number };
  let savedGame: unknown;
  let savedMemory: unknown;
  let savedFind: unknown;
  let time = 60_000;

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
    (globalThis as any).FIND_HOSTILE_STRUCTURES = FIND_HOSTILE_STRUCTURES;
    (globalThis as any).STRUCTURE_INVADER_CORE = "invaderCore";
    g.Memory = { roomIntel: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
    g.FIND_HOSTILE_CREEPS = savedFind as number;
  });

  it("sighted INVADER creeps zero raidDebt and stamp lastRaidSeen", () => {
    g.Memory.roomIntel.W5N5 = { lastVisit: 1, raidDebt: 88_000 };
    observe({
      W5N5: mockRoom("W5N5", { hostiles: [{ ticksToLive: 1400, owner: { username: "Invader" } } as any] })
    });
    expect(g.Memory.roomIntel.W5N5.raidDebt).to.equal(0);
    expect(g.Memory.roomIntel.W5N5.lastRaidSeen).to.equal(g.Game.time);
  });

  it("a PLAYER's hostiles mark the room but do NOT touch the raid meter", () => {
    g.Memory.roomIntel.W5N5 = { lastVisit: 1, raidDebt: 88_000 };
    observe({
      W5N5: mockRoom("W5N5", { hostiles: [{ ticksToLive: 1400, owner: { username: "enemy" } } as any] })
    });
    expect(g.Memory.roomIntel.W5N5.raidDebt).to.equal(88_000);
    expect(g.Memory.roomIntel.W5N5.lastRaidSeen).to.equal(undefined);
    expect(typeof g.Memory.roomIntel.W5N5.hostileUntil).to.equal("number");
  });
});

describe("utils/RoomDiscovery - transit embargo helpers (spec 13 phase 2b)", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any; FIND_HOSTILE_CREEPS?: number };
  let savedGame: unknown;
  let savedMemory: unknown;
  let savedFind: unknown;
  let time = 70_000;

  beforeEach(() => {
    savedGame = g.Game;
    savedMemory = g.Memory;
    savedFind = g.FIND_HOSTILE_CREEPS;
    g.FIND_HOSTILE_CREEPS = FIND_HOSTILE_CREEPS;
    (globalThis as any).FIND_HOSTILE_STRUCTURES = FIND_HOSTILE_STRUCTURES;
    (globalThis as any).STRUCTURE_INVADER_CORE = "invaderCore";
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
    g.FIND_HOSTILE_CREEPS = savedFind as number;
  });

  function gameWith(marks: Record<string, number>, route: Array<{ room: string }>): void {
    time += 1;
    const roomIntel: Record<string, any> = {};
    for (const room of Object.keys(marks)) {
      roomIntel[room] = { lastVisit: 1, hostileUntil: marks[room] };
    }
    g.Memory = { roomIntel };
    g.Game = {
      time,
      rooms: {}, // no vision anywhere: marks persist blind
      map: { findRoute: () => route }
    };
  }

  it("routeRooms includes both endpoints and every findRoute step", () => {
    gameWith({}, [{ room: "W1N1" }, { room: "W2N1" }]);
    expect(routeRooms("W0N1", "W2N1")).to.deep.equal(["W0N1", "W1N1", "W2N1"]);
  });

  it("a hostile TRANSIT room makes the whole route dangerous", () => {
    gameWith({ W1N1: time + 500 }, [{ room: "W1N1" }, { room: "W2N1" }]);
    expect(routeIsDangerous("W0N1", "W2N1"), "middle room is marked").to.equal(true);
  });

  it("a clear route is not dangerous, and no-marks short-circuits", () => {
    gameWith({}, [{ room: "W1N1" }, { room: "W2N1" }]);
    expect(routeIsDangerous("W0N1", "W2N1")).to.equal(false);
  });

  it("degrades to endpoints-only when the map router is unavailable (harness)", () => {
    time += 1;
    g.Memory = { roomIntel: { W1N1: { lastVisit: 1, hostileUntil: time + 500 } } };
    g.Game = { time, rooms: {} }; // no Game.map at all
    expect(routeRooms("W0N1", "W2N1")).to.deep.equal(["W0N1", "W2N1"]);
    expect(routeIsDangerous("W0N1", "W2N1"), "unseen transit room cannot be checked").to.equal(false);
    expect(routeIsDangerous("W1N1", "W2N1"), "endpoint marks still bite").to.equal(true);
  });
});

describe("utils/RoomDiscovery - invader-core sighting splits the occupation phases (spec 13 ph4)", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any; FIND_HOSTILE_CREEPS?: number };
  let savedGame: unknown;
  let savedMemory: unknown;
  let savedFind: unknown;
  let time = 80_000;

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
    (globalThis as any).FIND_HOSTILE_STRUCTURES = FIND_HOSTILE_STRUCTURES;
    (globalThis as any).STRUCTURE_INVADER_CORE = "invaderCore";
    g.Memory = { roomIntel: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
    g.FIND_HOSTILE_CREEPS = savedFind as number;
  });

  it("stamps invaderCorePresent=true when the core is in sight beside the reservation", () => {
    observe({
      W6N6: mockRoom("W6N6", {
        reservation: { username: "Invader", ticksToEnd: 4000 },
        hostileStructures: [{ structureType: "invaderCore" }]
      })
    });
    expect(g.Memory.roomIntel.W6N6.invaderCorePresent).to.equal(true);
  });

  it("stamps invaderCorePresent=false when the reservation stands but the core is gone (strip phase)", () => {
    observe({
      W6N6: mockRoom("W6N6", { reservation: { username: "Invader", ticksToEnd: 4000 } })
    });
    expect(g.Memory.roomIntel.W6N6.invaderCorePresent).to.equal(false);
  });

  it("clears the core flag together with the reservation mark on all-clear", () => {
    g.Memory.roomIntel.W6N6 = {
      lastVisit: 1,
      invaderReservedUntil: time + 4000,
      invaderCorePresent: true
    };
    observe({ W6N6: mockRoom("W6N6", {}) }); // fresh sighting: reservation gone
    expect(g.Memory.roomIntel.W6N6.invaderReservedUntil).to.equal(undefined);
    expect(g.Memory.roomIntel.W6N6.invaderCorePresent).to.equal(undefined);
  });
});

describe("utils/RoomDiscovery - flight-recorder rows for defense state (spec 13 ph5)", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any; FIND_HOSTILE_CREEPS?: number };
  let savedGame: unknown;
  let savedMemory: unknown;
  let savedFind: unknown;
  let time = 90_000;

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
    (globalThis as any).FIND_HOSTILE_STRUCTURES = FIND_HOSTILE_STRUCTURES;
    (globalThis as any).STRUCTURE_INVADER_CORE = "invaderCore";
    g.Memory = { roomIntel: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
    g.FIND_HOSTILE_CREEPS = savedFind as number;
  });

  // The ring has no reset - unique room names isolate these assertions.
  it("records one mark row per fresh mark, one unmark on the early lift", () => {
    observe({ W7N1: mockRoom("W7N1", { hostiles: [{ ticksToLive: 500 } as any] }) });
    observe({ W7N1: mockRoom("W7N1", { hostiles: [{ ticksToLive: 499 } as any] }) }); // re-stamp: no new row
    observe({ W7N1: mockRoom("W7N1", {}) }); // all-clear lift

    const marks = rows().filter(r => r.k === "mark" && r.d.room === "W7N1");
    const unmarks = rows().filter(r => r.k === "unmark" && r.d.room === "W7N1");
    expect(marks).to.have.length(1);
    expect(marks[0].d.kind).to.equal("creeps");
    expect(unmarks).to.have.length(1);
  });

  it("records one raid row per raid, not per tick of visibility", () => {
    g.Memory.roomIntel.W7N2 = { lastVisit: 1, raidDebt: 71_000 };
    const invader = { ticksToLive: 1400, owner: { username: "Invader" } } as any;
    observe({ W7N2: mockRoom("W7N2", { hostiles: [invader] }) });
    observe({ W7N2: mockRoom("W7N2", { hostiles: [invader] }) });
    observe({ W7N2: mockRoom("W7N2", { hostiles: [invader] }) });

    const raids = rows().filter(r => r.k === "raid" && r.d.room === "W7N2");
    expect(raids).to.have.length(1);
    expect(raids[0].d.debt, "the meter reading at reset (calibration data)").to.equal(71_000);
  });
});
