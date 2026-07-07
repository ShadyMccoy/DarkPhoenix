/**
 * hauling cells (docs/specs/08, avenue: logistics).
 *
 * T0: existence proof of the full income loop - the RCL2 flow economy fields
 * a real hauler and the spawn gets REFILLED after being drained by spawning.
 * The refill check only arms once a flow hauler exists, so a jack-only
 * economy can't satisfy it; per the errata (window #9) plus the measured
 * first-miner-at-138, the window stays at 300.
 *
 * NOTE this cell carries closure state (sawDrainSinceHauler) - cells are
 * constructed once per process, which holds for a grid run; a future
 * rerun-in-process flake policy must rebuild cells (see cells/index.ts).
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(20, 25).source(25, 30).toRoom();

const flowHaulerExists = (s: { memory: any }) =>
  Object.entries(s.memory?.creeps ?? {}).some(
    ([name, mem]: [string, any]) => name.startsWith("hauler-") && mem?.workType === "haul"
  );

// ---------------------------------------------------------------------------
// T1 circuit-split geometry: source (25,42) with its container staged on the
// harvest spot (24,41) holding 1500; controller (25,8). Solver flows for a
// 10 e/t source: controller reserve 2, spawn (demand 10, value 100) takes the
// remaining 8. assignCircuit counts committed fleet-mates, so three haulers
// flip to homeSinks spawn, controller, spawn in whatever order they fill -
// the multiset {spawn: 2, controller: 1} is deterministic.
// ---------------------------------------------------------------------------
const splitRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 8).source(25, 42).toRoom();

export function buildHaulingCells(): GridCell[] {
  let prevSpawnEnergy: number | null = null;

  // circuit-split closure state
  const firstSink: Record<string, string | null> = { h1: null, h2: null, h3: null };

  const sinksNow = (s: { memory: any }): Record<string, string | undefined> => {
    const out: Record<string, string | undefined> = {};
    for (const name of ["h1", "h2", "h3"]) out[name] = s.memory?.creeps?.[name]?.homeSink;
    return out;
  };

  return [
    {
      id: "haul-t1-circuit-split",
      tier: 1,
      avenue: "logistics",
      // 110, not 60: the controller-circuit hauler flips at ~26 and then
      // walks container (24,41) -> input (23,6), ~35 ticks loaded.
      window: 110,
      rooms: { home: splitRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      structures: [{ type: "container", x: 24, y: 41, energy: 1500 }],
      creeps: [
        {
          name: "m1",
          x: 24,
          y: 41,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-cs-m", assignedSourceId: "$id(home,source,25,42)" },
        },
        ...["h1", "h2", "h3"].map((name, i) => ({
          name,
          x: 25,
          y: 27 + i,
          body: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"],
          memory: {
            workType: "haul",
            corpId: `staged-cs-${name}`,
            working: false,
            assignedSourceId: "$id(home,source,25,42)",
          },
        })),
      ],
      assertions: [
        eventually("all three adopted by the carry corp", (s) =>
          ["h1", "h2", "h3"].every((n) => {
            const corpId = s.memory?.creeps?.[n]?.corpId;
            return typeof corpId === "string" && corpId.startsWith("hauling-");
          })
        ),
        eventually("fleet splits exactly {spawn: 2, controller: 1}", (s) => {
          const sinks = Object.values(sinksNow(s));
          if (sinks.some((v) => v === undefined)) return false;
          const spawnCount = sinks.filter((v) => v === "spawn").length;
          const ctrlCount = sinks.filter((v) => v === "controller").length;
          return spawnCount === 2 && ctrlCount === 1;
        }),
        // Circuits are PERMANENT: whatever a hauler was first assigned, it
        // keeps (the per-trip re-rolling thrash this design replaced).
        always("no hauler ever re-rolls its circuit", (s) => {
          const sinks = sinksNow(s);
          for (const name of ["h1", "h2", "h3"]) {
            const sink = sinks[name];
            if (sink === undefined) continue;
            if (firstSink[name] === null) firstSink[name] = sink;
            else if (firstSink[name] !== sink) return false;
          }
          return true;
        }),
        // Delivery evidence: a pile near the input tile is often consumed the
        // same tick by parked upgraders, so ANY controller progress (only the
        // controller circuit can feed upgraders here - no jacks, source 34
        // tiles away) or a transient pile both count.
        eventually("the controller circuit delivers to the controller side", (s) => {
          const ctrl = s.objects().find((o) => o.type === "controller");
          if ((ctrl?.progress ?? 0) > 0) return true;
          return s.objects().some((o) => {
            if (o.type !== "energy") return false;
            return Math.max(Math.abs(o.x - 25), Math.abs(o.y - 8)) <= 4;
          });
        }),
      ],
    },

    {
      // deliverEnergy's all-full fallback: a spawn-homed hauler whose whole
      // spawn network is full must spill to the controller side, never idle.
      // The spawn is pinned full every tick (whole-object store form - dotted
      // paths no-op in this db layer).
      id: "haul-t1-spawn-full-spill",
      tier: 1,
      avenue: "logistics",
      window: 50,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 10).source(25, 42).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      structures: [
        { type: "container", x: 24, y: 41, energy: 1500 }, // source container
        { type: "container", x: 25, y: 12, energy: 0 }, // controller input buffer
      ],
      creeps: [
        {
          name: "m1",
          x: 24,
          y: 41,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-sp-m", assignedSourceId: "$id(home,source,25,42)" },
        },
        {
          name: "h1",
          x: 25,
          y: 30,
          body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
          energy: 300,
          memory: {
            workType: "haul",
            corpId: "staged-sp-h",
            working: true,
            homeSink: "spawn",
            deliverSinkId: "spawn",
            assignedSourceId: "$id(home,source,25,42)",
          },
        },
      ],
      async onTick(ctx) {
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "spawn" },
          { $set: { store: { energy: 300 } } }
        );
      },
      assertions: [
        eventually("adopted by the carry corp", (s) => {
          const corpId = s.memory?.creeps?.h1?.corpId;
          return typeof corpId === "string" && corpId.startsWith("hauling-");
        }),
        eventually("h1 reaches the controller buffer", (s) => {
          const c = s.creep("h1");
          return !!c && Math.max(Math.abs(c.x - 25), Math.abs(c.y - 12)) <= 1;
        }),
        eventually("the buffer receives the spilled load", (s) => {
          const box = s.objects().find((o) => o.type === "container" && o.x === 25 && o.y === 12);
          return !!box && (box.store?.energy ?? 0) >= 250;
        }),
        eventually("h1 emptied its cargo", (s) => {
          const c = s.creep("h1");
          return !!c && (c.store?.energy ?? 0) === 0;
        }),
      ],
    },
    {
      id: "haul-t0-first-delivery",
      tier: 0,
      avenue: "logistics",
      window: 300,
      rooms: { home: homeRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      assertions: [
        eventually("a flow hauler is fielded", flowHaulerExists),
        // A hauler delivery is a bulk single-tick jump in the spawn store
        // (self-regen is +1/tick; jacks have recycled once a flow hauler
        // exists, so no other bulk filler remains).
        eventually("spawn receives a bulk delivery after the hauler exists", (s) => {
          const spawn = s.objects().find((o) => o.type === "spawn");
          const energy = spawn?.store?.energy ?? null;
          const jumped =
            prevSpawnEnergy !== null &&
            energy !== null &&
            energy - prevSpawnEnergy >= 40 &&
            flowHaulerExists(s);
          prevSpawnEnergy = energy;
          return jumped;
        }),
        // The loop must never wedge the colony: some creep is always alive
        // after the opening jack economy stands up.
        always("colony never empties", (s) => s.objects().some((o) => o.type === "creep"), 30),
      ],
    },
  ];
}
