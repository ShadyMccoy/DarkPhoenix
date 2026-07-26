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
 *   - the CONTROLLER-side spawn builds the upgraders (consumers bind to their
 *     NEAREST same-room spawn - the servingSpawnId generalization), so consumer
 *     throughput isn't funnelled through spawn[0];
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

import { GridCell, CellSample, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";
import { makeRefillSla } from "../refillSLA";

const HOME = (roomName: string): any => {
  const b = new RoomBuilder(roomName).border();
  b.source(8, 25); // Source A - by Spawn1
  b.source(42, 25); // Source B - by Spawn2
  b.controller(44, 42); // by Spawn2
  return b.toRoom();
};

/** Chebyshev range (the game's room range metric). */
const range = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

const SPAWN1 = { x: 10, y: 25 }; // addBot spawn, by Source A
const SPAWN2 = { x: 42, y: 40 }; // staged spawn, by the controller + Source B

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
      // The standing second spawn: full addBot-equivalent schema (name +
      // spawning:null), inserted raw because the declarative path omits both.
      async stage(ctx) {
        await ctx.db["rooms.objects"].insert({
          type: "spawn",
          room: ctx.room(),
          x: SPAWN2.x,
          y: SPAWN2.y,
          user: ctx.userId,
          name: "Spawn2",
          store: { energy: 300 },
          storeCapacityResource: { energy: ctx.C.SPAWN_ENERGY_CAPACITY },
          hits: ctx.C.SPAWN_HITS,
          hitsMax: ctx.C.SPAWN_HITS,
          spawning: null,
          notifyWhenAttacked: true,
        });
      },
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
        // The servingSpawnId generalization, end-to-end: the spawn NEAREST the
        // controller is the one that builds the upgraders (not spawn[0] across
        // the room). Identify it by position so id ordering doesn't matter.
        eventually("the controller-side spawn builds the upgraders (nearest-spawn binding)", (s: CellSample) => {
          const ctrl = s.objects().find((o) => o.type === "controller");
          const spawns = s.objects().filter((o) => o.type === "spawn" && o.user === s.userId);
          if (!ctrl || spawns.length < 2) return false;
          const nearCtrl = [...spawns].sort((a, b) => range(a, ctrl) - range(b, ctrl))[0];
          const executed = s.memory?.spawnAgenda?.[String(nearCtrl._id)]?.executed ?? [];
          return executed.some((e: any) => e.role === "upgrader");
        }),
        // The bank-capacity generalization's real-world consequence: the larger
        // 2-spawn / 100-cap extension bank still refills inside each draining
        // spawn's build deadline (grace for the warm settle).
        makeRefillSla(undefined, 20),
      ],
    },
  ];
}
