import { expect } from "chai";
import {
  declinedVerdictStands,
  evaluateRoadRoute,
  pavedRouteCostPerTick,
  paveScore,
  loadedTicksPerTile,
  roundTripTicksForRoute,
  REJUDGE_FLOW_FACTOR,
  ROAD_BUILD_COST,
  ROAD_DECAY_HITS,
  ROAD_HITS,
  SWAMP_ROAD_MULTIPLIER,
  UNMAINTAINED_ROAD_LIFE,
  WALL_ROAD_MULTIPLIER
} from "../../../src/economy/roadEconomics";
import { roundTripTicks } from "../../../src/economy/primitives";

/**
 * The road cost/benefit model. Hand-derived anchors:
 *
 * A plain 50-tile route hauling 10 e/t needs (10*102)/50 = 20.4 CARRY units.
 * Paving saves 0.5 MOVE per CARRY = 10.2 MOVE parts = 510 energy per
 * effective life (1450t) = ~0.352 e/t.
 *
 * Maintenance is TRAFFIC-DRIVEN: each creep step drains the decay timer by
 * its body-part count, and for a 2:1 road hauler fleet that works out to a
 * flat 3*flow/50 extra timer-ticks per tile per tick. At 10 e/t the timer
 * drains 1.6x wall-clock, so a plain tile loses 0.16 hits/t: 50 tiles
 * = 8 hits/t = 0.08 e/t * 1.5 overhead = 0.12 e/t. Net ~0.232 e/t; build
 * 15,000 -> payback ~64,700 ticks: a plain road pays only over a LONG horizon.
 *
 * The same route with 10 swamp tiles: unpaved MOVE/CARRY = (40*1+10*5)/50
 * = 1.8, so paving saves 1.3 MOVE/CARRY - ~2.6x the all-plain savings -
 * while build only rises 40%. Swamp converts dominate.
 */
describe("economy/roadEconomics", () => {
  it("constants match the game table: swamp 5x, wall 150x on cost/hits/decay", () => {
    // cost 300 / 1,500 / 45,000 ; hits 5,000 / 25,000 / 750,000 ;
    // decay 100 / 500 / 15,000 per 1,000 ticks
    expect(ROAD_BUILD_COST * SWAMP_ROAD_MULTIPLIER).to.equal(1_500);
    expect(ROAD_BUILD_COST * WALL_ROAD_MULTIPLIER).to.equal(45_000);
    expect(ROAD_HITS * SWAMP_ROAD_MULTIPLIER).to.equal(25_000);
    expect(ROAD_HITS * WALL_ROAD_MULTIPLIER).to.equal(750_000);
    expect(ROAD_DECAY_HITS * SWAMP_ROAD_MULTIPLIER).to.equal(500);
    expect(ROAD_DECAY_HITS * WALL_ROAD_MULTIPLIER).to.equal(15_000);
    // hits/decay = 50 intervals on every terrain: 50k ticks untrafficked
    expect(UNMAINTAINED_ROAD_LIFE).to.equal(50_000);
  });

  it("anchors: the all-plain 50-tile 10 e/t route", () => {
    const v = evaluateRoadRoute({ plainTiles: 50, swampTiles: 0, flow: 10 });
    expect(v.buildCost).to.equal(50 * ROAD_BUILD_COST);
    expect(v.bodySavingsPerTick).to.be.closeTo(0.352, 0.01);
    expect(v.maintenancePerTick).to.be.closeTo(0.12, 0.001);
    expect(v.netSavingsPerTick).to.be.greaterThan(0);
    expect(v.paybackTicks).to.be.closeTo(64_700, 3_000);
  });

  it("decay is traffic-driven: doubling flow raises maintenance, not just savings", () => {
    const at10 = evaluateRoadRoute({ plainTiles: 50, swampTiles: 0, flow: 10 });
    const at20 = evaluateRoadRoute({ plainTiles: 50, swampTiles: 0, flow: 20 });
    // timer drain 1.6 -> 2.2: maintenance rises 37.5%, sub-linearly in flow
    expect(at20.maintenancePerTick).to.be.closeTo(at10.maintenancePerTick * (2.2 / 1.6), 0.001);
    // savings are linear in flow, so busier routes still pay back FASTER
    expect(at20.paybackTicks).to.be.lessThan(at10.paybackTicks);
  });

  it("a long-horizon route paves; a short-horizon one does not", () => {
    const route = { plainTiles: 50, swampTiles: 0, flow: 10 };
    expect(evaluateRoadRoute(route, 100_000).worthPaving).to.equal(true);
    expect(evaluateRoadRoute(route, 6_000).worthPaving).to.equal(false);
  });

  it("swamp tiles flip a marginal route decisively positive", () => {
    const plain = evaluateRoadRoute({ plainTiles: 50, swampTiles: 0, flow: 10 });
    const swampy = evaluateRoadRoute({ plainTiles: 40, swampTiles: 10, flow: 10 });
    expect(swampy.bodySavingsPerTick).to.be.greaterThan(2 * plain.bodySavingsPerTick);
    expect(swampy.paybackTicks).to.be.lessThan(plain.paybackTicks);
    expect(swampy.buildCost).to.equal(40 * ROAD_BUILD_COST + 10 * ROAD_BUILD_COST * SWAMP_ROAD_MULTIPLIER);
  });

  it("low flow never pays: a trickle route is left unpaved", () => {
    const v = evaluateRoadRoute({ plainTiles: 50, swampTiles: 0, flow: 1 });
    // savings scale with flow; at 1 e/t they sit below maintenance
    expect(v.netSavingsPerTick).to.be.lessThan(0);
    expect(v.worthPaving).to.equal(false);
    expect(v.paybackTicks).to.equal(Infinity);
  });

  it("monetized spawn parts dominate: at 150 e/part payback drops ~65k -> ~12k", () => {
    // spawnPartValue = energyPerSpawnPart(10, 75) ~ 153: a d=75 remote is
    // waiting on spawn time. Freed parts: 10.2/1450 * 150 = 1.055 e/t -
    // 3x the direct body-energy savings.
    const v = evaluateRoadRoute({ plainTiles: 50, swampTiles: 0, flow: 10 }, undefined, 150);
    expect(v.netSavingsPerTick).to.be.closeTo(1.287, 0.01);
    expect(v.paybackTicks).to.be.closeTo(11_700, 500);
    // the unmonetized verdict is unchanged (slack-spawn regime)
    const slack = evaluateRoadRoute({ plainTiles: 50, swampTiles: 0, flow: 10 });
    expect(slack.paybackTicks).to.be.closeTo(64_700, 3_000);
  });

  it("a spawn-bound colony values even a trickle route positively", () => {
    const route = { plainTiles: 50, swampTiles: 0, flow: 1 };
    expect(evaluateRoadRoute(route).netSavingsPerTick).to.be.lessThan(0);
    expect(evaluateRoadRoute(route, undefined, 150).netSavingsPerTick).to.be.greaterThan(0);
  });

  it("frees spawn build-parts proportional to the MOVE parts saved", () => {
    const v = evaluateRoadRoute({ plainTiles: 50, swampTiles: 0, flow: 10 });
    // 10.2 MOVE parts per 1450-tick effective life
    expect(v.spawnPartsFreedPerTick).to.be.closeTo(10.2 / 1450, 0.0005);
  });

  it("tunnels claim no fatigue savings and never pave on their own merits", () => {
    // 2 wall tiles at 150x decay cost ~0.72 e/t upkeep at 10 e/t flow -
    // double the TOTAL savings of a 50-tile plain road.
    const v = evaluateRoadRoute({ plainTiles: 20, swampTiles: 0, wallTiles: 2, flow: 10 });
    expect(v.buildCost).to.equal(20 * ROAD_BUILD_COST + 2 * ROAD_BUILD_COST * WALL_ROAD_MULTIPLIER);
    expect(v.netSavingsPerTick).to.be.lessThan(0);
    expect(v.worthPaving).to.equal(false);
  });

  it("tunnel decisions compare routes: a big shortcut wins on recurring cost", () => {
    // 22-tile tunneled path vs 60-tile detour, both paved, 10 e/t.
    const tunneled = pavedRouteCostPerTick({ plainTiles: 20, swampTiles: 0, wallTiles: 2, flow: 10 });
    const detour = pavedRouteCostPerTick({ plainTiles: 60, swampTiles: 0, flow: 10 });
    expect(tunneled).to.be.closeTo(1.235, 0.01);
    expect(detour).to.be.closeTo(1.415, 0.01);
    expect(tunneled).to.be.lessThan(detour);
    // ...but the 78k build-cost delta repays at ~0.18 e/t: ~433k ticks.
    // Tunnels are end-game infrastructure, not remote-mining plumbing.
  });

  it("paveScore orders swampy high-flow routes first, rejects net-negative ones", () => {
    const swampyBusy = paveScore({ plainTiles: 30, swampTiles: 15, flow: 10 });
    const plainBusy = paveScore({ plainTiles: 45, swampTiles: 0, flow: 10 });
    const trickle = paveScore({ plainTiles: 45, swampTiles: 0, flow: 1 });
    expect(swampyBusy).to.be.greaterThan(plainBusy);
    expect(trickle).to.equal(-Infinity);
  });

  it("zero-length routes are inert", () => {
    const v = evaluateRoadRoute({ plainTiles: 0, swampTiles: 0, flow: 10 });
    expect(v.buildCost).to.equal(0);
    expect(v.worthPaving).to.equal(false);
  });
});

/**
 * Declined-verdict staleness (the remote-trunk fix, owner 2026-07-20): a
 * not-worth-paving verdict was PERMANENT, so a trunk judged at the
 * pre-reservation 5 e/t was never re-judged after reservation doubled the
 * source to 10 e/t - remote roads never got built. The verdict now records
 * its judged flow and stands only while live flow stays under 1.5x it.
 */
describe("economy/roadEconomics - declinedVerdictStands (re-judge on flow rise)", () => {
  it("stands at the judged flow and under modest jitter", () => {
    expect(declinedVerdictStands(10, 10)).to.equal(true);
    expect(declinedVerdictStands(10, 12)).to.equal(true);
    expect(declinedVerdictStands(10, 15)).to.equal(true); // exactly at the bar: stands
  });

  it("THE CANONICAL RISE: reservation's 5 -> 10 doubling voids the verdict", () => {
    expect(declinedVerdictStands(5, 10)).to.equal(false);
    expect(REJUDGE_FLOW_FACTOR).to.be.lessThan(2); // the doubling must clear the bar
  });

  it("falling or flat flow never re-judges (the cache keeps its purpose)", () => {
    expect(declinedVerdictStands(10, 5)).to.equal(true);
    expect(declinedVerdictStands(10, 0)).to.equal(true);
  });

  it("legacy entries (no recorded flow) earn one re-judge against any live flow", () => {
    expect(declinedVerdictStands(undefined, 5)).to.equal(false);
    expect(declinedVerdictStands(undefined, 0.001)).to.equal(false);
    // ...but a dead route (zero flow) stays settled even for legacy entries
    expect(declinedVerdictStands(undefined, 0)).to.equal(true);
  });
});

/**
 * Ticks, not tiles (owner directive 2026-07-19): a hauler's round trip is a
 * TIME, and a body whose MOVE complement no longer clears the terrain at full
 * speed crawls - so its round trip is LONGER than 2*tiles+2 even though the
 * tile distance is identical. Every anchor here is hand-derived from the
 * end-of-tick fatigue model: loaded ticks/tile = max(1, ceil(k*t/2)) for a
 * k=CARRY:MOVE body on terrain move-cost t (plain 2, road 1, swamp 10); an
 * EMPTY creep generates no fatigue and always moves 1 tile/tick.
 */
describe("economy/roadEconomics - ticks not tiles (hauler travel time)", () => {
  describe("loadedTicksPerTile", () => {
    it("1:1 clears road and plain at full speed, crawls on swamp (5x)", () => {
      expect(loadedTicksPerTile(1, 1)).to.equal(1); // road
      expect(loadedTicksPerTile(2, 1)).to.equal(1); // plain
      expect(loadedTicksPerTile(10, 1)).to.equal(5); // swamp
    });
    it("2:1 is full speed ONLY on road; half speed on plain, 10x on swamp", () => {
      expect(loadedTicksPerTile(1, 2)).to.equal(1); // road: the 2:1 body's home terrain
      expect(loadedTicksPerTile(2, 2)).to.equal(2); // plain: half speed (the partial-road penalty)
      expect(loadedTicksPerTile(10, 2)).to.equal(10); // swamp: a 2:1 hauler must not cross swamp
    });
  });

  describe("roundTripTicksForRoute", () => {
    it("a 1:1 body reproduces the tile-based round trip on plain/road (empty out, loaded back, +2)", () => {
      // 10 plain tiles, 1:1: loaded 10*1 + empty 10 + 2 = 22 == roundTripTicks(10)
      expect(roundTripTicksForRoute(0, 10, 0, 1)).to.equal(22);
      expect(roundTripTicksForRoute(0, 10, 0, 1)).to.equal(roundTripTicks(10));
      // all-road is identical for a 1:1 body (road and plain both clear at 1:1)
      expect(roundTripTicksForRoute(10, 0, 0, 1)).to.equal(22);
    });
    it("a 2:1 body on FULLY PAVED road matches the tile round trip (no penalty)", () => {
      // 20 road tiles, 2:1: loaded 20*1 + empty 20 + 2 = 42 == roundTripTicks(20)
      expect(roundTripTicksForRoute(20, 0, 0, 2)).to.equal(42);
      expect(roundTripTicksForRoute(20, 0, 0, 2)).to.equal(roundTripTicks(20));
    });
    it("a 2:1 body on UNPAVED plain crawls: the round trip is longer than 2*tiles+2", () => {
      // 10 plain tiles, 2:1: loaded 10*2=20 + empty 10 + 2 = 32 (vs 22 tile-based)
      expect(roundTripTicksForRoute(0, 10, 0, 2)).to.equal(32);
      expect(roundTripTicksForRoute(0, 10, 0, 2)).to.be.greaterThan(roundTripTicks(10));
    });
    it("PARTIAL roads land between: a 2:1 body over 5 road + 5 plain", () => {
      // loaded 5*1 + 5*2 = 15, empty 10, +2 = 27
      expect(roundTripTicksForRoute(5, 5, 0, 2)).to.equal(27);
    });
  });

});
