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

/** A serialized bootstrap corp with the deterministic per-room id, for
 * injection into Memory.bootstrapCorps["$room()"] - CorpRunner's get-or-
 * restore path rehydrates it, creepNames intact, so staged jacks are DRIVEN
 * by the corp rather than orphan-frozen. */
const bootstrapCorpMemory = (creepNames: string[], sourcePos: { x: number; y: number }) => ({
  id: "bootstrap-$room()-bootstrap",
  type: "bootstrap",
  nodeId: "$room()-bootstrap",
  balance: 1000,
  totalRevenue: 0,
  totalCost: 0,
  createdAt: 0,
  isActive: true,
  lastActivityTick: 0,
  unitsProduced: 0,
  expectedUnitsProduced: 0,
  unitsConsumed: 0,
  lastPlannedTick: 0,
  spawnId: "$id(home,spawn,25,25)",
  sourceId: `$id(home,source,${sourcePos.x},${sourcePos.y})`,
  creepNames,
  emergencyJackNames: [],
  lastSpawnAttempt: 0,
  lastEmergencyAttempt: 0,
  starvationStartTick: 0,
});

const standdownRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(15, 30).source(33, 25).toRoom();

const stagedJacks = () => [
  {
    name: "jack-a",
    x: 27,
    y: 25,
    body: ["work", "carry", "move"],
    memory: { workType: "harvest", corpId: "bootstrap-$room()-bootstrap" },
  },
  {
    name: "jack-b",
    x: 27,
    y: 26,
    body: ["work", "carry", "move"],
    memory: { workType: "harvest", corpId: "bootstrap-$room()-bootstrap" },
  },
];

export function buildChurnT2Cells(): GridCell[] {
  let stampSeen = false;

  return [
    {
      // The full churn arc, observed in phases: the orphan is STAMPED
      // (orphanedSince, the wait), then re-adopted the tick the ~10-tick
      // bootstrap solve commissions its source - readopt beats the 25-tick
      // grace with margin, and recycle never fires.
      id: "churn-readopt-after-resolve-churn",
      tier: 2,
      avenue: "churn-recovery",
      window: 40,
      rooms: { home: homeRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "om",
          x: 29,
          y: 25,
          body: ["work", "work", "move"],
          memory: { workType: "harvest", corpId: "mining-DEAD-harvest-0000", assignedSourceId: "$id(home,source,30,25)" },
        },
      ],
      assertions: [
        eventually("the wait phase is observed (orphanedSince stamped)", (s) => {
          if (s.memory?.creeps?.om?.orphanedSince !== undefined) stampSeen = true;
          return stampSeen;
        }),
        eventually("re-adopted before grace expires", (s) => {
          const corpId = s.memory?.creeps?.om?.corpId;
          return (
            stampSeen &&
            typeof corpId === "string" &&
            corpId.startsWith("mining-") &&
            !corpId.includes("DEAD") &&
            s.memory?.creeps?.om?.orphanedSince === undefined
          );
        }),
        always("never recycled", (s) => !!s.creep("om")),
      ],
    },

    {
      // The timed starvation path (distinct from the noHaulers bypass): a
      // scenery hauler suppresses the bypass, the bank is one-shot to 250,
      // and the starvation stopwatch must be recorded before the jack comes.
      id: "churn-jack-starvation-timer",
      tier: 2,
      avenue: "churn-recovery",
      window: 45,
      rooms: { home: standdownRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [{ name: "hauler-scenery", x: 45, y: 45, body: ["move", "carry"], memory: { workType: "haul" } }],
      async onTick(ctx) {
        if (ctx.tick === 1) {
          await ctx.db["rooms.objects"].update(
            { room: ctx.room(), type: "spawn" },
            { $set: { store: { energy: 250 } } }
          );
        }
      },
      assertions: [
        eventually("the starvation stopwatch is armed", (s) => {
          const corp = s.memory?.bootstrapCorps?.[s.room()];
          return (corp?.starvationStartTick ?? 0) > 0;
        }),
        eventually("a jack is fielded via the timed path", (s) =>
          s.objects().some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("jack-"))
        ),
      ],
    },

    {
      // Stand-down gate: with >=1 flow miner AND >=1 flow hauler visible,
      // existing jacks recycle and nothing respawns.
      id: "churn-jack-standdown-flow-established",
      tier: 2,
      avenue: "churn-recovery",
      window: 40,
      rooms: { home: standdownRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        ...stagedJacks(),
        { name: "miner-scenery", x: 43, y: 43, body: ["move"], memory: { workType: "harvest" } },
        { name: "hauler-scenery-1", x: 44, y: 44, body: ["move"], memory: { workType: "haul" } },
        { name: "hauler-scenery-2", x: 44, y: 45, body: ["move"], memory: { workType: "haul" } },
      ],
      memory: {
        bootstrapCorps: { "$room()": bootstrapCorpMemory(["jack-a", "jack-b"], { x: 33, y: 25 }) },
      },
      assertions: [
        eventually("both jacks recycled", (s) => !s.creep("jack-a") && !s.creep("jack-b")),
        always("no jack ever respawns", (s) => {
          if (s.tick < 30) return true;
          return !s
            .objects()
            .some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("jack-"));
        }),
      ],
    },

    {
      // The collapse regression: haulers alone (no flow miner) must NOT
      // stand the jacks down - they keep working the source.
      id: "churn-jack-no-standdown-haulers-only",
      tier: 2,
      avenue: "churn-recovery",
      window: 40,
      rooms: { home: standdownRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      // Pin the bank at 100: an ORGANIC flow miner (observed at tick 11)
      // would legitimately establish the flow and recycle the jacks - the
      // cell needs the flow to stay miner-less for its whole window.
      async onTick(ctx) {
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "spawn" },
          { $set: { store: { energy: 100 } } }
        );
      },
      creeps: [
        ...stagedJacks(),
        { name: "hauler-scenery-1", x: 43, y: 43, body: ["move"], memory: { workType: "haul" } },
        { name: "hauler-scenery-2", x: 44, y: 44, body: ["move"], memory: { workType: "haul" } },
        { name: "hauler-scenery-3", x: 44, y: 45, body: ["move"], memory: { workType: "haul" } },
      ],
      memory: {
        bootstrapCorps: { "$room()": bootstrapCorpMemory(["jack-a", "jack-b"], { x: 33, y: 25 }) },
      },
      assertions: [
        always("jacks stay alive through the window", (s) => !!s.creep("jack-a") && !!s.creep("jack-b")),
        eventually("jacks are driven, not stranded", (s) => {
          const a = s.creep("jack-a");
          const b = s.creep("jack-b");
          return (!!a && !(a.x === 27 && a.y === 25)) || (!!b && !(b.x === 27 && b.y === 26));
        }),
        eventually("the source is being worked", (s) => {
          const src = s.objects().find((o) => o.type === "source" && o.x === 33 && o.y === 25);
          return !!src && src.energy < 3000;
        }),
      ],
    },

    {
      // Anti-downgrade dispatch: a controller under 3000 ticks-to-downgrade
      // gets exactly ONE antidowngrade jack, ahead of the ordinary jack.
      id: "churn-antidowngrade-dispatch",
      tier: 2,
      avenue: "churn-recovery",
      window: 30,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(18, 25).source(32, 25).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      // Quiet kit: WITHOUT it a regular jack spawns, upgrades surplus, and
      // pushes downgradeTime past the 3000 trigger before the rescue path
      // fires (observed live). Job 2 runs before the yield branch, so the
      // rescue still dispatches in a yielded room.
      creeps: [
        { name: "decoy", x: 20, y: 20, body: ["carry", "move"], memory: { workType: "haul" } },
        { name: "filler1", x: 19, y: 20, body: ["move"] },
        { name: "filler2", x: 19, y: 21, body: ["move"] },
      ],
      async stage(ctx) {
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "controller" },
          { $set: { downgradeTime: ctx.gameTime + 2500 } }
        );
      },
      assertions: [
        eventually("the rescue jack is dispatched", (s) =>
          s
            .objects()
            .some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("antidowngrade-"))
        ),
        eventually("stamped as a bootstrap upgrader", (s) =>
          Object.entries(s.memory?.creeps ?? {}).some(
            ([name, mem]: [string, any]) =>
              name.startsWith("antidowngrade-") &&
              mem?.workType === "upgrade" &&
              typeof mem?.corpId === "string" &&
              mem.corpId.startsWith("bootstrap-")
          )
        ),
        always("never more than one rescue jack", (s) => {
          const count = s
            .objects()
            .filter((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("antidowngrade-"))
            .length;
          return count <= 1;
        }),
      ],
    },
  ];
}

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
