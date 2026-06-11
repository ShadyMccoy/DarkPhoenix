import { expect } from "chai";
import {
  reserverTollPerRoom,
  reserveRoomWorthIt,
  CLAIM_LIFETIME,
  RESERVER_BODY_COST
} from "../../../src/corps/economics";

/**
 * Reserving a remote room: a per-room cost (one reserver covers all the room's
 * sources, runs at ~50% duty, lives only 600 ticks) weighed against the +5 e/tick
 * each source gains going from the unreserved 1500 cap to the reserved 3000. The
 * decision falls out of the numbers - no RCL gate, just affordability and distance.
 */
describe("reserver economics", () => {
  it("is unaffordable below RCL 3 (can't build a 650 reserver body)", () => {
    // RCL2 capacity is 550 < 650, so no reserver can be built - toll is Infinity and
    // reserving never wins, with no explicit RCL check.
    expect(RESERVER_BODY_COST).to.equal(650);
    expect(reserverTollPerRoom(550, 30)).to.equal(Infinity);
    expect(reserveRoomWorthIt(550, 30, 2)).to.equal(false);
    // RCL3 (800) can afford it.
    expect(reserverTollPerRoom(800, 30)).to.be.lessThan(Infinity);
  });

  it("the toll rises with distance (short CLAIM life eaten by the walk)", () => {
    const near = reserverTollPerRoom(1300, 25);
    const far = reserverTollPerRoom(1300, 200);
    expect(far).to.be.greaterThan(near);
    // A reserver that has to walk most of its 600-tick life is very expensive.
    expect(reserverTollPerRoom(1300, CLAIM_LIFETIME - 10)).to.be.greaterThan(far);
  });

  it("is worth it for any VIABLE remote distance, even a single source", () => {
    // The toll (~0.9 e/tick at typical distances, after the ~50% duty cycle) is
    // small next to the +5 e/tick each source gains, so once a spawn can afford a
    // reserver every remote you'd actually mine is worth reserving - matching real
    // play, where remotes are essentially always reserved.
    for (const d of [25, 50, 100, 150]) {
      expect(reserveRoomWorthIt(800, d, 1), `d=${d}, 1 source should reserve`).to.equal(true);
    }
  });

  it("two sources amortize the reserver, so they reserve farther than one", () => {
    // The per-room reserver is shared, so its per-source cost halves. The crossover
    // where one source no longer justifies the toll but two still do sits far out
    // (the toll only approaches 5-10 e/tick as the walk eats the 600-tick CLAIM
    // life) - but it exists, which is the amortization at work.
    let crossover = -1;
    for (let d = 25; d <= 580; d += 5) {
      if (!reserveRoomWorthIt(1300, d, 1) && reserveRoomWorthIt(1300, d, 2)) {
        crossover = d;
        break;
      }
    }
    expect(crossover, "a band where 2 sources reserve but 1 does not").to.be.greaterThan(0);
  });

  it("stops reserving when the room is absurdly far (toll exceeds the gain)", () => {
    // Near the CLAIM lifetime the reserver spends almost all its life walking, so
    // the toll exceeds even two sources' +10 - reserving loses outright.
    expect(reserveRoomWorthIt(1300, CLAIM_LIFETIME - 20, 2)).to.equal(false);
  });
});
