import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, Memory, FIND_SOURCES, FIND_MINERALS } from "../mock";
import { ScoutCorp } from "../../../src/corps/ScoutCorp";

/**
 * The ScoutCorp records room intel for EVERY room the bot has vision of - any
 * room in Game.rooms - not just rooms a scout creep is visiting. A remote room we
 * are already mining is visible (a creep is there), so its controller gets
 * recorded even without a dedicated scout; that is what lets the planner value its
 * source as reservable (3000) instead of leaving it at the unreserved 1500.
 */
function remoteRoom(name: string, opts: { reservation?: string; lastVisit?: number } = {}): any {
  return {
    name,
    controller: {
      level: 0,
      pos: { x: 10, y: 10 },
      owner: undefined,
      reservation: opts.reservation ? { username: opts.reservation } : undefined
    },
    find: (type: number) => {
      if (type === FIND_SOURCES) return [{ id: "src-live-1", pos: { x: 25, y: 25 } }];
      if (type === FIND_MINERALS) return [];
      return []; // hostiles etc.
    }
  };
}

describe("ScoutCorp intel from vision (not just scouts)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).FIND_HOSTILE_STRUCTURES = 110; // not in the base mock globals
    Game.creeps = {}; // no scout creeps anywhere
    Game.time = 1000;
    Game.getObjectById = () => ({ room: { name: "W0N0" } }); // the home spawn
    (Memory as any).roomIntel = {};
  });

  it("records a visible remote room's controller with no scout creep present", () => {
    Game.rooms = { W1N0: remoteRoom("W1N0") };
    new ScoutCorp("W0N0-scout", "spawn1").work(Game.time);

    const intel = (Memory as any).roomIntel!.W1N0 as any;
    expect(intel, "intel recorded for the visible room").to.exist;
    expect(intel.controllerPos).to.deep.equal({ x: 10, y: 10 });
    expect(intel.sourcePositions).to.deep.equal([{ x: 25, y: 25 }]);
    expect(intel.lastVisit).to.equal(Game.time);
  });

  it("records each source's REAL game id beside its position (stable identity for the intel fallback)", () => {
    // The node-resource refresh prefers these ids over positional `intel-...`
    // ids, so a source's flow id - and its harvest corp - survives losing
    // vision of the room (the duplicate-miner-after-an-invader incident).
    Game.rooms = { W1N0: remoteRoom("W1N0") };
    new ScoutCorp("W0N0-scout", "spawn1").work(Game.time);

    const intel = (Memory as any).roomIntel!.W1N0 as any;
    expect(intel.sourceIds, "ids aligned with sourcePositions").to.deep.equal(["src-live-1"]);
  });

  it("captures the controller reservation so the planner can see who holds it", () => {
    Game.rooms = { W1N0: remoteRoom("W1N0", { reservation: "me" }) };
    new ScoutCorp("W0N0-scout", "spawn1").work(Game.time);
    expect(((Memory as any).roomIntel!.W1N0 as any).controllerReservation).to.equal("me");
  });

  it("does not re-record a freshly-seen room every tick (throttled)", () => {
    // Pre-seed fresh intel with a sentinel; a throttled pass should leave it.
    (Memory as any).roomIntel!.W1N0 = { lastVisit: Game.time, sentinel: true } as any;
    Game.rooms = { W1N0: remoteRoom("W1N0") };
    new ScoutCorp("W0N0-scout", "spawn1").work(Game.time);
    expect(((Memory as any).roomIntel!.W1N0 as any).sentinel, "fresh intel left untouched").to.equal(true);
  });

  it("preserves the defund marks across a re-record (scout mark-wipe regression)", () => {
    // The marks belong to the hostileRooms() vision pass (spec 12). A stale
    // room's full re-record must carry them over - overwriting them lifted a
    // live defund early whenever vision dropped the same tick.
    Game.time = 10000;
    (Memory as any).roomIntel!.W1N0 = {
      lastVisit: 1000, // >= STALE_THRESHOLD stale, so the pass re-records
      hostileUntil: 10800,
      invaderReservedUntil: 14000
    } as any;
    Game.rooms = { W1N0: remoteRoom("W1N0") };
    new ScoutCorp("W0N0-scout", "spawn1").work(Game.time);

    const intel = (Memory as any).roomIntel!.W1N0 as any;
    expect(intel.lastVisit, "the room WAS re-recorded").to.equal(Game.time);
    expect(intel.hostileUntil, "creep mark survives the re-record").to.equal(10800);
    expect(intel.invaderReservedUntil, "reservation mark survives the re-record").to.equal(14000);
  });

  it("does not invent marks on a re-record of an unmarked room", () => {
    Game.time = 10000;
    (Memory as any).roomIntel!.W1N0 = { lastVisit: 1000 } as any;
    Game.rooms = { W1N0: remoteRoom("W1N0") };
    new ScoutCorp("W0N0-scout", "spawn1").work(Game.time);

    const intel = (Memory as any).roomIntel!.W1N0 as any;
    expect(intel.lastVisit).to.equal(Game.time);
    expect(intel.hostileUntil).to.equal(undefined);
    expect(intel.invaderReservedUntil).to.equal(undefined);
  });
});
