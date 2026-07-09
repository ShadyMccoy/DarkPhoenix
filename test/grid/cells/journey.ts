/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * rcl-journey cells - replayed trip-point snapshots (docs/specs/10).
 *
 * Each file in test/fixtures/journey/ is a world state captured ~5 ticks
 * before an RCL-journey moment organically happened (scripts/journey-capture).
 * The cell restores that state VERBATIM - same room name (pinned), same
 * object ids (so every id inside the bot's Memory still resolves), Memory
 * itself byte-for-byte - and asserts the same trip-point check fires again
 * inside a short replay window. The long organic sim is paid once at capture;
 * the grid replays only the core moment.
 *
 * Restore mechanics:
 *  - pinnedRooms keeps the original room name so Memory's room-name-bearing
 *    corp ids stay valid. soloWorld isolates each snapshot in its own batch:
 *    two snapshots of the same run share object ids and room names, which
 *    must never share one db.
 *  - addBot's auto-spawn is removed and every snapshot object inserted with
 *    its original _id; the snapshot bot's user id is remapped to the fresh
 *    one; absolute-time fields are shifted by the gameTime delta.
 *  - Mid-spawn creeps (spawning=true) are dropped: their spawn-side state is
 *    not restorable, and at T-5 they are rare by construction.
 *
 * Known limitation: Memory is restored VERBATIM, so absolute-tick values
 * inside it (corp lastPlannedTick/createdAt, demand `since` stamps) point at
 * the capture world's clock, not the replay's. Cadence checks that subtract
 * (tick - last) go negative and simply wait their full interval; measured
 * replays still re-fire their trips (miner/hauler @5, upgrader @88), but a
 * trip that depends on anti-starvation aging or an exact planning cadence
 * may need its Memory tick fields shifted too - do that per-field, here,
 * when a real case appears.
 */

import { readdirSync, readFileSync } from "fs";
import * as path from "path";
import { GridCell, eventually } from "../GridCell";
import { tripPoint } from "../../journey/tripPoints";

const FIXTURE_DIR = path.resolve("test", "fixtures", "journey");

/** Absolute-gameTime fields shifted into the replay world's clock. */
const TIME_FIELDS = ["ageTime", "nextRegenerationTime", "downgradeTime", "decayTime", "nextDecayTime"];

interface JourneySnapshot {
  version: number;
  scenario: string;
  trip: string;
  description: string;
  tick: number;
  gameTime: number;
  botUserId: string;
  rooms: Record<string, { terrain: string[]; objects: any[] }>;
  memory: any;
}

function snapshotFiles(): string[] {
  try {
    return readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no snapshots captured yet - the avenue is simply empty
  }
}

function cellFromSnapshot(file: string): GridCell {
  const snap = JSON.parse(readFileSync(path.join(FIXTURE_DIR, file)).toString()) as JourneySnapshot;
  const tp = tripPoint(snap.trip);
  const roomNames = Object.keys(snap.rooms);
  const homeRoom = roomNames[0];
  const spawn = snap.rooms[homeRoom].objects.find(
    (o) => o.type === "spawn" && o.user === snap.botUserId
  );
  if (!spawn) throw new Error(`journey snapshot ${file}: no bot spawn in ${homeRoom}`);

  return {
    id: `journey-${snap.scenario}--${snap.trip}`,
    tier: 4,
    avenue: "rcl-journey",
    window: tp.replayWindow,
    soloWorld: true,
    pinnedRooms: roomNames.reduce<Record<string, string>>((acc, r) => {
      acc[r === homeRoom ? "home" : r] = r;
      return acc;
    }, {}),
    rooms: roomNames.reduce<GridCell["rooms"]>((acc, r) => {
      // addBot refuses a controller-less room, so the layout carries a
      // placeholder controller at the snapshot position; stage() swaps it for
      // the snapshot's own (original _id - Memory references it).
      const ctrl = snap.rooms[r].objects.find((o) => o.type === "controller");
      const objects: Array<{ type: "controller"; x: number; y: number }> = ctrl
        ? [{ type: "controller", x: ctrl.x, y: ctrl.y }]
        : [];
      acc[r === homeRoom ? "home" : r] = () => ({ room: r, terrain: snap.rooms[r].terrain, objects });
      return acc;
    }, {}),
    bot: { x: spawn.x, y: spawn.y },
    memory: snap.memory,
    async stage(ctx) {
      const delta = ctx.gameTime - snap.gameTime;
      // The auto-spawn addBot created and the placeholder controller the
      // layout carried; the snapshot's own objects replace both.
      await ctx.db["rooms.objects"].removeWhere({ room: ctx.room(), type: "spawn", user: ctx.userId });
      for (const roomName of roomNames) {
        await ctx.db["rooms.objects"].removeWhere({ room: roomName, type: "controller" });
        for (const obj of snap.rooms[roomName].objects) {
          if (obj.type === "creep" && obj.spawning) continue;
          // The spread keeps the original _id - Memory references depend on it.
          const doc: any = { ...obj };
          if (doc.user === snap.botUserId) doc.user = ctx.userId;
          if (doc.type === "controller") doc.safeMode = null;
          // Mid-spawn creeps are dropped on restore, so a spawn's in-flight
          // build must be cleared too or it references a ghost and wedges.
          if (doc.type === "spawn") doc.spawning = null;
          for (const f of TIME_FIELDS) {
            if (typeof doc[f] === "number") doc[f] += delta;
          }
          await ctx.db["rooms.objects"].insert(doc);
        }
      }
    },
    assertions: [
      eventually(`replayed moment fires: ${snap.description}`, (s) =>
        tp.check({ tick: s.tick, memory: s.memory, objects: () => s.objects() })
      ),
    ],
  };
}

export function buildJourneyCells(): GridCell[] {
  const cells: GridCell[] = [];
  for (const file of snapshotFiles()) {
    // A single stale/renamed/corrupt fixture must cost ONE cell, not brick
    // every grid invocation at import time.
    try {
      cells.push(cellFromSnapshot(file));
    } catch (err) {
      console.error(`journey: skipping unloadable snapshot ${file}: ${err}`);
    }
  }
  return cells;
}
