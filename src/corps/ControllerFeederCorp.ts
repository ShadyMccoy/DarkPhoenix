/**
 * @fileoverview ControllerFeederCorp - a LOCAL MOVER (type "moving") that relays
 * energy from the room's storage BANK to the controller's upgrade input, so the
 * long-range haulers deliver to ONE central destination - the storage - and this
 * dedicated feeder runs the short last leg to the parked upgraders.
 *
 * The controller analogue of ExtensionTenderCorp (which relays the depot ->
 * spawn/extensions). Once a room has a storage, the flow planner routes the
 * surplus into the bank (flowAdapter's STORAGE_UPGRADE_TARGET) and CarryCorp
 * deposits controller-bound loads into the storage rather than hauling all the way
 * to the controller (deliverToController defers to the feeder while it is active).
 * The feeder keeps the controller input spot - the upgrader container, or the
 * shared drop pile before one is built - topped from the bank, and the upgraders
 * draw from it exactly as before, so their stock-grounded sizing is unchanged: the
 * feeder REPLACES the direct haul, it does not change how fast the controller is
 * upgraded.
 *
 * @module corps/ControllerFeederCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { Position } from "../types/Position";
import { CoreDepot, controllerLink, coreDepot, coreLink, controllerInputSpot } from "./nodeEnergy";
import { travelTo, travelToBypass } from "./movement";
import { carryPartsFor } from "../economy/primitives";
import { bankSurplusRate, feederRelayRate } from "../economy/bank";

export interface SerializedControllerFeederCorp extends SerializedCorp {
  spawnId: string;
  controllerAllocation?: number;
}

/**
 * Energy the feeder keeps staged at the controller input. Matched to a container's
 * worth so the upgraders' stock-grounded sizing (UpgradingCorp.controllerSideStock)
 * is the SAME as it was under direct hauling - the feeder replaces the haul, it does
 * not change how fast the controller upgrades. A bare drop pile (before a container
 * is built) is held to the same target so it cannot grow unbounded.
 */
const CONTROLLER_FEED_TARGET = 2000;

/**
 * ControllerFeederCorp fields the shuttle fleet (usually one feeder; more only
 * while a bank surplus is being drawn down) that relays storage -> controller input.
 */
/** Container-refill headroom the relay carries above the plan's controller
 * flow: input-container decay plus a small buffer so the stock never starves
 * between shuttle arrivals. */
const FEEDER_STOCK_HEADROOM = 5;

/**
 * The relay rate the feeder fleet is sized to sustain (pure, unit-tested).
 *
 * SURPLUS (bankSurplusRate > 0): the raw surplus formula, IGNORING the plan's
 * controller allocation - consumers size from actuals, never the goal plan
 * (macro doctrine; the upgrader half is upgraderSizing's surplus regime, this
 * is its supply line). Prod t72455355: the plan's parts ledger exhausted
 * before the controller sink (allocated 2) while 340k stood banked; the old
 * clamp sized the feeder to relay 7 while the upgraders' sizing assumed the
 * surplus 115 - the stock drained 1520 -> 60 and burn ran 11 of 115. The two
 * halves of the consumption chain must read the SAME inflow or the upgraders'
 * math lies.
 *
 * NON-SURPLUS: the plan clamp stands (owner t72421124: while construction
 * preempts the bank the controller legitimately floors at ~2 e/t, and a
 * feeder sized to the raw formula is 90+ wasted parts). bankSurplusRate is
 * the shared regime lens - the same primitive the upgraders and the bank
 * draw read.
 */
export function feederRelayTarget(surplusRate: number, planFlow: number | undefined, banked: number): number {
  if (bankSurplusRate(banked) > 0) return surplusRate;
  return planFlow !== undefined ? Math.min(surplusRate, planFlow + FEEDER_STOCK_HEADROOM) : surplusRate;
}

export class ControllerFeederCorp extends Corp {
  private spawnId: string;
  /** The plan's controller-side flow (commission-owned, refreshed every round). */
  private controllerAllocation?: number;

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("moving", nodeId, customId);
    this.spawnId = spawnId;
  }

  /** The plan's controller allocation for this room - the relay's ceiling. */
  public setControllerAllocation(v: number): void {
    this.controllerAllocation = v;
  }

  public getSpawnId(): string {
    return this.spawnId;
  }

  /** Rebind to the commission's CURRENT spawn (commission-owned; never let it go stale). */
  public setSpawnId(spawnId: string): void {
    this.spawnId = spawnId;
  }

  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const controller = spawn?.room.controller;
    if (controller) return { x: controller.pos.x, y: controller.pos.y, roomName: controller.pos.roomName };
    if (spawn) return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  private getFeeders(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const c = Game.creeps[name];
      if (c.memory.corpId === this.id && c.memory.workType === "feed" && !c.spawning) creeps.push(c);
    }
    return creeps;
  }

  public getCreepCount(): number {
    return this.getFeeders().length;
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

  /** Energy already staged at the controller input: its container/link plus piles. */
  private controllerStock(controller: StructureController, inputPos: RoomPosition): number {
    let stock = 0;
    const buffer = controller.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_LINK
    })[0] as StructureContainer | StructureLink | undefined;
    if (buffer) stock += buffer.store[RESOURCE_ENERGY];
    for (const r of inputPos.findInRange(FIND_DROPPED_RESOURCES, 1)) {
      if (r.resourceType === RESOURCE_ENERGY) stock += r.amount;
    }
    return stock;
  }

  public work(tick: number): void {
    this.lastActivityTick = tick;
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;
    const room = spawn.room;
    const controller = room.controller;
    if (!controller) return;

    const depot = coreDepot(room);
    const feeders = this.getFeeders();
    // Signal the haulers: while a storage bank exists AND a feeder is alive to run
    // the last leg, controller-bound loads stop at the bank (CarryCorp defers to us).
    // If the feeder dies the flag clears and haulers resume delivering to the
    // controller directly, so a dead feeder never starves upgrading.
    room.memory.controllerFeederActive = !!(room.storage && room.storage.my) && feeders.length > 0;

    for (const creep of feeders) this.runFeeder(creep, controller, depot);
  }

  /**
   * A feeder shuttles bank -> controller input: fill up at the storage, top the
   * controller input to CONTROLLER_FEED_TARGET, reload when empty. It only flips
   * state on full/empty, so it makes complete trips rather than dithering.
   */
  private runFeeder(creep: Creep, controller: StructureController, depot: CoreDepot | null): void {
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) creep.memory.working = false;
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) creep.memory.working = true;

    if (creep.memory.working) {
      // LINK RELAY (spec 24 rung 3): with a controller link built, the long
      // leg belongs to the link network - the feeder's whole route becomes
      // storage -> core link, one tile. The LinkRunner fires core -> controller
      // link; upgraders draw from the link (the input election prefers it).
      const ctrlLink = controllerLink(creep.room);
      const core = ctrlLink ? coreLink(creep.room) : null;
      if (ctrlLink && core) {
        if (core.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
          if (creep.pos.getRangeTo(core.pos) > 2) travelTo(creep, core.pos, { range: 2 });
          return; // network saturated: hold the load beside the core
        }
        if (creep.pos.getRangeTo(core.pos) > 1) {
          travelToBypass(creep, core.pos, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
          return;
        }
        const moved = Math.min(creep.store[RESOURCE_ENERGY], core.store.getFreeCapacity(RESOURCE_ENERGY));
        if (creep.transfer(core, RESOURCE_ENERGY) === OK) {
          this.recordProduction(moved);
          creep.memory.lastDeliver = { to: "core-link", amount: moved, tick: Game.time };
        }
        return;
      }
      const input = controllerInputSpot(controller);
      // Topped up: hold the load near the input so the next drain is served at once
      // (do not overfill - a bare pile would otherwise grow without bound).
      if (this.controllerStock(controller, input.pos) >= CONTROLLER_FEED_TARGET) {
        if (creep.pos.getRangeTo(input.pos) > 2) travelTo(creep, input.pos, { range: 2 });
        return;
      }
      if (input.structure) {
        // Container/link: transfer from range 1. travelToBypass so a ring of parked
        // upgraders cannot wall the feeder out of range-1 access.
        if (creep.pos.getRangeTo(input.pos) > 1) {
          travelToBypass(creep, input.pos, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
          return;
        }
        const moved = Math.min(
          creep.store[RESOURCE_ENERGY],
          input.structure.store.getFreeCapacity(RESOURCE_ENERGY) ?? creep.store[RESOURCE_ENERGY]
        );
        if (creep.transfer(input.structure, RESOURCE_ENERGY) === OK) {
          this.recordProduction(moved);
          creep.memory.lastDeliver = { to: "controller-input", amount: moved, tick: Game.time };
        }
        return;
      }
      // Bare tile (no container yet): drop ON the input tile so every parked upgrader
      // ringing it can withdraw from the one shared pile (mirrors CarryCorp's drop).
      if (!creep.pos.isEqualTo(input.pos)) {
        travelToBypass(creep, input.pos, { range: 0, visualizePathStyle: { stroke: "#ffff88" } });
        return;
      }
      const carried = creep.store[RESOURCE_ENERGY];
      if (creep.drop(RESOURCE_ENERGY) === OK) this.recordProduction(carried);
      return;
    }

    // Reload from the bank (fall back to a nearby drop pile if the depot is dry).
    if (depot && depot.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(depot, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        travelTo(creep, depot, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
      }
      return;
    }
    if (depot && !creep.pos.isNearTo(depot)) travelTo(creep, depot, { range: 1 });
  }

  /**
   * Demand feeders once a storage bank exists and the room produces energy.
   * NON-blocking infrastructure: until one spawns, room.memory.controllerFeederActive
   * stays false and the haulers feed the controller directly, so nothing is starved.
   * Sized to sustain the RELAY RATE (economy/bank.feederRelayRate) over the
   * bank->controller round trip: the save-regime upgrade target while the
   * warchest fills - one shuttle, exactly as before - plus the surplus draw
   * once the bank is full, fielding additional shuttles when one body cannot
   * physically move the flow (a 35 e/t relay is ~27 CARRY across a 15-tile
   * leg; pretending one 13-CARRY feeder covers it would starve the upgraders
   * the plan just scaled up).
   */
  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    // Decision-symmetry stamp (spec 14 phase 2): for an infrastructure corp
    // the GATES are the decision - "why zero feeders with a fat bank" is a
    // gate verdict, so every return records which gate fired and what it read.
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) {
      this.lastSizing = { tick: ctx.tick, gate: "no-spawn" };
      return [];
    }
    const room = spawn.room;
    const controller = room.controller;
    if (!controller) {
      this.lastSizing = { tick: ctx.tick, gate: "no-controller" };
      return [];
    }
    if (!(room.storage && room.storage.my)) {
      this.lastSizing = { tick: ctx.tick, gate: "no-storage" };
      return []; // no bank yet -> haulers feed the controller directly
    }
    const banked = room.storage.store.energy ?? 0;
    const hasMiner = this.roomHasMiner(room);
    if (!hasMiner) {
      this.lastSizing = { tick: ctx.tick, gate: "no-miner", banked, hasMiner };
      return []; // infrastructure follows income
    }

    // Balanced 1:1 body sized to sustain the relay over the round trip (the
    // feeder travels, unlike the parked extension tender). The storage sits by
    // the spawn, so the spawn->controller distance approximates the bank->controller leg.
    // Link-fed rooms shrink the shuttle leg to storage -> core link (spec 24
    // rung 3): the same relay rate needs ~1/6th the CARRY, and the plan's
    // feeder pricing reads the same lens (infraSpawnLoad linkFedRoomCount).
    const linkFed = !!controllerLink(spawn.room);
    const distance = linkFed ? 1 : spawn.pos.getRangeTo(controller.pos);
    const PART_PAIR = 100; // CARRY + MOVE
    const maxCarry = Math.max(1, Math.min(Math.floor(ctx.energyCapacity / PART_PAIR), 25));
    // The relay serves the PLAN's controller flow, never the raw surplus
    // formula: when construction preempts the bank the controller floors at
    // ~2 e/t and relaying 115 into a full stock is 90+ wasted parts (owner
    // t72421124). No allocation known (old commission) -> formula unclamped.
    const surplusRate = feederRelayRate(banked);
    const planFlow = this.controllerAllocation;
    const relayRate = feederRelayTarget(surplusRate, planFlow, banked);
    const neededCarry = Math.max(1, Math.ceil(carryPartsFor(relayRate, distance) * 1.2));
    const wantedFeeders = Math.ceil(neededCarry / maxCarry);
    const feeders = this.getFeeders().length;
    this.lastSizing = {
      tick: ctx.tick,
      gate: feeders >= wantedFeeders ? "staffed" : "demand",
      banked,
      hasMiner,
      relayRate,
      ...(planFlow !== undefined ? { planFlow } : {}),
      surplusRate,
      distance,
      ...(linkFed ? { linkFed: true } : {}),
      neededCarry,
      wantedFeeders,
      feeders
    };
    if (feeders >= wantedFeeders) return [];
    const carry = Math.min(neededCarry, maxCarry);

    return [
      {
        buyerCorpId: this.id,
        role: "feeder",
        // Infrastructure tier: just below the extension tender (96), above upgrading -
        // it must exist for the upgraders it serves, but never ahead of the producers.
        value: 95,
        blocking: false, // infra, not income: haulers feed the controller directly until it spawns
        producesIncome: false,
        desiredCost: carry * PART_PAIR,
        minCost: Math.min(carry, 2) * PART_PAIR,
        since: 0,
        bodyParam: carry
      }
    ];
  }

  public serialize(): SerializedControllerFeederCorp {
    return { ...super.serialize(), spawnId: this.spawnId, controllerAllocation: this.controllerAllocation };
  }

  public deserialize(data: SerializedControllerFeederCorp): void {
    super.deserialize(data);
    this.controllerAllocation = data.controllerAllocation;
    this.spawnId = data.spawnId ?? this.spawnId;
  }
}
