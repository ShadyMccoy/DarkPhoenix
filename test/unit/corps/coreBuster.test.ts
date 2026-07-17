/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * CoreBusterCorp (spec 13 phase 4): kill the invader core, then strip the
 * leftover reservation. Mission targets come from the intel marks alone; the
 * payback gate skips occupations about to lapse; the core-present sighting
 * splits the two phases; rooms without known sources are never a mission
 * (that guard keeps the spec-12 phase-1 world - reservation staged blind,
 * partial intel - military-free, as its cell asserts).
 */
import "../../../src/types/Memory";
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { CoreBusterCorp } from "../../../src/corps/CoreBusterCorp";
import { CORE_BUSTER_MIN_REMAINING } from "../../../src/economy/primitives";

const HOME = "W1N1";
const REMOTE = "W1N2";

function install(): void {
  setupGlobals();
  (Game as any).map = {
    getRoomTerrain: () => ({ get: () => 0 }),
    getRoomLinearDistance: (a: string, b: string) => (a === b ? 0 : 1)
  };
  const g = global as any;
  g.ATTACK = "attack";
  g.MOVE = "move";
  g.CLAIM = "claim";
  Game.time = 80_000;
  Game.creeps = {};
  Game.rooms = {};
  (Memory as any).roomIntel = {};
  Game.getObjectById = (id: string) =>
    id === "spawn1"
      ? ({
          id: "spawn1",
          pos: { x: 25, y: 25, roomName: HOME },
          owner: { username: "me" },
          room: { name: HOME, controller: { my: true, level: 3 } }
        } as any)
      : null;
}

function occupiedIntel(opts: { remaining?: number; corePresent?: boolean; sourceCount?: number } = {}): any {
  return {
    lastVisit: 1,
    sourceCount: opts.sourceCount ?? 1,
    invaderReservedUntil: Game.time + (opts.remaining ?? 4000),
    ...(opts.corePresent === undefined ? {} : { invaderCorePresent: opts.corePresent })
  };
}

const ctx = { energyCapacity: 1300, tick: 80_000 } as any;

describe("CoreBusterCorp mission targets and demand (spec 13 phase 4)", () => {
  beforeEach(install);

  it("KILL phase: a sighted core on an occupied, sourced room demands a buster", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: true });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.missionTargets(HOME)).to.deep.equal({ attack: [REMOTE], strike: [] });

    const demands = corp.getSpawnDemand(ctx);
    expect(demands).to.have.length(1);
    expect(demands[0].role).to.equal("buster");
    expect(demands[0].desiredCost).to.equal(1300); // 10x(ATTACK+MOVE)
    expect(demands[0].blocking, "an occupation is a siege, not a kill window").to.equal(false);
    expect(demands[0].producesIncome, "restores a zeroed income stream").to.equal(true);
    expect(demands[0].holdToFund).to.equal(true);
    expect(demands[0].value, "ladder: miners 100 < buster 104 < guard 105 < reserver 115").to.equal(104);
  });

  it("STRIP phase: core sighted GONE flips the mission to a CLAIM striker", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: false });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.missionTargets(HOME)).to.deep.equal({ attack: [], strike: [REMOTE] });

    const demands = corp.getSpawnDemand(ctx);
    expect(demands).to.have.length(1);
    expect(demands[0].role).to.equal("striker");
    expect(demands[0].minCost, "CLAIM 600 floor is indivisible").to.equal(650);
    expect(demands[0].desiredCost).to.equal(1300); // 2x(CLAIM+MOVE)
  });

  it("an unsighted core (mark stamped blind) defaults to the striker phase", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel(); // no invaderCorePresent field
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.missionTargets(HOME).strike).to.deep.equal([REMOTE]);
  });

  it("payback gate: an occupation about to lapse is not worth a body", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ remaining: CORE_BUSTER_MIN_REMAINING - 1, corePresent: true });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.missionTargets(HOME)).to.deep.equal({ attack: [], strike: [] });

    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ remaining: CORE_BUSTER_MIN_REMAINING, corePresent: true });
    expect(corp.missionTargets(HOME).attack).to.deep.equal([REMOTE]);
  });

  it("no mission for a room with no known sources (the spec-12 phase-1 partial-intel world)", () => {
    // hostileRooms() creates PARTIAL intel {lastVisit, invaderReservedUntil}
    // for rooms marked blind - no sourceCount means no income to restore and
    // no mission, which keeps the def-t5 flight cell military-free.
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, invaderReservedUntil: Game.time + 5000 };
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.missionTargets(HOME)).to.deep.equal({ attack: [], strike: [] });
  });

  it("covered targets emit no duplicate demand", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: true });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    (Game.creeps as any).b1 = {
      name: "b1",
      spawning: false,
      memory: { corpId: corp.id, workType: "buster", targetRoom: REMOTE },
      room: { name: REMOTE }
    };
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("striker demand waits until a CLAIM body is affordable", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: false });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.getSpawnDemand({ energyCapacity: 600, tick: Game.time } as any)).to.have.length(0);
  });
});
