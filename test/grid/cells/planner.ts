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
      // 1200 (was 900, thrice-measured on the author's host): at d=22 the
      // cold loop converges only via the starved-hold backstop - hauler #2
      // (the controller circuit, min 300) first demands at ~360, starves at
      // ~660 (STARVATION_THRESHOLD=300), holds+spawns ~700, feeds the
      // controller ~780. The 900 window carried ZERO margin over that
      // convergence and went red on slower hosts (2026-07-20: 4/4 timeouts
      // on a container host INCLUDING the untouched base commit - the
      // mockup's per-tick CPU limit truncates ticks under load, delaying
      // tick-counted milestones). Widened per the pin-reconciliation
      // doctrine: the pin encodes CONVERGENCE, not host speed. Shrinking
      // the real dead window is a bot-improvement job (a lower starvation
      // threshold - the first A/B-pipeline experiment), not an assertion job.
      window: 1200,
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
      // 650 with 550 capacity (5 exts): at 800 the two 700-cost miners bank
      // serially far past any window; at 550 the 500-cost bodies field by ~60
      // and ~300 - and under the energy-led scheduler (consumers spend
      // freely, no holds) the second miner banks ~15% slower than before.
      window: 650,
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

/** Serpentine maze rows: full-width walls with 2-wide gaps alternating ends. */
const serpentine = (b: RoomBuilder, rows: number[], firstGapWest: boolean): RoomBuilder => {
  rows.forEach((y, i) => {
    const west = firstGapWest ? i % 2 === 0 : i % 2 === 1;
    b.hWall(y, { gap: west ? [2, 3] : [46, 47] });
  });
  return b;
};

export function buildPlannerT3Cells(): GridCell[] {
  let netzeroChecked = false;
  let subsetChecked = false;

  return [
    {
      // netEnergy exclusion on REAL path distance: a maze source ~33 tiles
      // as the crow flies but 300+ through the serpentine has negative net
      // and must never be staffed - the 'lots of miners out, little energy
      // back' failure this gate exists for.
      id: "plan-t3-netzero-maze-excluded",
      tier: 3,
      avenue: "planning-economy",
      window: 250,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(25, 8).source(30, 15);
          serpentine(b, [26, 29, 32, 35, 38, 41, 44, 47], true);
          return b.source(44, 48).toRoom();
        },
      },
      bot: { x: 25, y: 15 },
      controller: { level: 2 },
      assertions: [
        eventually("only the near source is ever planned", (s) => {
          if (s.tick < 60) return false;
          const near = s.objects().find((o) => o.type === "source" && o.x === 30 && o.y === 15);
          if (!near) return false;
          const mines = planCorps(s).filter((c) => c.kind === "mine");
          const ok = mines.length === 1 && mines[0].sourceId === `source-${near._id}`;
          if (ok) netzeroChecked = true;
          return netzeroChecked;
        }),
        always("the maze source is excluded at every resolve", (s) => {
          if (s.tick < 60) return true;
          const maze = s.objects().find((o) => o.type === "source" && o.x === 44 && o.y === 48);
          if (!maze) return true;
          return !planCorps(s).some((c) => c.kind === "mine" && c.sourceId === `source-${maze._id}`);
        }),
        always("no harvester ever walks the maze", (s) =>
          !s
            .objects()
            .some(
              (o) =>
                o.type === "creep" &&
                typeof o.name === "string" &&
                (o.name.startsWith("miner-") || o.name.startsWith("jack-")) &&
                o.y > 26
            )
        ),
      ],
    },

    {
      // The 0.2 parts/tick mining budget: near + exactly ONE of two
      // profitable-but-expensive maze sources fits; the planner must pick
      // the same one at every resolve and never touch the third.
      id: "plan-t3-budget-subset",
      tier: 3,
      avenue: "planning-economy",
      window: 250,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(25, 8).source(28, 15);
          serpentine(b, [26, 30, 34, 38, 42], true);
          return b.source(40, 46).source(46, 46).toRoom();
        },
      },
      bot: { x: 25, y: 15 },
      controller: { level: 3 },
      structures: [
        { type: "extension", x: 23, y: 13, energy: 50 },
        { type: "extension", x: 27, y: 13, energy: 50 },
        { type: "extension", x: 23, y: 17, energy: 50 },
        { type: "extension", x: 27, y: 17, energy: 50 },
        { type: "extension", x: 21, y: 15, energy: 50 },
        { type: "extension", x: 29, y: 15, energy: 50 },
        { type: "extension", x: 22, y: 12, energy: 50 },
        { type: "extension", x: 28, y: 12, energy: 50 },
        { type: "extension", x: 22, y: 18, energy: 50 },
        { type: "extension", x: 28, y: 18, energy: 50 },
      ],
      assertions: [
        eventually("near + exactly one far source planned", (s) => {
          if (s.tick < 60) return false;
          const near = s.objects().find((o) => o.type === "source" && o.x === 28 && o.y === 15);
          const far40 = s.objects().find((o) => o.type === "source" && o.x === 40 && o.y === 46);
          if (!near || !far40) return false;
          const mines = planCorps(s).filter((c) => c.kind === "mine");
          const ok =
            mines.length === 2 &&
            mines.some((m) => m.sourceId === `source-${near._id}`) &&
            mines.some((m) => m.sourceId === `source-${far40._id}`);
          if (ok) subsetChecked = true;
          return subsetChecked;
        }),
        always("the over-budget third source is never planned", (s) => {
          if (s.tick < 60) return true;
          const far46 = s.objects().find((o) => o.type === "source" && o.x === 46 && o.y === 46);
          if (!far46) return true;
          return !planCorps(s).some((c) => c.kind === "mine" && c.sourceId === `source-${far46._id}`);
        }),
        always("no harvester ever visits the skipped source", (s) =>
          !s
            .objects()
            .some(
              (o) =>
                o.type === "creep" &&
                typeof o.name === "string" &&
                o.name.startsWith("miner-") &&
                Math.max(Math.abs(o.x - 46), Math.abs(o.y - 46)) <= 2
            )
        ),
      ],
    },
  ];
}


export function buildPlannerT4Cells(): GridCell[] {
  return [
    {
      // Two spawns: every source is assigned to its NEAREST spawn, exactly
      // one mine entry per source, and at most one harvester ever works one.
      id: "plan-t4-two-spawn-nearest",
      tier: 4,
      avenue: "planning-economy",
      window: 250,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName)
            .border()
            .controller(25, 10)
            .source(5, 25)
            .source(45, 25)
            .source(23, 30)
            .toRoom(),
      },
      bot: { x: 10, y: 25 },
      controller: { level: 7 },
      structures: EXT_10_NEAR(10, 25).map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      async stage(ctx) {
        // Second spawn, per addOwnedRoom's schema.
        await ctx.db["rooms.objects"].insert({
          room: ctx.room(),
          type: "spawn",
          x: 40,
          y: 25,
          user: ctx.userId,
          name: "Spawn2",
          store: { energy: 300 },
          storeCapacityResource: { energy: 300 },
          hits: 5000,
          hitsMax: 5000,
          spawning: null,
          notifyWhenAttacked: true,
        });
      },
      assertions: [
        eventually("each source is planned at its nearest spawn", (s) => {
          const spawnA = s.objects().find((o) => o.type === "spawn" && o.x === 10 && o.y === 25);
          const spawnB = s.objects().find((o) => o.type === "spawn" && o.x === 40 && o.y === 25);
          const srcs = {
            a: s.objects().find((o) => o.type === "source" && o.x === 5 && o.y === 25),
            b: s.objects().find((o) => o.type === "source" && o.x === 45 && o.y === 25),
            c: s.objects().find((o) => o.type === "source" && o.x === 23 && o.y === 30),
          };
          if (!spawnA || !spawnB || !srcs.a || !srcs.b || !srcs.c) return false;
          const mines = planCorps(s).filter((c) => c.kind === "mine");
          if (mines.length !== 3) return false;
          const of = (src: any) => mines.find((m) => m.sourceId === `source-${src._id}`);
          return (
            of(srcs.a)?.spawnId === `spawn-${spawnA._id}` &&
            of(srcs.b)?.spawnId === `spawn-${spawnB._id}` &&
            of(srcs.c)?.spawnId === `spawn-${spawnA._id}`
          );
        }),
        always("never two mine entries for one source", (s) => {
          const mines = planCorps(s).filter((c) => c.kind === "mine");
          const ids = mines.map((m) => m.sourceId);
          return new Set(ids).size === ids.length;
        }),
        always("at most one fielded miner per source (settled)", (s) => {
          if (s.tick < 200) return true;
          for (const src of s.objects().filter((o) => o.type === "source")) {
            const adjacent = s
              .objects()
              .filter(
                (o) =>
                  o.type === "creep" &&
                  typeof o.name === "string" &&
                  o.name.startsWith("miner-") &&
                  Math.max(Math.abs(o.x - src.x), Math.abs(o.y - src.y)) <= 1
              );
            if (adjacent.length > 1) return false;
          }
          return true;
        }),
      ],
    },

    {
      // Link-aware haul pricing: the linked source's hauls are priced from
      // the CORE link (tiny carry), the unlinked twin pays full distance -
      // and the physical link pump eventually reaches the core.
      id: "plan-t4-link-haul-pricing",
      tier: 4,
      avenue: "planning-economy",
      // 220: the physical pump needs miner fielding (~40) + a 26-tile walk +
      // two 50-volleys before runLinks fires at the 100 threshold.
      window: 220,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().controller(25, 10).source(44, 44).source(6, 44).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 5 },
      structures: [
        { type: "storage", x: 21, y: 25, energy: 0 }, // clear of the EXT_10_NEAR tiles
        { type: "link", x: 22, y: 24, energy: 0 }, // core link, within 2 of storage
        { type: "link", x: 43, y: 43, energy: 0 }, // source link, within 2 of (44,44)
        ...EXT_10_NEAR(25, 25).map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      creeps: [
        // The linked source's miner is staged (organic serial 700-cost
        // banking put the second miner past the window): the pump is live
        // from adoption, the planning claims are untouched.
        {
          name: "mL",
          x: 43,
          y: 44, // bestAdjacentTile of (44,44): (43,43) holds the link, so (43,44)
          body: ["work", "work", "work", "work", "work", "carry", "move", "move", "move"],
          energy: 0,
          memory: { workType: "harvest", corpId: "staged-lp-m", assignedSourceId: "$id(home,source,44,44)" },
        },
      ],
      assertions: [
        eventually("both sources planned; linked hauls priced from the core", (s) => {
          const linked = s.objects().find((o) => o.type === "source" && o.x === 44 && o.y === 44);
          const unlinked = s.objects().find((o) => o.type === "source" && o.x === 6 && o.y === 44);
          if (!linked || !unlinked) return false;
          const corps = planCorps(s);
          const mines = corps.filter((c) => c.kind === "mine");
          if (mines.length !== 2) return false;
          const linkedHauls = corps.filter((c) => c.kind === "haul" && c.fromId === `source-${linked._id}`);
          const unlinkedHauls = corps.filter((c) => c.kind === "haul" && c.fromId === `source-${unlinked._id}`);
          if (linkedHauls.length === 0 || unlinkedHauls.length === 0) return false;
          const coreSide = linkedHauls.filter(
            (c) => String(c.toId).startsWith("spawn-") || String(c.toId).startsWith("storage-")
          );
          return coreSide.every((c) => (c.carry ?? 99) <= 3) && unlinkedHauls.some((c) => (c.carry ?? 0) >= 6);
        }),
        eventually("the physical pump reaches the core link", (s) => {
          const core = s.objects().find((o) => o.type === "link" && o.x === 22 && o.y === 24);
          return !!core && (core.store?.energy ?? 0) > 0;
        }),
      ],
    },

    {
      // DEPOSIT PORTS (spec 26, deposit-side mirror of the haul-pricing cell
      // above): a mined deposit whose haul-home route passes a CONTROLLER LINK
      // closer than its storage hub is priced to TURN AROUND at the link (a tiny
      // carry) and delivers there, where the upgraders consume it in place. This
      // is receipts-gated behavior (detectLinkDepositPorts reads a live link) -
      // the mockup stages no links unless a cell does, so a pure sim never
      // exercises it. The source sits by the controller (link ~5 tiles away)
      // while the storage hub is a room-crossing ~21 tiles off.
      id: "plan-t4-link-deposit-port",
      tier: 4,
      avenue: "planning-economy",
      window: 240,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().controller(40, 40).source(42, 42).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 5 },
      structures: [
        { type: "storage", x: 21, y: 25, energy: 5000 }, // the hub, by the spawn
        { type: "link", x: 40, y: 37, energy: 0 }, // controller link (within 3 of the controller)
        ...EXT_10_NEAR(25, 25).map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      creeps: [
        // Stage the miner so the pump is live from adoption (organic banking of a
        // far miner would land past the window); the planning claims are untouched.
        {
          name: "mD",
          x: 43,
          y: 43,
          body: ["work", "work", "work", "work", "work", "carry", "move", "move", "move"],
          energy: 0,
          memory: { workType: "harvest", corpId: "staged-dp-m", assignedSourceId: "$id(home,source,42,42)" },
        },
      ],
      assertions: [
        eventually("mined deposit is priced to the controller-link PORT (carry shrinks, port recorded)", (s) => {
          const src = s.objects().find((o) => o.type === "source" && o.x === 42 && o.y === 42);
          if (!src) return false;
          const home = planCorps(s).find(
            (c) => c.kind === "haul" && c.fromId === `source-${src._id}` && String(c.toId).startsWith("storage-")
          );
          if (!home) return false;
          // priced to the ~5-tile port leg (carryPartsFor(10,5)~=3), not the
          // ~21-tile hub leg (~9), and it recorded the chosen port.
          return !!home.port && (home.carry ?? 99) <= 5;
        }),
        eventually("haulers physically drop at the controller-link port (it fills)", (s) => {
          const link = s.objects().find((o) => o.type === "link" && o.x === 40 && o.y === 37);
          return !!link && (link.store?.energy ?? 0) > 0;
        }),
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
