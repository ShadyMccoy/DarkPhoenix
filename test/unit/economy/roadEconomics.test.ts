import { expect } from "chai";
import {
  evaluateRoadRoute,
  paveScore,
  ROAD_BUILD_COST,
  SWAMP_ROAD_MULTIPLIER
} from "../../../src/economy/roadEconomics";

/**
 * The road cost/benefit model. Hand-derived anchors:
 *
 * A plain 50-tile route hauling 10 e/t needs (10*102)/50 = 20.4 CARRY units.
 * Paving saves 0.5 MOVE per CARRY = 10.2 MOVE parts = 510 energy per
 * effective life (1450t) = ~0.352 e/t. Maintenance: 50 tiles * 0.001 e/t
 * * 1.5 overhead = 0.075 e/t. Net ~0.277 e/t; build 15,000 -> payback
 * ~54,000 ticks: a plain road pays only over a LONG horizon.
 *
 * The same route with 10 swamp tiles: unpaved MOVE/CARRY = (40*1+10*5)/50
 * = 1.8, so paving saves 1.3 MOVE/CARRY - ~2.6x the all-plain savings -
 * while build only rises 40%. Swamp converts dominate.
 */
describe("economy/roadEconomics", () => {
  it("anchors: the all-plain 50-tile 10 e/t route", () => {
    const v = evaluateRoadRoute({ plainTiles: 50, swampTiles: 0, flow: 10 });
    expect(v.buildCost).to.equal(50 * ROAD_BUILD_COST);
    expect(v.bodySavingsPerTick).to.be.closeTo(0.352, 0.01);
    expect(v.maintenancePerTick).to.be.closeTo(0.075, 0.001);
    expect(v.netSavingsPerTick).to.be.greaterThan(0);
    expect(v.paybackTicks).to.be.closeTo(54_000, 3_000);
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

  it("frees spawn build-parts proportional to the MOVE parts saved", () => {
    const v = evaluateRoadRoute({ plainTiles: 50, swampTiles: 0, flow: 10 });
    // 10.2 MOVE parts per 1450-tick effective life
    expect(v.spawnPartsFreedPerTick).to.be.closeTo(10.2 / 1450, 0.0005);
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
