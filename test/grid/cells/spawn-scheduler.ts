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
