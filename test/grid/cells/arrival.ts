/**
 * arrival cells (docs/specs/08, avenue: work-transition).
 *
 * T0 FLAGSHIP: the zombie-miner cell. A miner already standing on
 * sourceHarvestSpot must harvest as soon as its corp claims it - the exact
 * signature of the repo's oldest open flake ("mining corp at 0/10 actual",
 * docs/specs/00-corp-framework.md:248, 01-rcl5-cold-start-stall.md:37) is a
 * miner AT its post producing NOTHING. Staging the moment directly turns an
 * alternating integration flake into a deterministic 60-tick verdict.
 *
 * Expected tile: bestAdjacentTile(source(25,30), spawn(25,25)) resolves ties
 * (distance 4) to the first candidate in dx,dy=-1..1 order -> (24,29), not
 * the straight-line (25,29) (errata wrong-behavior #3).
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(18, 20).source(25, 30).toRoom();

/** bestAdjacentTile(source(25,30), spawn(25,25)) per the tie-break above. */
const SPOT = { x: 24, y: 29 };

const quiet = (): Array<{ name: string; x: number; y: number; body: string[]; memory?: any }> => [
  { name: "decoy", x: 20, y: 22, body: ["carry", "move"], memory: { workType: "haul" } },
  { name: "filler1", x: 19, y: 22, body: ["move"] },
  { name: "filler2", x: 19, y: 23, body: ["move"] },
];

// ---------------------------------------------------------------------------
// T1 geometry notes
//  - converges-to-container: container staged at (25,31), adjacent to source
//    (25,30). sourceHarvestSpot returns the BUILT container's tile no matter
//    what bestAdjacentTile would say, so the off-spot miner must walk to it.
//  - withdraws-stocked-container: container (25,33) beside source (25,32);
//    hauler staged at (24,32), Chebyshev 1 from the container.
//  - upgrader-parked: controller (25,10) in plain interior -> input spot
//    (23,8) (all candidates score 8; smallest-x/y tie-break), first parking
//    tile (22,7). Replicated from nodeEnergy.ts:243-312.
// ---------------------------------------------------------------------------


export function buildArrivalT4Cells(): GridCell[] {
  let linkAdopted: number | null = null;

  return [
    {
      // Link mining handoff: a full-store miner beside its source link must
      // transfer AND harvest the same tick (separate intent groups) - a
      // sustained ~10/tick pump into the link. Links are injectable via the
      // grid's stage layer (structureCapacity link:800 - errata #2 fixed).
      id: "arrive-miner-feeds-source-link",
      tier: 4,
      avenue: "work-transition",
      window: 45,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(18, 20).source(25, 32).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 5 },
      structures: [{ type: "link", x: 24, y: 32, energy: 0 }],
      creeps: [
        {
          name: "m1",
          x: 24,
          y: 31, // the harvest spot; link at (24,32) is range 1 of it
          body: ["work", "work", "work", "work", "work", "carry", "move", "move", "move"],
          energy: 50,
          memory: { workType: "harvest", corpId: "stale-mining", assignedSourceId: "$id(home,source,25,32)" },
        },
        ...quiet(),
      ],
      assertions: [
        eventually("adopted", (s) => {
          const corpId = s.memory?.creeps?.m1?.corpId;
          if (typeof corpId === "string" && corpId.startsWith("mining-") && linkAdopted === null) {
            linkAdopted = s.tick;
          }
          return linkAdopted !== null;
        }),
        eventually("first volley lands in the link", (s) => {
          const link = s.objects().find((o) => o.type === "link" && o.x === 24 && o.y === 32);
          return !!link && (link.store?.energy ?? 0) >= 50;
        }),
        eventually("the refill loop sustains the pump (>= 130)", (s) => {
          const link = s.objects().find((o) => o.type === "link" && o.x === 24 && o.y === 32);
          return !!link && (link.store?.energy ?? 0) >= 130;
        }),
        always("the miner never leaves its spot to do it", (s) => {
          const c = s.creep("m1");
          return !!c && c.x === 24 && c.y === 31;
        }),
      ],
    },
  ];
}

export function buildArrivalT3Cells(): GridCell[] {
  let threadAdopted: number | null = null;

  return [
    {
      // Pocketed source: the spot resolves to the single opening tile; the
      // miner threads the mouth and mines - any mis-resolution or approach
      // deadlock shows immediately. (arrive-hauler-escapes-upgrader-ring is
      // deliberately NOT built: same mechanism as move-bypass-ring-escape.)
      id: "arrive-miner-threads-pocket-opening",
      tier: 3,
      avenue: "work-transition",
      window: 40,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(20, 12);
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
      bot: { x: 14, y: 20 },
      controller: { level: 2 },
      creeps: [
        {
          name: "m1",
          x: 12,
          y: 22,
          body: ["work", "work", "work", "work", "work", "move", "move", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "stale-mining", assignedSourceId: "$id(home,source,10,25)" },
        },
        { name: "decoy", x: 18, y: 18, body: ["carry", "move"], memory: { workType: "haul" } },
        { name: "filler1", x: 18, y: 19, body: ["move"] },
        { name: "filler2", x: 18, y: 20, body: ["move"] },
      ],
      assertions: [
        eventually("adopted", (s) => {
          const corpId = s.memory?.creeps?.m1?.corpId;
          if (typeof corpId === "string" && corpId.startsWith("mining-") && threadAdopted === null) {
            threadAdopted = s.tick;
          }
          return threadAdopted !== null;
        }),
        eventually("threads the mouth onto the only harvest tile", (s) => {
          const m = s.creep("m1");
          return !!m && m.x === 10 && m.y === 24;
        }),
        eventually("mines at full rate once seated", (s) => {
          const src = s.objects().find((o) => o.type === "source" && o.x === 10 && o.y === 25);
          return !!src && src.energy <= 2900;
        }),
        always("never oscillates back out once seated", (s) => {
          const m = s.creep("m1");
          if (!m) return false;
          const src = s.objects().find((o) => o.type === "source" && o.x === 10 && o.y === 25);
          const seatedOnce = !!src && src.energy < 3000;
          return !seatedOnce || (m.x === 10 && m.y === 24);
        }),
      ],
    },
  ];
}

export function buildArrivalT2Cells(): GridCell[] {
  // stays-when-spot-held closure
  let stayAdopted: number | null = null;

  // dry-withdraw closure
  let dryAdopted: number | null = null;
  let dryBaseProgress: number | null = null;

  // no-dry-tick (WORK-heavy small-buffer drain) closure
  let noDryAdopted: number | null = null;

  // pile-pickup closure
  let prevPileStore: number | null = null;
  let pileStall = 0;

  // builder closure
  let buildStart: number | null = null;
  let buildBase: number | null = null;
  let flatRun = 0;
  let prevProgress: number | null = null;

  return [
    {
      // minerApproach 'stay': adjacent to the source with the spot held by a
      // permanent blocker, the miner harvests from where it stands - it never
      // shuffles at the occupied tile.
      id: "arrive-miner-stays-when-spot-held",
      tier: 2,
      avenue: "work-transition",
      window: 40,
      rooms: { home: homeRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        // Inert blocker ON the spot (24,29): no memory entry at all, so
        // OrphanRescue skips it forever (canary-proven untouchable).
        { name: "b1", x: SPOT.x, y: SPOT.y, body: ["move"] },
        {
          name: "m1",
          x: 26,
          y: 30,
          body: ["work", "work", "work", "work", "work", "move"],
          memory: { workType: "harvest", corpId: "stale-mining", assignedSourceId: "$id(home,source,25,30)" },
        },
        ...quiet(),
      ],
      assertions: [
        eventually("adopted", (s) => {
          const corpId = s.memory?.creeps?.m1?.corpId;
          if (typeof corpId === "string" && corpId.startsWith("mining-") && stayAdopted === null) {
            stayAdopted = s.tick;
          }
          return stayAdopted !== null;
        }),
        always("never leaves its adjacent tile", (s) => {
          const c = s.creep("m1");
          return !!c && c.x === 26 && c.y === 30;
        }),
        eventually("harvests from where it stands", (s) => {
          const src = s.objects().find((o) => o.type === "source" && o.x === 25 && o.y === 30);
          return !!src && src.energy <= 2880 && s.tick <= (stayAdopted ?? 0) + 25;
        }),
      ],
    },

    {
      // drawFromInput: an empty parked upgrader refills from the adjacent
      // input container WITHOUT moving, then resumes upgrading.
      id: "arrive-upgrader-dry-withdraws-in-place",
      tier: 2,
      avenue: "work-transition",
      window: 45,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 10).source(25, 32).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      // The container within 3 of the controller becomes the input spot's
      // buffer branch; parking tiles ring IT - first is (24,11).
      structures: [{ type: "container", x: 25, y: 12, energy: 800 }],
      creeps: [
        {
          name: "u1",
          x: 24,
          y: 11,
          body: ["work", "work", "work", "work", "carry", "carry", "carry", "carry", "move", "move"],
          memory: {
            workType: "upgrade",
            corpId: "stale-upgrading",
            working: false,
            upgradeSpot: { x: 24, y: 11 },
          },
        },
        ...quiet(),
      ],
      assertions: [
        eventually("adopted", (s) => {
          const corpId = s.memory?.creeps?.u1?.corpId;
          if (typeof corpId === "string" && corpId.startsWith("upgrading-") && dryAdopted === null) {
            dryAdopted = s.tick;
          }
          return dryAdopted !== null;
        }),
        always("never leaves its parking tile", (s) => {
          const c = s.creep("u1");
          return !!c && c.x === 24 && c.y === 11;
        }),
        eventually("withdraws in place", (s) => {
          const c = s.creep("u1");
          const box = s.objects().find((o) => o.type === "container" && o.x === 25 && o.y === 12);
          return !!c && !!box && (c.store?.energy ?? 0) >= 200 && (box.store?.energy ?? 0) <= 600;
        }),
        eventually("resumes upgrading at full rate", (s) => {
          if (dryAdopted === null) return false;
          const ctrl = s.objects().find((o) => o.type === "controller");
          if (!ctrl || s.tick < dryAdopted + 4) return false;
          if (dryBaseProgress === null) {
            dryBaseProgress = ctrl.progress ?? 0;
            return false;
          }
          if (s.tick > dryAdopted + 16) return false;
          return (ctrl.progress ?? 0) - dryBaseProgress >= 36;
        }),
      ],
    },

    {
      // A container-fed upgrader must top up AND upgrade in the SAME tick (so its
      // buffer never goes dry), BUT must not withdraw every tick (each withdraw is
      // ~0.2 CPU). Same geometry as arrive-upgrader-dry-withdraws-in-place
      // (container 25,12 -> input spot; parking tile 24,11), with a 6-WORK/1-CARRY
      // body (50 buffer) draining 6/tick. Two invariants pin BOTH concerns, and
      // only the batched same-tick top-up satisfies both:
      //   1) never dry (always store > 0) - the oscillation regression
      //      (working ? upgrade : draw) snapshots a 0 on every drain (a wasted WORK
      //      tick, "empty for a tick, then withdraws", live 2026-07-17); the
      //      same-tick top-up never does. The sibling parked cell's 4W/4C body
      //      starts at 200 and never drains here, which is why it misses this.
      //   2) drains between draws (eventually store <= 15) - a naive fix that
      //      withdraws EVERY tick keeps the buffer pinned ~44-50 and burns 0.2 CPU
      //      per tick per upgrader; the just-in-time batched refill lets the buffer
      //      fall to ~workParts (8) before topping up, so it is observed low.
      id: "arrive-upgrader-no-dry-tick-under-drain",
      tier: 2,
      avenue: "work-transition",
      window: 45,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 10).source(25, 32).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      // Plenty of buffer so the container never legitimately dries inside the
      // window (~6/tick drawn * 45 = 270 << 4000); an empty u1 means the bug, not
      // a starved input.
      structures: [{ type: "container", x: 25, y: 12, energy: 4000 }],
      creeps: [
        {
          name: "u1",
          x: 24,
          y: 11,
          // WORK-heavy, single-CARRY (containerFed shape): 50 buffer drained 6/tick.
          body: ["work", "work", "work", "work", "work", "work", "carry", "move", "move"],
          energy: 50, // starts full, so it is working from tick 1 (never a legit 0)
          memory: {
            workType: "upgrade",
            corpId: "stale-upgrading",
            working: true,
            upgradeSpot: { x: 24, y: 11 },
          },
        },
        ...quiet(),
      ],
      assertions: [
        eventually("adopted by the upgrading corp", (s) => {
          const corpId = s.memory?.creeps?.u1?.corpId;
          if (typeof corpId === "string" && corpId.startsWith("upgrading-") && noDryAdopted === null) {
            noDryAdopted = s.tick;
          }
          return noDryAdopted !== null;
        }),
        always("never leaves its parking tile", (s) => {
          const c = s.creep("u1");
          return !!c && c.x === 24 && c.y === 11;
        }),
        // Invariant 1 - never dry: a parked, container-fed upgrader tops up in the
        // same tick it upgrades, so its buffer never snapshots empty. The old
        // oscillation drains to exactly 0 on every cycle - one wasted WORK tick.
        // graceTicks covers adoption warm-up (pre-adoption the creep sits full).
        always(
          "buffer never goes dry (no wasted WORK tick refilling)",
          (s) => {
            const c = s.creep("u1");
            return !!c && (c.store?.energy ?? 0) > 0;
          },
          8
        ),
        // Invariant 2 - draws are batched, not every-tick: the just-in-time refill
        // lets the buffer fall to ~workParts (8 for this 6-WORK body) before topping
        // up, so it is observed <= 15. A naive fix that withdraws EVERY tick pins the
        // buffer ~44-50 (never <= 15) and burns 0.2 CPU/tick/upgrader - this fails on
        // that regression while the oscillation bug (which also drains low) does not,
        // so the two invariants together admit only the batched same-tick top-up.
        eventually("buffer drains between batched draws (not topped up every tick)", (s) => {
          const c = s.creep("u1");
          return !!c && (c.store?.energy ?? 0) <= 15;
        }),
      ],
    },

    {
      // A bare ground pile (no container anywhere) is collected at range 1 -
      // the 'stopped a tile short' regression, staged directly.
      id: "arrive-hauler-pile-pickup-range1",
      tier: 2,
      avenue: "work-transition",
      window: 45,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(18, 20).source(25, 32).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "h1",
          x: 25,
          y: 26,
          body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
          memory: { workType: "haul", corpId: "stale-hauling", working: false, assignedSourceId: "$id(home,source,25,32)" },
        },
        { name: "filler1", x: 19, y: 22, body: ["move"] },
        { name: "filler2", x: 19, y: 23, body: ["move"] },
      ],
      // 400 energy on the harvest-spot tile (24,31), injected raw.
      async stage(ctx) {
        await ctx.db["rooms.objects"].insert({
          type: "energy",
          room: ctx.room(),
          x: 24,
          y: 31,
          energy: 400,
          resourceType: "energy",
        });
      },
      assertions: [
        eventually("adopted", (s) => {
          const corpId = s.memory?.creeps?.h1?.corpId;
          return typeof corpId === "string" && corpId.startsWith("hauling-");
        }),
        eventually("collects the pile", (s) => {
          const c = s.creep("h1");
          const pile = s.objects().find((o) => o.type === "energy" && o.x === 24 && o.y === 31);
          return !!c && (c.store?.energy ?? 0) >= 250 && (!pile || pile.energy <= 150);
        }),
        always("never gains cargo beyond pickup range", (s) => {
          const c = s.creep("h1");
          if (!c) return true;
          const store = c.store?.energy ?? 0;
          const gained = prevPileStore !== null && store > prevPileStore;
          prevPileStore = store;
          return !gained || Math.max(Math.abs(c.x - 24), Math.abs(c.y - 31)) <= 1;
        }),
        always(
          "never stalls a tile short of a standing pile",
          (s) => {
            const c = s.creep("h1");
            const pile = s.objects().find((o) => o.type === "energy" && o.x === 24 && o.y === 31 && o.energy > 50);
            if (c && pile && (c.store?.energy ?? 0) === 0 && Math.max(Math.abs(c.x - 24), Math.abs(c.y - 31)) === 2) {
              pileStall += 1;
            } else pileStall = 0;
            return pileStall < 5;
          },
          20
        ),
      ],
    },

    {
      // refuelInPlace: a builder at a site with a container at its feet
      // builds EVERY tick past its unrefueled fuel horizon - the build/fetch
      // toggle never appears. Claimed instantly: its corpId is the
      // deterministic per-room construction corp id.
      id: "arrive-builder-builds-and-refuels-in-place",
      tier: 2,
      avenue: "work-transition",
      window: 60,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 10).source(25, 32).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      structures: [{ type: "container", x: 30, y: 25, energy: 1000 }],
      creeps: [
        // b1's memory lives in cell.memory (below) so the $room() token can
        // name the deterministic per-room construction corp id.
        {
          name: "b1",
          x: 29,
          y: 25,
          body: ["work", "work", "carry", "carry", "move", "move"],
          energy: 100,
        },
        ...quiet(),
      ],
      async stage(ctx) {
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
      },
      memory: {
        creeps: {
          b1: { workType: "build", corpId: "building-$room()-construction", working: true },
        },
      },
      assertions: [
        eventually("builds continuously past the fuel horizon", (s) => {
          const site = s
            .objects()
            .find((o) => o.type === "constructionSite" && o.x === 28 && o.y === 25);
          if (!site) return false;
          const progress = site.progress ?? 0;
          if (buildStart === null && progress > 0) {
            buildStart = s.tick;
            buildBase = progress;
            return false;
          }
          if (buildStart === null || buildBase === null) return false;
          if (s.tick < buildStart + 20) return false;
          return progress - buildBase >= 180;
        }),
        always("no 3-tick flat window once building", (s) => {
          const site = s
            .objects()
            .find((o) => o.type === "constructionSite" && o.x === 28 && o.y === 25);
          const progress = site?.progress ?? null;
          if (buildStart === null || progress === null) return true;
          if (prevProgress !== null && progress === prevProgress) flatRun += 1;
          else flatRun = 0;
          prevProgress = progress;
          return flatRun < 3;
        }),
        always("builder never leaves its tile", (s) => {
          const c = s.creep("b1");
          return !!c && c.x === 29 && c.y === 25;
        }),
        eventually("refuels from the container at its feet", (s) => {
          const box = s.objects().find((o) => o.type === "container" && o.x === 30 && o.y === 25);
          return !!box && (box.store?.energy ?? 0) <= 850;
        }),
      ],
    },

    {
      // Range-0 drop discipline: with no controller container, the loaded
      // controller hauler stands ON the input tile (23,8) and drops there -
      // a range-2 drop scatters the pile outside the upgrader ring's reach.
      id: "arrive-hauler-drops-on-input-tile",
      tier: 2,
      avenue: "work-transition",
      window: 45,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 10).source(25, 32).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "h1",
          x: 25,
          y: 18,
          body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
          energy: 300,
          memory: {
            workType: "haul",
            corpId: "stale-hauling",
            working: true,
            homeSink: "controller",
            deliverSinkId: "controller",
            assignedSourceId: "$id(home,source,25,32)",
          },
        },
        { name: "filler1", x: 19, y: 22, body: ["move"] },
        { name: "filler2", x: 19, y: 23, body: ["move"] },
      ],
      assertions: [
        eventually("adopted", (s) => {
          const corpId = s.memory?.creeps?.h1?.corpId;
          return typeof corpId === "string" && corpId.startsWith("hauling-");
        }),
        eventually("drops exactly on the input tile (23,8)", (s) =>
          s.objects().some((o) => o.type === "energy" && o.x === 23 && o.y === 8 && o.energy >= 250)
        ),
        eventually("stood on the input tile to do it", (s) => {
          const c = s.creep("h1");
          return !!c && c.x === 23 && c.y === 8;
        }),
        always("no scattered pile off the input tile near the controller", (s) =>
          s
            .objects()
            .filter((o) => o.type === "energy" && (o.energy ?? 0) >= 50)
            .every(
              (o) =>
                (o.x === 23 && o.y === 8) || Math.max(Math.abs(o.x - 25), Math.abs(o.y - 10)) > 3
            )
        ),
      ],
    },
  ];
}

export function buildArrivalT1Cells(): GridCell[] {
  // withdraws-stocked-container closure state
  let prevH1Store: number | null = null;
  let sawOneShotLoad = false;

  // upgrader-parked closure state
  let adoptedAt: number | null = null;
  let baseProgress: number | null = null;

  return [
    {
      id: "arrive-miner-converges-to-container",
      tier: 1,
      avenue: "work-transition",
      window: 60,
      rooms: { home: homeRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      structures: [{ type: "container", x: 25, y: 31, energy: 0 }],
      creeps: [
        {
          name: "m1",
          x: 29,
          y: 34,
          body: ["work", "work", "work", "work", "work", "move", "move", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "stale-mining", assignedSourceId: "$id(home,source,25,30)" },
        },
        ...quiet(),
      ],
      assertions: [
        eventually("adopted by the mining corp", (s) => {
          const corpId = s.memory?.creeps?.m1?.corpId;
          return typeof corpId === "string" && corpId.startsWith("mining-");
        }),
        eventually("walks onto the container tile", (s) => {
          const c = s.creep("m1");
          return !!c && c.x === 25 && c.y === 31;
        }),
        // The convergence payoff: CARRY-less harvest overflow lands IN the
        // container (the engine absorbs drops on a container tile).
        eventually("container absorbs the overflow", (s) => {
          const box = s.objects().find((o) => o.type === "container" && o.x === 25 && o.y === 31);
          return !!box && (box.store?.energy ?? 0) >= 80;
        }),
        always("no stray pile accumulates off the container tile", (s) =>
          s
            .objects()
            .filter((o) => o.type === "energy" && (o.energy ?? 0) > 100)
            .every((o) => o.x === 25 && o.y === 31)
        ),
        eventually("source is being drained", (s) => {
          const src = s.objects().find((o) => o.type === "source" && o.x === 25 && o.y === 30);
          return !!src && src.energy <= 2900;
        }),
      ],
    },

    {
      id: "arrive-hauler-withdraws-stocked-container",
      tier: 1,
      avenue: "work-transition",
      window: 30,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(18, 20).source(25, 32).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      structures: [{ type: "container", x: 25, y: 33, energy: 1500 }],
      creeps: [
        {
          name: "h1",
          x: 24,
          y: 32,
          body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
          memory: {
            workType: "haul",
            corpId: "stale-hauling",
            working: false,
            assignedSourceId: "$id(home,source,25,32)",
          },
        },
        { name: "filler1", x: 19, y: 22, body: ["move"] },
        { name: "filler2", x: 19, y: 23, body: ["move"] },
      ],
      assertions: [
        eventually("adopted by the carry corp", (s) => {
          const corpId = s.memory?.creeps?.h1?.corpId;
          return typeof corpId === "string" && corpId.startsWith("hauling-");
        }),
        // Already at range 1 of a stocked container: it must not wander before
        // its FIRST load (afterwards, walking back empty to reload is the
        // correct circuit behavior - the first run false-failed on that).
        always("never moves before its first load", (s) => {
          if (sawOneShotLoad) return true;
          const c = s.creep("h1");
          if (!c) return true;
          const store = c.store?.energy ?? 0;
          return store > 0 || (c.x === 24 && c.y === 32);
        }),
        // A single withdraw intent fills the whole 300 store in one tick.
        eventually("loads 0 -> 300 in one intent", (s) => {
          const c = s.creep("h1");
          const store = c?.store?.energy ?? null;
          const oneShot = prevH1Store === 0 && store === 300;
          if (oneShot) sawOneShotLoad = true;
          prevH1Store = store;
          return sawOneShotLoad;
        }),
        eventually("container debited to 1200", (s) => {
          const box = s.objects().find((o) => o.type === "container" && o.x === 25 && o.y === 33);
          return !!box && box.store?.energy === 1200;
        }),
        eventually("departs loaded", (s) => {
          const c = s.creep("h1");
          return !!c && (c.store?.energy ?? 0) > 0 && !(c.x === 24 && c.y === 32);
        }),
      ],
    },

    {
      id: "arrive-upgrader-parked-upgrades-every-tick",
      tier: 1,
      avenue: "work-transition",
      window: 40,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 10).source(25, 32).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "u1",
          x: 22,
          y: 7, // first parking tile for input spot (23,8)
          body: ["work", "work", "work", "work", "carry", "carry", "carry", "carry", "move", "move"],
          energy: 200,
          memory: {
            workType: "upgrade",
            corpId: "stale-upgrading",
            working: true,
            upgradeSpot: { x: 22, y: 7 },
          },
        },
        ...quiet(),
      ],
      assertions: [
        eventually("adopted by the upgrading corp", (s) => {
          const corpId = s.memory?.creeps?.u1?.corpId;
          if (typeof corpId === "string" && corpId.startsWith("upgrading-") && adoptedAt === null) {
            adoptedAt = s.tick;
          }
          return adoptedAt !== null;
        }),
        always("never leaves its cached parking tile", (s) => {
          const c = s.creep("u1");
          return !!c && c.x === 22 && c.y === 7;
        }),
        // The parked-model core invariant: with a full store, upgradeController
        // fires EVERY tick - 4 WORK = +4 progress/tick, >= 36 of the ideal 40
        // over the 10 ticks after adoption (organic upgraders can add at most
        // ~3 in this span, so a stalling u1 cannot be masked).
        eventually("upgrades every tick after adoption", (s) => {
          if (adoptedAt === null) return false;
          const ctrl = s.objects().find((o) => o.type === "controller");
          if (!ctrl) return false;
          if (s.tick < adoptedAt + 2) return false;
          if (baseProgress === null) {
            baseProgress = ctrl.progress ?? 0;
            return false;
          }
          if (s.tick > adoptedAt + 12) return false;
          return (ctrl.progress ?? 0) - baseProgress >= 36;
        }),
      ],
    },
  ];
}

export const arrivalCells: GridCell[] = [
  {
    id: "arrive-miner-on-spot-harvests",
    tier: 0,
    avenue: "work-transition",
    window: 60,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    creeps: [
      {
        name: "m1",
        x: SPOT.x,
        y: SPOT.y,
        body: ["work", "work", "work", "work", "work", "move"],
        memory: { workType: "harvest", corpId: "stale-mining", assignedSourceId: "$id(home,source,25,30)" },
      },
      // Jack suppressor (see spawn-exec.ts): keeps the source drain attributable.
      { name: "decoy", x: 20, y: 22, body: ["carry", "move"], memory: { workType: "haul" } },
    ],
    assertions: [
      eventually("adopted by the source's mining corp", (s) => {
        const corpId = s.memory?.creeps?.m1?.corpId;
        return typeof corpId === "string" && corpId.startsWith("mining-");
      }),
      // Staged ON the spot: frozen pre-adoption, approach 'stay' after. Any
      // move at any tick is a failure.
      always("never leaves the harvest tile", (s) => {
        const c = s.creep("m1");
        return !!c && c.x === SPOT.x && c.y === SPOT.y;
      }),
      // The zombie discriminator: 5 WORK = 10/tick from adoption (~11 measured)
      // drains 150 by ~tick 27. A zombie miner leaves the source near-full until
      // the organically-spawned second miner (2W, ~4/tick, fielded much later)
      // could touch it - which cannot reach -150 by tick 35.
      eventually("harvests promptly after adoption (anti-zombie)", (s) => {
        if (s.tick > 35) return false;
        const src = s.objects().find((o) => o.type === "source" && o.x === 25 && o.y === 30);
        return !!src && src.energy <= 2850;
      }),
      // Corroboration via the bot's own accounting: the 25-tick corpVariance
      // snapshot must show the mining corp producing (zombie signature: 0).
      eventually("corpVariance shows mining actual > 0", (s) => {
        const rows = s.memory?.corpVariance;
        return Array.isArray(rows) && rows.some((r: any) => r.type === "mining" && r.actual > 0);
      }),
    ],
  },
];
