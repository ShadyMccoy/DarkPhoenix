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
