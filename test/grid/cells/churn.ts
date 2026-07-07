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

export const churnCells: GridCell[] = [
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
