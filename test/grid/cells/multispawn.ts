/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * multi-spawn cells (RCL7+) - the assumptions a SECOND spawn breaks.
 *
 * A room is single-spawn from RCL1 through RCL6, so a lot of the economy grew
 * up saying "the spawn" (singular). At RCL7 the room gains a second spawn AND
 * 100-cap extensions (RCL8: a third + 200-cap); the engine's extension tick
 * derives capacity from the controller level, so a controller staged at 7 makes
 * every extension report 100 automatically.
 *
 * This avenue stages a WARM RCL7 room with two spawns placed apart - one by the
 * sources, one by the controller - and a funded storage bank, then asserts the
 * cross-cutting dual-spawn invariants the framework must honour:
 *
 *   - BOTH spawns are put to work (the second isn't left idle);
 *   - the pool serves a MIX of income and consumer demand across the two spawns
 *     (the SpawnDirector pools a room's demand and hands each buy to the nearest
 *     free spawn - distribution is not per-spawn), so consumer throughput isn't
 *     funnelled through spawn[0];
 *   - the refill SLA still holds on the larger 2-spawn / 100-cap bank (the
 *     ExtensionTenderCorp bank-capacity generalization).
 *
 * Staging notes (the second spawn is the interesting one):
 *   - addBot mints exactly ONE spawn (name "Spawn1"). A standing second spawn
 *     must be inserted with the full spawn schema - a unique `name`, `spawning:
 *     null`, and storeCapacityResource.energy - via the raw stage() hook; the
 *     declarative `structures` list omits name/spawning and would yield a spawn
 *     the runtime can't address.
 *   - PROVISIONAL: the window and thresholds below are reasoned, not calibrated -
 *     the grid mockup could not be run in the authoring sandbox. Run this cell
 *     once in a working grid env, tune the window, then `--update-baseline`.
 */

import { GridCell, CellSample, StageCtx, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";
import { makeRefillSla } from "../refillSLA";

const HOME = (roomName: string): any => {
  const b = new RoomBuilder(roomName).border();
  b.source(8, 25); // Source A - by Spawn1
  b.source(42, 25); // Source B - by Spawn2
  b.controller(44, 42); // by Spawn2
  return b.toRoom();
};

const SPAWN1 = { x: 10, y: 25 }; // addBot spawn, by Source A
const SPAWN2 = { x: 42, y: 40 }; // staged spawn, by the controller + Source B

/**
 * Insert a standing second spawn with the full addBot-equivalent schema - a
 * unique `name` and `spawning: null` the declarative `structures` path omits,
 * without which the runtime can't address the spawn.
 */
async function stageSecondSpawn(ctx: StageCtx, x: number, y: number, name = "Spawn2"): Promise<void> {
  await ctx.db["rooms.objects"].insert({
    type: "spawn",
    room: ctx.room(),
    x,
    y,
    user: ctx.userId,
    name,
    store: { energy: 300 },
    storeCapacityResource: { energy: ctx.C.SPAWN_ENERGY_CAPACITY },
    hits: ctx.C.SPAWN_HITS,
    hitsMax: ctx.C.SPAWN_HITS,
    spawning: null,
    notifyWhenAttacked: true,
  });
}

/** Two 10-extension clusters, one hugging each spawn (RCL7 = 50 max; 20 is
 *  plenty to exercise a two-cluster refill without a huge staging list). */
function extensionStructures(): { type: string; x: number; y: number; energy: number }[] {
  const out: { type: string; x: number; y: number; energy: number }[] = [];
  const cluster = (cx: number, cy: number): void => {
    let placed = 0;
    for (let dy = -1; dy <= 1 && placed < 10; dy++) {
      for (let dx = -2; dx <= 2 && placed < 10; dx++) {
        const x = cx + dx;
        const y = cy + 4 + dy; // offset off the spawn row so it doesn't collide
        out.push({ type: "extension", x, y, energy: 0 }); // start EMPTY - the tender must fill them
        placed++;
      }
    }
  };
  cluster(SPAWN1.x, SPAWN1.y);
  cluster(SPAWN2.x, SPAWN2.y);
  return out;
}

export function buildMultiSpawnT7Cells(): GridCell[] {
  return [
    {
      id: "multispawn-t7-both-spawns-worked",
      tier: 7,
      avenue: "multi-spawn",
      window: 800,
      rooms: { home: HOME },
      // addBot's Spawn1 sits by Source A; Spawn2 is staged by the controller.
      bot: { x: SPAWN1.x, y: SPAWN1.y },
      controller: { level: 7, progress: 0 },
      structures: [
        // Funded warchest so consumers + tender run from tick 1 (this cell is
        // about spawn UTILISATION, not the cold-start ramp).
        { type: "storage", x: 25, y: 33, energy: 120000 },
        // Source containers (miners drop here) + the controller's upgrade bucket.
        { type: "container", x: 9, y: 25, energy: 2000 },
        { type: "container", x: 41, y: 25, energy: 2000 },
        { type: "container", x: 44, y: 43, energy: 0 },
        ...extensionStructures(),
      ],
      // A miner on each source container -> income (and roomHasMiner) is live
      // immediately, so the tender/feeder gates open without a bootstrap ramp.
      creeps: [
        {
          name: "mA",
          x: 9,
          y: 25,
          body: ["work", "work", "work", "work", "work", "move"],
          memory: { workType: "harvest", corpId: "stale-mining", assignedSourceId: "$id(home,source,8,25)" },
        },
        {
          name: "mB",
          x: 41,
          y: 25,
          body: ["work", "work", "work", "work", "work", "move"],
          memory: { workType: "harvest", corpId: "stale-mining", assignedSourceId: "$id(home,source,42,25)" },
        },
      ],
      // The standing second spawn (see stageSecondSpawn).
      stage: (ctx) => stageSecondSpawn(ctx, SPAWN2.x, SPAWN2.y),
      assertions: [
        // Headline dual-spawn invariant: BOTH spawns actually build creeps.
        // Execution receipts (Memory.spawnAgenda[id].executed) accumulate and
        // persist, so once a spawn has bought anything it stays non-empty.
        eventually("both spawns are put to work (each executes at least one spawn)", (s: CellSample) => {
          const spawns = s.objects().filter((o) => o.type === "spawn" && o.user === s.userId);
          if (spawns.length < 2) return false;
          const agenda = s.memory?.spawnAgenda ?? {};
          return spawns.every((sp) => (agenda[String(sp._id)]?.executed?.length ?? 0) > 0);
        }),
        // Pooled distribution, end-to-end: across the two spawns' execution
        // receipts the pool served BOTH an income role (miner/hauler) AND a
        // consumer role (upgrader/builder/tanker) - the second spawn isn't just
        // shadowing the first on the same demand, and consumers aren't starved
        // behind income on a single lane.
        eventually("the pool serves a mix of income and consumer demand", (s: CellSample) => {
          const spawns = s.objects().filter((o) => o.type === "spawn" && o.user === s.userId);
          const agenda = s.memory?.spawnAgenda ?? {};
          const roles = new Set<string>();
          for (const sp of spawns) for (const e of agenda[String(sp._id)]?.executed ?? []) roles.add(e.role);
          const income = ["miner", "hauler"].some((r) => roles.has(r));
          const consumer = ["upgrader", "builder", "tanker"].some((r) => roles.has(r));
          return income && consumer;
        }),
        // The bank-capacity generalization's real-world consequence: the larger
        // 2-spawn / 100-cap extension bank still refills inside each draining
        // spawn's build deadline (grace for the warm settle).
        makeRefillSla(undefined, 20),
      ],
    },
    ...buildRemoteMineCell(),
  ];
}

// ===========================================================================
// CROSS-ROOM PRODUCTION: room A (two spawns) mines a source in remote room B.
// Home has the spawns and the extension bank; the remote room has only a
// source. The corps that mine B are ANCHORED to a home spawn (getSpawnId) but
// WORK in B (getPosition), so the home POOL builds them - production is
// cross-room, while the extension energy bank stays strictly per-room.
// ===========================================================================

const RM_SPAWN1 = { x: 25, y: 25 }; // addBot spawn (home)
const RM_SPAWN2 = { x: 20, y: 30 }; // staged spawn (home)

/** Home room with an east exit slot, controller, and one local source. */
const rmHome = (roomName: string): any => {
  const b = new RoomBuilder(roomName).border();
  for (let y = 24; y <= 26; y++) b.tile(49, y, "plain"); // east exit
  b.controller(25, 10);
  b.source(20, 38); // a home source keeps the base economy alive
  return b.toRoom();
};

/** The remote room: a matching west slot, ONE source, an unowned controller
 *  (so it reads as reservable) - no spawn of its own. */
const rmRemote = (roomName: string): any => {
  const b = new RoomBuilder(roomName).border();
  for (let y = 24; y <= 26; y++) b.tile(0, y, "plain"); // west exit
  b.controller(40, 25);
  b.source(25, 25);
  return b.toRoom();
};

/** Home extensions: two small clusters, one by each home spawn. */
function rmExtensions(): { type: string; x: number; y: number; energy: number }[] {
  const out: { type: string; x: number; y: number; energy: number }[] = [];
  for (const [cx, cy] of [
    [28, 22],
    [16, 33],
  ] as const) {
    let n = 0;
    for (let dy = 0; dy < 3 && n < 10; dy++) for (let dx = 0; dx < 4 && n < 10; dx++, n++) {
      out.push({ type: "extension", x: cx + dx, y: cy + dy, energy: 0 });
    }
  }
  return out;
}

function buildRemoteMineCell(): GridCell[] {
  return [
    {
      id: "multispawn-t7-remote-mine",
      tier: 7,
      avenue: "multi-spawn",
      window: 800,
      rooms: { home: rmHome, east: rmRemote },
      adjacency: { east: "E" },
      bot: { x: RM_SPAWN1.x, y: RM_SPAWN1.y },
      controller: { level: 7, progress: 0 },
      structures: [
        { type: "storage", x: 25, y: 33, energy: 120000 }, // funded warchest
        { type: "container", x: 20, y: 37, energy: 1500 }, // home source container
        { type: "container", x: 25, y: 12, energy: 0 }, // controller bucket
        ...rmExtensions(),
      ],
      creeps: [
        // Home income so the base runs from tick 1.
        {
          name: "mHome",
          x: 20,
          y: 37,
          body: ["work", "work", "work", "work", "work", "move"],
          memory: { workType: "harvest", corpId: "stale-mining", assignedSourceId: "$id(home,source,20,38)" },
        },
        // A standing scout in the remote room gives vision, so the remote source
        // is KNOWN and the planner can reach out to mine it (no 1800-tick organic
        // scout race - this is the staged version of the pipeline).
        { name: "eye", x: 25, y: 24, room: "east", body: ["move"], memory: { workType: "scout" } },
      ],
      stage: (ctx) => stageSecondSpawn(ctx, RM_SPAWN2.x, RM_SPAWN2.y),
      assertions: [
        // The planner reaches across the border and commissions the remote source.
        eventually("the planner mines the remote source", (s: CellSample) => {
          const src = s.objects("east").find((o) => o.type === "source");
          if (!src) return false;
          return (s.memory?.economyPlan?.corps ?? []).some(
            (c: any) => c.kind === "mine" && c.sourceId === `source-${src._id}`,
          );
        }),
        // ...and a HOME-spawned miner actually walks over and works it: cross-room
        // production, spawned from A, mining B.
        eventually("a home-spawned miner works the remote source", (s: CellSample) => {
          const src = s.objects("east").find((o) => o.type === "source");
          if (!src) return false;
          return s
            .objects("east")
            .some(
              (o) =>
                o.type === "creep" &&
                o.user === s.userId &&
                typeof o.name === "string" &&
                o.name.startsWith("miner-") &&
                Math.max(Math.abs(o.x - src.x), Math.abs(o.y - src.y)) <= 1,
            );
        }),
        // Both home spawns share the load (the remote miner + home economy don't
        // both queue behind one spawn).
        eventually("both home spawns are put to work", (s: CellSample) => {
          const spawns = s.objects("home").filter((o) => o.type === "spawn" && o.user === s.userId);
          if (spawns.length < 2) return false;
          const agenda = s.memory?.spawnAgenda ?? {};
          return spawns.every((sp) => (agenda[String(sp._id)]?.executed?.length ?? 0) > 0);
        }),
        // The home extension bank refills on its own (no cross-room energy pool).
        makeRefillSla("home", 20),
      ],
    },
  ];
}
