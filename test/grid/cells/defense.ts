/**
 * defense cells - two layers, both pinned here:
 *
 * FLIGHT (spec 12, owner directive 2026-07-10): a room held by hostiles
 * stops being FUNDED. Corps operating there emit no spawn demands, so the
 * colony never buys ECONOMY bodies for a grinder. One sighting captures the
 * hostile's ticksToLive, so the mark outlives vision; funding resumes on
 * the TTL bound or an all-clear look. Two hostile flavors share the one
 * danger lens (hostileRooms): sighted hostile CREEPS (TTL-bounded), and an
 * invader CORE's controller reservation (bounded by ticksToEnd).
 *
 * FIGHT (spec 13, owner directive 2026-07-17 "keep the remote flowing"):
 * layered ON TOP of flight, exempt from its gate. The raid meter mirrors
 * the engine's harvested-energy fuse and pre-spawns a RaidGuard before the
 * raid fires (def-t4); the CoreBuster runs kill+strip against core
 * occupations (def-t5-core-buster). Flight remains the fallback for rooms
 * without a mission - the def-t3/def-t5 flight cells must stay green
 * unchanged.
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
      // FIGHT-FIRST (spec 13 phase 3): the raid meter is staged ARMED (66k,
      // past the 65k floor) for a remote we mine, so the guard corp
      // PRE-SPAWNS - the guard must be fielded BEFORE the raid is injected
      // at tick 150. The injected invader is engine-faithful (the exact
      // smallMelee body remotes always get, driven by the real engine raid
      // AI) and must die to the guard, the staged remote miner must survive,
      // and the sighting must reset the raid meter to zero.
      id: "def-t4-raid-guard-holds-the-remote",
      tier: 4,
      avenue: "defense",
      window: 300,
      rooms: {
        home: homeEast((b) => b.controller(25, 10).source(25, 40)),
        east: eastRoom((b) => b.controller(10, 10).source(25, 25)),
      },
      adjacency: { east: "E" },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      // Full extension bank: the 650 guard body must be affordable (300
      // spawn + 10x50) - the pre-spawn, not energy scraping, is under test.
      structures: [
        { type: "extension", x: 23, y: 23, energy: 50 },
        { type: "extension", x: 23, y: 27, energy: 50 },
        { type: "extension", x: 27, y: 23, energy: 50 },
        { type: "extension", x: 27, y: 27, energy: 50 },
        { type: "extension", x: 22, y: 25, energy: 50 },
        { type: "extension", x: 28, y: 25, energy: 50 },
        { type: "extension", x: 24, y: 22, energy: 50 },
        { type: "extension", x: 26, y: 22, energy: 50 },
        { type: "extension", x: 24, y: 28, energy: 50 },
        { type: "extension", x: 26, y: 28, energy: 50 },
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
        // Remote miner: standing vision, the "we mine here" gate for the
        // armed trigger, and the body the raid would otherwise kill. NO
        // corpId - canary-proven untouchable (OrphanRescue skips unmanaged
        // creeps by design), so only combat can remove it from the room.
        {
          name: "rmE",
          x: 26,
          y: 25,
          room: "east",
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest" },
        },
      ],
      // The raid meter staged ARMED: 66k of accrued debt in the east room.
      memory: {
        roomIntel: {
          "$room(east)": {
            lastVisit: 1,
            raidDebt: 66000,
            sourceCount: 1,
            sourcePositions: [{ x: 25, y: 25 }],
            mineralType: null,
            mineralPos: null,
            controllerLevel: 0,
            controllerPos: { x: 10, y: 10 },
            controllerOwner: null,
            controllerReservation: null,
            hostileCreepCount: 0,
            hostileStructureCount: 0,
            isSafe: true,
          },
        },
      },
      async stage(ctx) {
        await ensureInvaderUser(ctx.db);
      },
      async onTick(ctx) {
        // Inject the raid at tick 150: the exact smallMelee body remotes
        // always receive (backend cronjobs.js:266-273), full 1500 TTL so
        // only combat - never expiry - can remove it inside the window.
        if (ctx.tick !== 150) return;
        await ctx.db["rooms.objects"].insert({
          type: "creep",
          name: "invader_east_1",
          x: 1,
          y: 25,
          room: ctx.room("east"),
          user: "2",
          body: [
            { type: "tough", hits: 100 },
            { type: "tough", hits: 100 },
            { type: "move", hits: 100 },
            { type: "move", hits: 100 },
            { type: "move", hits: 100 },
            { type: "move", hits: 100 },
            { type: "move", hits: 100 },
            { type: "ranged_attack", hits: 100 },
            { type: "work", hits: 100 },
            { type: "attack", hits: 100 },
          ],
          store: {},
          storeCapacity: 0,
          hits: 1000,
          hitsMax: 1000,
          fatigue: 0,
          ageTime: ctx.gameTime + 1500,
          spawning: false,
          notifyWhenAttacked: false,
        });
      },
      assertions: [
        // PRE-SPAWN: the guard is fielded off the armed meter alone - before
        // any hostile exists anywhere.
        eventually("the guard is fielded BEFORE the raid arrives", (s) => {
          if (s.tick >= 150) return false;
          return [undefined, "east"].some((h) =>
            s
              .objects(h)
              .some((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("guard-"))
          );
        }),
        // The injection actually landed (non-vacuity for the kill assertion).
        eventually("the raid lands in the east room", (s) =>
          s.objects("east").some((o: any) => o.type === "creep" && o.user === "2")
        ),
        // THE FIGHT: the invader dies to the guard well before its 1500 TTL.
        eventually("the guard kills the invader inside the window", (s) => {
          if (s.tick <= 155) return false;
          return !s.objects("east").some((o: any) => o.type === "creep" && o.user === "2");
        }),
        // THE POINT: the staged remote miner survives the whole raid.
        always(
          "the remote miner is never lost",
          (s) => s.objects("east").some((o: any) => o.type === "creep" && o.name === "rmE"),
          10 // staging settles
        ),
        // The sighting resets the raid meter (the engine zeroed its counter
        // when the raid spawned; the mirror follows on first sight).
        eventually("the raid sighting resets the meter", (s) => {
          if (s.tick <= 150) return false;
          const intel = s.memory?.roomIntel?.[s.room("east")];
          return typeof intel?.raidDebt === "number" && intel.raidDebt === 0 && typeof intel?.lastRaidSeen === "number";
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

    {
      // KILL + STRIP (spec 13 phase 4, superseding spec 12 phase 2): a LIVE
      // invader core (engine-processed: it renews its reservation every
      // tick) squats a remote we know is worth mining. The buster corp must
      // field an ATTACK creep off the intel marks alone, grind the core
      // down, and - because the engine does NOT clear the reservation on
      // core death - flip to the CLAIM striker phase and engage the
      // controller. The economic defund holds throughout (no economy body
      // is ever bought for the room). The core is staged pre-damaged (3000
      // hits) so the kill fits the window; the full 100k grind is arithmetic,
      // not behavior.
      id: "def-t5-core-buster-reclaims-remote",
      tier: 5,
      avenue: "defense",
      window: 500,
      rooms: {
        home: homeEast((b) => b.controller(25, 10).source(25, 40)),
        east: eastRoom((b) => b.controller(10, 10).source(25, 25)),
      },
      adjacency: { east: "E" },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: [
        { type: "extension", x: 23, y: 23, energy: 50 },
        { type: "extension", x: 23, y: 27, energy: 50 },
        { type: "extension", x: 27, y: 23, energy: 50 },
        { type: "extension", x: 27, y: 27, energy: 50 },
        { type: "extension", x: 22, y: 25, energy: 50 },
        { type: "extension", x: 28, y: 25, energy: 50 },
        { type: "extension", x: 24, y: 22, energy: 50 },
        { type: "extension", x: 26, y: 22, energy: 50 },
        { type: "extension", x: 24, y: 28, energy: 50 },
        { type: "extension", x: 26, y: 28, energy: 50 },
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
        // Standing eye: vision so the marks stamp every tick. NO corpId
        // (untouchable), single MOVE so it changes nothing economically.
        {
          name: "eye",
          x: 30,
          y: 25,
          room: "east",
          body: ["move"],
          memory: { workType: "scout" },
        },
      ],
      // The east room is KNOWN to be worth mining (the mission gate needs
      // sourceCount - a room never scouted is never a mission, which is what
      // keeps the phase-1 flight cell military-free).
      memory: {
        roomIntel: {
          "$room(east)": {
            lastVisit: 1,
            sourceCount: 1,
            sourcePositions: [{ x: 25, y: 25 }],
            mineralType: null,
            mineralPos: null,
            controllerLevel: 0,
            controllerPos: { x: 10, y: 10 },
            controllerOwner: null,
            controllerReservation: null,
            hostileCreepCount: 0,
            hostileStructureCount: 1,
            isSafe: false,
          },
        },
      },
      async stage(ctx) {
        await ensureInvaderUser(ctx.db);
        // A LIVE lesser core beside the controller: the engine processes
        // hand-inserted invaderCore objects (reservation renewal, +2/tick).
        // Pre-damaged to 3000 hits so a 6-pair buster finishes in ~17 ticks
        // of contact. No deployTime and no effects: long-deployed, hittable.
        await ctx.db["rooms.objects"].insert({
          type: "invaderCore",
          room: ctx.room("east"),
          x: 11,
          y: 10,
          user: "2",
          level: 0,
          hits: 3000,
          hitsMax: 100000,
          notifyWhenAttacked: false,
        });
        // Its reservation, mid-occupation: enough remaining to clear the
        // CORE_BUSTER_MIN_REMAINING payback gate (1000). Whole-object $set:
        // dotted paths silently no-op in the mockup db.
        await ctx.db["rooms.objects"].update(
          { room: ctx.room("east"), type: "controller" },
          { $set: { reservation: { user: "2", endTime: ctx.gameTime + 1500 } } }
        );
      },
      assertions: [
        // Intel: the sighting stamps the occupation AND the core's presence.
        eventually("intel stamps the reservation mark and the core sighting", (s) => {
          const intel = s.memory?.roomIntel?.[s.room("east")];
          return typeof intel?.invaderReservedUntil === "number" && intel?.invaderCorePresent === true;
        }),
        // Non-vacuity: the core stands at the start.
        eventually("the staged core initially stands", (s) =>
          s.tick <= 20 && s.objects("east").some((o: any) => o.type === "invaderCore")
        ),
        // KILL: the buster is fielded and the core object disappears (it has
        // no decay path staged - only the buster's ATTACK removes it).
        eventually("a buster is fielded", (s) =>
          [undefined, "east"].some((h) =>
            s.objects(h).some((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("buster-"))
          )
        ),
        eventually("the core is destroyed", (s) =>
          s.tick > 20 && !s.objects("east").some((o: any) => o.type === "invaderCore")
        ),
        // PHASE FLIP: with the core gone but the reservation standing, the
        // sighting flips the mission to the strip phase.
        eventually("intel flips to the strip phase (core gone, reservation stands)", (s) => {
          const intel = s.memory?.roomIntel?.[s.room("east")];
          return intel?.invaderCorePresent === false && typeof intel?.invaderReservedUntil === "number";
        }),
        // STRIP: the CLAIM striker is fielded and engages the controller
        // while the leftover reservation still stands (attackController is
        // its only duty there; full clearance is arithmetic beyond the
        // window - the engagement is the behavior under test).
        eventually("a striker is fielded", (s) =>
          [undefined, "east"].some((h) =>
            s.objects(h).some((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("striker-"))
          )
        ),
        eventually("the striker engages the reserved controller", (s) => {
          const ctrl = s.objects("east").find((o: any) => o.type === "controller");
          if (!ctrl?.reservation) return false;
          return s
            .objects("east")
            .some(
              (o: any) =>
                o.type === "creep" &&
                typeof o.name === "string" &&
                o.name.startsWith("striker-") &&
                Math.max(Math.abs(o.x - ctrl.x), Math.abs(o.y - ctrl.y)) <= 1
            );
        }),
        // THE DEFUND HOLDS THROUGHOUT: the mission never re-opens the
        // economy - no body is ever assigned the east source, and no
        // reserver is fielded while the room stays foreign-reserved.
        always(
          "no economy body is bought for the occupied room",
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
      ],
    },
  ];
}
