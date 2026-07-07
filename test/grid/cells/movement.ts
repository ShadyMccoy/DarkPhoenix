/**
 * movement cells (docs/specs/08, avenue: movement).
 *
 * T0: existence proof that travelTo delivers a miner to THE harvest tile and
 * it holds. The expected tile is hand-derived from bestAdjacentTile's
 * tie-break (errata wrong-behavior #3): first tile at minimal Chebyshev
 * distance to the spawn in dx,dy = -1..1 iteration order with strict '<'
 * (src/corps/nodeEnergy.ts:115-127). For source (30,25) vs spawn (25,25) the
 * ties at distance 4 resolve to the first candidate, (29,24) - NOT the
 * straight-line (29,25). If the cell geometry changes, recompute by hand.
 */

import { GridCell, always, atWindow, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(30, 25).toRoom();

/** bestAdjacentTile(source(30,25), spawn(25,25)) per the tie-break above. */
const SPOT = { x: 29, y: 24 };

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// ---------------------------------------------------------------------------
// move-pickup-range-close geometry: spawn (25,25), source (25,45) ~20 south.
// Harvest spot = bestAdjacentTile(source, spawn) = (24,44) (tie-break, errata
// wrong-behavior #3) - the miner is staged THERE so its drop pile and the
// resolved pickup spot are the same tile.
// ---------------------------------------------------------------------------
const pickupRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 8).source(25, 45).toRoom();
const PILE = { x: 24, y: 44 };

// ---------------------------------------------------------------------------
// move-upgrader-park-settle geometry: controller (25,10) in an all-plain
// interior. controllerInputSpot scans dx,dy=-2..2; every candidate scores 8
// walkable-in-range neighbours, so the tie-break (smallest x, then y) picks
// (23,8). Parking tiles ring the input, excluding it, sorted by x then y.
// Replicated from src/corps/nodeEnergy.ts:243-312 for this exact terrain.
// ---------------------------------------------------------------------------
const INPUT = { x: 23, y: 8 };
const PARKING: Array<{ x: number; y: number }> = [
  { x: 22, y: 7 },
  { x: 22, y: 8 },
  { x: 22, y: 9 },
  { x: 23, y: 7 },
  { x: 23, y: 9 },
  { x: 24, y: 7 },
  { x: 24, y: 8 },
  { x: 24, y: 9 },
];
const parkRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(25, 40).toRoom();

// ---------------------------------------------------------------------------
// T2 ring-bypass geometry: the REAL ring-starve shape - an OPEN room where
// all 8 parking tiles around the input are occupied by parked upgraders.
// (A walled 1-wide corridor was tried first and is UNFAIR: the yield-swap
// only fires when the blocker is the immediate next step, and the
// creep-aware pathfinder sees a fully-blocked corridor as "no path", so the
// hauler livelocks outside without ever touching the ring. In the open ring
// any approach tile puts a yielding upgrader adjacent - the bug's shape.)
// Controller (25,10) in plain interior -> input (23,8); the ring is its 8
// neighbours, all within upgrade range 3.
// ---------------------------------------------------------------------------
const RING_INPUT = { x: 23, y: 8 };
const RING_PARK = [
  { x: 22, y: 7 },
  { x: 23, y: 7 },
  { x: 24, y: 7 },
  { x: 22, y: 8 },
  { x: 24, y: 8 },
  { x: 22, y: 9 },
  { x: 23, y: 9 },
  { x: 24, y: 9 },
];
const ringRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(25, 40).toRoom();

const ringUpgraders = () =>
  RING_PARK.map((p, i) => ({
    name: `u${i + 1}`,
    x: p.x,
    y: p.y,
    body: ["work", "carry", "move"],
    energy: 50,
    memory: {
      workType: "upgrade",
      corpId: `staged-ring-u${i + 1}`,
      working: true,
      upgradeSpot: { x: p.x, y: p.y },
    },
  }));

export function buildT2MovementCells(): GridCell[] {
  // congestion closure state
  let settledTicks = 0;

  // ring closure state: consecutive off-spot ticks per upgrader, per cell
  const depositOffSpot = RING_PARK.map(() => 0);
  const escapeOffSpot = RING_PARK.map(() => 0);

  const upgradersReturn = (counters: number[]) => (s: any): boolean => {
    for (let i = 0; i < RING_PARK.length; i++) {
      const c = s.creep(`u${i + 1}`);
      if (!c) return false;
      const onSpot = c.x === RING_PARK[i].x && c.y === RING_PARK[i].y;
      counters[i] = onSpot ? 0 : counters[i] + 1;
      // A swap displaces for 1 tick and the walk back takes 1 more; a third
      // consecutive off-spot tick means the upgrader lost its slot.
      if (counters[i] >= 3) return false;
    }
    return true;
  };

  return [
    {
      // Two miners, one open source: exactly one takes the static spot, the
      // other spreads to an adjacent tile - both harvest, nobody queues.
      id: "move-miner-congestion-open",
      tier: 2,
      avenue: "movement",
      window: 75,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(10, 10).source(25, 40).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "m1",
          x: 24,
          y: 36,
          body: ["work", "work", "move"],
          memory: { workType: "harvest", corpId: "staged-cg1", assignedSourceId: "$id(home,source,25,40)" },
        },
        {
          name: "m2",
          x: 26,
          y: 36,
          body: ["work", "work", "move"],
          memory: { workType: "harvest", corpId: "staged-cg2", assignedSourceId: "$id(home,source,25,40)" },
        },
        { name: "decoy", x: 20, y: 20, body: ["carry", "move"], memory: { workType: "haul" } },
        { name: "filler1", x: 19, y: 20, body: ["move"] },
        { name: "filler2", x: 19, y: 21, body: ["move"] },
      ],
      assertions: [
        eventually("both adopted by the mining corp", (s) => {
          const c1 = s.memory?.creeps?.m1?.corpId;
          const c2 = s.memory?.creeps?.m2?.corpId;
          return (
            typeof c1 === "string" && c1.startsWith("mining-") && typeof c2 === "string" && c2.startsWith("mining-")
          );
        }),
        // The arbitration outcome, held for 5 consecutive ticks: one ON the
        // spot (24,39), the other adjacent on a different tile, source
        // draining at both miners' combined rate.
        eventually("one seats the spot, the other spreads - both harvest", (s) => {
          const m1 = s.creep("m1");
          const m2 = s.creep("m2");
          const src = s.objects().find((o) => o.type === "source" && o.x === 25 && o.y === 40);
          if (!m1 || !m2 || !src) return false;
          const onSpot = (c: any) => c.x === 24 && c.y === 39;
          const adjacent = (c: any) => Math.max(Math.abs(c.x - 25), Math.abs(c.y - 40)) === 1;
          const ok =
            (onSpot(m1) ? adjacent(m2) && !onSpot(m2) : onSpot(m2) && adjacent(m1)) &&
            src.energy <= 2900;
          settledTicks = ok ? settledTicks + 1 : 0;
          return settledTicks >= 5;
        }),
        // The gridlock signature: a miner idling two tiles out, insisting on
        // the occupied static tile. Grace covers adoption + the short walk.
        always(
          "neither miner idles at range >= 2",
          (s) => {
            for (const name of ["m1", "m2"]) {
              const c = s.creep(name);
              if (!c) return false;
              if (Math.max(Math.abs(c.x - 25), Math.abs(c.y - 40)) >= 2) return false;
            }
            return true;
          },
          25
        ),
      ],
    },

    {
      // A loaded hauler penetrates the FULL upgrader ring by mutual-swapping
      // through a yielding parked upgrader, and drops on the input tile.
      id: "move-bypass-ring-deposit",
      tier: 2,
      avenue: "movement",
      window: 85,
      rooms: { home: ringRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        ...ringUpgraders(),
        {
          name: "h1",
          x: 25,
          y: 20,
          body: ["carry", "carry", "move", "move"],
          energy: 100,
          memory: {
            workType: "haul",
            corpId: "staged-ring-h",
            working: true,
            homeSink: "controller",
            deliverSinkId: "controller",
            assignedSourceId: "$id(home,source,25,40)",
          },
        },
      ],
      assertions: [
        eventually("hauler adopted", (s) => {
          const corpId = s.memory?.creeps?.h1?.corpId;
          return typeof corpId === "string" && corpId.startsWith("hauling-");
        }),
        eventually("h1 reaches the enclosed input tile", (s) => {
          const c = s.creep("h1");
          return !!c && c.x === RING_INPUT.x && c.y === RING_INPUT.y;
        }),
        eventually("the load lands ON the input tile", (s) =>
          s
            .objects()
            .some((o) => o.type === "energy" && o.x === RING_INPUT.x && o.y === RING_INPUT.y && o.energy >= 80)
        ),
        always("displaced upgraders re-seat within 2 ticks", upgradersReturn(depositOffSpot), 15),
      ],
    },

    {
      // The reverse: an EMPTY hauler walled in on the input tile swaps OUT
      // through a yielding upgrader and heads for its pickup.
      id: "move-bypass-ring-escape",
      tier: 2,
      avenue: "movement",
      window: 70,
      rooms: { home: ringRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        ...ringUpgraders(),
        // A seated miner makes a pile at the source, so h1 has a pickup target.
        {
          name: "m1",
          x: 24,
          y: 39,
          body: ["work", "work", "work", "work", "work", "move"],
          memory: { workType: "harvest", corpId: "staged-ring-m", assignedSourceId: "$id(home,source,25,40)" },
        },
        {
          name: "h1",
          x: RING_INPUT.x,
          y: RING_INPUT.y,
          body: ["carry", "carry", "move", "move"],
          memory: {
            workType: "haul",
            corpId: "staged-ring-h",
            working: false,
            assignedSourceId: "$id(home,source,25,40)",
          },
        },
      ],
      assertions: [
        eventually("hauler adopted", (s) => {
          const corpId = s.memory?.creeps?.h1?.corpId;
          return typeof corpId === "string" && corpId.startsWith("hauling-");
        }),
        eventually("escapes the enclosed input tile", (s) => {
          const c = s.creep("h1");
          return !!c && !(c.x === RING_INPUT.x && c.y === RING_INPUT.y);
        }),
        eventually("closes on the pickup at the source", (s) => {
          const c = s.creep("h1");
          return !!c && Math.max(Math.abs(c.x - 24), Math.abs(c.y - 39)) <= 3;
        }),
        always("displaced upgraders re-seat within 2 ticks", upgradersReturn(escapeOffSpot), 15),
      ],
    },
  ];
}

/** Pocket a source: wall all 8 neighbours except the tile north of it. */
const pocketAt = (b: RoomBuilder, x: number, y: number): RoomBuilder => {
  for (const [wx, wy] of [
    [x - 1, y - 1],
    [x + 1, y - 1],
    [x - 1, y],
    [x + 1, y],
    [x - 1, y + 1],
    [x, y + 1],
    [x + 1, y + 1],
  ]) {
    b.tile(wx, wy, "wall");
  }
  return b;
};

export function buildT3MovementCells(): GridCell[] {
  // pocket-holdoff closure
  let holdoffTicks = 0;

  // swamp-detour closure
  let sawLoaded = false;
  let sawCycle = false;
  let prevSpawnStore: number | null = null;

  // choke closure
  const stillCounters: Record<string, { pos: string | null; n: number }> = {
    m1: { pos: null, n: 0 },
    h1: { pos: null, n: 0 },
  };

  // border closure
  let borderAdopted = false;
  let firstInwardDone = false;
  let wasOnExit = false;

  return [
    {
      // A 1-spot pocket: the seated miner is never displaced; the second
      // miner holds off outside instead of wedging the mouth.
      id: "move-miner-pocket-holdoff",
      tier: 3,
      avenue: "movement",
      window: 75,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(40, 10);
          return pocketAt(b, 10, 25).source(10, 25).toRoom();
        },
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "m1",
          x: 10,
          y: 24,
          body: ["work", "work", "move"],
          memory: { workType: "harvest", corpId: "staged-ph1", assignedSourceId: "$id(home,source,10,25)" },
        },
        {
          name: "m2",
          x: 14,
          y: 25,
          body: ["work", "work", "move"],
          memory: { workType: "harvest", corpId: "staged-ph2", assignedSourceId: "$id(home,source,10,25)" },
        },
        { name: "decoy", x: 20, y: 20, body: ["carry", "move"], memory: { workType: "haul" } },
        { name: "filler1", x: 19, y: 20, body: ["move"] },
        { name: "filler2", x: 19, y: 21, body: ["move"] },
      ],
      assertions: [
        always("the seated miner is never displaced", (s) => {
          const m1 = s.creep("m1");
          return !!m1 && m1.x === 10 && m1.y === 24;
        }),
        always("the second miner never wedges the mouth", (s) => {
          const m2 = s.creep("m2");
          return !m2 || !(m2.x === 10 && m2.y === 24);
        }),
        eventually("the holder harvests uninterrupted for 20 ticks", (s) => {
          const src = s.objects().find((o) => o.type === "source" && o.x === 10 && o.y === 25);
          const m1 = s.creep("m1");
          const ok = !!src && !!m1 && m1.x === 10 && m1.y === 24 && src.energy < 3000;
          holdoffTicks = ok ? holdoffTicks + 1 : 0;
          return holdoffTicks >= 20;
        }),
      ],
    },

    {
      // Swamp band (5 rows, one 2-wide plains gap): the hauler's round trip
      // threads the gap - it never wades - and still completes a delivery.
      id: "move-swamp-detour",
      tier: 3,
      avenue: "movement",
      window: 130,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(25, 8).source(25, 42);
          // 5 swamp rows y=31..35 across the room, plains gap at x=18..19.
          for (let y = 31; y <= 35; y++) {
            for (let x = 1; x <= 48; x++) {
              if (x === 18 || x === 19) continue;
              b.tile(x, y, "swamp");
            }
          }
          return b.toRoom();
        },
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "m1",
          x: 24,
          y: 41,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-sw-m", assignedSourceId: "$id(home,source,25,42)" },
        },
        {
          name: "h1",
          x: 25,
          y: 28,
          body: ["carry", "carry", "move", "move"],
          memory: { workType: "haul", corpId: "staged-sw-h", working: false, assignedSourceId: "$id(home,source,25,42)" },
        },
        { name: "filler1", x: 19, y: 20, body: ["move"] },
        { name: "filler2", x: 19, y: 21, body: ["move"] },
      ],
      assertions: [
        always("the hauler never stands on a swamp tile", (s) => {
          const h = s.creep("h1");
          if (!h) return true;
          // Swamp rows are y=31..35 except the x=18..19 gap.
          return !(h.y >= 31 && h.y <= 35 && h.x !== 18 && h.x !== 19);
        }),
        eventually("completes a full detoured delivery cycle", (s) => {
          const h = s.creep("h1");
          const spawn = s.objects().find((o) => o.type === "spawn");
          if (!h || !spawn) return false;
          if ((h.store?.energy ?? 0) >= 100) sawLoaded = true;
          const store = spawn.store?.energy ?? 0;
          if (sawLoaded && prevSpawnStore !== null && store - prevSpawnStore >= 40) sawCycle = true;
          prevSpawnStore = store;
          return sawCycle;
        }),
      ],
    },

    {
      // Opposing traffic through a 1-wide choke: miner west, hauler follows
      // and re-crosses east loaded - no head-on standoff freezes them.
      id: "move-choke-corridor",
      tier: 3,
      avenue: "movement",
      window: 115,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().vWall(15, { gap: [25, 25] }).controller(35, 10).source(8, 25).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "m1",
          x: 20,
          y: 25,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-ck-m", assignedSourceId: "$id(home,source,8,25)" },
        },
        {
          name: "h1",
          x: 22,
          y: 25,
          body: ["carry", "carry", "move", "move"],
          memory: { workType: "haul", corpId: "staged-ck-h", working: false, assignedSourceId: "$id(home,source,8,25)" },
        },
        { name: "filler1", x: 30, y: 20, body: ["move"] },
        { name: "filler2", x: 30, y: 21, body: ["move"] },
      ],
      assertions: [
        // Harvest spot for source (8,25) vs spawn (25,25): ties at Chebyshev
        // 16 resolve to the first candidate (9,24) (errata wrong-behavior #3).
        eventually("the miner crosses and seats at (9,24)", (s) => {
          const m = s.creep("m1");
          return !!m && m.x === 9 && m.y === 24;
        }),
        eventually("the hauler re-crosses east loaded", (s) => {
          const h = s.creep("h1");
          return !!h && h.x > 15 && (h.store?.energy ?? 0) > 0;
        }),
        // No frozen standoff: nobody holds one tile > 10 consecutive ticks
        // unless legitimately stationary (miner on spot; hauler filling at
        // the pile - errata wrong-behavior #7).
        always(
          "no head-on standoff freezes the corridor",
          (s) => {
            for (const name of ["m1", "h1"] as const) {
              const c = s.creep(name);
              if (!c) return false;
              const pos = `${c.x},${c.y}`;
              const st = stillCounters[name];
              if (st.pos === pos) st.n += 1;
              else {
                st.pos = pos;
                st.n = 0;
              }
              const minerSeated = name === "m1" && c.x === 9 && c.y === 24;
              const haulerAtPile = name === "h1" && Math.max(Math.abs(c.x - 9), Math.abs(c.y - 24)) <= 1;
              if (st.n > 10 && !minerSeated && !haulerAtPile) return false;
            }
            return true;
          },
          15
        ),
      ],
    },

    {
      // The border inward-step: a creep on its target room's exit tile takes
      // the raw step IN, never oscillating across. First true two-room cell.
      id: "move-border-inward-step",
      tier: 3,
      avenue: "movement",
      window: 75,
      rooms: {
        home: (roomName: string) => {
          const b = new RoomBuilder(roomName).border().controller(25, 10).source(44, 25);
          for (let y = 24; y <= 26; y++) b.tile(49, y, "plain"); // east exit slot
          return b.toRoom();
        },
        east: (roomName: string) => {
          const b = new RoomBuilder(roomName).border();
          for (let y = 24; y <= 26; y++) b.tile(0, y, "plain"); // matching west gap
          return b.toRoom();
        },
      },
      adjacency: { east: "E" },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "m1",
          x: 49,
          y: 25,
          body: ["work", "work", "move"],
          memory: { workType: "harvest", corpId: "staged-bd", assignedSourceId: "$id(home,source,44,25)" },
        },
        { name: "decoy", x: 20, y: 20, body: ["carry", "move"], memory: { workType: "haul" } },
        { name: "filler1", x: 19, y: 20, body: ["move"] },
        { name: "filler2", x: 19, y: 21, body: ["move"] },
      ],
      assertions: [
        eventually("adopted", (s) => {
          const corpId = s.memory?.creeps?.m1?.corpId;
          if (typeof corpId === "string" && corpId.startsWith("mining-")) borderAdopted = true;
          return borderAdopted;
        }),
        // Post-adoption: the first stand on a home exit tile is followed by
        // the inward step, and it NEVER flips across again.
        always("steps inward off the exit tile, never oscillates", (s) => {
          if (!borderAdopted) return true;
          const home = s.creep("m1");
          const east = s
            .objects("east")
            .find((o) => o.type === "creep" && o.name === "m1");
          if (firstInwardDone) {
            // After the inward step: never on a home edge, never back east.
            return !!home && home.x < 49 && !east;
          }
          if (east) return true; // pre-fix drift east is tolerated until adoption settles
          if (!home) return false;
          if (home.x === 49) {
            wasOnExit = true;
            return true;
          }
          if (wasOnExit && home.x === 48) firstInwardDone = true;
          return true;
        }),
        // Seats on the harvest spot (43,24) and works the source.
        eventually("seats and harvests", (s) => {
          const m = s.creep("m1");
          const src = s.objects().find((o) => o.type === "source" && o.x === 44 && o.y === 25);
          return !!m && m.x === 43 && m.y === 24 && !!src && src.energy < 3000;
        }),
      ],
    },
  ];
}

export function buildStatefulMovementCells(): GridCell[] {
  // move-pickup-range-close closure state
  let prevStore: number | null = null;
  let ticksStalledAtRange2 = 0;

  // move-upgrader-park-settle closure state
  const inputSquat = { u1: 0, u2: 0 };
  const posHistory: Record<string, Array<{ x: number; y: number }>> = { u1: [], u2: [] };

  return [
    {
      id: "move-pickup-range-close",
      tier: 1,
      avenue: "movement",
      window: 95,
      rooms: { home: pickupRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        {
          name: "m1",
          x: PILE.x,
          y: PILE.y,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-pk", assignedSourceId: "$id(home,source,25,45)" },
        },
        {
          name: "h1",
          x: 25,
          y: 27,
          body: ["carry", "carry", "move", "move"],
          memory: { workType: "haul", corpId: "staged-pk-h", assignedSourceId: "$id(home,source,25,45)", working: false },
        },
      ],
      assertions: [
        eventually("h1 adopted by the carry corp", (s) => {
          const corpId = s.memory?.creeps?.h1?.corpId;
          return typeof corpId === "string" && corpId.startsWith("hauling-");
        }),
        eventually("h1 fills its store from the pile", (s) => (s.creep("h1")?.store?.energy ?? 0) >= 100),
        // Pickup range is 1: gaining cargo while >= 2 away from the pile tile
        // means it collected from somewhere it physically cannot.
        always("never gains cargo at range >= 2 from the pile", (s) => {
          const h = s.creep("h1");
          if (!h) return true;
          const store = h.store?.energy ?? 0;
          const gained = prevStore !== null && store > prevStore;
          prevStore = store;
          return !gained || cheb(h, PILE) <= 1;
        }),
        // The bug signature: parked a tile short (range 2) with an untouched
        // pile. Grace covers adoption (~11) + the ~17-tile walk.
        always(
          "never stalls at range 2 of a standing pile",
          (s) => {
            const h = s.creep("h1");
            const pile = s.objects().some((o) => o.type === "energy" && o.x === PILE.x && o.y === PILE.y && o.energy > 50);
            if (h && pile && (h.store?.energy ?? 0) === 0 && cheb(h, PILE) === 2) ticksStalledAtRange2 += 1;
            else ticksStalledAtRange2 = 0;
            return ticksStalledAtRange2 < 6;
          },
          40
        ),
      ],
    },

    {
      id: "move-upgrader-park-settle",
      tier: 1,
      avenue: "movement",
      window: 80,
      rooms: { home: parkRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      creeps: [
        { name: "u1", x: 24, y: 22, body: ["work", "carry", "move"], energy: 50, memory: { workType: "upgrade", corpId: "staged-up1" } },
        { name: "u2", x: 26, y: 22, body: ["work", "carry", "move"], energy: 50, memory: { workType: "upgrade", corpId: "staged-up2" } },
      ],
      assertions: [
        eventually("both adopted by the upgrading corp", (s) => {
          const c1 = s.memory?.creeps?.u1?.corpId;
          const c2 = s.memory?.creeps?.u2?.corpId;
          return (
            typeof c1 === "string" && c1.startsWith("upgrading-") && typeof c2 === "string" && c2.startsWith("upgrading-")
          );
        }),
        eventually("both parked on distinct parking tiles with upgradeSpot cached", (s) => {
          const u1 = s.creep("u1");
          const u2 = s.creep("u2");
          if (!u1 || !u2) return false;
          const onPark = (c: any) => PARKING.some((p) => p.x === c.x && p.y === c.y);
          const distinct = u1.x !== u2.x || u1.y !== u2.y;
          const cached = (name: string, c: any) => {
            const spot = s.memory?.creeps?.[name]?.upgradeSpot;
            return !!spot && spot.x === c.x && spot.y === c.y;
          };
          return onPark(u1) && onPark(u2) && distinct && cached("u1", u1) && cached("u2", u2);
        }),
        // Transit may legitimately CROSS the input tile for one tick (errata
        // window #8); squatting it two consecutive ticks is the ring-starve bug.
        always("never squats the reserved input tile", (s) => {
          for (const name of ["u1", "u2"] as const) {
            const c = s.creep(name);
            if (c && c.x === INPUT.x && c.y === INPUT.y) inputSquat[name] += 1;
            else inputSquat[name] = 0;
            if (inputSquat[name] >= 2) return false;
          }
          return true;
        }),
        // Settled means SETTLED: identical positions across the final stretch.
        atWindow("positions stable for the last 10 ticks", (s) => {
          for (const name of ["u1", "u2"] as const) {
            const h = posHistory[name];
            if (h.length < 10) return false;
            const last = h.slice(-10);
            if (!last.every((p) => p.x === last[0].x && p.y === last[0].y)) return false;
          }
          return true;
        }),
        always("track positions", (s) => {
          for (const name of ["u1", "u2"] as const) {
            const c = s.creep(name);
            if (c) posHistory[name].push({ x: c.x, y: c.y });
          }
          return true;
        }),
        eventually("controller progress increased", (s) => {
          const ctrl = s.objects().find((o) => o.type === "controller");
          return (ctrl?.progress ?? 0) > 0;
        }),
      ],
    },
  ];
}

export const movementCells: GridCell[] = [
  {
    id: "move-reach-harvest-spot",
    tier: 0,
    avenue: "movement",
    window: 70,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    creeps: [
      {
        name: "m1",
        x: 27,
        y: 25,
        body: ["work", "work", "move"],
        memory: { workType: "harvest", corpId: "staged-move", assignedSourceId: "$id(home,source,30,25)" },
      },
      // Jack suppressor: workType 'haul' with NO corpId - BootstrapCorp counts
      // it as a hauler so no jack ever contests the harvest spot, and
      // OrphanRescue provably never touches it (churn-canary-untouched).
      { name: "decoy", x: 20, y: 20, body: ["carry", "move"], memory: { workType: "haul" } },
    ],
    assertions: [
      eventually("adopted by the mining corp", (s) => {
        const corpId = s.memory?.creeps?.m1?.corpId;
        return typeof corpId === "string" && corpId.startsWith("mining-");
      }),
      eventually("seated on the designated harvest tile", (s) => {
        const c = s.creep("m1");
        return !!c && c.x === SPOT.x && c.y === SPOT.y;
      }),
      // Once seated it must hold the tile (minerApproach 'stay'); grace covers
      // adoption (~11 measured) plus the 2-tile walk.
      always(
        "holds the harvest tile once seated",
        (s) => {
          const c = s.creep("m1");
          return !!c && c.x === SPOT.x && c.y === SPOT.y;
        },
        30
      ),
      // 2 WORK = 4/tick from ~tick 15; well under 2900 by mid-window. A miner
      // that reached the tile but idles (no harvest intents) never satisfies.
      eventually("harvesting drains the source", (s) => {
        const src = s.objects().find((o) => o.type === "source" && o.x === 30 && o.y === 25);
        return !!src && src.energy <= 2900;
      }),
    ],
  },
];
