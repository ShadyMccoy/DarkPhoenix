/**
 * @fileoverview CoreBusterCorp - evict hostile occupations: invader cores in
 * remote rooms (KILL the core, then STRIP the leftover reservation - spec 13
 * phase 4, superseding spec 12 phase 2 with engine-ground-truth economics),
 * and hostile structures in rooms WE OWN (the eviction class, t72968647: a
 * derelict foreign spawn consumes a claimed room's RCL-limited spawn slot,
 * wedging the founding site forever - the buster clears it).
 *
 * Engine facts that shape the mission:
 * - Income under a foreign reservation is ZERO (harvest.js:31), and a live
 *   level-0 core renews its 5000-cap reservation for the parent stronghold's
 *   whole collapse window - "wait it out" costs tens of thousands of ticks
 *   of a room's full rate.
 * - Killing the core does NOT clear the reservation (invader-core/destroy.js)
 *   - it decays 1/tick, and creep `attackController` strips only
 *   CLAIM_parts x 1 per attack. So the mission has two phases with two
 *   bodies: an ATTACK buster while the core stands, a CLAIM striker once it
 *   falls. Stripping against a LIVE core is pointless (its +2/tick renewal
 *   outruns a small striker), hence the phase split on the
 *   `invaderCorePresent` sighting.
 * - Level 0-1 cores can never spawn defenders - the buster fights nothing.
 *
 * MILITARY EXEMPTION: like the raid guard, this corp does not gate on
 * hostileRooms() - it exists to enter exactly the rooms the economy fled.
 * The economic defund (spec 12 phase 1) stays live underneath throughout the
 * mission; funding resumes on its own when the strip completes and a fresh
 * sighting lifts the mark.
 *
 * @module corps/CoreBusterCorp
 */

import { SerializedSpawnAnchoredCorp, SpawnAnchoredCorp } from "./SpawnAnchoredCorp";
import { CORE_BUSTER_MIN_REMAINING } from "../economy/primitives";
import { INVADER_USERNAME } from "../utils/RoomDiscovery";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { BUSTER } from "../spawn/demandLadder";
import { MAX_SCOUT_DISTANCE } from "./CorpConstants";
import { buildGuardBody, buildReserverBody } from "../spawn/BodyBuilder";
import { driveRecycle } from "./recycle";
import { travelTo } from "./movement";
import { GUARD_RECYCLE_GRACE } from "./RaidGuardCorp";

/**
 * Serialized state specific to CoreBusterCorp.
 */
export type SerializedCoreBusterCorp = SerializedSpawnAnchoredCorp;

/**
 * CoreBusterCorp manages buster (ATTACK) and striker (CLAIM) creeps that
 * reclaim invader-occupied remote rooms.
 */
export class CoreBusterCorp extends SpawnAnchoredCorp {
  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("coreBuster", nodeId, spawnId, customId);
  }

  private creepsOf(workType: "buster" | "strike"): Creep[] {
    return this.creepsOfWorkType(workType, { includeSpawning: false });
  }

  /**
   * Occupied rooms worth the mission, split by phase. A room qualifies when
   * its invader-reservation mark is active with at least the payback gate
   * remaining (below that the reservation lapses on its own), it has sources
   * we would mine, and it lies within scouting range. Phase from the last
   * sighting: core in sight = KILL, core gone = STRIP. Unsighted-core rooms
   * (invaderCorePresent undefined - marked before this field existed, or
   * marked blind) default to the striker: the reservation observable alone
   * cannot prove a core, and a striker discovering a live core flips the
   * intel on arrival (its own vision re-stamps).
   *
   * EVICTION (the EZRO-squatter incident, t72968647): rooms WE OWN that host
   * hostile structures also join the KILL phase. The engine counts ALL
   * owners' spawns against a room's RCL structure limit, so a derelict
   * foreign spawn in a freshly-claimed room consumes the RCL-1 slot and the
   * founding site can never place - the W43N21 campaign sat wedged on
   * exactly this. Owned rooms always have vision (the controller is an owned
   * structure), so the live read is durable, not a creep-vision read. Only
   * the CLOSEST home (by linear distance over rooms with my spawns,
   * lexicographic tie-break) claims the eviction - no double busters.
   */
  public missionTargets(homeRoom: string): { attack: string[]; strike: string[] } {
    const attack: string[] = [];
    const strike: string[] = [];
    if (typeof Memory !== "undefined" && Memory.roomIntel) {
      for (const roomName in Memory.roomIntel) {
        if (roomName === homeRoom) continue;
        const intel = Memory.roomIntel[roomName];
        if (!intel) continue;
        const remaining = (intel.invaderReservedUntil ?? 0) - Game.time;
        if (remaining < CORE_BUSTER_MIN_REMAINING) continue;
        if (!intel.sourceCount) continue; // no income to restore
        if (Game.map.getRoomLinearDistance(homeRoom, roomName) > MAX_SCOUT_DISTANCE) continue;

        if (intel.invaderCorePresent === true) attack.push(roomName);
        else strike.push(roomName);
      }
    }

    if (typeof Game !== "undefined" && Game.rooms) {
      const homeRooms = new Set<string>();
      for (const name in Game.spawns ?? {}) {
        const r = Game.spawns[name].room;
        if (r) homeRooms.add(r.name);
      }
      for (const roomName in Game.rooms) {
        if (roomName === homeRoom || attack.includes(roomName)) continue;
        const room = Game.rooms[roomName];
        if (!room?.controller?.my) continue;
        if (room.find(FIND_HOSTILE_STRUCTURES).length === 0) continue;
        if (Game.map.getRoomLinearDistance(homeRoom, roomName) > MAX_SCOUT_DISTANCE) continue;
        // Closest-home dedup: this corp claims the eviction only when its
        // home is the nearest spawn room (ties break lexicographically).
        let closest: string | undefined;
        let closestDist = Infinity;
        for (const hr of [...homeRooms].sort()) {
          const d = Game.map.getRoomLinearDistance(hr, roomName);
          if (d < closestDist) {
            closestDist = d;
            closest = hr;
          }
        }
        if (closest !== homeRoom) continue;
        attack.push(roomName);
      }
    }

    return { attack: attack.sort(), strike: strike.sort() };
  }

  public work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const targets = this.missionTargets(spawn.room.name);
    this.runFleet(this.creepsOf("buster"), targets.attack, spawn, tick, (c, room) => this.runBuster(c, room));
    this.runFleet(this.creepsOf("strike"), targets.strike, spawn, tick, (c, room) => this.runStriker(c, room));
  }

  /** Shared assignment loop: stable room assignment, quiet-grace recycle. */
  private runFleet(
    creeps: Creep[],
    targets: string[],
    spawn: StructureSpawn,
    tick: number,
    run: (creep: Creep, room: string) => void
  ): void {
    const covered = new Set<string>();
    for (const creep of creeps) {
      if (creep.memory.recycling) {
        driveRecycle(creep, spawn);
        continue;
      }
      let target = creep.memory.targetRoom;
      if (!target || !targets.includes(target) || covered.has(target)) {
        target = targets.find(r => !covered.has(r));
        creep.memory.targetRoom = target;
      }
      if (!target) {
        creep.memory.idleSince = creep.memory.idleSince ?? tick;
        if (tick - creep.memory.idleSince >= GUARD_RECYCLE_GRACE) {
          creep.memory.recycling = true;
          creep.memory.recycleReason = "mission-done";
        }
        continue;
      }
      delete creep.memory.idleSince;
      covered.add(target);
      run(creep, target);
    }
  }

  /** Walk to the room and grind the core down; wait out deploy invulnerability adjacent. */
  private runBuster(creep: Creep, targetRoom: string): void {
    if (creep.room.name !== targetRoom) {
      travelTo(creep, new RoomPosition(25, 25, targetRoom), {
        range: 20,
        visualizePathStyle: { stroke: "#ff9944" }
      });
      return;
    }
    const hostiles = creep.room.find(FIND_HOSTILE_STRUCTURES);
    const core = hostiles.find(s => s.structureType === STRUCTURE_INVADER_CORE) as StructureInvaderCore | undefined;
    // EVICTION targeting is scoped to rooms WE OWN: any hostile structure
    // there is an intrusion (a squatter spawn eats the RCL structure slot -
    // t72968647). In NEUTRAL rooms the mission stays core-only - another
    // player's remote-infra structures are not this corp's war to start.
    const target =
      core ??
      (creep.room.controller?.my ? (hostiles.find(s => s.structureType === STRUCTURE_SPAWN) ?? hostiles[0]) : undefined);
    if (!target) return; // vision re-stamps invaderCorePresent=false; strike phase takes over
    if (creep.pos.isNearTo(target)) {
      creep.attack(target); // ERR_INVALID_TARGET while deploy-invulnerable: wait it out adjacent
    } else {
      travelTo(creep, target.pos, { range: 1, visualizePathStyle: { stroke: "#ff9944" } });
    }
  }

  /** Walk to the room and grind the leftover reservation off the controller. */
  private runStriker(creep: Creep, targetRoom: string): void {
    if (creep.room.name !== targetRoom) {
      travelTo(creep, new RoomPosition(25, 25, targetRoom), {
        range: 20,
        visualizePathStyle: { stroke: "#ffdd44" }
      });
      return;
    }
    const controller = creep.room.controller;
    if (!controller?.reservation || controller.reservation.username !== INVADER_USERNAME) return;
    if (creep.pos.isNearTo(controller)) {
      creep.attackController(controller);
    } else {
      travelTo(creep, controller.pos, { range: 1, visualizePathStyle: { stroke: "#ffdd44" } });
    }
  }

  /**
   * One buster per kill target, one striker per strip target. Income-tier
   * treatment (value 104: above miners' 100 band, below guard 105 and
   * reserver 115) because the mission restores a zeroed income stream, but
   * never BLOCKING - an occupation is a long siege, not a kill window; the
   * queue may make it wait. holdToFund: both bodies are chunky one-offs.
   */
  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];

    const targets = this.missionTargets(spawn.room.name);
    const demands: SpawnDemand[] = [];

    // Staffing census, NOT the work roster (the t72811290 double-buy class,
    // same lens as the raid guard): a body in the spawn pipe or not yet
    // routed by runFleet counts, and each wildcard discounts one uncovered
    // room's ask. Per workType, so a buster in the pipe never staffs a
    // striker post.
    const busters = this.staffingCensus("buster");
    let busterWildcards = busters.wildcards;
    const busterBody = buildGuardBody(ctx.energyCapacity, 10); // ATTACK/MOVE pairs, up to 10
    if (busterBody.cost > 0) {
      for (const room of targets.attack) {
        if (busters.covered.has(room)) continue;
        if (busterWildcards > 0) {
          busterWildcards--;
          continue;
        }
        demands.push({
          buyerCorpId: this.id,
          role: "buster",
          value: BUSTER, // rung home + ladder rationale: spawn/demandLadder.ts
          blocking: false,
          producesIncome: true,
          holdToFund: true,
          desiredCost: busterBody.cost,
          minCost: buildGuardBody(390, 10).cost, // 3-pair floor still kills a defenseless core
          since: 0,
          bodyParam: busterBody.attackParts
        });
      }
    }

    const strikers = this.staffingCensus("strike");
    let strikerWildcards = strikers.wildcards;
    const strikerBody = buildReserverBody(ctx.energyCapacity, 2); // CLAIM+MOVE pairs
    if (strikerBody.cost > 0) {
      for (const room of targets.strike) {
        if (strikers.covered.has(room)) continue;
        if (strikerWildcards > 0) {
          strikerWildcards--;
          continue;
        }
        demands.push({
          buyerCorpId: this.id,
          role: "striker",
          value: BUSTER, // same mission, same rung (spawn/demandLadder.ts)
          blocking: false,
          producesIncome: true,
          holdToFund: true, // CLAIM 600 floor: indivisible, bank for it
          desiredCost: strikerBody.cost,
          minCost: 650, // 1x(CLAIM+MOVE)
          since: 0,
          bodyParam: strikerBody.claimParts
        });
      }
    }

    return demands;
  }

  public getCreepCount(): number {
    return this.creepsOf("buster").length + this.creepsOf("strike").length;
  }
}
