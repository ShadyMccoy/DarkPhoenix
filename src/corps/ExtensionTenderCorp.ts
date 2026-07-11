/**
 * @fileoverview ExtensionTenderCorp - a LOCAL MOVER (type "moving"): it does
 * intra-node energy carrying, the short last leg the long-range haulers shouldn't.
 *
 * Haulers are inter-node and should run a dumb source->depot bus, not fan out
 * across a dozen extensions chasing whichever one has a sliver of free space
 * (that reactive convergence is what makes them "school" on one tile). So once a
 * room has a CORE DEPOT - a container beside the spawn (the room's storage once
 * built) the haulers dump into - this local mover takes over the last leg: it
 * withdraws from the depot and tops
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
import { CoreDepot, coreDepot } from "./nodeEnergy";
import { extensionClusters, nextStop, roomCircuit } from "./refillCircuit";
import { travelTo, travelToBypass } from "./movement";
import { staffsPost } from "../economy/primitives";

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

  /**
   * Rebind to the commission's CURRENT spawn. The spawn id is commission-owned
   * state: a persisted corp outlives spawns (measured live: an immortal
   * upgrade/construction corp carried a dead spawn's id for good, so
   * collectDemands dropped its demands forever - 0 upgraders/builders while
   * the plan begged for them). Every kind's materialize() refreshes this.
   */
  public setSpawnId(spawnId: string): void {
    this.spawnId = spawnId;
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
   * Spawn + extensions in the room with free energy capacity - EXTENSIONS
   * FIRST, then by range. The refill SLA (owner 2026-07-10) binds the
   * extension bank to each draining spawn's build time, and the spawn
   * structure's own 300 regenerates spawn capability regardless; measured
   * (haul-t4-refill-sla-under-churn): with range-only ordering the tender's
   * whole first load vanished into the adjacent spawn structure and the
   * extensions waited out a second depot round-trip past the deadline.
   */
  private fillTargets(room: Room, from: RoomPosition, cluster?: FillTarget[]): FillTarget[] {
    const pool =
      cluster ??
      (room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_SPAWN
      }) as FillTarget[]);
    const targets = pool.filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    return targets.sort((a, b) => {
      const aSpawn = a.structureType === STRUCTURE_SPAWN ? 1 : 0;
      const bSpawn = b.structureType === STRUCTURE_SPAWN ? 1 : 0;
      if (aSpawn !== bSpawn) return aSpawn - bSpawn;
      return from.getRangeTo(a.pos) - from.getRangeTo(b.pos);
    });
  }

  public work(tick: number): void {
    this.lastActivityTick = tick;
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;
    const room = spawn.room;

    const depot = coreDepot(room);
    const tenders = this.getTenders();

    // Signal the haulers: while a depot exists AND a tender is alive to drain it,
    // haulers run the dumb source->depot bus instead of fanning across extensions.
    // If the tender dies the flag clears and haulers resume filling the spawn
    // network directly, so a dead tender can never deadlock the colony.
    room.memory.extensionTenderActive = !!depot && tenders.length > 0;

    // PER-CLUSTER assignment (refill SLA on split layouts): each tender owns
    // one spatial cluster - a single tender cannot beat 3t/part deadlines
    // across 20-tile-separated groups (measured on the legacy-layout
    // snapshot). Stable by name order so assignments survive across ticks;
    // extra tenders (clusters shrank) share cluster 0 until they expire.
    const clusters = extensionClusters(room) as FillTarget[][];
    const byName = [...tenders].sort((a, b) => a.name.localeCompare(b.name));
    byName.forEach((creep, i) => {
      const cluster = clusters.length > 0 ? clusters[i % clusters.length] : undefined;
      this.runTender(creep, room, depot, cluster);
    });
  }

  /**
   * A tender shuttles depot -> extensions/spawn: fill while it has energy, reload
   * from the depot when empty. It only flips state on full/empty, so it makes
   * complete trips (a clean burst) rather than dithering with partial loads.
   */
  private runTender(creep: Creep, room: Room, depot: CoreDepot | null, cluster?: FillTarget[]): void {
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) creep.memory.working = false;
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) creep.memory.working = true;

    if (creep.memory.working) {
      const targets = this.fillTargets(room, creep.pos, cluster);
      if (targets.length === 0) {
        // Nothing to fill: idle at the reload point AND top up while waiting,
        // so the next burst starts with a full load. A tender idling on its
        // burst leftovers had to mid-burst reload against a small creep's
        // 6-9 tick deadline (measured: SLA breach at t=336 of the churn
        // cell). Depot-less rooms idle at the nearest stocked container (or
        // the spawn, keeping first response instant).
        // Idle INSIDE the assigned cluster (its first member) when the depot
        // is another cluster's neighborhood - first response beats reload.
        const anchor = cluster && cluster.length > 0 ? cluster[0] : null;
        const depotNear = depot && anchor ? anchor.pos.getRangeTo(depot.pos) <= 6 : !!depot;
        const idleAt =
          (depotNear ? depot : null) ??
          anchor ??
          this.reloadStock(creep) ??
          Game.getObjectById(this.spawnId as Id<StructureSpawn>);
        if (idleAt && !creep.pos.isNearTo(idleAt)) {
          travelTo(creep, idleAt, { range: 1 });
        } else if (creep.store.getFreeCapacity() > 0) {
          const stock = depot ?? this.reloadStock(creep);
          if (stock && creep.pos.isNearTo(stock)) creep.withdraw(stock as StructureContainer, RESOURCE_ENERGY);
        }
        return;
      }

      // NEVER walk past an empty extension (owner directive 2026-07-09):
      // whatever the current destination, if ANY needy target is adjacent
      // right now, fill it THIS tick - the transfer is free alongside the
      // move, so the tender is filling every tick it possibly can.
      // While any extension is needy, en-route transfers go to EXTENSIONS
      // only: an adjacent spawn structure swallows the whole load in one
      // transfer (300 vs an extension's 50) and defeats the sweep.
      const needyExts = targets.filter(t => t.structureType === STRUCTURE_EXTENSION);
      const adjacentPool = needyExts.length > 0 ? needyExts : targets;
      const adjacent = adjacentPool.find(t => creep.pos.isNearTo(t.pos));
      if (adjacent) {
        creep.transfer(adjacent, RESOURCE_ENERGY);
        this.recordProduction(
          Math.min(creep.store[RESOURCE_ENERGY], adjacent.store.getFreeCapacity(RESOURCE_ENERGY))
        );
      }

      // BUS CIRCUIT (owner directive 2026-07-10): the tender follows the room's
      // fixed refill tour - same path every lap, skipping full stops - instead
      // of any ad-hoc target picking. Deterministic, no dither, and spawning
      // drains in the same order (SpawningCorp energyStructures), so holes
      // appear as a contiguous run the bus sweeps.
      const circuit = roomCircuit(room);
      const needySet = new Set<string>(adjacentPool.map(t => t.id as string));
      const stopIdx = nextStop(circuit, creep.memory.circuitIdx ?? 0, id => needySet.has(id));
      if (stopIdx === null) return; // every stop full
      creep.memory.circuitIdx = stopIdx;
      const dest = targets.find(t => t.id === circuit[stopIdx]);
      if (dest && (!adjacent || adjacent.id !== dest.id)) {
        if (!creep.pos.isNearTo(dest.pos)) {
          // Bypass so a parked hauler/sibling on the cluster path is swapped
          // through instead of deadlocking the bus (measured live).
          travelToBypass(creep, dest, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
        }
      } else if (adjacent && dest && adjacent.id === dest.id) {
        // Serving the current stop this tick: advance to the next on the tour.
        creep.memory.circuitIdx = (stopIdx + 1) % circuit.length;
      }
      return;
    }

    // Reloading: depot first, then any stocked container, then a drop pile -
    // a depot-less room's tender is still a real apparatus (refill SLA).
    if (depot && depot.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(depot, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        travelTo(creep, depot, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
      }
      return;
    }
    const container = this.reloadStock(creep);
    if (container) {
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        travelTo(creep, container, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
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

  /** Nearest stocked container/storage - the depot-less reload point. */
  private reloadStock(creep: Creep): StructureContainer | StructureStorage | null {
    return creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: s =>
        (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 0
    }) as StructureContainer | StructureStorage | null;
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

    // No depot required (refill SLA, owner 2026-07-10): the tender IS the
    // refill apparatus - a loaded tender idling by the bank is what beats a
    // draining spawn's 3t/part deadline, and hauler fan-fill measurably
    // cannot (organic breaches on the pre-ramped and pipeline worlds, both
    // depot-less). Without a depot it reloads from any container or pile and
    // idles by the spawn; the extensionTenderActive regime flag still keys
    // on the depot, so haulers keep fanning alongside it until one exists.
    const extensions = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTENSION });
    if (extensions.length === 0) return [];

    // Infrastructure follows income: don't spawn a tender before the room has a
    // miner, or it takes the first spawn slot and delays the economy it depends on.
    if (!this.roomHasMiner(room)) return [];

    // DELIVERY CONTRACT (staffsPost, same as miners/haulers): an incumbent
    // inside its replacement lead time no longer counts as staffing, so the
    // successor spawns early and the refill post is never dark. A tender gap
    // is a direct SLA breach (the depot bank goes invisible to refill while
    // no tender lives) - the ~50-100 tick death gap measured as exactly the
    // "extensions sit empty" class the owner keeps seeing live.
    // Counted over ALL corp creeps INCLUDING spawning ones (a successor in
    // the pipe staffs - staffsPost treats undefined ttl as freshest), else
    // the demand re-fires while the replacement builds and double-orders.
    let staffing = 0;
    for (const name in Game.creeps) {
      const c = Game.creeps[name];
      if (c.memory.corpId !== this.id || c.memory.workType !== "tank") continue;
      if (staffsPost(c.ticksToLive, c.body?.length ?? 0, 0)) staffing++;
    }
    // FLEET SIZE (refill SLA): one tender per spatial cluster - a single
    // tender cannot beat per-drain deadlines across separated groups - AND
    // enough combined carry to cover a full bank drain in one wave (at RCL2-3
    // the body caps at ~400 carry while a big miner drains 650+; measured,
    // pipeline t=1553: the lone tender's second trip lost the deadline).
    const PART_PAIR = 100; // CARRY + MOVE
    const maxCarry = Math.max(1, Math.min(Math.floor(ctx.energyCapacity / PART_PAIR), 25));
    const clusters = extensionClusters(room);
    const bankCapacity = 300 + 50 * extensions.length;
    const forCoverage = Math.ceil(bankCapacity / (maxCarry * 50));
    const target = Math.min(3, Math.max(1, clusters.length, forCoverage));
    if (staffing >= target) return [];

    // Carry enough to refill the LARGEST cluster in roughly one trip; the
    // scheduler scales the body down to the energy on hand if it can't afford it all.
    const biggest = clusters.reduce((m, c) => Math.max(m, c.length), extensions.length);
    const carry = Math.max(1, Math.min(biggest + 1, maxCarry));

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
