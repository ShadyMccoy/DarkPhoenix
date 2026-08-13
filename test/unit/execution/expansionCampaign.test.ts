/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * updateExpansionCampaign - the execution half of spec 06 (state machine over
 * Memory.expansion; places the founding spawn site once the room is owned).
 *
 * THE WEDGE THIS PINS (t72968647, the EZRO-squatter incident): the engine
 * counts ALL owners' spawns against a room's RCL structure limit, so a
 * foreign spawn in a freshly-claimed room (RCL 1 allows exactly one spawn)
 * makes createConstructionSite return ERR_RCL_NOT_ENOUGH forever. The
 * campaign treated that code as "controller not leveled yet, retry next
 * pass" and retried SILENTLY for 1,400+ ticks - no log, no stamp, the wedge
 * invisible until a production audit read the room objects. The occupied
 * slot must be NAMED (spec 14: when the cause is invisible, the fix is
 * FIRST a stamp); the coreBuster's eviction class does the muscle.
 */
import "../../../src/types/Memory";
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { updateExpansionCampaign } from "../../../src/execution/ExpansionCampaign";

const ROOM = "W43N21";

function install(): void {
  setupGlobals();
  const g = global as any;
  g.OK = 0;
  g.ERR_RCL_NOT_ENOUGH = -14;
  g.STRUCTURE_SPAWN = "spawn";
  g.FIND_MY_SPAWNS = 112;
  g.FIND_MY_CONSTRUCTION_SITES = 114;
  g.FIND_HOSTILE_STRUCTURES = 109;
  Game.time = 73_000_000;
  Game.rooms = {} as any;
  (Memory as any).expansion = {
    roomName: ROOM,
    nodeId: `${ROOM}-15-27`,
    spawnPos: { x: 15, y: 27, roomName: ROOM },
    sinceTick: Game.time - 100
  };
}

/** The claimed-but-spawnless campaign room, parameterized by the engine's verdict. */
function campaignRoom(opts: { createResult: number; hostileSpawns?: number }): any {
  return {
    name: ROOM,
    controller: { my: true, level: 1 },
    find: (type: number) => {
      if (type === (global as any).FIND_MY_SPAWNS) return [];
      if (type === (global as any).FIND_MY_CONSTRUCTION_SITES) return [];
      if (type === (global as any).FIND_HOSTILE_STRUCTURES) {
        return Array.from({ length: opts.hostileSpawns ?? 0 }, (_, i) => ({
          structureType: "spawn",
          pos: { x: 30 + i, y: 33, roomName: ROOM },
          hits: 5000
        }));
      }
      return [];
    },
    createConstructionSite: () => opts.createResult
  };
}

describe("updateExpansionCampaign - the occupied-slot stamp (EZRO-squatter wedge)", () => {
  let logs: string[];
  const origLog = console.log;

  beforeEach(() => {
    install();
    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
      origLog(...args); // tee - swallowing would eat mocha's own reporter lines
    };
  });

  afterEach(() => {
    console.log = origLog;
    delete (Memory as any).expansion;
  });

  it("NAMES the occupied slot when ERR_RCL_NOT_ENOUGH coincides with a hostile spawn (eviction required)", () => {
    (Game.rooms as any)[ROOM] = campaignRoom({ createResult: -14, hostileSpawns: 1 });

    updateExpansionCampaign([]);

    const stamp = logs.find(l => /occup/i.test(l) && l.includes(ROOM));
    expect(stamp, `the wedge must be named in the log (got: ${logs.join(" | ")})`).to.not.equal(undefined);
    expect((Memory as any).expansion, "the campaign holds - eviction un-wedges it").to.not.equal(undefined);
  });

  it("stays SILENT on ERR_RCL_NOT_ENOUGH with no hostile spawn (the genuinely-transient case)", () => {
    (Game.rooms as any)[ROOM] = campaignRoom({ createResult: -14 });

    updateExpansionCampaign([]);

    expect(
      logs.filter(l => l.includes("[Expansion]")),
      "no false alarms while the controller genuinely levels"
    ).to.have.length(0);
  });

  it("still places and logs the site on OK", () => {
    (Game.rooms as any)[ROOM] = campaignRoom({ createResult: 0 });

    updateExpansionCampaign([]);

    expect(logs.find(l => /founding spawn site placed/.test(l))).to.not.equal(undefined);
  });
});
