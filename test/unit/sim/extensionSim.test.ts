import { expect } from "chai";
import {
  EXT_CAP,
  Scenario,
  buildWorld,
  organicLayout,
  simulate,
  spineLayout,
  stepToward,
  tryStartSpawn
} from "../../../scripts/extension-sim/engine";

/**
 * Mechanics pins for the extension-refill mini-game (owner 2026-07-22:
 * "a small mock up of the real screeps"). Each rule here was verified
 * against the vendored engine before the sim encoded it - these pins keep
 * the sim honest so its layout/strategy verdicts mean something:
 * - _charge-energy.js: default draw = spawns then extensions, each sorted
 *   by distance from the spawning spawn; energyStructures drains verbatim.
 * - CREEP_SPAWN_TIME 3, EXTENSION_ENERGY_CAPACITY {6:50, 7:100, 8:200}.
 * - creeps/intents.js: transfer/withdraw/move stack in one tick.
 * - _add-fatigue.js: weight*terrain per move vs 2/MOVE recovery.
 */
describe("extension-sim mechanics (engine-verified rules)", () => {
  const base = (over: Partial<Scenario>): Scenario => ({
    layout: spineLayout(40, 1),
    rcl: 6,
    drawOrder: "engine-default",
    tenderPolicy: "greedy-nearest",
    tenderCount: 1,
    tenderBody: { carry: 16, move: 16 },
    ticks: 200,
    ...over
  });

  it("spawning takes 3 ticks per part and charges at START", () => {
    // RCL6 spine: 300 spawn + 40x50 = 2300 total -> 46-part max body.
    const world = buildWorld(base({}));
    const total = world.spawns[0].energy + world.extensions.reduce((s, e) => s + e.energy, 0);
    expect(total).to.equal(2300);
    const m = simulate(base({ ticks: 138 }));
    // One 46-part body: busy exactly 3*46 = 138 ticks, charged up front.
    expect(m.bodiesSpawned).to.equal(1);
    expect(m.spawnBusyTicks).to.equal(138);
  });

  it("extension capacity follows the RCL table (7 -> 100, 8 -> 200)", () => {
    expect(EXT_CAP[6]).to.equal(50);
    const w7 = buildWorld(base({ rcl: 7, layout: spineLayout(50, 2) }));
    expect(w7.extensions[0].cap).to.equal(100);
    const w8 = buildWorld(base({ rcl: 8, layout: spineLayout(60, 3) }));
    expect(w8.extensions[0].cap).to.equal(200);
  });

  it("default draw order drains nearest-the-spawn extensions first; near-reload-first drains storage-side first", () => {
    // RCL7 spine (5600 total, 2500 body): a PARTIAL drain, so ordering shows.
    const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
      Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const rank = (world: ReturnType<typeof buildWorld>, anchor: { x: number; y: number }) =>
      world.extensions.slice().sort((a, b) => cheb(a.pos, anchor) - cheb(b.pos, anchor));

    const s7 = base({ rcl: 7, layout: spineLayout(50, 2), tenderCount: 0 });
    const wDefault = buildWorld(s7);
    expect(tryStartSpawn(wDefault, wDefault.spawns[0], 50, "engine-default")).to.equal(true);
    const bySpawn = rank(wDefault, wDefault.spawns[0].pos);
    expect(bySpawn[0].energy, "nearest-the-spawn extension drained first").to.equal(0);
    expect(bySpawn[bySpawn.length - 1].energy, "farthest-from-spawn survives a partial drain").to.equal(100);

    const wReload = buildWorld(s7);
    expect(tryStartSpawn(wReload, wReload.spawns[0], 50, "near-reload-first")).to.equal(true);
    const byStorage = rank(wReload, wReload.storage);
    expect(byStorage[0].energy, "storage-side extension drained first").to.equal(0);
    expect(byStorage[byStorage.length - 1].energy, "far-from-storage survives").to.equal(100);
  });

  it("fatigue: a 2:1 body crawls OFF-road (higher refill latency) but matches 1:1 ON a road lane", () => {
    // Plain: 16C loaded = weight 16, fatigue 32 vs recovery 16 (8 MOVE) ->
    // one rest tick per tile, half speed. Road lane: fatigue 16 vs 16 ->
    // full speed even at 2:1 (the whole reason road-era bodies shed MOVE).
    const offRoad = (move: number) =>
      simulate(base({ layout: organicLayout(40, 1), tenderBody: { carry: 16, move }, ticks: 3000 }));
    const slowPlain = offRoad(8);
    const fastPlain = offRoad(16);
    expect(slowPlain.meanRefillLatency, "2:1 crawls on plain").to.be.greaterThan(fastPlain.meanRefillLatency);

    const onRoad = (move: number) =>
      simulate(base({ layout: spineLayout(40, 1), tenderBody: { carry: 16, move }, ticks: 3000 }));
    const slowRoad = onRoad(8);
    const fastRoad = onRoad(16);
    expect(
      Math.abs(slowRoad.meanRefillLatency - fastRoad.meanRefillLatency),
      "on the road lane 2:1 keeps pace with 1:1"
    ).to.be.at.most(fastRoad.meanRefillLatency * 0.15 + 1);
  });

  it("organic layouts never strand an extension unserviceable", () => {
    for (const seed of [1, 7, 23, 99]) {
      const layout = organicLayout(40, 1, seed);
      expect(layout.extensions.length).to.equal(40);
      const world = buildWorld(base({ layout, tenderCount: 1 }));
      // Every extension must be reachable to transfer range from the tender
      // start (storage side): stepToward finds a path or is already in range.
      for (const e of world.extensions) {
        const from = world.tenders[0].pos;
        const step =
          Math.max(Math.abs(from.x - e.pos.x), Math.abs(from.y - e.pos.y)) <= 1
            ? null
            : stepToward(world, from, e.pos, 1);
        const inRange = Math.max(Math.abs(from.x - e.pos.x), Math.abs(from.y - e.pos.y)) <= 1;
        expect(step !== null || inRange, `${e.id} at ${e.pos.x},${e.pos.y} unreachable (seed ${seed})`).to.equal(true);
      }
    }
  });

  it("circuit automaton: head-reset sweep keeps a HEAVY (2:1) tender at full utilization on its corridor", () => {
    // Owner 2026-07-22: "I don't see how circuit patrol could lose" + "1:1
    // on the tender is overkill". Confirmed once the sweep restarts at the
    // circuit head each load (the stale-cursor elevator bug cost util 0.87
    // measured). Fatigue recovers while standing to transfer, so the 2:1
    // rest ticks hide inside the corridor's standing ticks.
    const m = simulate(
      base({
        rcl: 7,
        layout: spineLayout(50, 2),
        drawOrder: "circuit",
        tenderPolicy: "lane-patrol",
        tenderBody: { carry: 33, move: 17 },
        ticks: 5000
      })
    );
    expect(m.utilization).to.equal(1);
    expect(m.endFill).to.be.greaterThan(0.99);
    expect(m.meanRefillLatency, "beats the 1:1 greedy bar (~107t) on the same board").to.be.lessThan(115);
  });

  it("refill keeps a saturated RCL6 spine spawn above 0.95 utilization with one 1:1 tender (the first-principles claim)", () => {
    // Rate check: 46-part bodies need 2300/138 = 16.7 e/t; one tender
    // sustains ~25-30. If the sim disagrees wildly, the mechanics are wrong.
    const m = simulate(base({ ticks: 5000 }));
    expect(m.utilization).to.be.greaterThan(0.95);
  });
});

