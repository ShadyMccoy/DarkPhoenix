/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { helper, hookConsole } from "./helper";
import { loadLayout, padNeighborTerrain } from "./loadLayout";

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

  // ROAD-ACROSS-BORDERS probe (owner 2026-07-22): pin the room-crossing
  // geometry the trunk-road planner assumes. Two adjacent rooms E0N0 | E1N0
  // share the vertical border E0N0 x=49 <-> E1N0 x=0. A [MOVE] creep is driven
  // with RAW moves (never moveTo, so the pathfinder can't mask the raw engine
  // physics). It walks east along row 25 into E1N0, then takes ONE diagonal
  // step off the entry edge tile. The test reads BOTH rooms every tick and
  // pins two facts the road planner depends on - both traced to the engine
  // source (@screeps/engine), not memory:
  //
  //   1. STRAIGHT CROSSING. creeps/tick.js:52-73 transfers an edge creep to
  //      the adjacent room at the MIRROR tile, preserving the perpendicular
  //      coordinate (x==49 -> x=0, SAME y). And movement.js:88-91 clamps any
  //      out-of-bounds move back onto the edge, so a diagonal at the border
  //      slides ALONG it rather than carrying you across diagonally. Net: you
  //      cannot cross a border diagonally - the crossing is a pure mirror.
  //      => a creep on row 25 in E0N0 lands on row 25 in E1N0.
  //
  //   2. DIAGONAL STEP OFF THE ENTRY TILE IS LEGAL. Once transferred in, the
  //      creep sits on the x=0 edge; a normal in-room diagonal move to
  //      (1, y+/-1) is unclamped and un-transferred (destination isn't an
  //      edge), and Screeps does not corner-block diagonals. => a creep that
  //      enters at (0,25) CAN step to (1,26) - it can walk straight onto a
  //      road tile placed one diagonal off the crossing.
  //
  // Together these say the trunk planner is safe: PathFinder (which obeys the
  // same crossing rules) returns border crossings that are straight across on
  // a shared row/column, and ConstructionCorp's isRoomEdgeTile skip leaves
  // only the two unpaveable edge tiles bare - the lane stays continuous.
  it("ROOM CROSSING: border crossing is straight, and a diagonal step off the entry tile is legal", async function () {
    this.timeout(240000);

    const MAIN = `
      module.exports.loop = function () {
        const spawn = Object.values(Game.spawns)[0];
        const c = Game.creeps.walker;
        if (!c) { if (spawn && !spawn.spawning) spawn.spawnCreep([MOVE], "walker"); return; }
        if (c.spawning) return;
        const m = c.memory;
        const r = c.pos.roomName, x = c.pos.x, y = c.pos.y;

        // In the ORIGIN room: get onto row 25 near the east side (moveTo routes
        // around the spawn), then walk STRAIGHT east with raw RIGHT moves. The
        // last interior tile sampled is (48,25); the next raw RIGHT steps onto
        // the edge (49,25) and the engine transfers us the SAME tick to the
        // mirror tile E1N0 (0,25) - so (49,25) is never seen at a tick boundary.
        if (r === "E0N0") {
          if (!(y === 25 && x >= 45)) { c.moveTo(new RoomPosition(45, 25, "E0N0")); return; }
          c.move(RIGHT);
          return;
        }

        // In the DESTINATION room: we entered on the x=0 edge. Take exactly one
        // DIAGONAL step inward (BOTTOM_RIGHT -> (1, y+1)) to prove a diagonal
        // road tile is reachable from the entry tile, then hold position.
        if (r === "E1N0") {
          if (!m.stepped) { c.move(BOTTOM_RIGHT); m.stepped = true; }
          return;
        }
      };
    `;

    await helper.beforeEach(async world => {
      // E0N0: owned room (controller + spawn). E1N0: plain neighbour to walk into.
      await loadLayout(world, [
        { room: "E0N0", terrain: Array.from({ length: 50 }, () => ".".repeat(50)), objects: [{ type: "controller", x: 10, y: 10 }] },
        { room: "E1N0", terrain: Array.from({ length: 50 }, () => ".".repeat(50)) }
      ]);
      // Wall-pad the OTHER neighbours so the engine never reads empty terrain.
      await padNeighborTerrain(world, ["E0N0", "E1N0"], 1, "wall");
      await world.addBot({ username: "prober", room: "E0N0", x: 25, y: 10, modules: { main: MAIN } });
    });

    const readCreep = async (): Promise<{ room: string; x: number; y: number } | null> => {
      for (const room of ["E0N0", "E1N0"]) {
        const objs = await helper.server.world.roomObjects(room);
        const cr = objs.find((o: any) => o.type === "creep");
        if (cr) return { room, x: cr.x, y: cr.y };
      }
      return null;
    };

    const traj: { room: string; x: number; y: number }[] = [];
    for (let t = 0; t < 60; t++) {
      await helper.server.tick();
      const cur = await readCreep();
      if (cur) {
        const last = traj[traj.length - 1];
        if (!last || last.room !== cur.room || last.x !== cur.x || last.y !== cur.y) traj.push(cur);
      }
    }

    console.log("\n=== room crossing trajectory ===");
    for (const p of traj) console.log(`  ${p.room} (${p.x},${p.y})`);

    // The last tile in the origin room and the first tile in the destination.
    const idxCross = traj.findIndex(p => p.room === "E1N0");
    assert.isAbove(idxCross, 0, "creep must cross into E1N0");
    const lastE0 = traj[idxCross - 1];
    const firstE1 = traj[idxCross];
    console.log(`crossing: E0N0 (${lastE0.x},${lastE0.y}) -> E1N0 (${firstE1.x},${firstE1.y})`);

    // FACT 1: the crossing is STRAIGHT - the creep approached the east border
    // along row 25 (last interior tile (48,25)) and arrived in E1N0 on the
    // mirror tile (0,25), the SAME row. The engine transfers an edge creep to
    // (0, y) with y preserved (creeps/tick.js:66-68), so landing on (0,25)
    // after leaving row 25 is proof the perpendicular coordinate carries over
    // unchanged - you cannot gain lateral position by crossing.
    assert.strictEqual(lastE0.y, 25, "approached the east border along row 25");
    assert.deepEqual({ x: firstE1.x, y: firstE1.y }, { x: 0, y: 25 }, "lands on the mirror tile (0,25) - perpendicular coord preserved");

    // FACT 2: the diagonal step off the entry edge tile succeeded - the creep
    // reached (1,26), one tile diagonally in from where it entered.
    const afterStep = traj[idxCross + 1];
    assert.ok(afterStep && afterStep.room === "E1N0", "creep stepped inward, staying in E1N0 (no border bounce)");
    assert.deepEqual({ x: afterStep.x, y: afterStep.y }, { x: 1, y: 26 }, "diagonal step off the entry tile lands on (1,26)");
  });
});
