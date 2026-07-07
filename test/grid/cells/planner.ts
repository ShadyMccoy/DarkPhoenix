/**
 * planner cells (docs/specs/08, avenue: planning-economy).
 *
 * T0: existence proof that one spawn + one near source yields a published
 * plan - Memory.economyPlan (flowAdapter.publishRoster) with exactly one
 * 'mine' corp for THAT source and at least one 'haul' route - and the spawn
 * acts on it. Guards the "spawn resource not claimed by any node -> 'No spawn
 * sinks' -> zero miners forever" class of failure (attachOwnedSpawnsToNodes).
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(25, 30).toRoom();

const planCorps = (s: { memory: any }): any[] => s.memory?.economyPlan?.corps ?? [];

export function buildPlannerT1Cells(): GridCell[] {
  let progressSnapshot: number | null = null;

  return [
    {
      // A realistic-distance source closes the whole loop, and the controller
      // allocation is exactly the ANTI_DOWNGRADE_RESERVE floor of 2: the
      // spawn sink (demand 10) legitimately soaks the rest of a 10 e/t supply.
      id: "plan-t1-single-source-loop",
      tier: 1,
      avenue: "planning-economy",
      // 900, thrice-measured: at d=22 the cold loop converges only via the
      // starved-hold backstop - hauler #2 (the controller circuit, min 300)
      // first demands at ~360, starves at ~660 (STARVATION_THRESHOLD=300),
      // holds+spawns ~700, feeds the controller ~780. This cell is the
      // spec-01 dead window quantified at realistic distance; shrinking the
      // horizon is a bot-improvement job (e.g. a lower threshold), not an
      // assertion job.
      window: 900,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 10).source(25, 47).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      assertions: [
        eventually("plan: one mine corp, upgrade work exactly the reserve floor", (s) => {
          const corps = planCorps(s);
          const mines = corps.filter((c) => c.kind === "mine");
          const upgrade = corps.find((c) => c.kind === "upgrade");
          return mines.length === 1 && !!upgrade && upgrade.work === 2;
        }),
        eventually("plan routes both circuits (spawn and controller hauls)", (s) => {
          const hauls = planCorps(s).filter((c) => c.kind === "haul");
          const toCtrl = hauls.some((c) => String(c.toId ?? "").startsWith("controller-"));
          const toSpawn = hauls.some((c) => String(c.toId ?? "").startsWith("spawn-"));
          return toCtrl && toSpawn;
        }),
        eventually("a flow miner works the far source", (s) => {
          const src = s.objects().find((o) => o.type === "source" && o.x === 25 && o.y === 47);
          if (!src || src.energy >= src.energyCapacity) return false;
          return s.objects().some(
            (o) =>
              o.type === "creep" &&
              typeof o.name === "string" &&
              o.name.startsWith("miner-") &&
              Math.max(Math.abs(o.x - 25), Math.abs(o.y - 47)) <= 1
          );
        }),
        // The delivered trickle physically reaches the controller: progress
        // rises in the back half of the window (upgraders only stand up after
        // the full mine -> haul loop exists - measured ~350+ here). The plan
        // allocates the controller only its 2 e/t reserve floor, so a +20
        // delta is >= 10 ticks of sustained flow-fed upgrading.
        eventually("controller progresses in the back half", (s) => {
          const ctrl = s.objects().find((o) => o.type === "controller");
          if (!ctrl) return false;
          if (s.tick < 400) return false;
          if (progressSnapshot === null) {
            progressSnapshot = ctrl.progress ?? 0;
            return false;
          }
          return (ctrl.progress ?? 0) >= progressSnapshot + 20;
        }),
      ],
    },
  ];
}

const EXT_10_NEAR = (cx: number, cy: number): Array<{ x: number; y: number }> => [
  { x: cx - 2, y: cy - 2 },
  { x: cx - 2, y: cy },
  { x: cx - 2, y: cy + 2 },
  { x: cx + 2, y: cy - 2 },
  { x: cx + 2, y: cy },
  { x: cx + 2, y: cy + 2 },
  { x: cx - 1, y: cy - 3 },
  { x: cx + 1, y: cy - 3 },
  { x: cx - 1, y: cy + 3 },
  { x: cx + 1, y: cy + 3 },
];

export function buildPlannerT2Cells(): GridCell[] {
  // asymmetric closure state
  let sawBothMines = false;

  // anti-downgrade-construction closure state
  let progressAt200: number | null = null;

  return [
    {
      // Both sources staffed when both fit the 0.2 parts/tick budget: the far
      // source (d~21) must not be silently abandoned by the net-per-part
      // ordering. 10 FULL extensions (800) field full miners fast.
      id: "plan-t2-asymmetric-both-staffed",
      tier: 2,
      avenue: "planning-economy",
      // 500 with 550 capacity (5 exts): at 800 the two 700-cost miners bank
      // serially past the window; at 550 the 500-cost bodies field by ~60 and
      // ~250, and the far walk (21 tiles) still fits comfortably.
      window: 500,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().controller(25, 8).source(22, 22).source(46, 46).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: EXT_10_NEAR(25, 25)
        .slice(0, 5)
        .map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      assertions: [
        eventually("plan mines BOTH sources", (s) => {
          const srcIds = s
            .objects()
            .filter((o) => o.type === "source")
            .map((o) => `source-${o._id}`);
          const mines = planCorps(s).filter((c) => c.kind === "mine");
          const both = srcIds.length === 2 && srcIds.every((id) => mines.some((m) => m.sourceId === id));
          if (both) sawBothMines = true;
          return sawBothMines;
        }),
        // Once both are planned, neither may vanish at any later %50 re-solve.
        always("neither mine entry is ever dropped", (s) => {
          if (!sawBothMines) return true;
          return planCorps(s).filter((c) => c.kind === "mine").length === 2;
        }),
        eventually("both sources simultaneously worked", (s) => {
          const sources = s.objects().filter((o) => o.type === "source");
          if (sources.length !== 2) return false;
          return sources.every(
            (src) =>
              src.energy < src.energyCapacity &&
              s.objects().some(
                (o) =>
                  o.type === "creep" &&
                  typeof o.name === "string" &&
                  o.name.startsWith("miner-") &&
                  Math.max(Math.abs(o.x - src.x), Math.abs(o.y - src.y)) <= 1
              )
          );
        }),
      ],
    },

    {
      // Nearest-supply routing with the spawn sink clamped to its demand:
      // spawn (10,25) drinks from its neighbour A, the controller (43,25)
      // from its neighbour B - and the upgrade allocation is the SURPLUS
      // (>= 4), not the bare reserve, because the clamp stops the value-100
      // spawn from soaking everything.
      id: "plan-t2-sink-source-pairing",
      tier: 2,
      avenue: "planning-economy",
      window: 100,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().controller(43, 25).source(6, 25).source(46, 25).toRoom(),
      },
      bot: { x: 10, y: 25 },
      controller: { level: 3 },
      structures: [
        ...EXT_10_NEAR(10, 25).map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
        { type: "container", x: 6, y: 24, energy: 0 },
        { type: "container", x: 46, y: 24, energy: 0 },
        { type: "container", x: 43, y: 27, energy: 0 },
      ],
      assertions: [
        eventually("controller pulls only from its neighbour B", (s) => {
          const srcB = s.objects().find((o) => o.type === "source" && o.x === 46 && o.y === 25);
          const ctrl = s.objects().find((o) => o.type === "controller");
          if (!srcB || !ctrl) return false;
          const hauls = planCorps(s).filter((c) => c.kind === "haul");
          const ctrlHauls = hauls.filter((c) => String(c.toId) === `controller-${ctrl._id}`);
          return ctrlHauls.length >= 1 && ctrlHauls.every((c) => String(c.fromId) === `source-${srcB._id}`);
        }),
        eventually("spawn pulls from its neighbour A", (s) => {
          const srcA = s.objects().find((o) => o.type === "source" && o.x === 6 && o.y === 25);
          const spawn = s.objects().find((o) => o.type === "spawn");
          if (!srcA || !spawn) return false;
          const hauls = planCorps(s).filter((c) => c.kind === "haul");
          return hauls.some(
            (c) => String(c.toId) === `spawn-${spawn._id}` && String(c.fromId) === `source-${srcA._id}`
          );
        }),
        eventually("upgrade allocation is the surplus, not the bare reserve", (s) => {
          const upgrade = planCorps(s).find((c) => c.kind === "upgrade");
          return !!upgrade && upgrade.work >= 4;
        }),
      ],
    },

    {
      // The reserve pre-pass under construction pressure: while extension
      // sites absorb the surplus (value 70 > controller 50), the plan must
      // still carry the controller's 2 e/t floor AND the controller must
      // physically progress - the regime the two starve fixes just repaired.
      id: "plan-t2-antidowngrade-construction",
      tier: 2,
      avenue: "planning-economy",
      // 900: physical controller progress under the build-out leans on the
      // starved-hold backstop (d=22 cell converged at 726; d~8 here).
      window: 900,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().controller(25, 10).source(18, 32).source(32, 32).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      assertions: [
        always("build corps never crowd out the reserve floor", (s) => {
          const sites = s.objects().filter((o) => o.type === "constructionSite").length;
          if (sites < 2 || s.tick < 150) return true; // regime not yet in force
          const corps = planCorps(s);
          if (corps.length === 0) return true; // between publishes
          const upgrade = corps.find((c) => c.kind === "upgrade");
          return !!upgrade && upgrade.work >= 2;
        }),
        eventually("construction is actually planned under the regime", (s) => {
          const sites = s.objects().filter((o) => o.type === "constructionSite").length;
          return sites >= 1 && planCorps(s).some((c) => c.kind === "build");
        }),
        eventually("controller physically progresses despite the build-out", (s) => {
          const ctrl = s.objects().find((o) => o.type === "controller");
          if (!ctrl || s.tick < 300) return false;
          if (progressAt200 === null) {
            progressAt200 = ctrl.progress ?? 0;
            return false;
          }
          return (ctrl.progress ?? 0) > progressAt200;
        }),
        // NOTE extension COMPLETION is deliberately not asserted: 3000 build
        // progress at ~5 e/t absorb is a ~600-tick tail owned by a future
        // free-economy-modded construction cell, not this plan-level one.
      ],
    },
  ];
}

export const plannerCells: GridCell[] = [
  {
    id: "plan-t0-single-source-commissioned",
    tier: 0,
    avenue: "planning-economy",
    window: 90,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    assertions: [
      eventually("plan mines exactly this source (one mine corp)", (s) => {
        const src = s.objects().find((o) => o.type === "source" && o.x === 25 && o.y === 30);
        if (!src) return false;
        const mines = planCorps(s).filter((c) => c.kind === "mine");
        return mines.length === 1 && mines[0].sourceId === `source-${src._id}`;
      }),
      eventually("plan routes at least one haul", (s) => planCorps(s).some((c) => c.kind === "haul")),
      eventually("the spawn acts on the plan", (s) => {
        const spawn = s.objects().find((o) => o.type === "spawn");
        if (spawn?.spawning) return true;
        return Object.values(s.memory?.creeps ?? {}).some((mem: any) => mem?.workType === "harvest");
      }),
    ],
  },
];
