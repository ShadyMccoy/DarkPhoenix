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
type FillTarget = StructureSpawn | StructureExtension | StructureTower;

/**
 * A tower joins the fill circuit only below half charge (spec 07): keep the
 * war chest loaded without topping off a mid-fight trickle shot-by-shot.
 */
export function towerNeedsFill(energy: number, capacity: number): boolean {
  return energy < capacity * 0.5;
}

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
    // Towers (spec 07) join EVERY pool - including per-cluster ones, they sit
    // beside the spawn by construction - but only below half charge.
    const towers = (
      room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_TOWER
      }) as StructureTower[]
    ).filter(t => towerNeedsFill(t.store[RESOURCE_ENERGY], t.store.getCapacity(RESOURCE_ENERGY) ?? 0));
    const targets = [...pool, ...towers].filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
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

    // RELOAD STAGGER (the pipeline-world SLA breach, spec 08 known-red #39):
    // with no stocked depot, reload fuel is a FAR walk, and both tenders
    // reloading simultaneously leave the bank dark exactly when near fuel
    // (hauler hand-offs, piles by the spawn) arrives. Cheap reloads (stocked
    // depot) need no stagger; otherwise only ONE tender may be away - the
    // rest hold their cluster, topping up from whatever lands within reach.
    const cheapReload = !!depot && depot.store[RESOURCE_ENERGY] > 0;
    const reloaders = byName.filter(c => !c.memory.working);
    // Sticky designation: a tender already mid-reload keeps its pass (else a
    // name-order swap would recall it empty from halfway out); otherwise the
    // first empty tender by name gets it.
    const designated = reloaders.find(c => c.memory.awayReloading)?.name ?? reloaders[0]?.name ?? null;

    byName.forEach((creep, i) => {
      const cluster = clusters.length > 0 ? clusters[i % clusters.length] : undefined;
      const mayReload = cheapReload || byName.length <= 1 || creep.name === designated;
      this.runTender(creep, room, depot, cluster, mayReload);
    });
  }

  /**
   * A tender shuttles depot -> extensions/spawn: fill while it has energy, reload
   * from the depot when empty. It only flips state on full/empty, so it makes
   * complete trips (a clean burst) rather than dithering with partial loads.
   */
  private runTender(creep: Creep, room: Room, depot: CoreDepot | null, cluster?: FillTarget[], mayReload = true): void {
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) creep.memory.working = false;
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) creep.memory.working = true;
    if (creep.memory.working) delete creep.memory.awayReloading;
    else if (mayReload) creep.memory.awayReloading = true;

    // SLA: never wander with a servable load while the bank is short - a
    // partial burst NOW beats topping up first against a 3t/part deadline
    // (measured, pipeline t=1142: a tender orbited a dry container holding 13
    // while an extension sat 50 short past its due moment).
    if (
      !creep.memory.working &&
      creep.store[RESOURCE_ENERGY] >= 50 &&
      this.fillTargets(room, creep.pos, cluster).length > 0
    ) {
      creep.memory.working = true;
      delete creep.memory.awayReloading;
    }

    // POSITIONING DISCIPLINE: a half-loaded tender heads home instead of
    // lingering at a slow fuel point for a full load - the working branch
    // parks it at its cluster anchor (topping up there if fuel is near), so
    // it is AT the post when the next drain lands. Measured (pipeline
    // t=1398): two tenders each holding 150 sat 7-13 tiles out hunting the
    // rest of a load while one extension went 11 short past its deadline.
    if (!creep.memory.working && creep.store[RESOURCE_ENERGY] >= creep.store.getCapacity() / 2) {
      creep.memory.working = true;
      delete creep.memory.awayReloading;
    }

    // Denied a far reload (stagger): hold the post instead. Any energy that
    // lands (a hauler top-up, an adjacent pile) resumes the burst at once -
    // a partial load serving the bank beats a full one 30 tiles away.
    if (!creep.memory.working && !mayReload) {
      if (creep.store[RESOURCE_ENERGY] > 0) {
        creep.memory.working = true;
      } else {
        const anchor = cluster && cluster.length > 0 ? cluster[0] : Game.getObjectById(this.spawnId as Id<StructureSpawn>);
        if (anchor && !creep.pos.isNearTo(anchor.pos)) {
          travelTo(creep, anchor, { range: 1 });
          return;
        }
        const stock = this.reloadStock(creep);
        if (stock && creep.pos.isNearTo(stock)) creep.withdraw(stock as StructureContainer, RESOURCE_ENERGY);
        else {
          const pile = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
            filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0
          })[0];
          if (pile) creep.pickup(pile);
        }
        return;
      }
    }

    if (creep.memory.working) {
      // Cluster ownership is a PREFERENCE, not a wall: with its own cluster
      // satisfied, a loaded tender covers any other cluster's short rather
      // than idling beside it (measured, pipeline t=1194: one extension 50
      // short past its deadline while a tender with 65 aboard idled 3 tiles
      // away on the wrong cluster - the SLA is room-level).
      let targets = this.fillTargets(room, creep.pos, cluster);
      if (targets.length === 0 && creep.store[RESOURCE_ENERGY] > 0) {
        targets = this.fillTargets(room, creep.pos);
      }
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

  /**
   * Nearest stocked container/storage - the depot-less reload point. The
   * CONTROLLER's input container is excluded: that is the upgraders' bucket
   * (a consumer's stock, kept full by the feeder) - a tender draining it is
   * circular economics AND a 12+ tile wander (measured, pipeline t=1548: a
   * tender reloaded at the controller box while its cluster went short).
   */
  private reloadStock(creep: Creep): StructureContainer | StructureStorage | null {
    const controller = creep.room.controller;
    return creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: s =>
        (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 0 &&
        !(controller && s.structureType === STRUCTURE_CONTAINER && s.pos.getRangeTo(controller.pos) <= 3)
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
    // Decision-symmetry gate stamps (spec 14 phase 2) - same contract as the
    // controller feeder: every return records the gate that fired.
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) {
      this.lastSizing = { tick: ctx.tick, gate: "no-spawn" };
      return [];
    }
    const room = spawn.room;

    // No depot required (refill SLA, owner 2026-07-10): the tender IS the
    // refill apparatus - a loaded tender idling by the bank is what beats a
    // draining spawn's 3t/part deadline, and hauler fan-fill measurably
    // cannot (organic breaches on the pre-ramped and pipeline worlds, both
    // depot-less). Without a depot it reloads from any container or pile and
    // idles by the spawn; the extensionTenderActive regime flag still keys
    // on the depot, so haulers keep fanning alongside it until one exists.
    const extensions = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTENSION });
    if (extensions.length === 0) {
      this.lastSizing = { tick: ctx.tick, gate: "no-extensions" };
      return [];
    }

    // Infrastructure follows income: don't spawn a tender before the room has a
    // miner, or it takes the first spawn slot and delays the economy it depends on.
    const hasMiner = this.roomHasMiner(room);
    if (!hasMiner) {
      this.lastSizing = { tick: ctx.tick, gate: "no-miner", extensions: extensions.length, hasMiner };
      return [];
    }

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
    this.lastSizing = {
      tick: ctx.tick,
      gate: staffing >= target ? "staffed" : "demand",
      extensions: extensions.length,
      hasMiner,
      clusters: clusters.length,
      staffing,
      target
    };
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
