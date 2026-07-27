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
import {
  CoreDepot,
  controllerLink,
  coreDepot,
  coreLink,
  coreLinkDrainAmount,
  coreLinkLoadRoom,
  controllerInputSpot,
  sourceLink
} from "./nodeEnergy";
import { travelTo, travelToBypass } from "./movement";
import { carryPartsFor, parkedRelayCarry } from "../economy/primitives";
import { bankSurplusRate, feederRelayRate, resolveReserveTarget } from "../economy/bank";
import { buildPoolAbsorbRate } from "./ConstructionCorp";

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
 * Below this banked storage the spend path has effectively nothing to relay - a
 * RARE drained/recovery state (owner 2026-07-24: "miners are more important than
 * feeders if we have NO energy, which is rare; the rest of the time feeder is
 * more important"). Below it the first feeder yields to income (miners rebuild);
 * at or above it the feeder is the linchpin and outranks the marginal miner.
 */
const FEEDER_INCOME_FIRST_FLOOR = 2000;

/**
 * The FIRST feeder's spawn value when energy is present. Above the miner band
 * (HarvestCorp: `100 + efficiency*0.5`, efficiency = net/rate*100 < 100, so
 * miners top out just under 150) so the linchpin outranks the marginal
 * producer - it unlocks consumption of energy already mined. It never WALLS
 * (blocking stays false), so topping the ladder cannot spiral the bank.
 */
const FEEDER_LINCHPIN_VALUE = 150;

/**
 * Per-source-link drain the feeder must be able to move core -> storage (spec 02
 * sole-operator floor). An owned-room source produces SOURCE_ENERGY_CAPACITY /
 * ENERGY_REGEN_TIME = 3000/300 = 10 e/t, and its link may double as a spec-26
 * DEPOSIT PORT receiving remote drops (DEPOSIT_PORT_HEADROOM = 30 e/t). Both
 * emerge at the core and must be banked by the feeder, or the core backs up and
 * source-link volleys strand (the spec-26 gridlock). A generous, cheap
 * over-estimate: at the parked 1-tile leg even 80 e/t is ~4 CARRY. Keep the 30
 * in sync with flowAdapter.DEPOSIT_PORT_HEADROOM.
 */
const PER_LINK_SOURCE_DRAIN = 10 + 30;

/**
 * ControllerFeederCorp fields the shuttle fleet (usually one feeder; more only
 * while a bank surplus is being drawn down) that relays storage -> controller input.
 */
/** Container-refill headroom the relay carries above the plan's controller
 * flow: input-container decay plus a small buffer so the stock never starves
 * between shuttle arrivals. */
export const FEEDER_STOCK_HEADROOM = 5;

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
export function feederRelayTarget(
  surplusRate: number,
  planFlow: number | undefined,
  banked: number,
  reserveTarget: number,
  constructionAbsorb = 0
): number {
  // CONSTRUCTION-FIRST, ABSORB-BOUNDED (owner 2026-07-21: "when construction
  // is around ... funnel energy to construction. Upgrading is secondary";
  // prod t72478939): with sites standing, the build set eats what it CAN
  // absorb (buildPoolAbsorbRate - the same projectAbsorbRate lens that sizes
  // the crew and the plan's construction sink) and the relay serves the REST
  // of the surplus, floored at the plan's post-construction controller
  // residual. The boolean form of this clamp treated 12 road sites (pool
  // absorb ~5 e/t) exactly like a 100k build-out: relay clamped to 7 while
  // surplus 115 stood and construction ate 0.47 e/t measured - the freed
  // energy BANKED (+20.18/t at 474k, 17x target). A build-out that absorbs
  // the whole draw floors the relay at the plan residual - the link-era
  // clamp, preserved. No sites -> the unclamped surplus draw stands.
  if (bankSurplusRate(banked, reserveTarget) > 0) {
    if (constructionAbsorb <= 0 || planFlow === undefined) return surplusRate;
    return Math.max(Math.min(surplusRate, planFlow + FEEDER_STOCK_HEADROOM), surplusRate - constructionAbsorb);
  }
  return planFlow !== undefined ? Math.min(surplusRate, planFlow + FEEDER_STOCK_HEADROOM) : surplusRate;
}

/**
 * The rate the feeder's BODY is sized to (owner 2026-07-22: "the feeder
 * seems way too large") - distinct from the RELAY TARGET above, which paces
 * how much the feeder moves over time. The body only needs to keep pace
 * with what the consumers can actually BURN: standing upgrader WORK x 1 e/t
 * with 1.5x headroom (fleet growth + stock building), floored at the plan's
 * controller flow so a mid-resize dip never starves the allocation. At the
 * link-fed distance 1 the old body sized to the full surplus VALVE (~110
 * e/t -> 11 carry, a 22-part creep) while the fleet burned ~40 - the valve
 * pacing is unchanged, the feeder just makes more trips with a body sized
 * from ACTUALS (sustainableConsumptionRate doctrine, applied to the relay).
 */
export function feederBodyRate(
  relayRate: number,
  planFlow: number | undefined,
  standingWork: number,
  banked: number,
  reserveTarget: number
): number {
  // SURPLUS regime only: the save-regime relay is already small (the
  // warchest trickle) and its sizing contract is pinned - a filling
  // warchest must see no behavior change.
  if (bankSurplusRate(banked, reserveTarget) <= 0) return relayRate;
  const burnCap = Math.max(planFlow ?? 0, standingWork * 1.5);
  return burnCap > 0 ? Math.min(relayRate, burnCap) : relayRate;
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
    // LINK ROUTER (spec 02 feeder-router, owner 2026-07-26): in a link-fed room
    // the feeder is the SOLE bidirectional operator of the core link - it LOADS
    // storage -> core to feed the controller relay AND DRAINS core -> storage to
    // bank source-link income and keep the core open for volleys. No walking
    // hauler touches the core (emergent kind selection - commissionsFromPlan
    // omits the carry corp for a link-served source), so nothing thrashes
    // against the feeder (t72595372). This fully owns the tick; the working/
    // reload machine below serves only walking (no controller-link) rooms.
    const ctrlLink = controllerLink(creep.room);
    const core = ctrlLink ? coreLink(creep.room) : null;
    if (ctrlLink && core && creep.room.storage && creep.room.storage.my) {
      this.runLinkRouter(creep, core, ctrlLink, creep.room.storage);
      return;
    }

    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) creep.memory.working = false;
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) creep.memory.working = true;

    if (creep.memory.working) {
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
   * The bidirectional core-link router (spec 02, owner 2026-07-26): the feeder
   * keeps the core link at ONE target level - the same level coreLinkLoadRoom
   * loads to (min of the income-reserve ceiling and the controller link's
   * headroom). Below it, LOAD storage -> core to feed the controller relay;
   * above it, DRAIN core -> storage to bank the source-link income/surplus so
   * volleys always find landing room. The two directions meet at the target and
   * never fight. Direction is chosen only while empty-handed so a trip never
   * flip-flops mid-carry. This is the empty direction the old code lacked - the
   * band-aid was a walking hauler draining the core (fault 2), which fought the
   * feeder's load direction. That hauler is gone (emergent kind selection), so
   * the feeder is the sole operator.
   */
  private runLinkRouter(creep: Creep, core: StructureLink, ctrlLink: StructureLink, storage: StructureStorage): void {
    const coreEnergy = core.store[RESOURCE_ENERGY];
    const capacity = coreEnergy + core.store.getFreeCapacity(RESOURCE_ENERGY);
    const ctrlFree = ctrlLink.store.getFreeCapacity(RESOURCE_ENERGY);
    const loadRoom = coreLinkLoadRoom(coreEnergy, capacity, ctrlFree);
    const drainAmount = coreLinkDrainAmount(coreEnergy, capacity, ctrlFree);
    const storageFree = storage.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0;

    // Decide direction ONLY when empty-handed: a half-loaded feeder always
    // finishes putting its load somewhere first, so it never flip-flops.
    if (creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.linkMode = drainAmount > 0 && storageFree > 0 ? "drain" : "load";
    }

    if (creep.memory.linkMode === "drain") {
      // EMPTY the core into the bank: withdraw the excess, then deposit it.
      if (creep.store[RESOURCE_ENERGY] > 0) {
        if (creep.pos.getRangeTo(storage.pos) > 1) {
          travelTo(creep, storage.pos, { range: 1, visualizePathStyle: { stroke: "#88ccff" } });
          return;
        }
        const moved = Math.min(creep.store[RESOURCE_ENERGY], storageFree);
        if (moved > 0 && creep.transfer(storage, RESOURCE_ENERGY) === OK) {
          this.recordProduction(moved);
          creep.memory.lastDeliver = { to: "storage-drain", amount: moved, tick: Game.time };
        }
        return;
      }
      if (drainAmount > 0) {
        if (creep.pos.getRangeTo(core.pos) > 1) {
          travelToBypass(creep, core.pos, { range: 1, visualizePathStyle: { stroke: "#88ccff" } });
          return;
        }
        // Pull only the EXCESS above target so the relay buffer stays staged -
        // over-draining would immediately re-load (a self-thrash).
        creep.withdraw(core, RESOURCE_ENERGY, Math.min(creep.store.getFreeCapacity(RESOURCE_ENERGY), drainAmount));
        return;
      }
      creep.memory.linkMode = "load"; // core is back at target: nothing to drain
    }

    // LOAD storage -> core to feed the controller relay (the original behavior).
    if (loadRoom <= 0) {
      // Relay staged. If income has since over-filled the core (drain pressure)
      // while we hold a load meant for it, bank the load rather than stalling
      // the core against volleys; else hold beside the core for the next top-up.
      if (drainAmount > 0 && creep.store[RESOURCE_ENERGY] > 0 && storageFree > 0) {
        if (creep.pos.getRangeTo(storage.pos) > 1) {
          travelTo(creep, storage.pos, { range: 1, visualizePathStyle: { stroke: "#88ccff" } });
          return;
        }
        creep.transfer(storage, RESOURCE_ENERGY);
        return;
      }
      if (creep.pos.getRangeTo(core.pos) > 2) travelTo(creep, core.pos, { range: 2 });
      return;
    }
    if (creep.store[RESOURCE_ENERGY] === 0) {
      // Fill from the bank first.
      if (creep.pos.getRangeTo(storage.pos) > 1) {
        travelTo(creep, storage.pos, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
        return;
      }
      creep.withdraw(storage, RESOURCE_ENERGY);
      return;
    }
    if (creep.pos.getRangeTo(core.pos) > 1) {
      travelToBypass(creep, core.pos, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
      return;
    }
    const moved = Math.min(creep.store[RESOURCE_ENERGY], loadRoom);
    if (creep.transfer(core, RESOURCE_ENERGY, moved) === OK) {
      this.recordProduction(moved);
      creep.memory.lastDeliver = { to: "core-link", amount: moved, tick: Game.time };
    }
  }

  /**
   * Energy/tick the feeder must be able to drain from the core link (spec 02
   * sole-operator floor): every link-served in-room source's income plus its
   * spec-26 deposit-port headroom. Zero for a room with no source links (the
   * core carries only the controller relay then). A cheap over-estimate; an
   * oversized feeder simply idles when the core is at target.
   */
  private coreDrainRate(room: Room): number {
    const core = coreLink(room);
    if (!core) return 0;
    let linkServed = 0;
    for (const src of room.find(FIND_SOURCES)) {
      if (sourceLink(src.pos, core.id)) linkServed++;
    }
    return linkServed * PER_LINK_SOURCE_DRAIN;
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

    // Balanced 1:1 body sized to sustain the relay. WALKING rooms (no link):
    // the storage sits by the spawn, so the spawn->controller distance
    // approximates the bank->controller leg. LINK-FED rooms (spec 24 rung 3)
    // are a PARKED post - the feeder stands adjacent to the storage and the
    // core link BOTH and never moves (owner 2026-07-22: "The feeder doesn't
    // move at all"), so its cycle is withdraw tick + transfer tick with zero
    // travel; carryPartsFor(rate, 1) would charge two phantom travel ticks
    // and double the body. The plan's feeder pricing reads the same lens
    // (infraSpawnLoad linkFedRoomCount).
    const linkFed = !!controllerLink(spawn.room);
    const distance = linkFed ? 1 : spawn.pos.getRangeTo(controller.pos);
    const PART_PAIR = 100; // CARRY + MOVE
    const maxCarry = Math.max(1, Math.min(Math.floor(ctx.energyCapacity / PART_PAIR), 25));
    // The relay serves the PLAN's controller flow, never the raw surplus
    // formula: when construction preempts the bank the controller floors at
    // ~2 e/t and relaying 115 into a full stock is 90+ wasted parts (owner
    // t72421124). No allocation known (old commission) -> formula unclamped.
    const reserveTarget = resolveReserveTarget(Memory.warchestTarget);
    const surplusRate = feederRelayRate(banked, reserveTarget);
    const planFlow = this.controllerAllocation;
    // ONE absorb lens with the upgraders AND the crew (owner 2026-07-21 +
    // prod t72478939): construction eats what it can absorb; the relay
    // serves the rest of the surplus, floored at the plan residual.
    const constructionAbsorb = buildPoolAbsorbRate(spawn.pos.roomName, spawn.pos);
    const relayRate = feederRelayTarget(surplusRate, planFlow, banked, reserveTarget, constructionAbsorb);
    // BODY sized to consumer burn, not the surplus valve (feederBodyRate -
    // owner: "the feeder seems way too large"). Standing WORK read from the
    // live upgrader fleet, the same actuals-first doctrine consumers use.
    let standingWork = 0;
    for (const name in Game.creeps) {
      const c = Game.creeps[name];
      if (c.memory.workType === "upgrade" && !c.spawning) standingWork += c.getActiveBodyparts(WORK);
    }
    const bodyRate = feederBodyRate(relayRate, planFlow, standingWork, banked, reserveTarget);
    // SOLE-OPERATOR DRAIN FLOOR (spec 02): the feeder is the ONLY creep that
    // empties the core link, so its body must move everything that emerges there
    // (link-served source income + spec-26 deposit-port inflow) to the bank, or
    // the core backs up and source-link volleys strand (the spec-26 gridlock).
    // Non-link rooms have no core drain, so this is 0 and the body is unchanged.
    const coreDrain = linkFed ? this.coreDrainRate(spawn.room) : 0;
    const effectiveBodyRate = Math.max(bodyRate, coreDrain);
    const neededCarry = Math.max(
      1,
      Math.ceil((linkFed ? parkedRelayCarry(effectiveBodyRate) : carryPartsFor(effectiveBodyRate, distance)) * 1.2)
    );
    const wantedFeeders = Math.ceil(neededCarry / maxCarry);
    const feeders = this.getFeeders().length;
    this.lastSizing = {
      tick: ctx.tick,
      gate: feeders >= wantedFeeders ? "staffed" : "demand",
      banked,
      hasMiner,
      relayRate,
      bodyRate,
      standingWork,
      ...(planFlow !== undefined ? { planFlow } : {}),
      surplusRate,
      ...(constructionAbsorb > 0 ? { constructionAbsorb } : {}),
      distance,
      ...(linkFed ? { linkFed: true } : {}),
      ...(coreDrain > 0 ? { coreDrain } : {}),
      neededCarry,
      wantedFeeders,
      feeders
    };
    if (feeders >= wantedFeeders) return [];
    const carry = Math.min(neededCarry, maxCarry);
    // The feeder is the LINCHPIN of the whole spend path (owner 2026-07-24:
    // "unless we have basically no energy, we always want the feeder; everything
    // else is optimized to rely on it"). The link relay, the upgrader's surplus
    // detection (bankedBehindFeeder), and the controller input election all
    // assume it exists - when its post goes DARK the upgraders go surplus-blind
    // and the bank rots (the E4 idle-capital coupling, audit t72553726: feeder 0
    // -> inflow 2 -> upgrader fleet decays 40->24 WORK -> 40k stranded). At the
    // old infra value (95) it lost the ranked spawn slot to the miner band
    // (125-147) and OSCILLATED. So with energy present the FIRST feeder outranks
    // the marginal producer (owner: "the rest of the time feeder is more
    // important" than miners) - ONE cheap body that UNLOCKS consumption of
    // energy already mined. When storage is DRAINED (banked <
    // FEEDER_INCOME_FIRST_FLOOR - the rare "NO energy" case) it yields to income
    // so miners rebuild first. It never front-runs a cold-start (the no-miner
    // gate only demands a feeder once income flows) and never WALLS (blocking
    // stays false). Additional feeders (surplus drawdown) stay infra-tier.
    const firstFeeder = feeders === 0;
    const drained = banked < FEEDER_INCOME_FIRST_FLOOR; // rare

    return [
      {
        buyerCorpId: this.id,
        role: "feeder",
        // First feeder with energy: above the miner band (the linchpin). First
        // feeder while DRAINED: below miners (income first). Additional feeders:
        // the old infra tier, just below the tender.
        value: firstFeeder ? (drained ? 90 : FEEDER_LINCHPIN_VALUE) : 95,
        blocking: false, // never walls: haulers feed the controller directly until it spawns
        // The first feeder also pierces holds/walls while its post is dark and a
        // real bank stands stranded behind it (the emergency lane, incident
        // t72499165 + the cold-start stream lesson) - a dark post is the E4
        // coupling's trigger.
        infrastructure: firstFeeder && banked >= 10_000,
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
