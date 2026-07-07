/**
 * churn cells - OrphanRescue canaries (docs/specs/08, avenue: churn-recovery).
 *
 * These three cells are the grid's foundation: ~30 other designed cells stage
 * creeps by injecting them with a synthetic corpId and relying on OrphanRescue
 * (src/execution/OrphanRescue.ts) to re-adopt them into the live corp that owns
 * their work. Until re-adoption is PROVEN to work under staging, no staged
 * cell's verdict means anything - so these run first, and double as the
 * regression guard for bug #92 ("creeps standing around until they die").
 *
 * The three OrphanRescue behaviors, one cell each:
 *   readopt  - synthetic-corpId creep whose work exists -> corpId flips to the
 *              live corp within the grace window (ORPHAN_GRACE_TICKS = 25).
 *   recycle  - synthetic-corpId creep whose work does NOT exist -> left alone
 *              through the grace window, then walked to the spawn and recycled.
 *   untouched- creep with NO corpId -> never adopted, never recycled
 *              (OrphanRescue.ts:161 skips it by design).
 */

import { GridCell, always, atWindow, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

/** Shared geometry: sealed plain room, spawn (25,25), controller north, source east. */
const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(30, 25).toRoom();

const SOURCE_ID = "$id(home,source,30,25)";

// churn-canary-recycle stand-still tracking (position frozen through grace).
let cx1Anchor: { x: number; y: number } | null = null;

export const churnCells: GridCell[] = [
  {
    // T1: the OTHER readopt path - a hauler is matched to the carry corp that
    // routes its assignedSourceId (OrphanRescue.ts:117-125), not by standing
    // position. Complements churn-canary-readopt's miner path.
    id: "churn-readopt-hauler-route",
    tier: 1,
    avenue: "churn-recovery",
    window: 40,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    creeps: [
      {
        name: "hx",
        x: 22,
        y: 25,
        body: ["carry", "carry", "move"],
        memory: { workType: "haul", corpId: "hauling-DEAD-hauling-0000", assignedSourceId: SOURCE_ID },
      },
    ],
    assertions: [
      eventually("re-adopted into the live carry corp by route", (s) => {
        const corpId = s.memory?.creeps?.hx?.corpId;
        return typeof corpId === "string" && corpId.startsWith("hauling-") && !corpId.includes("DEAD");
      }),
      always("never recycled while its route exists", (s) => !!s.creep("hx")),
      atWindow("no orphan stamp survives", (s) => s.memory?.creeps?.hx?.orphanedSince === undefined),
    ],
  },

  {
    id: "churn-canary-readopt",
    tier: 1,
    avenue: "churn-recovery",
    window: 90,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    creeps: [
      {
        name: "cm1",
        x: 28,
        y: 25,
        body: ["work", "work", "move"],
        memory: { workType: "harvest", corpId: "staged-orphan", assignedSourceId: SOURCE_ID },
      },
    ],
    assertions: [
      // The flagship: OrphanRescue.readoptTarget matches the staged miner to the
      // commissioned harvest corp via its assignedSourceId and rewrites corpId.
      eventually("re-adopted into live mining corp", (s) => {
        const corpId = s.memory?.creeps?.cm1?.corpId;
        return typeof corpId === "string" && corpId.startsWith("mining-");
      }),
      // After adoption the corp seats it on the harvest spot beside the source.
      eventually("takes post adjacent to source", (s) => {
        const c = s.creep("cm1");
        return !!c && Math.max(Math.abs(c.x - 30), Math.abs(c.y - 25)) === 1;
      }),
      // Wrongful recycle (adoption slower than the 25-tick grace) kills it; a
      // dead cm1 fails this immediately and dates the failure.
      always("never recycled while its work exists", (s) => !!s.creep("cm1")),
    ],
  },

  {
    id: "churn-canary-recycle",
    tier: 1,
    avenue: "churn-recovery",
    window: 60,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    creeps: [
      {
        name: "cx1",
        x: 20,
        y: 25,
        body: ["carry", "move"],
        // A hauler for a source id that will never exist: readoptTarget finds no
        // carry corp routing it, so the only correct outcome is recycling.
        memory: { workType: "haul", corpId: "ghost-corp-never-exists", assignedSourceId: "xxdeadbeef" },
      },
    ],
    assertions: [
      // Grace respected: still alive at tick 20 (< ORPHAN_GRACE_TICKS + walk).
      always("not recycled inside the grace window", (s) => s.tick >= 20 || !!s.creep("cx1")),
      // 'wait' means WAIT: OrphanRescue issues no moves during grace, and
      // nothing else may drive an orphan - the position stays frozen.
      always("stands still through the grace window", (s) => {
        if (s.tick < 3 || s.tick > 22) return true;
        const c = s.creep("cx1");
        if (!c) return false;
        if (cx1Anchor === null) cx1Anchor = { x: c.x, y: c.y };
        return c.x === cx1Anchor.x && c.y === cx1Anchor.y;
      }),
      // Never mis-adopted while alive: its corpId must stay the ghost id.
      always("never adopted by an unrelated corp", (s) => {
        const corpId = s.memory?.creeps?.cx1?.corpId;
        return corpId === undefined || corpId === "ghost-corp-never-exists";
      }),
      // Past grace it walks to the spawn and is recycled: gone from the world.
      eventually("recycled after grace expires", (s) => !s.creep("cx1")),
    ],
  },

  {
    // T0 existence proof of the disaster layer: zero creeps -> noHaulers ->
    // BootstrapCorp bypasses the starvation timer and spawns a jack at once.
    // Cold RCL1 (no controller bump): bootstrap owns the room by design.
    id: "churn-jack-immediate-no-haulers",
    tier: 0,
    avenue: "churn-recovery",
    window: 30,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    assertions: [
      // Prompt existence proof of the disaster layer. Exact start tick is NOT
      // asserted: BootstrapCorp's SPAWN_COOLDOWN=10 gates on absolute
      // Game.time (lastSpawnAttempt inits to 0), so a world whose clock starts
      // near 0 spawns the jack at tick ~10, one starting later spawns at ~1 -
      // fielded anywhere in [10, 22] is the immediate path (3 parts = 9 spawn
      // ticks). What must hold: the jack comes promptly and comes FIRST.
      eventually("jack fielded promptly", (s) => {
        if (s.tick > 22) return false;
        return s
          .objects()
          .some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("jack-"));
      }),
      always("the jack is the room's first creep", (s) => {
        const creeps = s.objects().filter((o) => o.type === "creep" && typeof o.name === "string");
        return creeps.length === 0 || creeps.some((o) => o.name.startsWith("jack-"));
      }),
      eventually("jack fielded with the bootstrap corp stamp", (s) => {
        const jack = s
          .objects()
          .find((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("jack-"));
        if (!jack) return false;
        const mem = s.memory?.creeps?.[jack.name];
        return (
          typeof mem?.corpId === "string" && mem.corpId.startsWith("bootstrap-") && mem.workType === "harvest"
        );
      }),
    ],
  },

  {
    id: "churn-canary-untouched",
    tier: 1,
    avenue: "churn-recovery",
    window: 60,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    creeps: [
      {
        name: "cn1",
        x: 15,
        y: 25,
        body: ["move"],
        memory: { workType: "scout" }, // deliberately NO corpId
      },
    ],
    assertions: [
      always("never recycled", (s) => !!s.creep("cn1")),
      atWindow("still has no corpId", (s) => {
        const mem = s.memory?.creeps?.cn1;
        return !!mem && mem.corpId === undefined;
      }),
    ],
  },
];
