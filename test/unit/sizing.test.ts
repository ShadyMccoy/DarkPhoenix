import { assert } from "chai";
import { bodyCost } from "../../src/primitives";
import { carryPartsFor, haulerBody, minerBody, tenderBody, upgraderBody, workmanBody } from "../../src/sizing";

/**
 * The exhaustive suite on THE sizing module (law 5). Every body any kind
 * buys is derived here and nowhere else; these pins are the anti-thrash.
 * Named regressions ride along: #148's route law and the 24-CARRY hauler.
 */
describe("sizing", () => {
  it("sizes workman bodies: survival floor at 200, units of 250, cap at 5", () => {
    assert.isNull(workmanBody(199), "below the floor nothing is buyable");
    assert.deepEqual(workmanBody(200), { work: 1, carry: 1, move: 1 });
    assert.deepEqual(workmanBody(249), { work: 1, carry: 1, move: 1 });
    assert.deepEqual(workmanBody(250), { work: 1, carry: 1, move: 2 });
    assert.deepEqual(workmanBody(550), { work: 2, carry: 2, move: 4 });
    assert.deepEqual(workmanBody(9999), { work: 5, carry: 5, move: 10 }, "5-unit cap");
  });

  it("sizes miners: floor [1W,1M] at 150, WORK capped at saturation", () => {
    assert.isNull(minerBody(149));
    assert.deepEqual(minerBody(150), { work: 1, carry: 0, move: 1 });
    assert.deepEqual(minerBody(300), { work: 2, carry: 0, move: 1 });
    assert.deepEqual(minerBody(550), { work: 5, carry: 0, move: 1 });
    assert.deepEqual(minerBody(9999), { work: 5, carry: 0, move: 1 }, "a sixth WORK mines nothing");
  });

  it("sizes haulers: paired C+M, floor at 100, 25-pair part cap", () => {
    assert.isNull(haulerBody(99));
    assert.deepEqual(haulerBody(100), { work: 0, carry: 1, move: 1 });
    assert.deepEqual(haulerBody(550), { work: 0, carry: 5, move: 5 });
    assert.deepEqual(haulerBody(99999), { work: 0, carry: 25, move: 25 }, "50-part body limit");
  });

  it("sizes upgraders: floor [1W,1C,1M] at 200, WORK capped at the RCL8 throttle", () => {
    assert.isNull(upgraderBody(199));
    assert.deepEqual(upgraderBody(200), { work: 1, carry: 1, move: 1 });
    assert.deepEqual(upgraderBody(300), { work: 2, carry: 1, move: 1 });
    assert.deepEqual(upgraderBody(550), { work: 4, carry: 1, move: 1 });
    assert.deepEqual(upgraderBody(99999), { work: 15, carry: 1, move: 1 }, "no body outdrinks a controller");
  });

  it("sizes tenders: paired C+M, floor at 100, capped small — the estate is compact", () => {
    assert.isNull(tenderBody(99));
    assert.deepEqual(tenderBody(100), { work: 0, carry: 1, move: 1 });
    assert.deepEqual(tenderBody(9999), { work: 0, carry: 2, move: 2 });
  });

  it("every derived body fits its budget", () => {
    for (let budget = 100; budget <= 2000; budget += 50) {
      const bodies = [workmanBody(budget), minerBody(budget), haulerBody(budget), upgraderBody(budget), tenderBody(budget)];
      for (const body of bodies) {
        if (body) assert.isAtMost(bodyCost(body), budget, `budget ${budget}`);
      }
    }
  });

  it("pins #148's route law: CARRY from flow and round-trip distance", () => {
    assert.equal(carryPartsFor(10, 10), 4, "10 e/t over 10 tiles");
    assert.equal(carryPartsFor(10, 25), 10, "10 e/t over 25 tiles");
    // The X6 incident by name: a 1.7-CARRY route never justifies 24 CARRY.
    assert.equal(carryPartsFor(2, 21), 2);
  });
});
