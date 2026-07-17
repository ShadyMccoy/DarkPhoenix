/**
 * @fileoverview CoreBusterCorp - evict invader-core occupations from remote
 * rooms: KILL the core, then STRIP the leftover reservation (spec 13 phase 4,
 * superseding spec 12 phase 2 with engine-ground-truth economics).
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

import { Corp, SerializedCorp } from "./Corp";
import { CORE_BUSTER_MIN_REMAINING } from "../economy/primitives";
import { INVADER_USERNAME } from "../utils/RoomDiscovery";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { MAX_SCOUT_DISTANCE } from "./CorpConstants";
import { Position } from "../types/Position";
import { buildGuardBody, buildReserverBody } from "../spawn/BodyBuilder";
import { driveRecycle } from "./recycle";
import { travelTo } from "./movement";
import { GUARD_RECYCLE_GRACE } from "./RaidGuardCorp";

/**
 * Serialized state specific to CoreBusterCorp.
 */
export interface SerializedCoreBusterCorp extends SerializedCorp {
  spawnId: string;
}

/**
 * CoreBusterCorp manages buster (ATTACK) and striker (CLAIM) creeps that
 * reclaim invader-occupied remote rooms.
 */
export class CoreBusterCorp extends Corp {
  private spawnId: string;

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("coreBuster", nodeId, customId);
    this.spawnId = spawnId;
  }

  public getSpawnId(): string {
    return this.spawnId;
  }

  /** Commission-owned state: every materialize() refreshes this (the stale-spawnId trap). */
  public setSpawnId(spawnId: string): void {
    this.spawnId = spawnId;
  }

  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  private creepsOf(workType: "buster" | "strike"): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && creep.memory.workType === workType && !creep.spawning) {
        creeps.push(creep);
      }
    }
    return creeps;
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
   */
  public missionTargets(homeRoom: string): { attack: string[]; strike: string[] } {
    const attack: string[] = [];
    const strike: string[] = [];
    if (typeof Memory === "undefined" || !Memory.roomIntel) return { attack, strike };

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
    const core = creep.room
      .find(FIND_HOSTILE_STRUCTURES)
      .find(s => s.structureType === STRUCTURE_INVADER_CORE) as StructureInvaderCore | undefined;
    if (!core) return; // vision re-stamps invaderCorePresent=false; strike phase takes over
    if (creep.pos.isNearTo(core)) {
      creep.attack(core); // ERR_INVALID_TARGET while deploy-invulnerable: wait it out adjacent
    } else {
      travelTo(creep, core.pos, { range: 1, visualizePathStyle: { stroke: "#ff9944" } });
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

    const coveredBusters = new Set(this.creepsOf("buster").map(c => c.memory.targetRoom));
    const busterBody = buildGuardBody(ctx.energyCapacity, 10); // ATTACK/MOVE pairs, up to 10
    if (busterBody.cost > 0) {
      for (const room of targets.attack) {
        if (coveredBusters.has(room)) continue;
        demands.push({
          buyerCorpId: this.id,
          role: "buster",
          value: 104,
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

    const coveredStrikers = new Set(this.creepsOf("strike").map(c => c.memory.targetRoom));
    const strikerBody = buildReserverBody(ctx.energyCapacity, 2); // CLAIM+MOVE pairs
    if (strikerBody.cost > 0) {
      for (const room of targets.strike) {
        if (coveredStrikers.has(room)) continue;
        demands.push({
          buyerCorpId: this.id,
          role: "striker",
          value: 104,
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

  public serialize(): SerializedCoreBusterCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId
    };
  }

  public deserialize(data: SerializedCoreBusterCorp): void {
    super.deserialize(data);
    this.spawnId = data.spawnId ?? this.spawnId;
  }
}
