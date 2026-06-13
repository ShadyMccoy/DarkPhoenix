/**
 * @fileoverview ReservationCorp - keeps the controllers of remote rooms we mine
 * reserved, so their sources regenerate the full 3000 (10 e/tick) instead of the
 * unreserved 1500 (5 e/tick).
 *
 * This is the one genuinely room-specific part of remote mining: a source in an
 * unowned room is throttled to half output unless we hold its controller. A
 * reserver (CLAIM + MOVE) parks on the controller and reserves it continuously.
 * We only bother for rooms we are actually mining - the trigger is "one of our
 * miners is working in an unowned, controllered room" - so the claimer's cost is
 * always set against real extra harvest.
 *
 * @module corps/ReservationCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { MAX_SCOUT_DISTANCE } from "./CorpConstants";
import { Position } from "../types/Position";
import { buildReserverBody } from "../spawn/BodyBuilder";
import { travelTo } from "./movement";

/**
 * Serialized state specific to ReservationCorp.
 */
export interface SerializedReservationCorp extends SerializedCorp {
  spawnId: string;
}

/**
 * ReservationCorp manages reserver creeps that hold remote controllers.
 */
export class ReservationCorp extends Corp {
  private spawnId: string;

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("reservation", nodeId, customId);
    this.spawnId = spawnId;
  }

  public getSpawnId(): string {
    return this.spawnId;
  }

  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  private getActiveCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && creep.memory.workType === "reserve" && !creep.spawning) {
        creeps.push(creep);
      }
    }
    return creeps;
  }

  /**
   * Rooms worth reserving from this home: unowned, controllered rooms within
   * scouting range where one of our miners is currently working, and which no
   * other player owns or reserves (we cannot reserve over them). Reserving a room
   * we are mining roughly doubles that source's output, so the trigger is simply
   * "are we mining here".
   */
  private targetRooms(homeRoom: string, myUsername: string | undefined): string[] {
    const targets = new Set<string>();
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.workType !== "harvest") continue;
      const controller = creep.room.controller;
      if (!controller) continue; // Source Keeper / controller-less rooms: not reservable
      if (controller.my) continue; // our own room needs no reservation
      if (controller.owner) continue; // owned by another player: cannot reserve
      if (controller.reservation && controller.reservation.username !== myUsername) continue; // someone else reserves it
      if (Game.map.getRoomLinearDistance(homeRoom, creep.room.name) > MAX_SCOUT_DISTANCE) continue;
      targets.add(creep.room.name);
    }
    return [...targets];
  }

  public work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;
    const homeRoom = spawn.room.name;
    const myUsername = spawn.owner?.username;

    const targets = this.targetRooms(homeRoom, myUsername);
    const covered = new Set<string>();

    for (const creep of this.getActiveCreeps()) {
      let target = creep.memory.targetRoom;
      // (Re)assign if the creep has no target, its target is no longer worth
      // reserving, or another reserver already covers it.
      if (!target || !targets.includes(target) || covered.has(target)) {
        target = targets.find(r => !covered.has(r));
        creep.memory.targetRoom = target;
      }
      if (!target) continue; // nothing to reserve right now - idle until reassigned
      covered.add(target);
      this.runReserver(creep, target);
    }
  }

  /** Walk to the target room's controller and hold the reservation. */
  private runReserver(creep: Creep, targetRoom: string): void {
    if (creep.room.name !== targetRoom) {
      travelTo(creep, new RoomPosition(25, 25, targetRoom), {
        range: 20,
        visualizePathStyle: { stroke: "#88aaff" }
      });
      return;
    }
    const controller = creep.room.controller;
    if (!controller) return;
    if (creep.pos.isNearTo(controller)) {
      creep.reserveController(controller);
    } else {
      creep.moveTo(controller, { range: 1, visualizePathStyle: { stroke: "#88aaff" } });
    }
  }

  /**
   * Request one reserver while a target room lacks one. Reservers are an income
   * optimisation (they lift a remote source from 1500 to 3000), so they rank
   * below the core mining/hauling that produces the base income, and are only
   * requested for rooms we already mine. Gated by affordability: CLAIM costs 600,
   * so a low-capacity room asks for nothing until it can build one.
   */
  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];

    const targets = this.targetRooms(spawn.room.name, spawn.owner?.username);
    if (targets.length === 0) return [];

    const covered = new Set(
      this.getActiveCreeps()
        .map(c => c.memory.targetRoom)
        .filter((r): r is string => !!r)
    );
    if (targets.every(t => covered.has(t))) return [];

    const body = buildReserverBody(ctx.energyCapacity, 2);
    if (body.cost === 0) return []; // cannot afford a CLAIM yet

    return [
      {
        buyerCorpId: this.id,
        role: "reserver",
        // Reservation doubles a remote source (+~5 e/tick for a 650 claimer that
        // lasts 600 ticks - an enormous ROI), so it ranks as income work: above
        // discretionary upgrading (90), below the core miners (100+) and the
        // haulers (90-110) that actually move the energy it unlocks.
        value: 92,
        blocking: false,
        producesIncome: true, // a reserved source delivers twice the energy
        desiredCost: body.cost,
        minCost: body.cost,
        since: 0,
        bodyParam: body.claimParts
      }
    ];
  }

  public getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  public serialize(): SerializedReservationCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId
    };
  }

  public deserialize(data: SerializedReservationCorp): void {
    super.deserialize(data);
    this.spawnId = data.spawnId ?? this.spawnId;
  }
}
