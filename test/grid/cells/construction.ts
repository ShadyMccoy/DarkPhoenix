/**
 * construction cells (docs/specs/08, avenue: construction).
 *
 * T0: at RCL2 (container rungs gated to RCL3+) the ConstructionCorp's
 * first-ever placement is an extension, its tile satisfies every
 * findGridPosition predicate, and the one-site-at-a-time policy holds.
 * The room is all-plain inside the border, so the >=3-walkable-neighbours
 * rule reduces to staying inside the 2..47 interior - asserted directly.
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const SOURCE = { x: 25, y: 32 };
const SPAWN = { x: 25, y: 25 };
const CONTROLLER = { x: 25, y: 10 };

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(CONTROLLER.x, CONTROLLER.y).source(SOURCE.x, SOURCE.y).toRoom();

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

const sites = (s: { objects(h?: string): any[] }) =>
  s.objects().filter((o: any) => o.type === "constructionSite");

/** Every findGridPosition predicate, checked from outside the bot. */
const obeysGridRules = (site: { x: number; y: number }): boolean =>
  (site.x + site.y) % 2 === 0 && // checkerboard
  cheb(site, SOURCE) >= 2 &&
  cheb(site, SOURCE) <= 6 && // clusters near the source
  cheb(site, SPAWN) > 1 && // clear of the spawn ring
  cheb(site, CONTROLLER) > 2 && // clear of the controller camp
  site.x >= 2 &&
  site.x <= 47 &&
  site.y >= 2 &&
  site.y <= 47; // interior (plain room => >=3 walkable neighbours)

// ---------------------------------------------------------------------------
// T1 rung-order cells share this geometry: spawn (25,25), controller (25,10),
// source (25,40). The source's harvest spot (= container placement tile and
// the drop-pile tile) is bestAdjacentTile(source, spawn) = (24,39); the core
// depot tile is bestAdjacentTile(spawn, spawn) = (24,24). Piles are injected
// via the stage() raw-db hook (probe-verified: they persist and decay
// ceil(amount/1000)=1 per tick).
// ---------------------------------------------------------------------------
const rungRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(25, 40).toRoom();

const HARVEST_SPOT = { x: 24, y: 39 };
const DEPOT_TILE = { x: 24, y: 24 };

const quiet = (): Array<{ name: string; x: number; y: number; body: string[]; memory?: any }> => [
  { name: "decoy", x: 20, y: 20, body: ["carry", "move"], memory: { workType: "haul" } },
  { name: "filler1", x: 19, y: 20, body: ["move"] },
  { name: "filler2", x: 19, y: 21, body: ["move"] },
];

const containerSiteAt = (s: { objects(h?: string): any[] }, pos: { x: number; y: number }) =>
  s
    .objects()
    .some((o: any) => o.type === "constructionSite" && o.structureType === "container" && o.x === pos.x && o.y === pos.y);

export function buildConstructionT1Cells(): GridCell[] {
  let srcContainerSeen = false;

  return [
    {
      // Rung 1 outranks everything: a >= 200 pile at the source is the demand
      // signal, and the container lands ON the miner's harvest tile - the
      // pile/container/pickup convergence.
      id: "cons-src-container-on-pile",
      tier: 1,
      avenue: "construction",
      window: 60,
      rooms: { home: rungRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      creeps: quiet(),
      async stage(ctx) {
        await ctx.db["rooms.objects"].insert({
          type: "energy",
          room: ctx.room(),
          x: HARVEST_SPOT.x,
          y: HARVEST_SPOT.y,
          energy: 400,
          resourceType: "energy",
        });
      },
      assertions: [
        eventually("container site lands exactly on the harvest tile", (s) => {
          if (containerSiteAt(s, HARVEST_SPOT)) srcContainerSeen = true;
          return srcContainerSeen;
        }),
        always("no other site is placed before the source container", (s) => {
          if (srcContainerSeen) return true;
          return sites(s).every(
            (o: any) => o.structureType === "container" && o.x === HARVEST_SPOT.x && o.y === HARVEST_SPOT.y
          );
        }),
      ],
    },

    {
      // The same room with a sub-threshold pile (150, decaying): rung 1 must
      // NOT fire; the core depot beside the spawn is the correct first site.
      id: "cons-depot-when-pile-thin",
      tier: 1,
      avenue: "construction",
      window: 60,
      rooms: { home: rungRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      creeps: quiet(),
      async stage(ctx) {
        await ctx.db["rooms.objects"].insert({
          type: "energy",
          room: ctx.room(),
          x: HARVEST_SPOT.x,
          y: HARVEST_SPOT.y,
          energy: 150,
          resourceType: "energy",
        });
      },
      assertions: [
        eventually("depot container site lands beside the spawn", (s) => containerSiteAt(s, DEPOT_TILE)),
        always("no container site ever appears at the source", (s) =>
          !s
            .objects()
            .some(
              (o: any) =>
                o.type === "constructionSite" &&
                o.structureType === "container" &&
                Math.max(Math.abs(o.x - 25), Math.abs(o.y - 40)) <= 1
            )
        ),
      ],
    },
  ];
}

const twoSourceRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(15, 30).source(35, 30).toRoom();

const EXT_POS: Array<{ x: number; y: number }> = [
  { x: 22, y: 24 },
  { x: 28, y: 24 },
  { x: 22, y: 26 },
  { x: 28, y: 26 },
  { x: 24, y: 22 },
  { x: 26, y: 22 },
  { x: 22, y: 28 },
  { x: 28, y: 28 },
  { x: 20, y: 24 },
  { x: 30, y: 24 },
];

const CONTAINER_FULL = 250000;

export function buildConstructionT2Cells(): GridCell[] {
  let oneSiteContainerSeen = false;
  let prevBHits: number | null = null;
  let maxAHits = 0;
  let prevRoadHits: number | null = null;

  return [
    {
      // The activeSites===0 gate: with BOTH sources signalling for rung-1
      // containers simultaneously, only one site may ever exist.
      id: "cons-one-site-at-a-time",
      tier: 2,
      avenue: "construction",
      window: 60,
      rooms: { home: twoSourceRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      creeps: quiet(),
      async stage(ctx) {
        for (const p of [
          { x: 16, y: 29 },
          { x: 34, y: 29 },
        ]) {
          await ctx.db["rooms.objects"].insert({
            type: "energy",
            room: ctx.room(),
            x: p.x,
            y: p.y,
            energy: 400,
            resourceType: "energy",
          });
        }
      },
      assertions: [
        eventually("a rung-1 container site appears at one source", (s) => {
          const hit = sites(s).some(
            (o: any) =>
              o.structureType === "container" &&
              (Math.max(Math.abs(o.x - 15), Math.abs(o.y - 30)) <= 1 ||
                Math.max(Math.abs(o.x - 35), Math.abs(o.y - 30)) <= 1)
          );
          if (hit) oneSiteContainerSeen = true;
          return oneSiteContainerSeen;
        }),
        always("never more than one site exists", (s) => sites(s).length <= 1),
      ],
    },

    {
      // Rung order: source containers + depot satisfied, extensions
      // unfinished -> the next site is an extension, never the controller
      // container (the far-hard-to-feed-structure-first stall).
      id: "cons-ext-before-ctrl-container",
      tier: 2,
      avenue: "construction",
      window: 60,
      rooms: { home: twoSourceRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: [
        { type: "container", x: 15, y: 29, energy: 0 },
        { type: "container", x: 35, y: 29, energy: 0 },
        { type: "container", x: 24, y: 24, energy: 0 }, // depot beside spawn
        ...EXT_POS.slice(0, 5).map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      creeps: quiet(),
      assertions: [
        eventually("an extension site is placed", (s) =>
          sites(s).some((o: any) => o.structureType === "extension")
        ),
        always("the controller container waits its turn", (s) =>
          !sites(s).some(
            (o: any) =>
              o.structureType === "container" && Math.max(Math.abs(o.x - 25), Math.abs(o.y - 10)) <= 2
          )
        ),
      ],
    },

    {
      // The last rung: containers + depot + ALL 10 RCL3 extensions built ->
      // the controller container fires, within 2 of the controller.
      id: "cons-ctrl-container-last",
      tier: 2,
      avenue: "construction",
      window: 60,
      rooms: { home: twoSourceRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: [
        { type: "container", x: 15, y: 29, energy: 0 },
        { type: "container", x: 35, y: 29, energy: 0 },
        { type: "container", x: 24, y: 24, energy: 0 },
        ...EXT_POS.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      creeps: quiet(),
      assertions: [
        eventually("the controller container site appears", (s) =>
          sites(s).some(
            (o: any) =>
              o.structureType === "container" && Math.max(Math.abs(o.x - 25), Math.abs(o.y - 10)) <= 2
          )
        ),
        always("nothing else is placed", (s) =>
          sites(s).every(
            (o: any) =>
              o.structureType === "container" && Math.max(Math.abs(o.x - 25), Math.abs(o.y - 10)) <= 2
          )
        ),
      ],
    },

    {
      // REPAIR_SPAWN_BELOW hysteresis: only the 55% container triggers a
      // maintenance builder, and it repairs the MOST decayed first - the
      // healthier 75% container is untouched meanwhile.
      id: "cons-repair-starts-below-60",
      tier: 2,
      avenue: "construction",
      window: 400,
      rooms: { home: twoSourceRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: [
        { type: "container", x: 15, y: 29, energy: 1000, hits: 137500 }, // A: 55%
        { type: "container", x: 35, y: 29, energy: 0, hits: 187500 }, // B: 75%
        { type: "container", x: 24, y: 24, energy: 0 },
        { type: "container", x: 25, y: 12, energy: 0 },
        ...EXT_POS.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      assertions: [
        eventually("a maintenance builder is fielded", (s) =>
          Object.entries(s.memory?.creeps ?? {}).some(
            ([, mem]: [string, any]) =>
              mem?.workType === "build" && typeof mem?.corpId === "string" && mem.corpId.endsWith("-construction")
          )
        ),
        eventually("the 55% container is repaired", (s) => {
          const a = s.objects().find((o) => o.type === "container" && o.x === 15 && o.y === 29);
          return !!a && (a.hits ?? 0) > 140000;
        }),
        // Most-decayed-first: B may decay but must never RISE while A is worse.
        always("the healthier container is untouched", (s) => {
          const b = s.objects().find((o) => o.type === "container" && o.x === 35 && o.y === 29);
          if (!b) return false;
          const rose = prevBHits !== null && (b.hits ?? 0) > prevBHits;
          prevBHits = b.hits ?? 0;
          return !rose;
        }),
      ],
    },

    {
      // REPAIR_TO=0.99: repair only STARTS below the 60% hysteresis gate
      // (staging at 96% never engages - observed live), so A is staged at
      // 55% and a 10-WORK builder (1000 hits/tick, self-fuelling from A's
      // store) drives the full climb to the 247500 ceiling in-window, where
      // it must STOP - hits plateau below hitsMax.
      id: "cons-repair-stops-at-99",
      tier: 2,
      avenue: "construction",
      // 230, measured: repair reached 245500/247500 at 170 - refuel pauses
      // and the organic miner's arrival eat ~40 ticks beyond the raw
      // 110-tick repair time.
      window: 230,
      rooms: { home: twoSourceRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: [
        { type: "container", x: 15, y: 29, energy: 1500, hits: 137500 }, // A: 55%
        { type: "container", x: 35, y: 29, energy: 0 },
        { type: "container", x: 24, y: 24, energy: 0 },
        { type: "container", x: 25, y: 12, energy: 0 },
        ...EXT_POS.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      creeps: [
        {
          name: "b1",
          x: 15,
          y: 28,
          body: ["work", "work", "work", "work", "work", "work", "work", "work", "work", "work", "carry", "carry", "carry", "carry", "move", "move"],
          energy: 200,
        },
        ...quiet(),
      ],
      memory: {
        creeps: {
          b1: { workType: "build", corpId: "building-$room()-construction", working: true },
        },
      },
      assertions: [
        // NOTE: pickRepairTarget is most-decayed-first, so in a decaying room
        // the builder ROTATES targets at parity and the fleet equilibrates
        // just under the ceiling - "reaches exactly 99%" is unattainable by
        // design (measured: all four containers hover 245-246k). The honest
        // ceiling observables: the staged wreck is massively repaired, and NO
        // container ever exceeds REPAIR_TO (+ one 10-WORK tick of slack).
        eventually("the 55% container is repaired toward the ceiling", (s) => {
          const a = s.objects().find((o) => o.type === "container" && o.x === 15 && o.y === 29);
          if (a) maxAHits = Math.max(maxAHits, a.hits ?? 0);
          return maxAHits >= 240000;
        }),
        always("no container ever exceeds the 99% ceiling", (s) =>
          s
            .objects()
            .filter((o) => o.type === "container")
            .every((o) => (o.hits ?? 0) <= 247500 + 1100)
        ),
        always("never tops out to full", (s) =>
          s
            .objects()
            .filter((o) => o.type === "container")
            .every((o) => (o.hits ?? 0) < CONTAINER_FULL)
        ),
      ],
    },

    {
      // The roads rung fires ONLY when the ladder is otherwise complete: with
      // source/depot/controller containers and the full RCL3 extension set
      // staged, the corp's first placement is the source->spawn route's road
      // sites (batched - roads are not one-per-cooldown), and the builders
      // then actually pave.
      id: "cons-road-route-paved",
      tier: 2,
      avenue: "construction",
      // 700: the surplus gate (full spawn bank) defers the route start until
      // the organic economy stabilizes (~250-350), then partial paving needs
      // another ~150.
      window: 700,
      rooms: { home: rungRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: [
        { type: "container", x: HARVEST_SPOT.x, y: HARVEST_SPOT.y, energy: 2000 },
        { type: "container", x: DEPOT_TILE.x, y: DEPOT_TILE.y, energy: 1500 },
        { type: "container", x: 25, y: 12, energy: 0 },
        ...EXT_POS.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      assertions: [
        eventually("road sites are batch-placed along the haul route", (s) =>
          sites(s).filter((o: any) => o.structureType === "road").length >= 8
        ),
        always("only road sites are ever placed (the ladder is satisfied)", (s) =>
          sites(s).every((o: any) => o.structureType === "road")
        ),
        eventually("at least part of the route is actually paved", (s) =>
          s.objects().filter((o: any) => o.type === "road").length >= 3
        ),
      ],
    },

    {
      // Road repair with the FRACTION ordering pinned in the discriminating
      // direction: a 90% road (4500/5000 hits) has by far the LOWEST absolute
      // hits in the room, so the absolute-hits sort would repair it first -
      // the fraction sort must instead drive the 55% container (137500/250000)
      // up, touching the road only after the container passes it. The staged
      // 10-WORK builder (the stops-at-99 kit) makes the container climb fit
      // the window, and the road - which holds no energy - is then topped up
      // via the new fuel-from-elsewhere path.
      id: "cons-repair-road-fraction",
      tier: 2,
      avenue: "construction",
      window: 400,
      rooms: { home: twoSourceRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: [
        { type: "road", x: 25, y: 20, hits: 4500 }, // 90% - lowest ABSOLUTE hits
        // 55% - worst FRACTION; holds its own repair energy (the ~875 the
        // climb burns) so the 2-MOVE builder never leaves the tile mid-climb.
        { type: "container", x: 25, y: 12, energy: 1200, hits: 137500 },
        { type: "container", x: 15, y: 29, energy: 1500 },
        { type: "container", x: 35, y: 29, energy: 1000 },
        { type: "container", x: 24, y: 24, energy: 1500 }, // the builder's fuel
        ...EXT_POS.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      creeps: [
        {
          name: "rb1",
          x: 25,
          y: 13,
          body: ["work", "work", "work", "work", "work", "work", "work", "work", "work", "work", "carry", "carry", "carry", "carry", "move", "move"],
          energy: 200,
        },
        ...quiet(),
      ],
      memory: {
        creeps: {
          rb1: { workType: "build", corpId: "building-$room()-construction", working: true },
        },
      },
      assertions: [
        eventually("the 55% container is repaired past 60% (fraction outranks absolute)", (s) => {
          const ctrl = s.objects().find((o: any) => o.type === "container" && o.x === 25 && o.y === 12);
          return !!ctrl && (ctrl.hits ?? 0) >= 155000;
        }),
        // The absolute-hits sort would top the 4500-hit road up FIRST. Under
        // fraction order it must not rise until the container passes 60%.
        always("the 90% road never rises before the container crosses 60%", (s) => {
          const ctrl = s.objects().find((o: any) => o.type === "container" && o.x === 25 && o.y === 12);
          const road = s.objects().find((o: any) => o.type === "road" && o.x === 25 && o.y === 20);
          const rose = prevRoadHits !== null && !!road && (road.hits ?? 0) > prevRoadHits;
          prevRoadHits = road ? road.hits ?? 0 : prevRoadHits;
          if (!rose) return true;
          return !!ctrl && (ctrl.hits ?? 0) >= 150000;
        }),
        eventually("the road is eventually topped up too (fueling from elsewhere works)", (s) => {
          const road = s.objects().find((o: any) => o.type === "road" && o.x === 25 && o.y === 20);
          return !!road && (road.hits ?? 0) >= 4900;
        }),
      ],
    },
  ];
}

export function buildConstructionT3Cells(): GridCell[] {
  return [
    {
      // Pocket convergence: with one walkable adjacent tile, the container
      // site MUST land exactly there - any other tile is a wall and would
      // orphan the miner's drop pile forever.
      id: "cons-pocket-container-exact-tile",
      tier: 3,
      avenue: "construction",
      window: 60,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(25, 10);
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
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      creeps: quiet(),
      async stage(ctx) {
        await ctx.db["rooms.objects"].insert({
          type: "energy",
          room: ctx.room(),
          x: 10,
          y: 24,
          energy: 400,
          resourceType: "energy",
        });
      },
      assertions: [
        eventually("container site lands exactly on the pocket tile", (s) =>
          s
            .objects()
            .some(
              (o: any) =>
                o.type === "constructionSite" && o.structureType === "container" && o.x === 10 && o.y === 24
            )
        ),
        always("no container site anywhere else near the source", (s) =>
          s
            .objects()
            .filter(
              (o: any) =>
                o.type === "constructionSite" &&
                o.structureType === "container" &&
                Math.max(Math.abs(o.x - 10), Math.abs(o.y - 25)) <= 2
            )
            .every((o: any) => o.x === 10 && o.y === 24)
        ),
      ],
    },
  ];
}


export function buildConstructionT4Cells(): GridCell[] {
  const EXT_20: Array<{ x: number; y: number }> = [];
  for (const y of [19, 21]) for (let x = 18; x <= 32; x += 2) EXT_20.push({ x, y });
  for (const x of [20, 22, 24, 26]) EXT_20.push({ x, y: 17 });

  const EXT_30: Array<{ x: number; y: number }> = [];
  for (const y of [30, 32, 34, 36, 38]) for (const x of [31, 33, 35, 37, 39, 41]) EXT_30.push({ x, y });

  return [
    {
      // The in-ladder cap guard: with extensions AT the RCL4 cap, the corp
      // falls through to the storage rung instead of retrying an over-cap
      // extension every cooldown forever.
      id: "cons-capguard-storage-rcl4",
      tier: 4,
      avenue: "construction",
      window: 60,
      rooms: { home: twoSourceRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 4 },
      structures: [
        { type: "container", x: 15, y: 29, energy: 0 },
        { type: "container", x: 35, y: 29, energy: 0 },
        { type: "container", x: 24, y: 25, energy: 0 },
        ...EXT_20.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      creeps: quiet(),
      assertions: [
        eventually("the storage site lands beside the spawn", (s) =>
          sites(s).some(
            (o: any) =>
              o.structureType === "storage" && Math.max(Math.abs(o.x - 25), Math.abs(o.y - 25)) <= 2
          )
        ),
        always("never an over-cap extension site", (s) =>
          !sites(s).some((o: any) => o.structureType === "extension")
        ),
      ],
    },

    {
      // Link anchoring: at RCL5 with zero links, the CORE link beside the
      // storage wins - even though both sources are >8 range and eligible.
      id: "cons-link-core-first",
      tier: 4,
      avenue: "construction",
      window: 60,
      rooms: { home: twoSourceRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 5 },
      structures: [
        { type: "storage", x: 24, y: 25, energy: 10000 },
        { type: "container", x: 15, y: 29, energy: 0 },
        { type: "container", x: 35, y: 29, energy: 0 },
        ...EXT_30.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      creeps: quiet(),
      assertions: [
        eventually("the core link site lands beside the storage", (s) =>
          sites(s).some(
            (o: any) => o.structureType === "link" && Math.max(Math.abs(o.x - 24), Math.abs(o.y - 25)) <= 1
          )
        ),
        always("no source link before the core", (s) =>
          !sites(s).some(
            (o: any) =>
              o.structureType === "link" &&
              (Math.max(Math.abs(o.x - 15), Math.abs(o.y - 30)) <= 2 ||
                Math.max(Math.abs(o.x - 35), Math.abs(o.y - 30)) <= 2)
          )
        ),
      ],
    },

    {
      // Source-link selection: with the core built, the next link goes to the
      // FARTHEST >8-range source; the <=8-range source never gets one, and
      // LINK_LIMITS[5]=2 blocks a third.
      id: "cons-link-farthest-source",
      tier: 4,
      avenue: "construction",
      window: 60,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName)
            .border()
            .controller(10, 10)
            .source(30, 27)
            .source(25, 42)
            .source(45, 44)
            .toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 5 },
      structures: [
        { type: "storage", x: 24, y: 25, energy: 10000 },
        { type: "link", x: 23, y: 24, energy: 0 }, // core link, prebuilt
        { type: "container", x: 30, y: 26, energy: 0 },
        { type: "container", x: 25, y: 41, energy: 0 },
        { type: "container", x: 44, y: 44, energy: 0 },
        ...EXT_30.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      creeps: quiet(),
      assertions: [
        eventually("the link site goes to the FARTHEST eligible source", (s) =>
          sites(s).some(
            (o: any) => o.structureType === "link" && Math.max(Math.abs(o.x - 45), Math.abs(o.y - 44)) <= 2
          )
        ),
        always("never near the mid or in-range sources, never a third", (s) => {
          const links = sites(s).filter((o: any) => o.structureType === "link");
          if (links.length > 1) return false;
          return links.every(
            (o: any) =>
              Math.max(Math.abs(o.x - 25), Math.abs(o.y - 42)) > 2 &&
              Math.max(Math.abs(o.x - 30), Math.abs(o.y - 27)) > 2
          );
        }),
      ],
    },
  ];
}

export const constructionCells: GridCell[] = [
  {
    id: "cons-ext-first-site-checkerboard",
    tier: 0,
    avenue: "construction",
    window: 100,
    rooms: { home: homeRoom },
    bot: { x: SPAWN.x, y: SPAWN.y },
    controller: { level: 2 },
    assertions: [
      eventually("an extension construction site is placed", (s) =>
        sites(s).some((o: any) => o.structureType === "extension")
      ),
      always("only extensions are ever placed at RCL2", (s) =>
        sites(s).every((o: any) => o.structureType === "extension")
      ),
      always("every placed site obeys the grid rules", (s) => sites(s).every(obeysGridRules)),
      always("never more than one site at a time", (s) => sites(s).length <= 1),
    ],
  },
];
