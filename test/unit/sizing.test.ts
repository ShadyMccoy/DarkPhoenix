import { assert } from "chai";
import { bodyCost } from "../../src/primitives";
import {
  builderBody,
  carryPartsFor,
  haulerBody,
  haulerBodyFor,
  hubServiceBody,
  minerBody,
  portTenderBody,
  tenderBody,
  upgraderBody,
  workmanBody
} from "../../src/sizing";

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

  it("sizes haulers to route AND flow: the 24-CARRY body on a sliver route dies here", () => {
    // #148's law applied at the body, not just the fleet: the pairs a
    // flow needs over a round trip, capped by budget and the part limit.
    assert.deepEqual(haulerBodyFor(10, 10, 550), { work: 0, carry: 4, move: 4 }, "4 CARRY moves 10 e/t over 10 tiles");
    assert.deepEqual(haulerBodyFor(2, 5, 550), { work: 0, carry: 1, move: 1 }, "a sliver flow buys the floor body");
    assert.deepEqual(haulerBodyFor(10, 25, 550), { work: 0, carry: 5, move: 5 }, "budget caps what the route wants");
    assert.deepEqual(haulerBodyFor(100, 30, 99999), { work: 0, carry: 25, move: 25 }, "50-part body limit");
    assert.isNull(haulerBodyFor(10, 10, 99), "below the pair floor nothing is buyable");
    assert.isNull(haulerBodyFor(0, 10, 550), "no flow, no body");
  });

  it("reprices the roaded gait: 2C per MOVE, 75e per CARRY against 100 unpaved", () => {
    assert.deepEqual(haulerBodyFor(10, 10, 550, true), { work: 0, carry: 4, move: 2 }, "same 4 CARRY, half the MOVE");
    assert.deepEqual(haulerBodyFor(2, 5, 550, true), { work: 0, carry: 2, move: 1 }, "the floor unit is 2C1M");
    assert.deepEqual(haulerBodyFor(200, 40, 99999, true), { work: 0, carry: 32, move: 16 }, "48-part cap");
  });

  it("sizes builders: W-heavy at a fed site, floor at 200, capped at 10 WORK", () => {
    assert.isNull(builderBody(199));
    assert.deepEqual(builderBody(200), { work: 1, carry: 1, move: 1 });
    assert.deepEqual(builderBody(550), { work: 4, carry: 1, move: 1 });
    assert.deepEqual(builderBody(99999), { work: 10, carry: 1, move: 1 }, "one 10W body absorbs 50 e/t");
  });

  it("sizes tenders: paired C+M, floor at 100, capped small — the estate is compact", () => {
    assert.isNull(tenderBody(99));
    assert.deepEqual(tenderBody(100), { work: 0, carry: 1, move: 1 });
    assert.deepEqual(tenderBody(9999), { work: 0, carry: 2, move: 2 });
  });

  it("every derived body fits its budget", () => {
    for (let budget = 100; budget <= 2000; budget += 50) {
      const bodies = [
        workmanBody(budget),
        minerBody(budget),
        haulerBody(budget),
        haulerBodyFor(7, 15, budget),
        builderBody(budget),
        upgraderBody(budget),
        tenderBody(budget)
      ];
      for (const body of bodies) {
        if (body) assert.isAtMost(bodyCost(body), budget, `budget ${budget}`);
      }
    }
  });

  it("sizes the port tender to its trunk's flow: parked 2-tick cycle, floor 1 CARRY, cap one volley", () => {
    // The throat (Addendum 4, v1's porttender): parked between buffer
    // and link, CARRY covers 2·flow; one whole volley is the cap —
    // staging more than 800 per cycle cannot outrun the cooldown.
    assert.deepEqual(portTenderBody(10), { work: 0, carry: 1, move: 1 }, "a trickle trunk gets the floor throat");
    assert.deepEqual(portTenderBody(30), { work: 0, carry: 2, move: 1 });
    assert.deepEqual(portTenderBody(80), { work: 0, carry: 4, move: 1 });
    assert.deepEqual(portTenderBody(9999), { work: 0, carry: 16, move: 1 }, "one volley per cycle is the cap");
  });

  it("sizes the hub service body per SENDER: v1's concurrency law, 4 CARRY each", () => {
    // t72819265 A/B: "one creep working harder cannot cover two senders
    // arriving at once" — the hub scales in CREEPS per sender, small each.
    assert.deepEqual(hubServiceBody(), { work: 0, carry: 4, move: 1 });
  });

  it("caps a link-fed hauler at the landing quantum — spec 45 leg 3 by name, roaded included", () => {
    // Measured in v1: 978–1,851e bodies into an 800-cap port stood 2–3
    // volley cycles per trip. Surplus CARRY buys standing time at the
    // port, never throughput; walking routes stay uncapped.
    assert.deepEqual(haulerBodyFor(100, 30, 99999, false, true), { work: 0, carry: 16, move: 16 });
    assert.deepEqual(haulerBodyFor(200, 40, 99999, true, true), { work: 0, carry: 16, move: 8 }, "roaded gait, same quantum");
    assert.deepEqual(haulerBodyFor(10, 10, 550, false, true), { work: 0, carry: 4, move: 4 }, "under the cap the route law rules");
    assert.deepEqual(haulerBodyFor(100, 30, 99999), { work: 0, carry: 25, move: 25 }, "a walking route keeps the body limit");
  });

  it("pins #148's route law: CARRY from flow and round-trip distance", () => {
    assert.equal(carryPartsFor(10, 10), 4, "10 e/t over 10 tiles");
    assert.equal(carryPartsFor(10, 25), 10, "10 e/t over 25 tiles");
    // The X6 incident by name: a 1.7-CARRY route never justifies 24 CARRY.
    assert.equal(carryPartsFor(2, 21), 2);
  });
});
