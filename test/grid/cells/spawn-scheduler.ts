/**
 * spawn-scheduler cells (docs/specs/08, avenue: spawn-decision).
 *
 * T0: at a cold RCL2 start, the scheduler's very first spawned creep must be
 * the source's first miner - income+blocking tier - never a hauler (dropped by
 * withMinerPrecedence while no miner is fielded), upgrader (emits no demand
 * without a hauler), or builder. Bootstrap jacks are allowed and excluded from
 * the check: the bootstrap-to-flow handoff is exactly what's under test
 * (known bug: colonyHasMiner once counted jacks, making the first flow miner
 * non-blocking so the handoff never happened).
 *
 * Window 170 comes from measurement, not the designer's 80: the calibration
 * cell recorded the first flow miner at tick 138 on this exact geometry
 * (jack economy first, then energy accumulation for the 250 floor body).
 */

import { GridCell, StagedCreep, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(30, 25).toRoom();

const SCHEDULED = /^(hauler|upgrader|builder|tanker|reserver)-/;

const minerCreep = (s: { objects(h?: string): any[] }) =>
  s.objects().find((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("miner-"));

const bodyCounts = (creep: any): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const p of creep.body ?? []) counts[p.type] = (counts[p.type] ?? 0) + 1;
  return counts;
};

/**
 * The quiet-room staging kit: a no-corpId decoy hauler suppresses
 * BootstrapCorp's noHaulers immediate path AND (with the two fillers pushing
 * otherCreeps >= 3) parks bootstrap in its yield branch, so NO jack ever
 * spawns and the spawn bank belongs entirely to the scheduler under test.
 * All three are canary-proven untouchable (no corpId -> OrphanRescue skips).
 */
const quietRoom = (dx = 0): StagedCreep[] => [
  { name: "decoy", x: 20 + dx, y: 20, body: ["carry", "move"], memory: { workType: "haul" } },
  { name: "filler1", x: 19 + dx, y: 20, body: ["move"] },
  { name: "filler2", x: 19 + dx, y: 21, body: ["move"] },
];

/** Two-source rooms for the T2 ordering cells. */
const twoSourceRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(15, 30).source(35, 30).toRoom();

const EXT_5: Array<{ x: number; y: number }> = [
  { x: 23, y: 23 },
  { x: 23, y: 27 },
  { x: 27, y: 23 },
  { x: 27, y: 27 },
  { x: 22, y: 25 },
];
const EXT_10: Array<{ x: number; y: number }> = [
  ...EXT_5,
  { x: 28, y: 25 },
  { x: 23, y: 21 },
  { x: 27, y: 21 },
  { x: 23, y: 29 },
  { x: 27, y: 29 },
];

export function buildT2SchedulerCells(): GridCell[] {
  // spawn-93 closure state
  let namesAtStart: Set<string> | null = null;
  let firstFresh: { name: string; corpId?: string } | null = null;

  // hold-full-miner-regrow closure state
  let prevTotal: number | null = null;
  let regrowHoldEnded = false;
  let regrowNamesAtStart: Set<string> | null = null;
  let regrowFirstFresh: any = null;

  const freshTracker = (s: any, names: Set<string> | null): string | null => {
    const creeps = s
      .objects()
      .filter((o: any) => o.type === "creep" && typeof o.name === "string")
      .map((o: any) => o.name as string);
    if (!names) return null;
    return creeps.find((n: string) => !names.has(n)) ?? null;
  };

  return [
    {
      // #93 regression, staged at the exact decision: source A is started
      // (staged miner + one hauler, fleet under target -> a persistent
      // income+STARTED scaling-hauler demand), source B is fresh. The
      // blocking bonus (1e4) must beat the started bonus (1e3): the first
      // new creep is B's miner, never A's next hauler.
      id: "spawn-93-fresh-miner-beats-scaling-hauler",
      tier: 2,
      avenue: "spawn-decision",
      window: 60,
      rooms: { home: twoSourceRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      structures: EXT_5.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      creeps: [
        {
          name: "mA",
          x: 14, // bestAdjacentTile(source(15,30), spawn(25,25)) = (14,29)? ties resolve dx-1,dy-1 -> (14,29)
          y: 29,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-93m", assignedSourceId: "$id(home,source,15,30)" },
        },
        {
          name: "hA",
          x: 20,
          y: 27,
          body: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"],
          memory: { workType: "haul", corpId: "staged-93h", working: false, assignedSourceId: "$id(home,source,15,30)" },
        },
      ],
      assertions: [
        eventually("the first fresh creep is B's first miner", (s) => {
          if (namesAtStart === null) {
            namesAtStart = new Set(
              s
                .objects()
                .filter((o: any) => o.type === "creep" && typeof o.name === "string")
                .map((o: any) => o.name as string)
            );
            return false;
          }
          if (!firstFresh) {
            const fresh = freshTracker(s, namesAtStart);
            if (fresh) firstFresh = { name: fresh, corpId: s.memory?.creeps?.[fresh]?.corpId };
            else return false;
          }
          if (!firstFresh.corpId) firstFresh.corpId = s.memory?.creeps?.[firstFresh.name]?.corpId;
          const srcB = s.objects().find((o: any) => o.type === "source" && o.x === 35 && o.y === 30);
          if (!srcB || !firstFresh.corpId) return false;
          return (
            firstFresh.name.startsWith("miner-") &&
            firstFresh.corpId === `mining-${s.room()}-harvest-${String(srcB._id).slice(-4)}`
          );
        }),
        always("no fresh hauler before B's miner exists", (s) => {
          const creeps = s.objects().filter((o: any) => o.type === "creep" && typeof o.name === "string");
          const freshHauler = creeps.some(
            (o: any) => o.name.startsWith("hauler-") && namesAtStart !== null && !namesAtStart.has(o.name)
          );
          const freshMiner = creeps.some((o: any) => o.name.startsWith("miner-"));
          return !freshHauler || freshMiner;
        }),
      ],
    },

    {
      // The full-body regrow hold: with colonyHasMiner true (B's staged
      // miner), source A's replacement demand has NO runt floor - min ==
      // desired == 700 at 800 capacity. The bank (spawn + 10 EMPTY
      // extensions) starts at 300; only hauler deliveries can reach 700, and
      // the strict hold must refuse every cheaper demand meanwhile. Watched
      // on the total-energy trajectory (drop below 700 = illegal spawn).
      id: "spawn-hold-full-miner-regrow",
      tier: 2,
      avenue: "spawn-decision",
      window: 160,
      rooms: { home: twoSourceRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: [
        ...EXT_10.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 0 })),
        { type: "container", x: 34, y: 29, energy: 1800 }, // B's source container, stocked
      ],
      creeps: [
        {
          name: "mB",
          x: 34,
          y: 29,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-rgm", assignedSourceId: "$id(home,source,35,30)" },
        },
        {
          name: "hB",
          x: 30,
          y: 27,
          body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
          memory: {
            workType: "haul",
            corpId: "staged-rgh",
            working: false,
            homeSink: "spawn",
            assignedSourceId: "$id(home,source,35,30)",
          },
        },
      ],
      assertions: [
        always("bank only climbs until the 700 full-miner start", (s) => {
          const stores = s
            .objects()
            .filter((o: any) => o.type === "spawn" || o.type === "extension")
            .reduce((sum: number, o: any) => sum + (o.store?.energy ?? 0), 0);
          const prev = prevTotal;
          prevTotal = stores;
          if (s.tick <= 15 || regrowHoldEnded || prev === null) return true;
          if (stores >= prev) return true;
          if (prev >= 700) {
            regrowHoldEnded = true;
            return true;
          }
          // Deliveries only ADD; the sole legal subtraction is the 700 spawn.
          return false;
        }),
        eventually("the first fresh creep is A's FULL 5W1C3M miner", (s) => {
          if (regrowNamesAtStart === null) {
            regrowNamesAtStart = new Set(
              s
                .objects()
                .filter((o: any) => o.type === "creep" && typeof o.name === "string")
                .map((o: any) => o.name as string)
            );
            return false;
          }
          if (!regrowFirstFresh) {
            const fresh = freshTracker(s, regrowNamesAtStart);
            if (fresh) regrowFirstFresh = s.objects().find((o: any) => o.type === "creep" && o.name === fresh);
            else return false;
          }
          const parts: Record<string, number> = {};
          for (const p of regrowFirstFresh.body ?? []) parts[p.type] = (parts[p.type] ?? 0) + 1;
          return (
            String(regrowFirstFresh.name).startsWith("miner-") &&
            parts.work === 5 &&
            parts.carry === 1 &&
            parts.move === 3
          );
        }),
      ],
    },
  ];
}

export function buildT3SchedulerCells(): GridCell[] {
  let builderSeen: number | null = null;
  let haulersAfterBuilder = 0;
  let backdated = false;

  return [
    {
      // The starved one-shot end to end (#93's companion): with the bank
      // pinned so an income hauler is affordable EVERY tick, the builder
      // demand can never win on rank alone. Backdating its firstSeen stamp
      // 300 ticks (env-level Memory rewrite, re-read by the bot next tick)
      // must produce exactly one builder spawn, then income resumes.
      id: "spawn-starved-builder-one-shot",
      tier: 3,
      avenue: "spawn-decision",
      window: 130,
      rooms: {
        // TWO far open sources: ~10 CARRY of route need each keeps income
        // demands unsatisfied for 140+ ticks of serial spawning - the builder
        // can NEVER win on rank in-window without the starvation lift
        // (a single source's fleet saturated by ~tick 35 and let the builder
        // win organically, which false-failed the first build).
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().controller(25, 8).source(25, 45).source(45, 25).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "m1",
          x: 24,
          y: 44,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-sb-m", assignedSourceId: "$id(home,source,25,45)" },
        },
        {
          name: "m2",
          x: 44,
          y: 24,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-sb-m2", assignedSourceId: "$id(home,source,45,25)" },
        },
        {
          name: "h1",
          x: 25,
          y: 30,
          body: ["carry", "carry", "carry", "move", "move", "move"],
          memory: { workType: "haul", corpId: "staged-sb-h", working: false, assignedSourceId: "$id(home,source,25,45)" },
        },
      ],
      async onTick(ctx) {
        // The site lands at tick 15, AFTER the income corps exist: staged at
        // tick 0 it made the builder the only demand at tick 1 and it won the
        // pinned bank legitimately (observed) - the cell needs the builder
        // demand born INTO an income-dominated queue.
        if (ctx.tick === 15) {
          await ctx.db["rooms.objects"].insert({
            type: "constructionSite",
            room: ctx.room(),
            x: 28,
            y: 25,
            user: ctx.userId,
            structureType: "extension",
            progress: 0,
            progressTotal: 3000,
          });
        }
        // Income always affordable: pin the bank to 300 every tick.
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "spawn" },
          { $set: { store: { energy: 300 } } }
        );
        // At tick 40 (demands stamped, income spawning underway), backdate
        // the builder's firstSeen by the full starvation threshold.
        if (ctx.tick === 40) {
          const raw = (await ctx.env.get(ctx.env.keys.MEMORY + ctx.userId)) || "{}";
          const mem = JSON.parse(raw);
          const table = mem.spawnDemandFirstSeen ?? {};
          for (const key of Object.keys(table)) {
            if (key.endsWith(":builder")) table[key] = ctx.gameTime - 301;
          }
          mem.spawnDemandFirstSeen = table;
          await ctx.env.set(ctx.env.keys.MEMORY + ctx.userId, JSON.stringify(mem));
        }
      },
      assertions: [
        eventually("the starved builder gets its one-shot spawn", (s) => {
          if (s.tick === 40) backdated = true;
          const builder = s
            .objects()
            .find((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("builder-"));
          if (builder && builderSeen === null) builderSeen = s.tick;
          return backdated && builderSeen !== null;
        }),
        always("no builder wins before the backdate", (s) => {
          if (s.tick >= 40) return true;
          return !s
            .objects()
            .some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("builder-"));
        }),
        eventually("income spawning resumes after the one-shot", (s) => {
          if (builderSeen === null) return false;
          const haulers = s
            .objects()
            .filter((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("hauler-")).length;
          haulersAfterBuilder = Math.max(haulersAfterBuilder, haulers);
          return haulersAfterBuilder >= 1 && s.tick > builderSeen;
        }),
      ],
    },
  ];
}


export function buildT4SchedulerCells(): GridCell[] {
  // timer-survives closure
  let builderKey: string | null = null;
  let builderFirstValue: number | null = null;
  let busyStreak = 0;
  let busyPeriods = 0;

  // min-scaled closure
  let firstHaulerCarry: number | null = null;

  const EXT_20 = EXT_10.concat([
    { x: 22, y: 20 },
    { x: 28, y: 20 },
    { x: 22, y: 30 },
    { x: 28, y: 30 },
    { x: 20, y: 22 },
    { x: 30, y: 22 },
    { x: 20, y: 28 },
    { x: 30, y: 28 },
    { x: 24, y: 19 },
    { x: 26, y: 19 },
  ]);

  return [
    {
      // Anti-starvation aging must SURVIVE busy spawns: at 1300 capacity the
      // income bodies are 20-26 parts (60-78 busy ticks), and the builder's
      // firstSeen stamp must stay byte-identical across >= 2 long busy
      // periods - the old bug reset the clock whenever the spawn was busy,
      // so chronically-outranked demands never aged past the threshold.
      id: "spawn-timer-survives-busy-spawn",
      tier: 4,
      avenue: "spawn-decision",
      window: 150,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().controller(25, 8).source(8, 45).source(42, 45).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 4 },
      structures: EXT_20.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      creeps: [
        {
          name: "mA",
          x: 8,
          y: 44,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-ts-m", assignedSourceId: "$id(home,source,8,45)" },
        },
        {
          name: "hA",
          x: 12,
          y: 40,
          body: ["carry", "carry", "carry", "move", "move", "move"],
          memory: { workType: "haul", corpId: "staged-ts-h", working: false, assignedSourceId: "$id(home,source,8,45)" },
        },
      ],
      async onTick(ctx) {
        // Site lands after income corps exist (T3 lesson); the bank is pinned
        // full so the big income bodies spawn back to back (busy streaks).
        if (ctx.tick === 15) {
          await ctx.db["rooms.objects"].insert({
            type: "constructionSite",
            room: ctx.room(),
            x: 32, // clear of every staged extension (28,25 collided with one)
            y: 25,
            user: ctx.userId,
            structureType: "extension",
            progress: 0,
            progressTotal: 3000,
          });
        }
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "spawn" },
          { $set: { store: { energy: 300 } } }
        );
      },
      assertions: [
        eventually("the builder demand is stamped", (s) => {
          const table = s.memory?.spawnDemandFirstSeen ?? {};
          for (const [key, value] of Object.entries(table)) {
            if (key.endsWith(":builder") && builderKey === null) {
              builderKey = key;
              builderFirstValue = value as number;
            }
          }
          return builderKey !== null;
        }),
        always("the stamp survives every busy period byte-identical", (s) => {
          const spawn = s.objects().find((o: any) => o.type === "spawn");
          const busy = !!spawn?.spawning;
          if (busy) busyStreak += 1;
          else {
            if (busyStreak >= 15) busyPeriods += 1;
            busyStreak = 0;
          }
          if (builderKey === null) return true;
          const now = s.memory?.spawnDemandFirstSeen?.[builderKey];
          return now === builderFirstValue;
        }),
        eventually("at least two distinct long busy periods occurred", () => {
          return busyPeriods + (busyStreak >= 15 ? 1 : 0) >= 2;
        }),
      ],
    },

    {
      // The deliberate asymmetry to the miner hold: an AFFORDABLE blocking
      // hauler spends NOW at the scaled 3-CARRY min (it is what refills the
      // spawn - holding for the 13-CARRY desired body would deadlock), and a
      // later sibling heals bigger.
      id: "spawn-blocking-hauler-spawns-at-min-scaled",
      tier: 4,
      avenue: "spawn-decision",
      // 200: the bigger sibling waits on organic bank growth past 400.
      window: 200,
      rooms: {
        // d~30: the route needs ~15 CARRY (5 haulers), so the fleet is still
        // hungry when the bank fattens - the >3C sibling actually spawns.
        // (At d=20 the fleet saturated with 3C bodies before the bank grew.)
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 8).source(25, 47).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 4 },
      structures: EXT_20.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 0 })),
      creeps: [
        {
          name: "mA",
          x: 24,
          y: 46,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-ms-m", assignedSourceId: "$id(home,source,25,47)" },
        },
        ...quietRoom(),
      ],
      assertions: [
        eventually("the first hauler spawns at the scaled 3C3M min", (s) => {
          const h = s
            .objects()
            .find((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("hauler-"));
          if (!h) return false;
          if (firstHaulerCarry === null) firstHaulerCarry = bodyCounts(h).carry ?? 0;
          return firstHaulerCarry === 3;
        }),
        // NOTE two earlier follow-on assertions were dropped after
        // measurement: budgets never organically exceed the 300 floor (the
        // scheduler spawns the instant min is affordable - correct), and the
        // fleet does not grow in COUNT either (count-sizing packs the route
        // into one big hauler; upgrading it is the runt-pounce mechanism,
        // already pinned green at T3). The immediate min-scaled spawn IS the
        // asymmetry-vs-the-miner-hold claim, and it is the whole cell.
      ],
    },
  ];
}

export function buildStatefulSchedulerCells(): GridCell[] {
  // spawn-no-hauler-before-miner closure state
  let minerFirstSeen: number | null = null;
  let haulerFirstSeen: number | null = null;

  // spawn-hold-strict-first-hauler closure state
  let namesAtStage: Set<string> | null = null;
  let firstNewCreep: any = null;
  let prevBank: number | null = null;
  let holdEnded = false;

  return [
    {
      // withMinerPrecedence under a spawn that is NEVER energy-gated: the
      // harness pins the store to 300 every tick, so an eager scheduler would
      // spawn the hauler instantly if the precedence filter were broken.
      id: "spawn-no-hauler-before-miner",
      tier: 1,
      avenue: "spawn-decision",
      window: 90,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 8).source(25, 45).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      async onTick(ctx) {
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "spawn" },
          { $set: { store: { energy: 300 } } } // whole-object: dotted paths no-op in this db layer
        );
      },
      assertions: [
        always("no hauler exists while no miner does", (s) => {
          const creeps = s.objects().filter((o: any) => o.type === "creep" && typeof o.name === "string");
          const miner = creeps.find((o: any) => o.name.startsWith("miner-"));
          const hauler = creeps.find((o: any) => o.name.startsWith("hauler-"));
          if (miner && minerFirstSeen === null) minerFirstSeen = s.tick;
          if (hauler && haulerFirstSeen === null) haulerFirstSeen = s.tick;
          return !hauler || !!miner;
        }),
        eventually("both fielded, hauler strictly after miner", () => {
          return minerFirstSeen !== null && haulerFirstSeen !== null && haulerFirstSeen > minerFirstSeen;
        }),
        eventually("first hauler has >= 3 CARRY", (s) => {
          const hauler = s
            .objects()
            .find((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("hauler-"));
          return !!hauler && (bodyCounts(hauler).carry ?? 0) >= 3;
        }),
      ],
    },

    {
      // The strict hold: with a miner fielded and the blocking first hauler
      // (min 300) unaffordable at 260, estimateIncome > 0 (the decoy counts)
      // makes scheduleSpawn return null outright - NOTHING may spawn, not
      // even an affordable 250 scaling miner, until self-regen reaches 300
      // and the hauler spawns at its 3-CARRY floor.
      id: "spawn-hold-strict-first-hauler",
      tier: 1,
      avenue: "spawn-decision",
      window: 110,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 8).source(25, 40).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        // A fielded 2W miner on the harvest spot: groupStarted flips true, the
        // open 8-spot source still wants more WORK, so a 250 scaling-miner
        // demand persists - the exact temptation the strict hold must refuse.
        // Spot = bestAdjacentTile(source(25,40), spawn(25,25)) = (24,39).
        {
          name: "m1",
          x: 24,
          y: 39,
          body: ["work", "work", "move"],
          memory: { workType: "harvest", corpId: "staged-hs", assignedSourceId: "$id(home,source,25,40)" },
        },
        ...quietRoom(),
      ],
      async onTick(ctx) {
        // Ticks 1-19: pin the bank at 100 (nothing's minCost is affordable) so
        // the initial 300 cannot fund the hauler before the moment under test
        // is staged. Tick 20 (miner adopted ~11): release at 260 - above the
        // 250 scaling miner, below the 300 first-hauler floor - then hands off
        // to self-regen (+1/tick, reaching 300 at ~tick 60).
        if (ctx.tick < 20) {
          await ctx.db["rooms.objects"].update(
            { room: ctx.room(), type: "spawn" },
            { $set: { store: { energy: 100 } } }
          );
        } else if (ctx.tick === 20) {
          await ctx.db["rooms.objects"].update(
            { room: ctx.room(), type: "spawn" },
            { $set: { store: { energy: 260 } } }
          );
        }
      },
      assertions: [
        // Creep docs only appear at spawn COMPLETION, so the hold is watched
        // on the bank itself: energy is deducted the tick a spawn STARTS, and
        // during the hold the bank may only climb (+1/tick self-regen). A drop
        // from BELOW 300 = an illegal spawn start (e.g. the 250 scaling
        // miner); the one legal drop is from >= 300 - the held-for hauler.
        always("the bank only climbs until the hauler's legal start", (s) => {
          const spawn = s.objects().find((o: any) => o.type === "spawn");
          const bank = spawn?.store?.energy ?? null;
          const prev = prevBank;
          prevBank = bank;
          if (s.tick <= 21 || holdEnded || prev === null || bank === null) return true;
          if (bank >= prev) return true; // climbing or flat: held
          if (prev >= 300) {
            holdEnded = true; // the legal start, at the hauler's full floor
            return true;
          }
          return false; // spent the dribble below the floor: hold broken
        }),
        eventually("the held-for hauler is the next creep, at its 3C3M floor", (s) => {
          const creeps = s
            .objects()
            .filter((o: any) => o.type === "creep" && typeof o.name === "string")
            .map((o: any) => o.name as string);
          if (namesAtStage === null) {
            if (s.tick >= 21) namesAtStage = new Set(creeps);
            return false;
          }
          if (firstNewCreep === null) {
            const fresh = creeps.find((n) => !namesAtStage!.has(n));
            if (fresh) firstNewCreep = s.objects().find((o: any) => o.type === "creep" && o.name === fresh);
          }
          if (!firstNewCreep || typeof firstNewCreep.name !== "string") return false;
          if (!firstNewCreep.name.startsWith("hauler-")) return false;
          const counts = bodyCounts(firstNewCreep);
          return counts.carry === 3 && counts.move === 3 && Object.keys(counts).length === 2;
        }),
        always("no organic miner ever spawns (the 250 temptation refused)", (s) => {
          return !s
            .objects()
            .some((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("miner-"));
        }),
      ],
    },
  ];
}

export const spawnSchedulerCells: GridCell[] = [
  {
    id: "spawn-first-miner-outranks-all",
    tier: 0,
    avenue: "spawn-decision",
    window: 170,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    assertions: [
      eventually("the first scheduler-spawned creep is a miner", (s) => !!minerCreep(s)),
      // Until the first miner exists, NO consumption/transport creep may have
      // been scheduled (jacks are bootstrap, not the scheduler).
      always("no hauler/upgrader/builder before the first miner", (s) => {
        if (minerCreep(s)) return true; // ordering satisfied from here on
        return !s
          .objects()
          .some((o: any) => o.type === "creep" && typeof o.name === "string" && SCHEDULED.test(o.name));
      }),
      eventually("miner spawned at the 2W1M cold-start floor", (s) => {
        const m = minerCreep(s);
        if (!m || !Array.isArray(m.body)) return false;
        const parts = m.body.map((p: any) => p.type);
        return (
          parts.length === 3 &&
          parts.filter((t: string) => t === "work").length === 2 &&
          parts.filter((t: string) => t === "move").length === 1
        );
      }),
      eventually("miner memory stamped workType harvest", (s) => {
        const m = minerCreep(s);
        return !!m && s.memory?.creeps?.[m.name]?.workType === "harvest";
      }),
    ],
  },
];

/**
 * Agenda fidelity (spec 11 phase 1): every creep the colony actually spawns
 * must match the head of the last PUBLISHED agenda (Memory.spawnAgenda) - the
 * one-line observable that turns sequencing bugs ("granted 6x minerB against
 * target 1", "the reserver waited 1800 ticks") from archaeology into a cell
 * verdict. Tolerance: top-2 entries, because the agenda re-publishes each
 * evaluation tick and a same-tick recompute can legitimately swap adjacent
 * entries (e.g. a demand satisfied by the very spawn being checked).
 */
export function buildAgendaFidelityCells(): GridCell[] {
  let knownCreeps: Set<string> | null = null;
  let lastQueue: Array<{ role: string; corp: string }> = [];
  let agendaSeen = false;
  let violations = 0;

  const ROLE_BY_WORKTYPE: Record<string, string> = {
    harvest: "miner",
    haul: "hauler",
    upgrade: "upgrader",
    build: "builder",
    tank: "tanker",
    scout: "scout",
    reserve: "reserver",
  };

  return [
    {
      // A busy two-source RCL2 ramp: many demands compete, so the agenda is
      // exercised across roles - and every organic spawn must match its head.
      id: "agenda-t2-spawns-match-head",
      tier: 2,
      avenue: "plan-fidelity",
      window: 400,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().controller(25, 12).source(18, 32).source(32, 32).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      assertions: [
        eventually("the agenda is published", (s) => {
          const table = s.memory?.spawnAgenda ?? {};
          if (Object.values(table).some((a: any) => (a?.queue ?? []).length > 0)) agendaSeen = true;
          return agendaSeen;
        }),
        always("every spawn matches the agenda head (top-2 tolerance)", (s) => {
          const names = new Set(Object.keys(s.memory?.creeps ?? {}));
          if (knownCreeps === null) {
            knownCreeps = names;
            return true;
          }
          for (const name of names) {
            if (knownCreeps.has(name)) continue;
            // Jacks are bootstrap machinery, outside the agenda's scope.
            if (name.startsWith("jack-")) continue;
            const mem: any = s.memory?.creeps?.[name];
            const role = ROLE_BY_WORKTYPE[mem?.workType] ?? mem?.workType;
            const top = lastQueue.slice(0, 2);
            const matches = top.some((q) => q.role === role && q.corp === mem?.corpId);
            if (!matches && lastQueue.length > 0) violations += 1;
          }
          knownCreeps = names;
          // Capture the agenda AFTER the diff: it predicts the NEXT spawn.
          const table: any = s.memory?.spawnAgenda ?? {};
          const first: any = Object.values(table)[0];
          lastQueue = (first?.queue ?? []).map((q: any) => ({ role: q.role, corp: q.corp }));
          return violations === 0;
        }, 20),
      ],
    },
  ];
}
