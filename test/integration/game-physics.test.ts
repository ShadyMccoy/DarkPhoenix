/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { helper, hookConsole } from "./helper";
import { loadLayout } from "./loadLayout";

/**
 * GAME-PHYSICS PROBES (owner 2026-07-20): tiny micro-bot scenarios against
 * the REAL engine to pin mechanics our economics constants assume, instead
 * of trusting docs or memory. Each probe stages a minimal room, runs a
 * few-line custom bot (NOT dist/main.js), and reads the world directly.
 *
 * 1. ROAD WEAR vs LOAD: does an empty hauler wear roads as much as a loaded
 *    one? roadEconomics.maintenanceFor charges every crossing at full body
 *    (the body.length model). The owner's hypothesis: empty CARRY may not
 *    wear the road (the fatigue-weight model). Whichever the engine says
 *    becomes the pinned truth and the maintenance formula follows it.
 *
 * 2. SWAMP SPEED empty vs loaded: an empty creep generates no fatigue, so
 *    swamp should be full speed when empty - the premise of the "swamp
 *    shortcut" (empty leg cuts straight across the belt the road detours
 *    around; the loaded leg returns by road). The probe measures both legs.
 */

describe("game physics probes (micro-bot, real engine)", () => {
  before(() => hookConsole());
  afterEach(async () => helper.afterEach());

  it("ROAD WEAR: measures per-step wear for an EMPTY vs LOADED hauler", async function () {
    this.timeout(240000);

    // Walk lane: two adjacent roads at (20,20)-(21,20); a CONTROL road at
    // (30,30) nobody touches isolates wall-clock decay. Identical
    // nextDecayTime far in the future so no decay event fires mid-probe.
    const DECAY_AT = 100_000;
    const road = (x: number, y: number) => ({
      type: "road",
      x,
      y,
      attributes: { hits: 5000, hitsMax: 5000, nextDecayTime: DECAY_AT }
    });

    // The micro-bot: spawn a 3C3M walker (300 = the spawn's starting store),
    // shuttle it between the two road tiles (one road step every tick).
    // After tick 80 it tops up from the container and keeps shuttling
    // loaded. The TEST classifies each tick by the creep's carried energy.
    const MAIN = `
      module.exports.loop = function () {
        const spawn = Object.values(Game.spawns)[0];
        const c = Game.creeps.walker;
        if (!c) { if (spawn && !spawn.spawning) spawn.spawnCreep([CARRY,CARRY,CARRY,MOVE,MOVE,MOVE], "walker"); return; }
        if (c.spawning) return;
        if (Game.time > 90 && c.store.getFreeCapacity() > 0 && !c.memory.loaded) {
          const cont = c.room.find(FIND_STRUCTURES, { filter: s => s.structureType === "container" })[0];
          if (cont) {
            if (c.withdraw(cont, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) { c.moveTo(cont); return; }
            if (c.store.getFreeCapacity() === 0) c.memory.loaded = true;
            return;
          }
        }
        if (c.pos.y !== 20 || c.pos.x < 20 || c.pos.x > 21) { c.moveTo(new RoomPosition(20, 20, "W0N0")); return; }
        if (c.pos.x <= 20) c.memory.dir = 1; else if (c.pos.x >= 21) c.memory.dir = -1;
        c.move(c.memory.dir === 1 ? RIGHT : LEFT);
      };
    `;

    await helper.beforeEach(async world => {
      await loadLayout(world, {
        room: "W0N0",
        terrain: Array.from({ length: 50 }, () => ".".repeat(50)),
        objects: [
          { type: "controller", x: 10, y: 10 },
          road(20, 20),
          road(21, 20),
          road(30, 30),
          { type: "container", x: 22, y: 21, attributes: { store: { energy: 2000 }, storeCapacityResource: { energy: 2000 }, hits: 250000, hitsMax: 250000 } }
        ]
      });
      await world.addBot({ username: "prober", room: "W0N0", x: 25, y: 25, modules: { main: MAIN } });
    });

    const readWorld = async (): Promise<{ walked: number; control: number; carrying: number; x: number; y: number } | null> => {
      const objs = await helper.server.world.roomObjects("W0N0");
      const roads = objs.filter((o: any) => o.type === "road");
      const lane = roads.filter((o: any) => o.y === 20);
      const walked = lane.length === 2 ? { nextDecayTime: lane[0].nextDecayTime + lane[1].nextDecayTime } : undefined;
      const control = roads.find((o: any) => o.x === 30);
      const creep = objs.find((o: any) => o.type === "creep");
      if (!walked || !control) return null;
      return {
        walked: walked.nextDecayTime ?? 0,
        control: control.nextDecayTime ?? 0,
        carrying: creep?.store?.energy ?? 0,
        x: creep?.x ?? -1,
        y: creep?.y ?? -1
      };
    };

    let emptyWear = 0;
    let emptySteps = 0;
    let loadedWear = 0;
    let loadedSteps = 0;
    let prev = null as Awaited<ReturnType<typeof readWorld>>;
    let dumped = false;

    for (let t = 0; t < 220; t++) {
      await helper.server.tick();
      if (t === 10 && !dumped) {
        dumped = true;
        const objs = await helper.server.world.roomObjects("W0N0");
        const rawRoad = objs.find((o: any) => o.type === "road");
        console.log(`raw road object @t10: ${JSON.stringify(rawRoad)}`);
      }
      const cur = await readWorld();
      if (prev && cur) {
        // wear this tick = extra decay-advance on the LANE (both tiles
        // summed - each step lands on exactly one of them) vs 2x control
        const wear = (prev.walked - cur.walked) - 2 * (prev.control - cur.control);
        const stepped =
          cur.y === 20 && prev.y === 20 && cur.x !== prev.x && (cur.x === 20 || cur.x === 21) && (prev.x === 20 || prev.x === 21);
        if (stepped) {
          if (prev.carrying > 0) { loadedWear += wear; loadedSteps++; }
          else { emptyWear += wear; emptySteps++; }
        }
      }
      prev = cur;
    }

    const perStepEmpty = emptySteps > 0 ? emptyWear / emptySteps : NaN;
    const perStepLoaded = loadedSteps > 0 ? loadedWear / loadedSteps : NaN;
    console.log(`\n=== road wear probe === empty ${perStepEmpty} /step (${emptySteps} steps), loaded ${perStepLoaded} /step (${loadedSteps} steps)`);
    console.log(`models: body.length(6 parts)=equal wear both phases; fatigue-weight=loaded>empty`);

    assert.isAbove(emptySteps, 20, "probe must observe empty road steps");
    assert.isAbove(loadedSteps, 20, "probe must observe loaded road steps");
    // THE RULE, from the engine source (processor/intents/movement.js:219):
    // nextDecayTime -= ROAD_WEAROUT(1) * body.length - total parts,
    // LOAD-INDEPENDENT. A 6-part walker wears 6 per step, empty or full;
    // the owner's empty-carry-is-free hypothesis is falsified and
    // roadEconomics.maintenanceFor's both-legs-at-full-body charge is exact.
    assert.closeTo(perStepEmpty, 6, 0.5, "empty wear = body.length per step");
    assert.closeTo(perStepLoaded, 6, 0.5, "loaded wear = body.length per step (load-independent)");
  });

  it("SWAMP SPEED: empty full-speed across the belt, loaded crawls (the shortcut premise)", async function () {
    this.timeout(240000);

    // A 12-tile swamp belt on row 20 (x 15..26), plain elsewhere.
    const terrain = Array.from({ length: 50 }, (_v, y) =>
      y === 20 ? ".".repeat(15) + "~".repeat(12) + ".".repeat(23) : ".".repeat(50)
    );

    const MAIN = `
      module.exports.loop = function () {
        const spawn = Object.values(Game.spawns)[0];
        const c = Game.creeps.wader;
        if (!c) { if (spawn && !spawn.spawning) spawn.spawnCreep([CARRY, MOVE], "wader"); return; }
        if (c.spawning) return;
        const m = c.memory;
        if (!m.phase) m.phase = "toStart";
        if (m.phase === "toStart") {
          if (c.pos.x === 14 && c.pos.y === 20) { m.phase = "crossEmpty"; return; }
          c.moveTo(new RoomPosition(14, 20, "W0N0")); return;
        }
        if (m.phase === "crossEmpty") {
          if (c.pos.x >= 27) { m.phase = "load"; return; }
          c.move(RIGHT); return;
        }
        if (m.phase === "load") {
          const cont = c.room.find(FIND_STRUCTURES, { filter: s => s.structureType === "container" })[0];
          if (c.withdraw(cont, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) { c.moveTo(cont); return; }
          m.phase = "crossLoaded"; return;
        }
        if (m.phase === "crossLoaded") {
          if (c.pos.x <= 14) { m.phase = "done"; return; }
          c.move(LEFT); return;
        }
      };
    `;

    await helper.beforeEach(async world => {
      await loadLayout(world, {
        room: "W0N0",
        terrain,
        objects: [
          { type: "controller", x: 10, y: 10 },
          { type: "container", x: 28, y: 20, attributes: { store: { energy: 500 }, storeCapacityResource: { energy: 2000 }, hits: 250000, hitsMax: 250000 } }
        ]
      });
      await world.addBot({ username: "prober", room: "W0N0", x: 25, y: 25, modules: { main: MAIN } });
    });

    let emptyStart = -1;
    let emptyEnd = -1;
    let loadedStart = -1;
    let loadedEnd = -1;

    for (let t = 0; t < 400; t++) {
      await helper.server.tick();
      const objs = await helper.server.world.roomObjects("W0N0");
      const c = objs.find((o: any) => o.type === "creep");
      if (!c) continue;
      const carrying = (c.store?.energy ?? 0) > 0;
      if (!carrying && c.y === 20 && c.x === 15 && emptyStart === -1) emptyStart = t;
      if (!carrying && c.x >= 27 && emptyStart !== -1 && emptyEnd === -1) emptyEnd = t;
      if (carrying && c.x === 26 && c.y === 20 && loadedStart === -1) loadedStart = t;
      if (carrying && c.x <= 14 && loadedStart !== -1 && loadedEnd === -1) { loadedEnd = t; break; }
    }

    const emptyTicks = emptyEnd - emptyStart;
    const loadedTicks = loadedEnd - loadedStart;
    console.log(`\n=== swamp probe === empty crossing ${emptyTicks}t, loaded crossing ${loadedTicks}t (12-tile belt)`);

    assert.isAbove(emptyEnd, -1, "empty crossing must complete");
    assert.isAbove(loadedEnd, -1, "loaded crossing must complete");
    // The shortcut premise: empty = full speed (~1 tile/tick) across swamp...
    assert.isBelow(emptyTicks, 12 + 4, "empty creep crosses swamp at ~1 tile/tick");
    // ...while a 1:1 body crawls it loaded at ~5 ticks/tile.
    assert.isAbove(loadedTicks, emptyTicks * 3, "loaded 1:1 crawls the same belt");
    // The shortcut arithmetic this enables: a route whose ROAD detours D
    // tiles around this belt can send EMPTY haulers straight across, saving
    // (D + detourLength - beltWidth) empty-leg ticks per round trip - which
    // is fewer CARRY parts in flight for the same flow.
  });
});
