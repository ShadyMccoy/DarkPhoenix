/**
 * defense cells - v1 DEFENSE ECONOMICS (owner directive 2026-07-10): no
 * military yet; a room held by hostiles simply stops being FUNDED. Corps
 * operating there (miners at its sources, haulers on its routes, reservers
 * headed in) emit no spawn demands, so the colony never buys bodies for a
 * grinder. One sighting captures the hostile's ticksToLive, so the mark
 * outlives vision; funding resumes on the TTL bound or an all-clear look.
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

/** Ticks the staged invader lives (its ageTime is set at stage). */
const INVADER_DIES_AT = 150;

export function buildDefenseCells(): GridCell[] {
  return [
    {
      // A commissioned source with an invader camped on it: the mine corp's
      // demand must stay silent while the invader lives (bootstrap jacks are
      // separate machinery and may still wander), then fund normally once
      // it dies - the whole response is economic, no combat.
      id: "def-t3-invader-defunds-source",
      tier: 3,
      avenue: "defense",
      window: 300,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().controller(25, 10).source(40, 25).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      async stage(ctx) {
        // The Invader NPC user ("2") may not exist in a fresh mockup db.
        const users = ctx.db["users"];
        const invaderUser = await users.findOne({ _id: "2" });
        if (!invaderUser) {
          await users.insert({ _id: "2", username: "Invader", cpu: 0, gcl: 0, active: 0 });
        }
        await ctx.db["rooms.objects"].insert({
          type: "creep",
          name: "invader-1",
          x: 41,
          y: 25,
          room: ctx.room(),
          user: "2",
          body: [
            { type: "attack", hits: 100 },
            { type: "move", hits: 100 },
          ],
          store: {},
          storeCapacity: 0,
          hits: 200,
          hitsMax: 200,
          fatigue: 0,
          ageTime: ctx.gameTime + INVADER_DIES_AT,
          spawning: false,
          notifyWhenAttacked: false,
        });
      },
      assertions: [
        // The defunding: while the invader lives, the mine corp buys nobody.
        always(
          "no flow miner is funded while the invader lives",
          (s) => {
            if (s.tick >= INVADER_DIES_AT) return true; // gate lapses with the TTL
            return !Object.values(s.memory?.creeps ?? {}).some(
              (mem: any) => typeof mem?.corpId === "string" && mem.corpId.startsWith("mining-")
            );
          },
          10 // staging settles
        ),
        // The TTL capture: one sighting marks the room hostile in intel.
        eventually("the sighting stamps a TTL-bounded hostile mark", (s) => {
          const intel = s.memory?.roomIntel?.[s.room()];
          return typeof intel?.hostileUntil === "number";
        }),
        // The resumption: once the invader dies, funding returns and a flow
        // miner reaches the source.
        eventually("funding resumes after the invader dies: a miner works the source", (s) => {
          if (s.tick < INVADER_DIES_AT) return false;
          const src = s.objects().find((o: any) => o.type === "source" && o.x === 40 && o.y === 25);
          if (!src) return false;
          return s
            .objects()
            .some(
              (o: any) =>
                o.type === "creep" &&
                typeof o.name === "string" &&
                o.name.startsWith("miner-") &&
                Math.max(Math.abs(o.x - 40), Math.abs(o.y - 25)) <= 1
            );
        }),
      ],
    },
  ];
}
