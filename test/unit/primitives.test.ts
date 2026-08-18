import { assert } from "chai";
import {
  PART_COST,
  SOURCE_RATE,
  SOURCE_SATURATION_WORK,
  bodyCost,
  bodyList,
  workmanBody,
  workmanCycleRate,
  workmenPerSource
} from "../../src/primitives";

/**
 * Pins on the ported engine facts and the body/cycle math. These are the
 * numbers the planner prices with — if the engine ever disagrees, the
 * engine wins and these pins move WITH a fidelity-line measurement.
 */
describe("primitives", () => {
  it("pins the engine constants v1 verified", () => {
    assert.equal(SOURCE_RATE, 10, "3000 energy / 300 ticks");
    assert.equal(SOURCE_SATURATION_WORK, 5, "5 WORK on-site drains a source");
    assert.deepEqual(PART_COST, { work: 100, carry: 50, move: 50 });
  });

  it("sizes workman bodies: survival floor at 200, units of 250, cap at 5", () => {
    assert.isNull(workmanBody(199), "below the floor nothing is buyable");
    assert.deepEqual(workmanBody(200), { work: 1, carry: 1, move: 1 });
    assert.deepEqual(workmanBody(249), { work: 1, carry: 1, move: 1 });
    assert.deepEqual(workmanBody(250), { work: 1, carry: 1, move: 2 });
    assert.deepEqual(workmanBody(550), { work: 2, carry: 2, move: 4 });
    assert.deepEqual(workmanBody(9999), { work: 5, carry: 5, move: 10 }, "5-unit cap");
  });

  it("prices bodies and lists parts", () => {
    const unit = { work: 1, carry: 1, move: 2 };
    assert.equal(bodyCost(unit), 250);
    assert.equal(bodyCost({ work: 2, carry: 2, move: 4 }), 500);
    assert.deepEqual(bodyList(unit), ["work", "carry", "move", "move"]);
  });

  it("models the workman cycle: fill + walk out + unload + walk back", () => {
    // 1 unit, distance 10: fill 50/2=25t, cycle 25+20+1=46t, 50e delivered.
    assert.closeTo(workmanCycleRate({ work: 1, carry: 1, move: 2 }, 10), 50 / 46, 1e-9);
  });

  it("staffs a source by effective on-site WORK, clamped to standing room", () => {
    // 1-unit workman at distance 10 has 25/46 harvest duty -> 0.54 eff WORK;
    // saturating wants 10 bodies, the 3 standing spots clamp it.
    assert.equal(workmenPerSource({ work: 1, carry: 1, move: 2 }, 10, 3), 3);
    // A 5-unit body close in saturates with the spots to spare.
    assert.equal(workmenPerSource({ work: 5, carry: 5, move: 10 }, 2, 5), 2);
    assert.equal(workmenPerSource({ work: 1, carry: 1, move: 2 }, 10, 1), 1, "never zero");
  });
});
