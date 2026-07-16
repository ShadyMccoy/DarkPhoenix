/**
 * defense cells - v1 DEFENSE ECONOMICS (owner directive 2026-07-10): no
 * military yet; a room held by hostiles simply stops being FUNDED. Corps
 * operating there (miners at its sources, haulers on its routes, reservers
 * headed in) emit no spawn demands, so the colony never buys bodies for a
 * grinder. One sighting captures the hostile's ticksToLive, so the mark
 * outlives vision; funding resumes on the TTL bound or an all-clear look.
 *
 * Two hostile flavors share the one danger lens (hostileRooms): sighted
 * hostile CREEPS (TTL-bounded), and an invader CORE's controller
 * reservation (bounded by the reservation's ticksToEnd) - the core is a
 * structure the creep pass never sees, so the reservation is the
 * observable. See docs/specs/12-invader-protocols.md.
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

/** Ticks the staged invader lives (its ageTime is set at stage). */
const INVADER_DIES_AT = 150;

/** Home room with an east exit slot at (49, 24..26) - multiroom pattern. */
const homeEast = (build: (b: RoomBuilder) => RoomBuilder) => (roomName: string) => {
  const b = new RoomBuilder(roomName).border();
  for (let y = 24; y <= 26; y++) b.tile(49, y, "plain");
  return build(b).toRoom();
};

/** East room with the matching west slot at (0, 24..26). */
const eastRoom = (build: (b: RoomBuilder) => RoomBuilder) => (roomName: string) => {
  const b = new RoomBuilder(roomName).border();
  for (let y = 24; y <= 26; y++) b.tile(0, y, "plain");
  return build(b).toRoom();
};

/** Ensure the Invader NPC user ("2") exists in a fresh mockup db. */
async function ensureInvaderUser(db: any): Promise<void> {
  const users = db["users"];
  const invaderUser = await users.findOne({ _id: "2" });
  if (!invaderUser) {
    await users.insert({ _id: "2", username: "Invader", cpu: 0, gcl: 0, active: 0 });
  }
}

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
        await ensureInvaderUser(ctx.db);
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

    {
      // An invader CORE reserves the remote room's controller (the screenshot
      // scenario: "Reserved: Invader (4998)"). No hostile creep is ever in
      // sight, so the v1 creep pass alone would keep funding a room whose
      // controller we cannot take back. The reservation is the observable:
      // the planner still OPENS the remote mine (non-vacuity - the defund,
      // not the planner, is what holds the line), intel stamps the
      // reservation-bounded mark, and no body is ever bought for the room -
      // no miner/hauler for its source, no reserver at all.
      id: "def-t5-invader-reservation-defunds-remote",
      tier: 5,
      avenue: "defense",
      window: 300,
      rooms: {
        home: homeEast((b) => b.controller(25, 10).source(25, 40)),
        east: eastRoom((b) => b.controller(10, 10).source(25, 25)),
      },
      adjacency: { east: "E" },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      // Full extensions: bodies are affordable, so the defund - not energy -
      // is what's being measured (pattern: spawn-reserver-started-income).
      structures: [
        { type: "extension", x: 23, y: 23, energy: 50 },
        { type: "extension", x: 23, y: 27, energy: 50 },
        { type: "extension", x: 27, y: 23, energy: 50 },
        { type: "extension", x: 27, y: 27, energy: 50 },
        { type: "extension", x: 22, y: 25, energy: 50 },
        { type: "extension", x: 28, y: 25, energy: 50 },
        { type: "extension", x: 24, y: 22, energy: 50 },
        { type: "extension", x: 26, y: 22, energy: 50 },
      ],
      creeps: [
        // Home income pair keeps the economy sane (multiroom pattern).
        {
          name: "mH",
          x: 24,
          y: 39,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-def-m", assignedSourceId: "$id(home,source,25,40)" },
        },
        {
          name: "hH",
          x: 22,
          y: 30,
          body: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"],
          memory: { workType: "haul", corpId: "staged-def-h", working: false, assignedSourceId: "$id(home,source,25,40)" },
        },
        // Remote harvester: gives standing vision of the east room (the mark
        // needs a sighting) and arms ReservationCorp's trigger. NO corpId -
        // canary-proven untouchable, so it stands all window.
        {
          name: "rh",
          x: 26,
          y: 25,
          room: "east",
          body: ["work", "work", "move"],
          memory: { workType: "harvest" },
        },
      ],
      async stage(ctx) {
        await ensureInvaderUser(ctx.db);
        // The core itself is not staged - the RESERVATION is the observable
        // the protocol keys on, and it outlives the window (as live cores
        // renew theirs). Whole-object $set: dotted paths silently no-op in
        // the mockup db.
        await ctx.db["rooms.objects"].update(
          { room: ctx.room("east"), type: "controller" },
          { $set: { reservation: { user: "2", endTime: ctx.gameTime + 5000 } } }
        );
      },
      assertions: [
        // Non-vacuity: the planner still opens the remote mine (the defund is
        // downstream, at spawn-demand time - pattern: plan-t5-remote-pipeline).
        eventually("the planner opens the invader-reserved remote source", (s) => {
          const src = s.objects("east").find((o: any) => o.type === "source");
          if (!src) return false;
          return (s.memory?.economyPlan?.corps ?? []).some(
            (c: any) => c.kind === "mine" && c.sourceId === `source-${src._id}`
          );
        }),
        // The sighting stamps the reservation-bounded mark.
        eventually("intel stamps the invader-reservation mark", (s) => {
          const intel = s.memory?.roomIntel?.[s.room("east")];
          return typeof intel?.invaderReservedUntil === "number";
        }),
        // The defund: no body is ever bought for the reserved room - nothing
        // is ever ASSIGNED its source, and no reserver is fielded anywhere.
        always(
          "no miner, hauler, or reserver is funded for the reserved room",
          (s) => {
            const src = s.objects("east").find((o: any) => o.type === "source");
            if (!src) return true;
            const assigned = Object.values(s.memory?.creeps ?? {}).some(
              (mem: any) => mem?.assignedSourceId === src._id
            );
            const reserver = [undefined, "east"].some((h) =>
              s
                .objects(h)
                .some((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("reserver-"))
            );
            return !assigned && !reserver;
          },
          10 // staging settles
        ),
        // Belt and suspenders: no miner ever physically enters the room.
        always("no miner ever walks into the reserved room", (s) =>
          !s
            .objects("east")
            .some((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("miner-"))
        ),
      ],
    },
  ];
}
