import { expect } from "chai";
import {
  evaluateRoadRoute,
  pavedRouteCostPerTick,
  paveScore,
  ROAD_BUILD_COST,
  ROAD_DECAY_HITS,
  ROAD_HITS,
  SWAMP_ROAD_MULTIPLIER,
  UNMAINTAINED_ROAD_LIFE,
  WALL_ROAD_MULTIPLIER
} from "../../../src/economy/roadEconomics";

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
