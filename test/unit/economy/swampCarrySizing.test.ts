import { expect } from "chai";
import { effectiveOneWayTiles, loadedTicksPerTile } from "../../../src/economy/roadEconomics";
import { carryPartsFor } from "../../../src/economy/primitives";

/**
 * TICKS, NOT TILES (owner 2026-08-02: "we definitely need to include swamps in
 * the estimate. It's supposed to translate a route into ticks so accounting for
 * swamps, move ratio, carry fill and roads is essential").
 *
 * CARRY sizing is `rate * roundTrip / CARRY_CAPACITY` - a function of TIME. The
 * round trip was a tile count, which is only the same thing when a loaded body
 * clears every tile at 1 tick. The engine's rules:
 *
 *   fatigue on moving  = terrainCost * (non-MOVE parts carrying weight)
 *   terrainCost        = road 1, plain 2, swamp 10
 *   recovery per tick  = 2 * MOVE parts
 *   an EMPTY CARRY part weighs NOTHING - the outbound leg is always 1 tick/tile
 *
 * So the loaded rate depends only on the RATIO (carry per move), not the body
 * size - which is what makes this sizeable without circularity.
 */
describe("route -> ticks (swamp, move ratio, carry fill, roads)", () => {
  describe("loadedTicksPerTile is the engine's fatigue rule", () => {
    it("1:1 body: 1 tick on road and plain, FIVE on swamp", () => {
      expect(loadedTicksPerTile(1, 1), "road").to.equal(1);
      expect(loadedTicksPerTile(2, 1), "plain").to.equal(1);
      expect(loadedTicksPerTile(10, 1), "swamp").to.equal(5);
    });

    it("2:1 road body: 1 on road, but HALF SPEED on plain and 10x on swamp", () => {
      expect(loadedTicksPerTile(1, 2), "road").to.equal(1);
      expect(loadedTicksPerTile(2, 2), "plain").to.equal(2);
      expect(loadedTicksPerTile(10, 2), "swamp").to.equal(10);
    });

    it("1:2 body buys speed over swamp with MOVE parts", () => {
      expect(loadedTicksPerTile(10, 0.5), "swamp at 1 CARRY per 2 MOVE").to.equal(3);
    });
  });

  describe("effectiveOneWayTiles", () => {
    it("is UNCHANGED on a swamp-free unpaved route with a 1:1 body", () => {
      // The regression guard: everything already shipped must price identically.
      // 20 tiles out at 1, 20 back at 1 => 20 effective one-way.
      expect(effectiveOneWayTiles(20, 0, 1, 0)).to.equal(20);
      expect(effectiveOneWayTiles(20, 0, 1)).to.equal(20); // default swamp 0
    });

    it("charges an all-swamp unpaved route THREE times a plain one", () => {
      // empty out 20 @1 = 20; loaded back 20 @5 = 100; (20+100)/2 = 60.
      expect(effectiveOneWayTiles(20, 0, 1, 1)).to.equal(60);
      expect(effectiveOneWayTiles(20, 0, 1, 1) / effectiveOneWayTiles(20, 0, 1, 0)).to.equal(3);
    });

    it("scales with the swamp SHARE, not just its presence", () => {
      const clean = effectiveOneWayTiles(20, 0, 1, 0);
      const half = effectiveOneWayTiles(20, 0, 1, 0.5);
      const full = effectiveOneWayTiles(20, 0, 1, 1);
      expect(half).to.be.greaterThan(clean);
      expect(half).to.be.lessThan(full);
      expect(half).to.equal((clean + full) / 2); // linear in the share
    });

    it("PAVING neutralises swamp - a road costs 1 whatever lies beneath it", () => {
      // Fully paved, 2:1 body: 20 out + 20 back = 20 effective, swamp or not.
      expect(effectiveOneWayTiles(20, 1, 2, 1)).to.equal(20);
      expect(effectiveOneWayTiles(20, 1, 2, 1)).to.equal(effectiveOneWayTiles(20, 1, 2, 0));
    });

    it("prices swamp only on the UNPAVED remainder of a part-built road", () => {
      // Half paved, all-swamp underneath, 1:1 body:
      //   10 paved back @1 = 10; 10 swamp back @5 = 50; out 20 @1 = 20 => 40.
      expect(effectiveOneWayTiles(20, 0.5, 1, 1)).to.equal(40);
    });
  });

  describe("what it costs the plan", () => {
    it("an all-swamp remote needs 3x the CARRY the tile count implies", () => {
      const tiles = 40;
      const rate = 10;
      const naive = carryPartsFor(rate, tiles);
      const real = carryPartsFor(rate, effectiveOneWayTiles(tiles, 0, 1, 1));
      expect(real / naive).to.be.closeTo(3, 0.05);
      // Concretely: a 10 e/t source 40 tiles out over swamp is sized at ~16.4
      // CARRY by the tile count and actually needs ~48.
      expect(naive).to.be.closeTo(16.4, 0.1);
      expect(real).to.be.closeTo(48.4, 0.2);
    });
  });
});

/**
 * THE LANDING QUANTUM (spec 45 leg 3, owner-directed 2026-08-05).
 *
 * A deposit-route hauler unloads into a LINK PORT, and a link holds
 * LINK_CAPACITY (800) - one arrival is one unload intent, given port room.
 * Measured t72787778: deposit-route bodies carried 978-1,851e into an 800-cap
 * port, so each trip stood through 2-3 volley cycles waiting for the port to
 * clear. The oversize body does not move more energy; it converts its own
 * surplus CARRY into standing time at the port, which is exactly the atSink
 * idle the drop-off is blamed for.
 *
 * Match the actuator to the quantum it serves - the worthABody doctrine's
 * cousin. The cap reuses `volleyServiceCarry()` (LINK_PAYLOAD_CARRY
 * = 16), the SAME primitive the feeder's volley-service floor reads, so the
 * unloading side and the draining side cannot drift apart.
 *
 * WALKING routes are untouched: they unload into storage, which has no
 * quantum, and their bodies are sized by the route's own round trip.
 */
describe("deposit-route body cap: the landing quantum (spec 45 leg 3)", () => {
  // LINK_PAYLOAD_CARRY, not volleyServiceCarry: the two split 2026-08-07 when
  // the core shuttle was resized to 4/sender. This cap is about what fits in a
  // LINK per arrival (16) and is unaffected by how big the shuttle needs to be.
  const { depositRouteCarryCap, LINK_PAYLOAD_CARRY } = require("../../../src/economy/primitives") as typeof import("../../../src/economy/primitives");

  it("caps a deposit route at ONE full volley of CARRY", () => {
    // The live shape: a 37-CARRY body (1,851e) on a port route.
    expect(depositRouteCarryCap(37, true)).to.equal(LINK_PAYLOAD_CARRY);
    expect(depositRouteCarryCap(37, true)).to.equal(16);
  });

  it("leaves a WALKING route alone (storage has no quantum)", () => {
    expect(depositRouteCarryCap(37, false)).to.equal(37);
  });

  it("never inflates a body that is already under the quantum", () => {
    expect(depositRouteCarryCap(6, true)).to.equal(6);
    expect(depositRouteCarryCap(16, true)).to.equal(16);
  });

  it("reads the SAME primitive as the feeder's volley-service floor (one home, no drift)", () => {
    // If one side is ever retuned the other follows by construction - the
    // unloading quantum and the draining quantum are the same physical fact.
    expect(depositRouteCarryCap(99, true)).to.equal(LINK_PAYLOAD_CARRY);
  });
});
