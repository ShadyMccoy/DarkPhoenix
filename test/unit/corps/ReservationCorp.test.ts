import { expect } from "chai";
import "../../../src/types/Memory";
import { Game as MockGame } from "../mock";
import { buildReserverBody } from "../../../src/spawn/BodyBuilder";
import { ReservationCorp } from "../../../src/corps/ReservationCorp";

/**
 * Reservation is the one genuinely room-specific part of remote mining: holding a
 * remote controller lifts its sources from 1500 back to the full 3000. These
 * scenarios pin down (a) the reserver body math and (b) the corp's trigger - it
 * asks for a reserver exactly when one of our miners is working in an unowned,
 * controllered room within range, and stops once that room is covered.
 */

describe("buildReserverBody", () => {
  it("builds nothing when a CLAIM (600) is unaffordable", () => {
    expect(buildReserverBody(300).body).to.have.length(0);
    expect(buildReserverBody(300).cost).to.equal(0);
  });

  it("builds one CLAIM+MOVE pair at low-but-sufficient capacity", () => {
    const r = buildReserverBody(650);
    expect(r.claimParts).to.equal(1);
    expect(r.body).to.deep.equal([CLAIM, MOVE]);
    expect(r.cost).to.equal(650);
  });

  it("scales to maxClaim and no further", () => {
    expect(buildReserverBody(2000, 2).claimParts).to.equal(2); // capped at maxClaim
    expect(buildReserverBody(2000, 2).body).to.deep.equal([CLAIM, CLAIM, MOVE, MOVE]);
    expect(buildReserverBody(900, 2).claimParts).to.equal(1); // only one pair affordable
  });
});

/** A fake miner working in a room with the given controller state. */
function minerIn(roomName: string, controller: unknown): unknown {
  return { memory: { workType: "harvest" }, room: { name: roomName, controller } };
}

/** Stub Game with a home spawn, a fleet, and a fixed inter-room distance. */
function setWorld(creeps: Record<string, unknown>, distance = 1): void {
  const spawn = { id: "spawn1", room: { name: "W0N0" }, owner: { username: "me" } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).Game = {
    ...MockGame,
    creeps,
    time: 100,
    getObjectById: (id: string) => (id === "spawn1" ? spawn : null),
    map: { ...MockGame.map, getRoomLinearDistance: () => distance },
  };
}

function corp(): ReservationCorp {
  return new ReservationCorp("W0N0-reservation", "spawn1");
}

const ctx = { energyCapacity: 800, tick: 100 };

describe("ReservationCorp demand (reserve rooms we mine)", () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game = { ...MockGame, creeps: {}, time: 100 };
  });

  it("requests a reserver when a miner works an unowned, controllered room", () => {
    setWorld({ m1: minerIn("W1N0", { my: false, owner: undefined, reservation: undefined }) });
    const demand = corp().getSpawnDemand(ctx);
    expect(demand).to.have.length(1);
    expect(demand[0]).to.include({ role: "reserver", producesIncome: true });
  });

  it("does not reserve our own room, or rooms owned/reserved by others", () => {
    setWorld({
      home: minerIn("W0N0", { my: true }), // our room - no reservation needed
      enemy: minerIn("W2N0", { my: false, owner: { username: "rival" } }), // owned by another
      taken: minerIn("W3N0", { my: false, reservation: { username: "rival" } }), // reserved by another
    });
    expect(corp().getSpawnDemand(ctx)).to.have.length(0);
  });

  it("does not reserve a Source-Keeper / controller-less room", () => {
    setWorld({ m1: minerIn("W5N5", null) });
    expect(corp().getSpawnDemand(ctx)).to.have.length(0);
  });

  it("stops requesting once a reserver already covers the room", () => {
    const c = corp();
    setWorld({
      m1: minerIn("W1N0", { my: false, owner: undefined, reservation: undefined }),
      r1: { memory: { corpId: c.id, workType: "reserve", targetRoom: "W1N0" }, spawning: false },
    });
    expect(c.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("asks for nothing when no miner is working a remote room", () => {
    setWorld({ home: minerIn("W0N0", { my: true }) });
    expect(corp().getSpawnDemand(ctx)).to.have.length(0);
  });
});
