/**
 * spawn-exec cells (docs/specs/08, avenue: spawn-execution).
 *
 * T0: the first flow miner's memory stamp must resolve to a live commissioned
 * corp (the flow-id prefix regressions: harvestKind.materialize must strip
 * 'source-' or the spawned miner's corpId never resolves and it freezes), and
 * the cold-start floor body is 2W1M within the 300 budget.
 *
 * The decoy hauler applies the reviewer's fix (errata wrong-behavior #4 /
 * infeasible #3 pattern): workType 'haul' with NO corpId suppresses
 * BootstrapCorp's jack path from tick 1 (it counts haul-workType creeps)
 * while OrphanRescue provably never adopts or recycles it - so the spawn's
 * 300 energy is untouched and the first spawn IS the flow miner, giving this
 * cell a tight, deterministic window.
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

/** Source pocketed to one mining spot: walls on all neighbours except north. */
const homeRoom = (roomName: string) => {
  const b = new RoomBuilder(roomName).border().controller(35, 20);
  // pocket(19,25): 8 neighbours walled except the (19,24) opening
  for (const [x, y] of [
    [18, 24],
    [20, 24],
    [18, 25],
    [20, 25],
    [18, 26],
    [19, 26],
    [20, 26],
  ]) {
    b.tile(x, y, "wall");
  }
  return b.source(19, 25).toRoom();
};

const minerEntries = (s: { memory: any }): Array<[string, any]> =>
  Object.entries(s.memory?.creeps ?? {}).filter(([name]) => name.startsWith("miner-"));

const bodyCounts = (creep: any): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const p of creep.body ?? []) counts[p.type] = (counts[p.type] ?? 0) + 1;
  return counts;
};

const firstMinerDoc = (s: { objects(h?: string): any[] }) =>
  s.objects().find((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("miner-"));

/** Quiet-room kit (see spawn-scheduler.ts): no jacks, untouched spawn bank. */
const quiet = (): Array<{ name: string; x: number; y: number; body: string[]; memory?: any }> => [
  { name: "decoy", x: 20, y: 20, body: ["carry", "move"], memory: { workType: "haul" } },
  { name: "filler1", x: 19, y: 20, body: ["move"] },
  { name: "filler2", x: 19, y: 21, body: ["move"] },
];

/** Pocketed source at (15,25): all neighbours walled except the (15,24) opening. */
const pocketRoom = () => (roomName: string) => {
  const b = new RoomBuilder(roomName).border().controller(35, 20);
  for (const [x, y] of [
    [14, 24],
    [16, 24],
    [14, 25],
    [16, 25],
    [14, 26],
    [15, 26],
    [16, 26],
  ]) {
    b.tile(x, y, "wall");
  }
  return b.source(15, 25).toRoom();
};

const EXT_5: Array<{ x: number; y: number }> = [
  { x: 23, y: 23 },
  { x: 23, y: 25 },
  { x: 23, y: 27 },
  { x: 27, y: 23 },
  { x: 27, y: 27 },
];
const EXT_8: Array<{ x: number; y: number }> = [...EXT_5, { x: 27, y: 25 }, { x: 24, y: 22 }, { x: 26, y: 22 }];

const fullExtensions = (positions: Array<{ x: number; y: number }>) =>
  positions.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 }));

export const spawnExecT1Cells: GridCell[] = [
  {
    // 550 capacity sits BELOW MINER_CARRY_MIN_CAPACITY=600: the scaled miner
    // is exactly 4W2M (500) with ZERO CARRY - the link-feed CARRY must not
    // appear early (BodyBuilder.ts:61-73).
    id: "spawnexec-miner-body-550",
    tier: 1,
    avenue: "spawn-execution",
    window: 45,
    rooms: { home: pocketRoom() },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    structures: fullExtensions(EXT_5),
    creeps: quiet(),
    assertions: [
      eventually("miner scaled to 4W2M at 550 capacity", (s) => {
        const m = firstMinerDoc(s);
        if (!m) return false;
        const c = bodyCounts(m);
        return c.work === 4 && c.move === 2 && Object.keys(c).length === 2;
      }),
      always("no miner ever carries CARRY below the 600 threshold", (s) => {
        const m = firstMinerDoc(s);
        return !m || (bodyCounts(m).carry ?? 0) === 0;
      }),
    ],
  },

  {
    // Across the 600 boundary (errata wrong-behavior #1: restaged at 700,
    // where the demand's desired body AND the executor's rebuild both clear
    // MINER_CARRY_MIN_CAPACITY): the miner gains its link-feed CARRY -
    // buildMinerBody(5, 700) = 5W1C3M, verified against BodyBuilder source.
    id: "spawnexec-miner-carry-700-boundary",
    tier: 1,
    avenue: "spawn-execution",
    window: 55,
    rooms: { home: pocketRoom() },
    bot: { x: 25, y: 25 },
    controller: { level: 3 },
    structures: fullExtensions(EXT_8),
    creeps: quiet(),
    assertions: [
      eventually("miner crosses the boundary as 5W1C3M", (s) => {
        const m = firstMinerDoc(s);
        if (!m) return false;
        const c = bodyCounts(m);
        return c.work === 5 && c.carry === 1 && c.move === 3;
      }),
    ],
  },

  {
    // The prefix-strip grouping end to end: a fielded (staged+adopted) miner
    // must flip the carry demand's groupStarted via the stripped source key,
    // or withMinerPrecedence silently drops every hauler demand forever and
    // the mined energy strands ('miner mines, energy piles, no hauler ever').
    id: "spawnexec-first-hauler-group-prefix",
    tier: 1,
    avenue: "spawn-execution",
    window: 70,
    rooms: { home: pocketRoom() },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    structures: fullExtensions(EXT_5),
    creeps: [
      // On the pocket's only opening - the harvest spot - so the corp counts
      // it as fielded the moment OrphanRescue hands it over.
      {
        name: "m1",
        x: 15,
        y: 24,
        body: ["work", "work", "work", "work", "move"],
        memory: { workType: "harvest", corpId: "stale-x", assignedSourceId: "$id(home,source,15,25)" },
      },
      // No decoy: the blocking first-hauler demand IS the subject; one
      // bootstrap jack is tolerated (excluded by name).
    ],
    assertions: [
      eventually("first hauler spawned with the full corp stamp", (s) => {
        const src = s.objects().find((o: any) => o.type === "source" && o.x === 15 && o.y === 25);
        if (!src) return false;
        const expected = `hauling-${s.room()}-hauling-${String(src._id).slice(-4)}`;
        return Object.entries(s.memory?.creeps ?? {}).some(
          ([name, mem]: [string, any]) =>
            name.startsWith("hauler-") && mem?.workType === "haul" && mem?.corpId === expected
        );
      }),
      eventually("hauler body is 1:1 CARRY:MOVE with >= 3 CARRY", (s) => {
        const h = s
          .objects()
          .find((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("hauler-"));
        if (!h) return false;
        const c = bodyCounts(h);
        return (c.carry ?? 0) >= 3 && c.carry === c.move;
      }),
      eventually("the staged miner is meanwhile harvesting", (s) => {
        const src = s.objects().find((o: any) => o.type === "source" && o.x === 15 && o.y === 25);
        return !!src && src.energy < 2950;
      }),
    ],
  },
];

/** Pocket a source at (px,py), opening to the north. */
const pocketWalls = (b: RoomBuilder, px: number, py: number): RoomBuilder => {
  for (const [x, y] of [
    [px - 1, py - 1],
    [px + 1, py - 1],
    [px - 1, py],
    [px + 1, py],
    [px - 1, py + 1],
    [px, py + 1],
    [px + 1, py + 1],
  ]) {
    b.tile(x, y, "wall");
  }
  return b;
};

export function buildSpawnExecT3Cells(): GridCell[] {
  let runtRecycledAt: number | null = null;

  return [
    {
      // The runt catch-22 fix: a 2W miner on a rate-5 source (totalWork 3) at
      // 550 capacity is recycled the moment the 3W replacement is affordable
      // RIGHT NOW - and the replacement is full-size, never another runt.
      id: "spawnexec-miner-runt-recycle-affordable",
      tier: 3,
      avenue: "spawn-execution",
      // 150: recycle lands ~43-55; under the energy-led scheduler the
      // replacement can queue behind TWO consumer spawns (~30 ticks) before
      // its own 15-tick build - worst case ~115. (Green at 110 solo, red in
      // a shared world once - the flake margin is consumer interleaving.)
      window: 150,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(33, 20);
          return pocketWalls(b, 19, 25).source(19, 25, { energy: 1500, energyCapacity: 1500 }).toRoom();
        },
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      // The container set is PRE-BUILT (closes every construction rung the
      // owner build order now opens at RCL2), and the bank is PINNED full:
      // the full infra legitimately wakes the tender + upgraders, and the
      // runt-recycle gate (spawnIdleAndMaxed) only needs ONE idle-full
      // evaluation - the pin guarantees it despite the spenders.
      structures: [
        ...EXT_5.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
        { type: "container", x: 19, y: 24, energy: 0 }, // on the pocket tile
        { type: "container", x: 24, y: 24, energy: 0 }, // depot
        { type: "container", x: 33, y: 22, energy: 0 }, // controller buffer
      ],
      async onTick(ctx) {
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "spawn" },
          { $set: { store: { energy: 300 } } }
        );
        for (const p of [
          { x: 23, y: 23 },
          { x: 23, y: 27 },
          { x: 27, y: 23 },
          { x: 27, y: 27 },
          { x: 22, y: 25 },
        ]) {
          await ctx.db["rooms.objects"].update(
            { room: ctx.room(), type: "extension", x: p.x, y: p.y },
            { $set: { store: { energy: 50 } } }
          );
        }
      },
      creeps: [
        {
          name: "runt",
          x: 19,
          y: 24,
          body: ["work", "work", "move"],
          memory: { workType: "harvest", corpId: "staged-rr", assignedSourceId: "$id(home,source,19,25)" },
        },
        {
          name: "hx",
          x: 22,
          y: 23,
          body: ["carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move"],
          memory: { workType: "haul", corpId: "staged-rr-h", working: false, assignedSourceId: "$id(home,source,19,25)" },
        },
        {
          name: "u1",
          x: 32,
          y: 19,
          body: ["work", "work", "work", "work", "carry", "move", "move"],
          energy: 50,
          memory: { workType: "upgrade", corpId: "staged-rr-u1", working: true },
        },
        { name: "filler1", x: 20, y: 20, body: ["move"] },
      ],
      assertions: [
        eventually("the runt is flagged and recycled", (s) => {
          const flagged = s.memory?.creeps?.runt?.recycling === true;
          const gone = !s.creep("runt");
          if (gone && runtRecycledAt === null) runtRecycledAt = s.tick;
          return (flagged || runtRecycledAt !== null) && gone;
        }),
        // The staged source says 1500, but the bot's ownership lift values
        // owned-room sources at 3000 (the game rule: owned rooms regen 3000)
        // -> rate 10 -> desiredWork 5 -> the full body 550 affords is 4W2M.
        // Measured: the replacement spawned exactly so.
        eventually("the replacement is the full body the capacity affords (4W)", (s) => {
          const fresh = s
            .objects()
            .find((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("miner-"));
          if (!fresh) return false;
          const work = (fresh.body ?? []).filter((p: any) => p.type === "work").length;
          return work === 4;
        }),
        always("never another sub-3-WORK miner (anti-thrash)", (s) =>
          s
            .objects()
            .filter((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("miner-"))
            .every((o) => (o.body ?? []).filter((p: any) => p.type === "work").length >= 3)
        ),
      ],
    },

    {
      // The inverse guard: at 300 capacity a 2W miner IS the max body -
      // recycling must never fire; it mines undisturbed all window.
      id: "spawnexec-miner-runt-immortal-at-cap",
      tier: 3,
      avenue: "spawn-execution",
      window: 40,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(33, 20);
          return pocketWalls(b, 19, 25).source(19, 25).toRoom();
        },
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "runt",
          x: 19,
          y: 24,
          body: ["work", "work", "move"],
          memory: { workType: "harvest", corpId: "staged-ri", assignedSourceId: "$id(home,source,19,25)" },
        },
        {
          name: "hx",
          x: 22,
          y: 23,
          body: ["carry", "carry", "carry", "move", "move", "move"],
          memory: { workType: "haul", corpId: "staged-ri-h", working: false, assignedSourceId: "$id(home,source,19,25)" },
        },
        { name: "filler1", x: 20, y: 20, body: ["move"] },
        { name: "filler2", x: 20, y: 21, body: ["move"] },
      ],
      assertions: [
        always("never flagged for recycling", (s) => s.memory?.creeps?.runt?.recycling !== true),
        always("never leaves its harvest tile", (s) => {
          const c = s.creep("runt");
          return !!c && c.x === 19 && c.y === 24;
        }),
        eventually("keeps mining", (s) => {
          const src = s.objects().find((o) => o.type === "source" && o.x === 19 && o.y === 25);
          return !!src && src.energy <= 2920;
        }),
      ],
    },

    {
      // The hauler pounce: with the spawn momentarily flush (550), the
      // 1-CARRY runt is swapped out and every later hauler is >= 3 CARRY.
      id: "spawnexec-hauler-runt-recycle-pounce",
      tier: 3,
      avenue: "spawn-execution",
      window: 55,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(33, 22);
          return pocketWalls(b, 18, 25).source(18, 25).toRoom();
        },
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      structures: EXT_5.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      creeps: [
        {
          name: "mA",
          x: 18,
          y: 24,
          body: ["work", "work", "work", "work", "move"],
          memory: { workType: "harvest", corpId: "staged-hp-m", assignedSourceId: "$id(home,source,18,25)" },
        },
        {
          name: "runt",
          x: 21,
          y: 24,
          body: ["carry", "move"],
          memory: { workType: "haul", corpId: "staged-hp-r", working: false, assignedSourceId: "$id(home,source,18,25)" },
        },
        {
          name: "big",
          x: 21,
          y: 26,
          body: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"],
          memory: { workType: "haul", corpId: "staged-hp-b", working: false, assignedSourceId: "$id(home,source,18,25)" },
        },
        {
          name: "u1",
          x: 32,
          y: 21,
          body: ["work", "work", "work", "work", "carry", "move", "move"],
          energy: 50,
          memory: { workType: "upgrade", corpId: "staged-hp-u", working: true },
        },
      ],
      assertions: [
        eventually("the 1-CARRY runt is flagged and recycled", (s) => {
          const flagged = s.memory?.creeps?.runt?.recycling === true;
          return flagged || !s.creep("runt");
        }),
        eventually("the runt is gone", (s) => !s.creep("runt")),
        always("every fresh hauler is a real body (>= 3 CARRY, 1:1)", (s) =>
          s
            .objects()
            .filter((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("hauler-"))
            .every((o) => {
              const carry = (o.body ?? []).filter((p: any) => p.type === "carry").length;
              const move = (o.body ?? []).filter((p: any) => p.type === "move").length;
              return carry >= 3 && carry === move;
            })
        ),
      ],
    },
  ];
}


export function buildSpawnExecT4Cells(): GridCell[] {
  return [
    {
      // At 1300 the miner body CAPS at its design point 5W1C3M (700) rather
      // than growing monstrous, and the follow-on hauler keeps 1:1 pairs
      // sized to the route (carryPartsFor(10,12)*1.2 ~ 6-7C).
      id: "spawnexec-bodies-at-1300-rcl4",
      tier: 4,
      avenue: "spawn-execution",
      window: 80,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(35, 18);
          for (const [x, y] of [
            [12, 24],
            [14, 24],
            [12, 25],
            [14, 25],
            [12, 26],
            [13, 26],
            [14, 26],
          ]) {
            b.tile(x, y, "wall");
          }
          return b.source(13, 25).toRoom();
        },
      },
      bot: { x: 25, y: 25 },
      controller: { level: 4 },
      structures: [
        ...EXT_5,
        { x: 28, y: 25 },
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
        { x: 23, y: 19 },
        { x: 27, y: 19 },
      ].map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      creeps: quiet(),
      assertions: [
        eventually("miner caps at exactly 5W1C3M", (s) => {
          const m = firstMinerDoc(s);
          if (!m) return false;
          const c = bodyCounts(m);
          return c.work === 5 && c.carry === 1 && c.move === 3;
        }),
        eventually("the route hauler keeps 1:1 pairs in the [5,8] band", (s) => {
          const h = s
            .objects()
            .find((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("hauler-"));
          if (!h) return false;
          const c = bodyCounts(h);
          return (c.carry ?? 0) >= 5 && (c.carry ?? 0) <= 8 && c.carry === c.move;
        }),
        always("no monstrous miner ever spawns", (s) =>
          s
            .objects()
            .filter((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("miner-"))
            .every((o: any) => (o.body ?? []).length <= 9)
        ),
      ],
    },
  ];
}

export const spawnExecCells: GridCell[] = [
  {
    id: "spawnexec-first-miner-stamp-300",
    tier: 0,
    avenue: "spawn-execution",
    window: 60,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    creeps: [{ name: "decoy", x: 24, y: 23, body: ["carry", "move"], memory: { workType: "haul" } }],
    assertions: [
      eventually("first flow miner spawned with the 2W1M floor body", (s) => {
        const m = s
          .objects()
          .find((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("miner-"));
        if (!m || !Array.isArray(m.body)) return false;
        const parts = m.body.map((p: any) => p.type);
        return parts.length === 3 && parts.filter((t: string) => t === "work").length === 2;
      }),
      eventually("corpId stamps a live commissioned mining corp", (s) => {
        const store = JSON.stringify(s.memory?.commissionedCorps ?? {});
        return minerEntries(s).some(
          ([, mem]) =>
            typeof mem?.corpId === "string" && mem.corpId.startsWith("mining-") && store.includes(mem.corpId)
        );
      }),
      eventually("spawnedBy stamped with the spawning corp", (s) =>
        minerEntries(s).some(([, mem]) => typeof mem?.spawnedBy === "string" && mem.spawnedBy.startsWith("spawning-"))
      ),
      eventually("workType stamped harvest", (s) =>
        minerEntries(s).some(([, mem]) => mem?.workType === "harvest")
      ),
      // The prefix-regression signature: a spawned miner whose corpId never
      // resolves gets orphanedSince stamped by OrphanRescue. None may ever.
      always("no spawned miner is ever orphaned", (s) =>
        minerEntries(s).every(([, mem]) => mem?.orphanedSince === undefined)
      ),
    ],
  },
];
