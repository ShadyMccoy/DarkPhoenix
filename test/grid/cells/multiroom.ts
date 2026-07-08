/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * T5 multi-room cells (docs/specs/08, the deepest tier): remote mining,
 * border traffic, reservation economics, and Source-Keeper exclusion.
 *
 * Geometry: each cell's home room opens a 3-tile exit slot on one edge, and
 * the neighbouring room opens the matching slot - the remoteSource pattern.
 * Everything else stays sealed (the isolation invariant). The SK cell PINS
 * its room names (W3N4 home, W4N4 keeper room): SK classification is pure
 * room-name arithmetic, and row N0 - where the packer normally allocates -
 * can never be SK.
 *
 * Design dedupe: the organic reserver-dispatch assertion is folded into the
 * remote pipeline cell (same 800-tick world) instead of a second long world.
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

/** Home room with an east exit slot at (49, 24..26). */
const homeEast = (build: (b: RoomBuilder) => RoomBuilder) => (roomName: string) => {
  const b = new RoomBuilder(roomName).border();
  for (let y = 24; y <= 26; y++) b.tile(49, y, "plain");
  return build(b).toRoom();
};

/** East room with the matching west slot at (0, 24..26). */
const eastRoom = (build: (b: RoomBuilder) => RoomBuilder) => (roomName: string) => {
  const b = new RoomBuilder(roomName).border();
  for (let y = 24; y <= 26; y++) b.tile(0, y, "plain");
  return build(b).toRoom();
};

const EXT_8: Array<{ x: number; y: number }> = [
  { x: 23, y: 23 },
  { x: 23, y: 27 },
  { x: 27, y: 23 },
  { x: 27, y: 27 },
  { x: 22, y: 25 },
  { x: 28, y: 25 },
  { x: 24, y: 22 },
  { x: 26, y: 22 },
];
const EXT_20: Array<{ x: number; y: number }> = [
  ...EXT_8,
  { x: 23, y: 21 },
  { x: 27, y: 21 },
  { x: 23, y: 29 },
  { x: 27, y: 29 },
  { x: 21, y: 23 },
  { x: 29, y: 23 },
  { x: 21, y: 27 },
  { x: 29, y: 27 },
  { x: 25, y: 21 },
  { x: 25, y: 29 },
  { x: 21, y: 25 },
  { x: 29, y: 25 },
];

const fullExts = (positions: Array<{ x: number; y: number }>) =>
  positions.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 }));

/** A home income pair (miner on its spot + hauler), keeps the economy sane. */
const homeIncome = (srcX: number, srcY: number, spotX: number, spotY: number) => [
  {
    name: "mH",
    x: spotX,
    y: spotY,
    body: ["work", "work", "work", "work", "work", "move", "move", "move"],
    memory: { workType: "harvest", corpId: "staged-mr-m", assignedSourceId: `$id(home,source,${srcX},${srcY})` },
  },
  {
    name: "hH",
    x: 22,
    y: 30,
    body: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"],
    memory: { workType: "haul", corpId: "staged-mr-h", working: false, assignedSourceId: `$id(home,source,${srcX},${srcY})` },
  },
];

/**
 * The remote harvester that arms ReservationCorp's trigger: OUR creep with
 * workType 'harvest' standing in the unowned, controllered east room. NO
 * corpId - canary-proven untouchable, so the trigger stays armed all window.
 */
const remoteHarvester = () => ({
  name: "rh",
  x: 26,
  y: 25,
  room: "east",
  body: ["work", "work", "move"],
  memory: { workType: "harvest" },
});

export function buildMultiroomT5Cells(): GridCell[] {
  // scout closure
  let intelAt: number | null = null;

  // yields-to-miner closure
  let namesAtStart: Set<string> | null = null;
  let firstFresh: string | null = null;

  // orphan-walks-home closure
  let seenInHome = false;

  // pipeline closure
  let remoteMinedSeen = false;

  return [
    {
      // The scout crosses the border, records intel for the east room, and
      // comes home. Deliberately NOT asserted: interior penetration (intel is
      // recorded from the entry edge and the scout retargets - errata
      // wrong-behavior #2; the idle-scout edge ping-pong is a known latent
      // bug tracked separately).
      id: "move-scout-border-crossing",
      tier: 5,
      avenue: "movement",
      window: 130,
      rooms: {
        home: homeEast((b) => b.controller(25, 10).source(30, 25)),
        east: eastRoom((b) => b),
      },
      adjacency: { east: "E" },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      assertions: [
        eventually("a scout is fielded", (s) =>
          s.objects().some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("scout-")) ||
          s
            .objects("east")
            .some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("scout-"))
        ),
        eventually("intel is recorded for the east room", (s) => {
          if (s.memory?.roomIntel?.[s.room("east")] !== undefined && intelAt === null) intelAt = s.tick;
          return intelAt !== null;
        }),
        eventually("the scout returns home after recording", (s) => {
          if (intelAt === null) return false;
          return (
            s.tick > intelAt &&
            s.objects().some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("scout-"))
          );
        }),
      ],
    },

    {
      // A worked remote room's reserver ranks as STARTED INCOME: with the
      // trigger armed (rh standing by the east source) and 650 affordable,
      // the reserver is fielded and walks into the east room.
      id: "spawn-reserver-started-income",
      tier: 5,
      avenue: "spawn-decision",
      window: 90,
      rooms: {
        home: homeEast((b) => b.controller(25, 10).source(25, 40)),
        east: eastRoom((b) => b.controller(10, 10).source(25, 25)),
      },
      adjacency: { east: "E" },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: fullExts(EXT_8),
      creeps: [...homeIncome(25, 40, 24, 39), remoteHarvester()],
      assertions: [
        eventually("a reserver is fielded", (s) =>
          s.objects().some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("reserver-")) ||
          s
            .objects("east")
            .some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("reserver-"))
        ),
        eventually("it enters the remote room", (s) =>
          s
            .objects("east")
            .some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("reserver-"))
        ),
      ],
    },

    {
      // Ordering under contention: a fresh home source's FIRST MINER
      // (blocking income) still beats the reserver (started income) - then
      // the reserver comes.
      id: "spawn-reserver-yields-to-blocking-miner",
      tier: 5,
      avenue: "spawn-decision",
      // 400, and the extensions are staged EMPTY: with a full bank the
      // reserver won an EMPTY tick-1 queue. Contested, the reserver queues
      // behind the ENTIRE income expansion (fresh miner ~95, its hauler
      // ~157, the remote source's miner ~234 - the staged rh gives vision,
      // so the solver legitimately opens the remote mine) and rides its
      // income starved-hold (~315) to the spawn. NOTE for spec 01: value 92
      // underprices reservation (650 energy doubles a remote source, beating
      // a scaling hauler's marginal value 110) - a candidate energy lever.
      window: 400,
      rooms: {
        home: homeEast((b) => b.controller(25, 10).source(25, 40).source(10, 30)),
        east: eastRoom((b) => b.controller(10, 10).source(25, 25)),
      },
      adjacency: { east: "E" },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: EXT_8.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 0 })),
      creeps: [...homeIncome(25, 40, 24, 39), remoteHarvester()],
      assertions: [
        eventually("the fresh source's miner is the first new creep", (s) => {
          const names = s
            .objects()
            .filter((o) => o.type === "creep" && typeof o.name === "string")
            .map((o) => o.name as string);
          if (namesAtStart === null) {
            namesAtStart = new Set(names);
            return false;
          }
          if (firstFresh === null) {
            firstFresh = names.find((n) => !namesAtStart!.has(n)) ?? null;
            if (firstFresh === null) return false;
          }
          return firstFresh.startsWith("miner-");
        }),
        eventually("the reserver follows", (s) =>
          s.objects().some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("reserver-")) ||
          s
            .objects("east")
            .some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("reserver-"))
        ),
      ],
    },

    {
      // Body scaling across rooms: at 1300 capacity the reserver carries the
      // full 2x(CLAIM+MOVE) pair set and physically reaches the remote
      // controller.
      id: "spawnexec-reserver-body-multiroom",
      tier: 5,
      avenue: "spawn-execution",
      window: 110,
      rooms: {
        home: homeEast((b) => b.controller(25, 10).source(25, 40)),
        east: eastRoom((b) => b.controller(10, 10).source(25, 25)),
      },
      adjacency: { east: "E" },
      bot: { x: 25, y: 25 },
      controller: { level: 4 },
      structures: fullExts(EXT_20),
      creeps: [...homeIncome(25, 40, 24, 39), remoteHarvester()],
      assertions: [
        eventually("the reserver carries the full 2-CLAIM body", (s) => {
          const r =
            s.objects().find((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("reserver-")) ??
            s
              .objects("east")
              .find((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("reserver-"));
          if (!r) return false;
          const claim = (r.body ?? []).filter((p: any) => p.type === "claim").length;
          const move = (r.body ?? []).filter((p: any) => p.type === "move").length;
          return claim === 2 && move === 2;
        }),
        eventually("it reaches the remote controller", (s) =>
          s
            .objects("east")
            .some(
              (o) =>
                o.type === "creep" &&
                typeof o.name === "string" &&
                o.name.startsWith("reserver-") &&
                Math.max(Math.abs(o.x - 10), Math.abs(o.y - 10)) <= 2
            )
        ),
      ],
    },

    {
      // An unadoptable orphan stranded in the REMOTE room walks home across
      // the border to the nearest spawn and recycles - cross-room
      // driveRecycle end to end.
      id: "churn-remote-orphan-walks-home",
      tier: 5,
      avenue: "churn-recovery",
      window: 140,
      rooms: {
        home: homeEast((b) => b.controller(25, 10).source(30, 25)),
        east: eastRoom((b) => b),
      },
      adjacency: { east: "E" },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "oh",
          x: 25,
          y: 25,
          room: "east",
          body: ["carry", "carry", "move"],
          memory: { workType: "haul", corpId: "hauling-DEAD-hauling-0000", assignedSourceId: "xxnope" },
        },
      ],
      assertions: [
        eventually("it leaves the remote room after grace", (s) =>
          !s.objects("east").some((o) => o.type === "creep" && o.name === "oh")
        ),
        eventually("it crosses into the home room", (s) => {
          if (s.creep("oh")) seenInHome = true;
          return seenInHome;
        }),
        eventually("it is recycled at the home spawn", (s) => {
          return (
            seenInHome &&
            !s.creep("oh") &&
            !s.objects("east").some((o) => o.type === "creep" && o.name === "oh")
          );
        }),
      ],
    },

    {
      // The full organic remote pipeline: scout -> intel -> home economy
      // saturates -> the remote unlocks -> the planner mines it -> a miner
      // walks over and works it -> the reserver is dispatched. The
      // home-saturation gate + spawn-then-recycle (this cell's findings,
      // spec 01) made the timeline LATER but stable: home saturates ~500,
      // remote opens at the next refresh+replan, mining ~1100, dispatch
      // after. 1500 covers it with margin.
      id: "plan-t5-remote-pipeline",
      tier: 5,
      avenue: "planning-economy",
      window: 1500,
      rooms: {
        home: homeEast((b) => b.controller(25, 10).source(25, 40)),
        east: eastRoom((b) => b.controller(10, 10).source(25, 25)),
      },
      adjacency: { east: "E" },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: fullExts(EXT_8),
      assertions: [
        eventually("the planner mines the remote source", (s) => {
          const src = s.objects("east").find((o) => o.type === "source");
          if (!src) return false;
          const mines = (s.memory?.economyPlan?.corps ?? []).filter((c: any) => c.kind === "mine");
          if (mines.some((m: any) => m.sourceId === `source-${src._id}`)) remoteMinedSeen = true;
          return remoteMinedSeen;
        }),
        eventually("a miner works the remote source", (s) => {
          const src = s.objects("east").find((o) => o.type === "source");
          if (!src) return false;
          return (
            src.energy < src.energyCapacity &&
            s
              .objects("east")
              .some(
                (o) =>
                  o.type === "creep" &&
                  typeof o.name === "string" &&
                  o.name.startsWith("miner-") &&
                  Math.max(Math.abs(o.x - src.x), Math.abs(o.y - src.y)) <= 1
              )
          );
        }),
        eventually("the reserver is dispatched to the worked remote", (s) =>
          s.objects().some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("reserver-")) ||
          s
            .objects("east")
            .some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("reserver-"))
        ),

      ],
    },

    {
      // Source-Keeper exclusion: the scout records the keeper room's source,
      // and the planner must NEVER mine it - classification is by room name
      // (both coords % 10 in 4..6), so the rooms are PINNED: home W3N4, the
      // keeper room W4N4 to its west.
      id: "plan-t5-sk-never-mined",
      tier: 5,
      avenue: "planning-economy",
      window: 300,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(25, 10).source(30, 25);
          for (let y = 24; y <= 26; y++) b.tile(0, y, "plain"); // west exit
          return b.toRoom();
        },
        sk: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().source(25, 25);
          for (let y = 24; y <= 26; y++) b.tile(49, y, "plain"); // matching east gap
          return b.toRoom();
        },
      },
      pinnedRooms: { home: "W3N4", sk: "W4N4" },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      assertions: [
        eventually("the keeper room is scouted (exclusion is exercised)", (s) =>
          s.memory?.roomIntel?.["W4N4"] !== undefined
        ),
        always("the keeper source is never planned", (s) => {
          const src = s.objects("sk").find((o) => o.type === "source");
          if (!src) return true;
          return !(s.memory?.economyPlan?.corps ?? []).some(
            (c: any) => c.kind === "mine" && c.sourceId === `source-${src._id}`
          );
        }),
        always("no miner ever enters the keeper room", (s) =>
          !s
            .objects("sk")
            .some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("miner-"))
        ),
      ],
    },
  ];
}
