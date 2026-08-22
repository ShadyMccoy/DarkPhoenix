import { assert } from "chai";
import { buildPlan, jobCensus, planStale } from "../../src/plan";
import { World, WorldCreep, WorldRoom } from "../../src/world";

/**
 * The planner is pure — World in, Plan out — so these tests stage plain
 * values, no mockup and no game globals. They pin the DECISIONS (sizing
 * law, survival law, the one census), not internal shapes.
 */

function room(over: Partial<WorldRoom> = {}): WorldRoom {
  return {
    name: "W0N0",
    rcl: 1,
    rclProgress: 0,
    rclProgressTotal: 200,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    controllerId: "ctrl",
    controllerX: 25,
    controllerY: 10,
    spawns: [{ id: "sp1", name: "Spawn1", x: 25, y: 25, energy: 300, energyCapacity: 300, spawningJob: null }],
    sources: [
      { id: "srcA", x: 10, y: 40, energy: 3000, spots: 3, distToSpawn: 15 },
      { id: "srcB", x: 40, y: 40, energy: 3000, spots: 2, distToSpawn: 15 }
    ],
    refills: [],
    sourceRateCap: 20,
    ...over
  };
}

function creep(over: Partial<WorldCreep> = {}): WorldCreep {
  return {
    name: "w1",
    room: "W0N0",
    x: 25,
    y: 25,
    job: "work:srcA",
    work: 1,
    energy: 0,
    free: 50,
    spawning: false,
    ttl: 1400,
    ...over
  };
}

function world(rooms: WorldRoom[], creeps: WorldCreep[] = [], tick = 100): World {
  return { tick, rooms, creeps };
}

describe("plan", () => {
  it("orders one work job per source, spots- and ramp-clamped, capped by the source rate", () => {
    const plan = buildPlan(world([room()], [creep()]));
    assert.lengthOf(plan.jobs, 2);
    const byId = new Map(plan.jobs.map(j => [j.id, j]));
    assert.equal(byId.get("work:srcA")?.target, 3, "spots clamp srcA at 3");
    assert.equal(byId.get("work:srcB")?.target, 2, "spots clamp srcB at 2");

    // An open-terrain source (8 spots) must NOT order the duty-corrected
    // saturation fleet — the ramp cap holds it at 3 (measured: 12 bodies
    // starve the residual past the M1 gate).
    const open = buildPlan(
      world([room({ sources: [{ id: "srcC", x: 10, y: 40, energy: 3000, spots: 8, distToSpawn: 15 }] })], [creep()])
    );
    assert.equal(open.jobs[0].target, 3, "ramp cap");
    for (const j of plan.jobs) {
      assert.deepEqual(j.body, { work: 1, carry: 1, move: 2 }, "sized to 300 capacity");
      assert.isAtMost(j.expectedRate, 10, "a job never claims more than its source");
    }
    assert.isAbove(plan.expectedMined, 0);
  });

  it("sizes to capacity when staffed, to cash-in-hand when nobody is alive (survival law)", () => {
    const staffed = buildPlan(world([room({ energyCapacityAvailable: 550 })], [creep()]));
    assert.deepEqual(staffed.jobs[0].body, { work: 2, carry: 2, move: 4 });

    const wiped = buildPlan(world([room({ energyCapacityAvailable: 550, energyAvailable: 210 })], []));
    assert.deepEqual(wiped.jobs[0].body, { work: 1, carry: 1, move: 1 }, "buy what stands us up NOW");
  });

  it("orders nothing below the survival floor rather than queueing the unbuyable", () => {
    const plan = buildPlan(world([room({ energyAvailable: 150 })], []));
    assert.lengthOf(plan.jobs, 0);
  });

  it("counts the spawn pipe in the one census (the t72811290 class)", () => {
    const census = jobCensus(
      world([room()], [creep(), creep({ name: "w2", spawning: true }), creep({ name: "w3", job: "work:srcB" })])
    );
    assert.equal(census.get("work:srcA"), 2, "a spawning body already staffs its job");
    assert.equal(census.get("work:srcB"), 1);
  });

  it("goes stale on cadence, and immediately on a survival flip", () => {
    const w0 = world([room()], [creep()]);
    const plan = buildPlan(w0);
    assert.isFalse(planStale(plan, world([room()], [creep()], plan.tick + 5), 20));
    assert.isTrue(planStale(plan, world([room()], [creep()], plan.tick + 20), 20), "cadence");

    const capacityPlan = buildPlan(world([room({ energyCapacityAvailable: 550 })], [creep()]));
    const wipedWorld = world([room({ energyCapacityAvailable: 550, energyAvailable: 300 })], [], capacityPlan.tick + 1);
    assert.isTrue(planStale(capacityPlan, wipedWorld, 20), "500e order, 300e cash, nobody alive -> resize now");
  });
});
