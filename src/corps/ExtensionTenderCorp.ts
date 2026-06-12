/**
 * @fileoverview ExtensionTenderCorp - a LOCAL MOVER (type "moving"): it does
 * intra-node energy carrying, the short last leg the long-range haulers shouldn't.
 *
 * Haulers are inter-node and should run a dumb source->depot bus, not fan out
 * across a dozen extensions chasing whichever one has a sliver of free space
 * (that reactive convergence is what makes them "school" on one tile). So once a
 * room has a CORE DEPOT - a container beside the spawn the haulers dump into -
 * this local mover takes over the last leg: it withdraws from the depot and tops
 * up the extensions (and the spawn) as a dedicated job.
 *
 * Extensions drain in a BURST (a whole creep's cost vanishes the instant it
 * spawns) and then sit idle until the next spawn, so the tender is deliberately
 * oversized - big enough to refill the whole extension set from the depot in
 * roughly one trip - and mostly idles between bursts.
 *
 * @module corps/ExtensionTenderCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { Position } from "../types/Position";
import { travelTo } from "./movement";

export interface SerializedExtensionTenderCorp extends SerializedCorp {
  spawnId: string;
}

/** A spawn or extension the tender keeps topped up. */
type FillTarget = StructureSpawn | StructureExtension;

export class ExtensionTenderCorp extends Corp {
  private spawnId: string;

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("moving", nodeId, customId);
    this.spawnId = spawnId;
  }

  public getSpawnId(): string {
    return this.spawnId;
  }

  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  private getTenders(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const c = Game.creeps[name];
      if (c.memory.corpId === this.id && c.memory.workType === "tank" && !c.spawning) creeps.push(c);
    }
    return creeps;
  }

  public getCreepCount(): number {
    return this.getTenders().length;
  }

  /** True once a flow miner is producing in the room (income before infrastructure). */
  private roomHasMiner(room: Room): boolean {
    for (const name in Game.creeps) {
      const c = Game.creeps[name];
      if (
        c.room.name === room.name &&
        c.memory.workType === "harvest" &&
        (c.memory.corpId ?? "").startsWith("mining-")
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * The core depot: a container adjacent to one of the room's spawns. This is the
   * one structure haulers dump into and the tender draws from. Null until built.
   */
  private coreDepot(room: Room): StructureContainer | null {
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
      const c = spawn.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: s => s.structureType === STRUCTURE_CONTAINER
      })[0] as StructureContainer | undefined;
      if (c) return c;
    }
    return null;
  }

  /** Spawn + extensions in the room with free energy capacity, nearest the tender first. */
  private fillTargets(room: Room, from: RoomPosition): FillTarget[] {
    const targets = room.find(FIND_MY_STRUCTURES, {
      filter: s =>
        (s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_SPAWN) &&
        (s as FillTarget).store.getFreeCapacity(RESOURCE_ENERGY) > 0
    }) as FillTarget[];
    return targets.sort((a, b) => from.getRangeTo(a.pos) - from.getRangeTo(b.pos));
  }

  public work(tick: number): void {
    this.lastActivityTick = tick;
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;
    const room = spawn.room;

    const depot = this.coreDepot(room);
    const tenders = this.getTenders();

    // Signal the haulers: while a depot exists AND a tender is alive to drain it,
    // haulers run the dumb source->depot bus instead of fanning across extensions.
    // If the tender dies the flag clears and haulers resume filling the spawn
    // network directly, so a dead tender can never deadlock the colony.
    room.memory.extensionTenderActive = !!depot && tenders.length > 0;

    for (const creep of tenders) this.runTender(creep, room, depot);
  }

  /**
   * A tender shuttles depot -> extensions/spawn: fill while it has energy, reload
   * from the depot when empty. It only flips state on full/empty, so it makes
   * complete trips (a clean burst) rather than dithering with partial loads.
   */
  private runTender(creep: Creep, room: Room, depot: StructureContainer | null): void {
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) creep.memory.working = false;
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) creep.memory.working = true;

    if (creep.memory.working) {
      const target = this.fillTargets(room, creep.pos)[0];
      if (!target) {
        // Nothing to fill: idle on the depot so the next burst is served instantly.
        if (depot && !creep.pos.isNearTo(depot)) travelTo(creep, depot, { range: 1 });
        return;
      }
      if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        travelTo(creep, target, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
      } else {
        this.recordProduction(Math.min(creep.store[RESOURCE_ENERGY], target.store.getFreeCapacity(RESOURCE_ENERGY)));
      }
      return;
    }

    // Reloading: draw from the depot (fall back to the largest nearby drop pile so a
    // not-yet-built depot still works).
    if (depot && depot.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(depot, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        travelTo(creep, depot, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
      }
      return;
    }
    const pile = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0
    });
    if (pile) {
      if (creep.pickup(pile) === ERR_NOT_IN_RANGE) travelTo(creep, pile, { range: 1 });
    } else if (depot && !creep.pos.isNearTo(depot)) {
      travelTo(creep, depot, { range: 1 });
    }
  }

  /**
   * Demand one oversized tender once a depot exists and there are extensions to
   * keep filled. NON-blocking: it is infrastructure (it tops the topmost
   * consumption tier, above building/upgrading), not core income, so it must not
   * hold the spawn ahead of the miners/haulers that produce the energy it moves -
   * until it spawns, room.memory.extensionTenderActive stays false and the haulers
   * keep filling the extensions themselves, so nothing is starved in the meantime.
   * Sized to refill the whole extension set in ~one trip (a bit oversized, since it
   * works in bursts).
   */
  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];
    const room = spawn.room;
    if (!this.coreDepot(room)) return []; // no depot yet -> haulers still fill the network

    const extensions = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTENSION });
    if (extensions.length === 0) return [];

    // Infrastructure follows income: don't spawn a tender before the room has a
    // miner, or it takes the first spawn slot and delays the economy it depends on.
    if (!this.roomHasMiner(room)) return [];

    const tenders = this.getTenders();
    if (tenders.length >= 1) return []; // one (oversized) tender per room is enough

    // Carry enough to refill every extension (+ the spawn) in roughly one trip; the
    // scheduler scales the body down to the energy on hand if it can't afford it all.
    const PART_PAIR = 100; // CARRY + MOVE
    const maxCarry = Math.max(1, Math.min(Math.floor(ctx.energyCapacity / PART_PAIR), 25));
    const carry = Math.max(1, Math.min(extensions.length + 1, maxCarry));

    return [
      {
        buyerCorpId: this.id,
        role: "tanker",
        value: 96, // infrastructure: above upgrading/building, below the core mining economy
        blocking: false, // infrastructure, not core income - never hold the spawn ahead of producers
        producesIncome: false,
        desiredCost: carry * PART_PAIR,
        minCost: Math.min(carry, 2) * PART_PAIR,
        since: 0,
        bodyParam: carry
      }
    ];
  }

  public serialize(): SerializedExtensionTenderCorp {
    return { ...super.serialize(), spawnId: this.spawnId };
  }

  public deserialize(data: SerializedExtensionTenderCorp): void {
    super.deserialize(data);
    this.spawnId = data.spawnId ?? this.spawnId;
  }
}

/** Create an ExtensionTenderCorp for an owned room's spawn. */
export function createExtensionTenderCorp(room: Room): ExtensionTenderCorp | null {
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return null;
  return new ExtensionTenderCorp(`${room.name}-tender`, spawn.id);
}
