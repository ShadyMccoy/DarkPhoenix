/**
 * @fileoverview ClaimCorp - fields the ONE claimer of an active expansion
 * campaign (Memory.expansion, spec 06). Pattern: ReservationCorp, simpler -
 * a single CLAIM+MOVE creep walks to the campaign room, claims the controller,
 * and demobilizes (recycles at home) once the room is ours. Everything after
 * the claim is the founding SINK's job (flowAdapter NEW_SPAWN_SITE_VALUE),
 * not this corp's.
 *
 * @module corps/ClaimCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { Position } from "../types/Position";
import { buildReserverBody } from "../spawn/BodyBuilder";
import { driveRecycle } from "./recycle";
import { travelTo } from "./movement";

export interface SerializedClaimCorp extends SerializedCorp {
  spawnId: string;
}

export class ClaimCorp extends Corp {
  private spawnId: string;

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("claim", nodeId, customId);
    this.spawnId = spawnId;
  }

  public getSpawnId(): string {
    return this.spawnId;
  }

  /** Commission-owned state: every materialize() refreshes this (stale-spawn trap). */
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

  private getActiveCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && creep.memory.workType === "claim" && !creep.spawning) {
        creeps.push(creep);
      }
    }
    return creeps;
  }

  /** Claimers still in the spawn count toward "already fielded". */
  private getTotalCreepCount(): number {
    let count = 0;
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && creep.memory.workType === "claim") count++;
    }
    return count;
  }

  public work(tick: number): void {
    this.lastActivityTick = tick;
    const expansion = Memory.expansion;
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);

    for (const creep of this.getActiveCreeps()) {
      // Campaign over (claimed, completed, or abandoned): demobilize.
      const targetRoom = expansion?.roomName;
      const claimed = targetRoom ? Game.rooms[targetRoom]?.controller?.my === true : true;
      if (!targetRoom || claimed || creep.memory.recycling) {
        creep.memory.recycling = true;
        if (spawn) driveRecycle(creep, spawn);
        continue;
      }
      this.runClaimer(creep, targetRoom);
    }
  }

  private runClaimer(creep: Creep, targetRoom: string): void {
    if (creep.room.name !== targetRoom) {
      travelTo(creep, new RoomPosition(25, 25, targetRoom), {
        range: 20,
        visualizePathStyle: { stroke: "#ffaa00" }
      });
      return;
    }
    const controller = creep.room.controller;
    if (!controller) return;
    if (creep.pos.isNearTo(controller)) {
      const result = creep.claimController(controller);
      if (result === OK) {
        console.log(`[Expansion] ${targetRoom} claimed`);
      } else if (result === ERR_GCL_NOT_ENOUGH) {
        // Trigger raced a GCL change: fall back to reserving so the walk
        // isn't wasted while the campaign times out or GCL catches up.
        creep.reserveController(controller);
      } else {
        // A claim that can't succeed should be loud: the campaign burns its
        // timeout window on it.
        console.log(`[Expansion] claimController(${targetRoom}) failed: ${result}`);
      }
    } else {
      creep.moveTo(controller, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
    }
  }

  /**
   * One claimer while the campaign is live and the room is not yet ours.
   * Investment-tier value: below every income corp (reserver 115, scaling
   * haulers 90-110) - claiming never outbids the economy that pays for it -
   * but held-funded (CLAIM 600 floor is indivisible, same reasoning as the
   * reserver's hold; without it every cheaper body eats the bank first).
   */
  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const expansion = Memory.expansion;
    if (!expansion) return [];
    if (Game.rooms[expansion.roomName]?.controller?.my) return [];
    if (this.getTotalCreepCount() > 0) return [];

    const body = buildReserverBody(ctx.energyCapacity, 1);
    if (body.cost === 0) return []; // cannot afford a CLAIM yet

    return [
      {
        buyerCorpId: this.id,
        role: "claimer",
        value: 80,
        blocking: false,
        producesIncome: false,
        holdToFund: true,
        desiredCost: body.cost,
        minCost: body.cost,
        since: 0,
        bodyParam: 1
      }
    ];
  }

  public getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  public serialize(): SerializedClaimCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId
    };
  }

  public deserialize(data: SerializedClaimCorp): void {
    super.deserialize(data);
    this.spawnId = data.spawnId ?? this.spawnId;
  }
}
