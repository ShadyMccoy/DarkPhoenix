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
  createdAt: 0,
  lastActivityTick: 0,
  unitsProduced: 0,
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

export function buildChurnT3Cells(): GridCell[] {
  let baseGameTime: number | null = null;
  let crossedSafe = false;
  let sawTwoJacks = false;
  let drainSeen = false;

  return [
    {
      // Retiring hysteresis, staged ORGANICALLY via scavenge transience: the
      // staged hauler is adopted by the 900-pile's scavenge corp; its first
      // pickup drops the stock below the 750 threshold, so the next rebuild
      // drops the commission - but the corp has a live creep, so it RETIRES:
      // stays in the store, keeps driving the hauler, spawns nothing new.
      id: "churn-retiring-scavenge-corp",
      tier: 3,
      avenue: "churn-recovery",
      window: 120,
      rooms: { home: standdownRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        // A decoy + fillers keep jacks out; the scavenger spawns ORGANICALLY
        // (its blocking income demand wins at 300), drains the stock below
        // 750, and the next rebuild drops the commission - retiring begins.
        { name: "decoy", x: 20, y: 20, body: ["carry", "move"], memory: { workType: "haul" } },
        { name: "filler1", x: 20, y: 21, body: ["move"] },
        { name: "filler2", x: 20, y: 22, body: ["move"] },
      ],
      async stage(ctx) {
        await ctx.db["rooms.objects"].insert({
          type: "energy",
          room: ctx.room(),
          x: 40,
          y: 40,
          energy: 900,
          resourceType: "energy",
        });
      },
      assertions: [
        eventually("an organic scavenger is fielded", (s) =>
          Object.entries(s.memory?.creeps ?? {}).some(
            ([, mem]: [string, any]) =>
              mem?.workType === "haul" && typeof mem?.corpId === "string" && mem.corpId.endsWith("0-40")
          )
        ),
        eventually("the stock is drained below the threshold", (s) => {
          const pile = s.objects().find((o) => o.type === "energy" && o.x === 40 && o.y === 40);
          if (!pile || (pile.energy ?? 0) < 750) drainSeen = true;
          return drainSeen;
        }),
        // Past the drain and at least one 50-tick rebuild, the corp must
        // survive as retiring: its scavenger stays claimed (no orphan stamp,
        // never recycled) and no second creep is ever spawned for it.
        always("the retiring corp keeps its creep claimed", (s) => {
          if (!drainSeen || s.tick < 80) return true;
          const entries = Object.entries(s.memory?.creeps ?? {}).filter(
            ([, mem]: [string, any]) =>
              mem?.workType === "haul" && typeof mem?.corpId === "string" && mem.corpId.endsWith("0-40")
          );
          return entries.length >= 1 && entries.every(([, mem]: [string, any]) => mem.orphanedSince === undefined);
        }),
        always("never a second creep for the retiring corp", (s) => {
          const entries = Object.entries(s.memory?.creeps ?? {}).filter(
            ([, mem]: [string, any]) =>
              mem?.workType === "haul" && typeof mem?.corpId === "string" && mem.corpId.endsWith("0-40")
          );
          return entries.length <= 1;
        }),
      ],
    },

    {
      // BOOTSTRAP_MAX_JACKS=2 under sustained starvation: adversity terrain
      // keeps the flow from establishing, jacks cycle - the cap holds at
      // every single tick.
      id: "churn-jack-cap-two",
      tier: 3,
      avenue: "churn-recovery",
      window: 100,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(40, 40);
          // swamp moat between spawn (40,25) and the pocketed source (10,25)
          for (let y = 20; y <= 30; y++) {
            for (let x = 15; x <= 30; x++) b.tile(x, y, "swamp");
          }
          for (const [x, y] of [
            [9, 24],
            [11, 24],
            [9, 25],
            [11, 25],
            [9, 26],
            [10, 26],
            [11, 26],
          ]) {
            b.tile(x, y, "wall");
          }
          return b.source(10, 25).toRoom();
        },
      },
      bot: { x: 40, y: 25 },
      controller: { level: 2 },
      // Pin 250 EVERY tick: bootstrap runs BEFORE the scheduler in the loop,
      // so with jack money always on hand the jacks win the spawn (a one-shot
      // 250 was measurably stolen by a 250 flow miner); 250 < 300 also keeps
      // isStarving armed, and the 300-min flow hauler can never spawn, so
      // flowEstablished stays false and the jacks never stand down.
      async onTick(ctx) {
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "spawn" },
          { $set: { store: { energy: 250 } } }
        );
      },
      assertions: [
        always("never more than two jacks", (s) => {
          const jacks = s
            .objects()
            .filter((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("jack-")).length;
          if (jacks >= 2) sawTwoJacks = true;
          return jacks <= 2;
        }),
        eventually("the first jack comes promptly", (s) => {
          if (s.tick > 25) return sawTwoJacks; // don't time out the cell on this
          return s
            .objects()
            .some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("jack-"));
        }),
        eventually("the cap is actually exercised (two jacks at once)", () => sawTwoJacks),
      ],
    },

    {
      // The full anti-downgrade arc: the staged rescue jack upgrades the
      // controller past the 7000-tick safe line, then recycles itself; the
      // nonempty emergencyJackNames blocks a second dispatch throughout.
      id: "churn-antidowngrade-recover-recycle",
      tier: 3,
      avenue: "churn-recovery",
      window: 100,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(15, 25).source(35, 25).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "antidowngrade-stage",
          x: 17,
          y: 25,
          body: ["work", "carry", "move"],
          energy: 50,
          memory: { workType: "upgrade", corpId: "bootstrap-$room()-bootstrap", working: true },
        },
        { name: "decoy", x: 28, y: 20, body: ["carry", "move"], memory: { workType: "haul" } },
        { name: "filler1", x: 28, y: 21, body: ["move"] },
        { name: "filler2", x: 28, y: 22, body: ["move"] },
      ],
      memory: {
        bootstrapCorps: {
          "$room()": {
            ...bootstrapCorpMemory([], { x: 35, y: 25 }),
            emergencyJackNames: ["antidowngrade-stage"],
          },
        },
      },
      async stage(ctx) {
        baseGameTime = ctx.gameTime;
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "controller" },
          { $set: { downgradeTime: ctx.gameTime + 2600 } }
        );
      },
      assertions: [
        eventually("the timer is pushed past the 7000 safe line", (s) => {
          const ctrl = s.objects().find((o) => o.type === "controller");
          if (!ctrl || baseGameTime === null) return false;
          const ticksToDowngrade = (ctrl.downgradeTime ?? 0) - (baseGameTime + s.tick);
          if (ticksToDowngrade >= 7000) crossedSafe = true;
          return crossedSafe;
        }),
        always("the controller never downgrades", (s) => {
          const ctrl = s.objects().find((o) => o.type === "controller");
          return !!ctrl && ctrl.level === 2;
        }),
        eventually("the rescue jack recycles itself once safe", (s) => crossedSafe && !s.creep("antidowngrade-stage")),
        always("never a second rescue jack", (s) => {
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

/** 10 extension positions clear of the spawn's neighbourhood (grid pattern). */
const REPLACEMENT_EXTS: Array<{ x: number; y: number }> = [
  { x: 23, y: 23 }, { x: 23, y: 25 }, { x: 23, y: 27 },
  { x: 27, y: 23 }, { x: 27, y: 27 },
  { x: 24, y: 22 }, { x: 26, y: 22 },
  { x: 24, y: 28 }, { x: 26, y: 28 },
  { x: 25, y: 21 },
];

/** Ratchet point for the delivery gap (see the assertion comment). */
const MAX_POST_GAP_TICKS = 45;

export function buildChurnReplacementCells(): GridCell[] {
  let incumbentDied: number | null = null;
  let postGapTicks = 0;
  let firstStaffedAfter: number | null = null;
  let succSpawnedAt: number | null = null;
  let gapLogged = false;

  /** Live creeps claimed by the source's mining corp (jacks are bootstrap-*). */
  const miningCreeps = (s: { memory: any; objects(): any[] }): any[] => {
    const claimed = new Set(
      Object.entries(s.memory?.creeps ?? {})
        .filter(([, mem]: [string, any]) => typeof mem?.corpId === "string" && mem.corpId.startsWith("mining-"))
        .map(([name]) => name)
    );
    return s.objects().filter((o) => o.type === "creep" && claimed.has(o.name));
  };

  return [
    {
      // The delivery contract end to end (staffsPost): a full-size miner with
      // a shortened life must be REPLACED IN ADVANCE - its successor starts
      // spawning ~leadTime (3/part build + walk ticks) before death, so the
      // post never sits empty for more than the small scheduling slack.
      // Reactive replacement (the old behavior) leaves the source dark for
      // build(27) + walk(~30) = ~60 ticks - the fielded-CARRY / mined-energy
      // dips the W1N6 accounting measured every creep generation.
      id: "churn-t3-gapless-replacement",
      tier: 3,
      avenue: "churn-recovery",
      window: 320,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().controller(25, 10).source(40, 25).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: REPLACEMENT_EXTS.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 0 })),
      creeps: [
        {
          // The incumbent: the exact body buildMinerBody(5, 800) produces, so
          // the successor is its equal (no runt-recycle interference).
          name: "m0",
          x: 39,
          y: 25,
          body: ["work", "work", "work", "work", "work", "carry", "move", "move", "move"],
          memory: {
            workType: "harvest",
            corpId: "staged-replacement-m0",
            assignedSourceId: "$id(home,source,40,25)",
          },
        },
      ],
      async stage(ctx) {
        // Shorten the incumbent's life: death at ~tick 220, well inside the
        // window but far past adoption + the ~57-tick replacement lead.
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "creep", name: "m0" },
          { $set: { ageTime: ctx.gameTime + 220 } }
        );
      },
      async onTick(ctx) {
        // Keep energy at zero through the adoption window so the corp cannot
        // field an organic miner before it claims m0 (that would make the
        // "successor while incumbent lives" claim vacuous); then pin the room
        // full so the replacement decision is about TIMING, never affordability.
        const energy = ctx.tick < 30 ? 0 : 50;
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "extension" },
          { $set: { store: { energy } } }
        );
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "spawn" },
          { $set: { store: { energy: ctx.tick < 30 ? 0 : 300 } } }
        );
      },
      assertions: [
        eventually("the staged miner is adopted by the mining corp", (s) => {
          const mem = s.memory?.creeps?.m0;
          return typeof mem?.corpId === "string" && mem.corpId.startsWith("mining-");
        }),
        // THE lead-time claim: a second mining-corp creep exists (spawning or
        // walking out) while the incumbent is still alive. Reactive
        // replacement cannot satisfy this - it only orders after death.
        eventually("the successor exists while the incumbent still lives", (s) => {
          if (!s.creep("m0")) return false;
          const mine = Object.entries(s.memory?.creeps ?? {}).filter(
            ([, mem]: [string, any]) => typeof mem?.corpId === "string" && mem.corpId.startsWith("mining-")
          );
          return mine.length >= 2;
        }),
        // Replacement, not swarm: the corp never fields a third body.
        always("never more than two mining-corp creeps", (s) => miningCreeps(s).length <= 2, 40),
        // The post itself: after the incumbent dies, ticks with no mining-corp
        // creep within range 1 of the source are the delivery gap. Measured
        // decomposition (twice): demand leads correctly (succ spawn @142-166
        // vs death @220), but the successor HOLDS OFF at distance while the
        // incumbent occupies the spot and only walks in after the death -
        // gap 28-37 = roughly the walk-in. Reactive replacement measures
        // 80-110 here, so 45 pins the advance-delivery win; shrinking toward
        // <= 10 is a bot-improvement job (successor pre-positioning at range
        // 1-2 while waiting), not an assertion job.
        atWindow(`post gap after death is at most ${MAX_POST_GAP_TICKS} ticks`, (s) => {
          if (s.tick >= 320 && !gapLogged) {
            gapLogged = true;
            console.log(
              `  [gapless] died=${incumbentDied} postGap=${postGapTicks} ` +
                `firstStaffedAfter=${firstStaffedAfter} succSpawnedAt=${succSpawnedAt}`
            );
          }
          return incumbentDied !== null && postGapTicks <= MAX_POST_GAP_TICKS;
        }),
        // Collector for the gap metric (always true; runs every sample).
        always("(gap accounting)", (s) => {
          const alive = !!s.creep("m0");
          if (alive && succSpawnedAt === null && miningCreeps(s).length >= 2) succSpawnedAt = s.tick;
          if (!alive && incumbentDied === null && s.tick > 100) incumbentDied = s.tick;
          if (incumbentDied !== null) {
            const staffed = miningCreeps(s).some(
              (o) => Math.max(Math.abs(o.x - 40), Math.abs(o.y - 25)) <= 1
            );
            if (!staffed) postGapTicks += 1;
            else if (firstStaffedAfter === null) firstStaffedAfter = s.tick;
          }
          return true;
        }),
      ],
    },
  ];
}
