/**
 * @fileoverview LinkCorp - a LOCAL MOVER (type "moving") that relays
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
 * @module corps/LinkCorp
 */

import { SerializedSpawnAnchoredCorp, SpawnAnchoredCorp } from "./SpawnAnchoredCorp";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { FEEDER, FEEDER_DRAINED, FEEDER_LINCHPIN } from "../spawn/demandLadder";
import { Position } from "../types/Position";
import {
  CoreDepot,
  PortPost,
  portPosts,
  controllerLink,
  coreDepot,
  coreLink,
  coreInboundPending,
  coreLinkDrainAmount,
  coreLinkLoadRoom,
  controllerInputSpot,
  feederRelayStock,
  sourceLink
} from "./nodeEnergy";
import { travelTo, travelToBypass, travelToLane } from "./movement";
import { roomHasFlowMiner } from "./censusLens";
import { PORT_TENDER_CARRY } from "../economy/primitives";
import { buildTankerBody } from "../spawn/BodyBuilder";
import { stampControllerFeederRegime } from "./regimes";
import {
  CARRY_MOVE_PAIR_COST,
  SOURCE_RATE,
  carryPartsFor,
  depositPortHeadroom,
  maxCarryPairs,
  parkedRelayCarry,
  volleyServiceCarry
} from "../economy/primitives";
import { bankFedControllerRate, resolveReserveTarget } from "../economy/bank";

export interface SerializedLinkCorp extends SerializedSpawnAnchoredCorp {
  controllerAllocation?: number;
  /** Throughput meter (rolling ~1500t window, survives resets). */
  moveEnergy?: number;
  moveActive?: number;
  moveAlive?: number;
  moveSince?: number;
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
 * LinkCorp fields the shuttle fleet (usually one feeder; more only
 * while a bank surplus is being drawn down) that relays storage -> controller input.
 */
/** Container-refill headroom the relay carries above the plan's controller
 * flow: input-container decay plus a small buffer so the stock never starves
 * between shuttle arrivals. */
export const FEEDER_STOCK_HEADROOM = 5;

/**
 * The relay rate the feeder fleet is sized to sustain (pure, unit-tested).
 *
 * THE PLAN ALLOCATION IS THE VALVE (spec 38 phase B; owner 2026-07-31:
 * "incorporate the actual into the plan ... a single consistent framework",
 * completing the upgrader half's 2026-08-02 consolidation). The feeder
 * relays the plan's routed controller allocation plus the stock headroom -
 * in EVERY regime. The actuals (bank stock, construction claims) are plan
 * INPUTS now: the bank enters the solve as a transient source
 * (bankToTransientSource), construction competes as a sink in the same
 * ladder, and the sip floor is the controller sink's RESERVE
 * (controllerFloorRate, won by the reserve pre-pass before value greed) -
 * so reading the plan IS reading the actuals, one direction, no
 * side-channel.
 *
 * What died here (P-C, spec 38): the surplus-regime override that returned
 * the raw surplus formula (feederRelayRate = 15 + bankSurplusRate),
 * measured 89.69 relayed against 50.02 planned at t72681617 - a fleet the
 * plan never priced (P12 3.30x). It was born at prod t72455355, when the
 * parts ledger exhausted before the controller sink (allocated 2) while
 * 340k stood banked; phase A moved that floor INSIDE the plan, so the
 * override's precondition is impossible by construction (staged proof:
 * bank.test.ts "spec 38 acceptance"). The constructionAbsorb netting died
 * with it - the plan's allocation is already the post-construction
 * residual, netting it again double-counts (its own incident t72478939 was
 * an artifact of netting against the RAW formula).
 *
 * The t72421124 clamp (plan ~2 while construction preempts, no 90-part
 * feeder into a full stock) is now just... the law, not a special regime.
 *
 * No allocation (old commission, pre-first-solve): the surplus formula
 * stands as the legacy fallback.
 */
export function feederRelayTarget(surplusRate: number, planFlow: number | undefined): number {
  return planFlow !== undefined ? planFlow + FEEDER_STOCK_HEADROOM : surplusRate;
}

export class LinkCorp extends SpawnAnchoredCorp {
  /** The plan's controller-side flow (commission-owned, refreshed every round). */
  private controllerAllocation?: number;
  /**
   * THROUGHPUT METER (measured t72811683). `volleyServiceCarry()` floors the
   * body at 16 CARRY on the premise that it "clears one full LINK_CAPACITY
   * volley in ONE parked withdraw+transfer cycle" - i.e. ~400 e/t. The live
   * numbers refuse that: with ONE 16-CARRY feeder the core ran fill 178-233,
   * `hubClampShare` 0.28-0.30 and fleet `portWaitFrac` 0.228; with TWO
   * (32 CARRY, from the double-order this session fixed) it ran fill 91,
   * clamp 0.000, waitFrac 0.000. A 400 e/t body cannot be the binding
   * constraint on an 80 e/t drain, so the SIZING LAW is not what is wrong -
   * the EXECUTION is, and nothing measured it.
   *
   * So: energy actually moved, and the share of alive ticks it moved
   * anything. Throughput below the parked-cycle premise localises the gap to
   * the run loop (travel, mode flapping, waiting on the controller leg)
   * instead of leaving the constant to be guessed at a second time.
   */
  private moveEnergy = 0;
  private moveActive = 0;
  private moveAlive = 0;
  private moveSince = 0;

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("moving", nodeId, spawnId, customId);
  }

  /** The plan's controller allocation for this room - the relay's ceiling. */
  public setControllerAllocation(v: number): void {
    this.controllerAllocation = v;
  }

  /** The feeder posts AT the controller input, not the spawn - override the anchor. */
  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const controller = spawn?.room.controller;
    if (controller) return { x: controller.pos.x, y: controller.pos.y, roomName: controller.pos.roomName };
    return super.getPosition();
  }

  private getFeeders(): Creep[] {
    return this.creepsOfWorkType("feed", { includeSpawning: false });
  }

  /**
   * STAFFING lens for the DEMAND side - includes bodies still in the spawn.
   *
   * Measured t72811290: TWO 1600e feeders bought 48 ticks apart into this same
   * corp against `wantedFeeders: 1`. A feeder body is 32 parts, ~96 ticks in
   * the spawn, and while it builds `getFeeders()` (includeSpawning: false)
   * returns 0 - so the demand re-armed and bought a second one. F1 put the
   * feeder class at 0.086 p/t against 0.007 planned (12x) and infra spend at
   * 4.26 vs a 1.51 budget.
   *
   * That is the CLAUDE.md staffsPost trap verbatim - the demand side and the
   * work side must not read different counts - and the sibling of "recycling
   * counts as staffing ... excluding them double-orders". ClaimCorp and
   * ReservationCorp already carry both lenses; this one carried only the work
   * lens and used it for both jobs.
   *
   * The two lenses legitimately DIFFER in what they answer: work() needs
   * creeps that can act THIS TICK (a spawning body cannot relay), while the
   * demand needs "is one already on the way". One body coming IS one body
   * staffed.
   */
  public staffedFeeders(): number {
    return this.creepsOfWorkType("feed", { includeSpawning: true }).length;
  }

  public getCreepCount(): number {
    return this.getFeeders().length;
  }

  public work(tick: number): void {
    this.lastActivityTick = tick;
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;
    const room = spawn.room;
    // PORTS FIRST and independent: a port tender never touches the core link, so
    // it must not sit behind the feeder's own gates (a room with no controller
    // or no bank still has ports to drain).
    this.runPortPosts(room);
    const controller = room.controller;
    if (!controller) return;

    const depot = coreDepot(room);
    const feeders = this.getFeeders();
    // Signal the haulers: while a storage bank exists AND a feeder is alive to run
    // the last leg, controller-bound loads stop at the bank (CarryCorp defers to us).
    // If the feeder dies the flag clears and haulers resume delivering to the
    // controller directly, so a dead feeder never starves upgrading.
    stampControllerFeederRegime(room.memory, !!(room.storage && room.storage.my) && feeders.length > 0);

    if (tick - this.moveSince >= 1500) {
      this.moveEnergy = 0;
      this.moveActive = 0;
      this.moveAlive = 0;
      this.moveSince = tick;
    }
    for (const creep of feeders) {
      const before = creep.store[RESOURCE_ENERGY] ?? 0;
      this.runFeeder(creep, controller, depot);
      // Intents resolve at end of tick, so the store still reads pre-action
      // here; measure the DELTA against last tick's snapshot instead (creep
      // memory, so it survives a global reset like the duty meter does).
      const prev = (creep.memory as { feederLast?: number }).feederLast;
      if (prev !== undefined && prev !== before) {
        this.moveEnergy += Math.abs(before - prev);
        this.moveActive += 1;
      }
      (creep.memory as { feederLast?: number }).feederLast = before;
      this.moveAlive += 1;
    }
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
      // feederRelayStock is the NARROW staged-stock lens (shared home:
      // nodeEnergy, beside the upgraders' wide controllerSideStock - the
      // radii differ deliberately; see the lens's own rationale).
      if (feederRelayStock(controller, input.pos) >= CONTROLLER_FEED_TARGET) {
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
    // ARRIVALS-FIRST (spec 45 leg 2): a loaded/near-fire source link means a
    // volley wants this buffer THIS beat, so the target drops to 0 - stop
    // staging from storage into the landing zone, and PRE-drain what is
    // already there. One target level still drives both directions, so the
    // load/drain XOR symmetry and the phase-D valve law are untouched.
    const inbound = coreInboundPending(core.room, core);
    const loadRoom = coreLinkLoadRoom(coreEnergy, capacity, ctrlFree, inbound);
    const drainAmount = coreLinkDrainAmount(coreEnergy, capacity, ctrlFree, inbound);
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
   *
   * DERIVED FROM THE PORT'S OWN GEOMETRY, not a copied number. This read
   * `linkServed * (10 + 30)` with a docblock asking the next editor to "keep
   * the 30 in sync with flowAdapter.DEPOSIT_PORT_HEADROOM" - a manual coupling
   * that went stale the moment the flat cap was retired for the fire rate
   * (2026-08-06). The port's headroom is a function of ITS range to the core
   * and the feeder can see that geometry, so it asks the same primitive the
   * planner asks and the two cannot disagree again.
   *
   * Per link the drain is exactly what that link can PUSH into the core -
   * `SOURCE_RATE + depositPortHeadroom(range)` collapses to `LINK_CAPACITY /
   * range` wherever the fire rate clears the source rate. With no geometry
   * (harness paths) the headroom falls back to the conservative 30 and this
   * returns 10 + 30 per link, bit-identical to the constant it replaced.
   *
   * The floor is rarely what binds: since spec 45 the body also carries
   * `volleyServiceCarry(inboundSenders)` (2 senders = 32 CARRY), against which
   * even 100 e/t over the parked 1-tile leg is ~5 CARRY.
   */
  private coreDrainRate(room: Room): number {
    const core = coreLink(room);
    if (!core) return 0;
    let drain = 0;
    for (const src of room.find(FIND_SOURCES)) {
      const link = sourceLink(src.pos, core.id);
      if (!link) continue;
      // The source's own income, plus whatever remote deposit flow its link
      // can still fire on top of it - both emerge at the core and both must be
      // banked, or the core backs up and volleys strand (spec-26 gridlock).
      const range = typeof link.pos.getRangeTo === "function" ? link.pos.getRangeTo(core.pos) : undefined;
      drain += SOURCE_RATE + depositPortHeadroom(range, SOURCE_RATE);
    }
    return drain;
  }

  /**
   * Links that SEND INTO this room's core link: every link that is neither
   * the core nor the withdraw-only controller link - deposit ports and
   * source links alike, the same set LinkRunner loops as senders. Spec 45:
   * while any exist, volleys of up to LINK_CAPACITY land on the core and the
   * feeder must be able to clear one in a SINGLE parked cycle.
   */
  private inboundLinkSenderCount(room: Room): number {
    const core = coreLink(room);
    if (!core) return 0;
    const ctrl = controllerLink(room);
    return room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_LINK && s.id !== core.id && s.id !== (ctrl?.id ?? "")
    }).length;
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
  /**
   * The corp's demands: the FEEDER's (gated by bank/controller state) plus the
   * PORT tenders' (gated only by whether a port has a buffer). Appending here
   * rather than adding a second corp is what keeps the spec-39 demand surface
   * from growing - one owner, one demand site, two roles.
   */
  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    return [...this.feederDemands(ctx), ...this.portDemands(ctx)];
  }

  private feederDemands(ctx: SpawnDemandContext): SpawnDemand[] {
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
    const hasMiner = roomHasFlowMiner(room.name);
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
    const maxCarry = maxCarryPairs(ctx.energyCapacity);
    // THE PLAN ALLOCATION IS THE VALVE (spec 38 phase B): the relay serves the
    // plan's routed controller flow + stock headroom in every regime - the
    // surplus formula survives only as the legacy fallback for a commission
    // that carries no allocation. The body sizes to the SAME rate: relay
    // target and consumer burn (upgraderSizing reads the same allocation) are
    // one number now, so the old feederBodyRate actuals-clamp ("the feeder
    // seems way too large" - a body sized to a 110 e/t valve while consumers
    // burned 40) has nothing left to clamp.
    const reserveTarget = resolveReserveTarget(Memory.warchestTarget);
    const surplusRate = bankFedControllerRate(banked, reserveTarget);
    const planFlow = this.controllerAllocation;
    const relayRate = feederRelayTarget(surplusRate, planFlow);
    // SOLE-OPERATOR DRAIN FLOOR (spec 02): the feeder is the ONLY creep that
    // empties the core link, so its body must move everything that emerges there
    // (link-served source income + spec-26 deposit-port inflow) to the bank, or
    // the core backs up and source-link volleys strand (the spec-26 gridlock).
    // Non-link rooms have no core drain, so this is 0 and the body is unchanged.
    const coreDrain = linkFed ? this.coreDrainRate(spawn.room) : 0;
    const effectiveBodyRate = Math.max(relayRate, coreDrain);
    // VOLLEY-SERVICE FLOOR (spec 45, owner 2026-08-05): with inbound senders
    // on the core link the feeder is a SERVICE creep - it must clear a full
    // LINK_CAPACITY volley in ONE parked withdraw+transfer cycle, or it is
    // itself the network's clamp (measured: the throughput-sized 4C body
    // took ~8t per 800e volley against a ~7t arrival cadence; coreEmptyShare
    // 0.26, hubClampShare 0.50). Its idle between volleys is the price of
    // hauler duty. infraSpawnLoad prices the same floor (F1).
    const inboundSenders = linkFed ? this.inboundLinkSenderCount(spawn.room) : 0;
    // ONE VOLLEY PER SENDER, not one volley total (A/B t72819265). N senders
    // can land N volleys inside one drain window and a single creep serves
    // them serially - measured, 1 feeder at 16 CARRY clamped 0.268 while the
    // accidental 32 clamped 0.091, with the SINGLE feeder moving MORE per tick
    // (187.33 vs 131.28). Latency, not rate. `inboundSenders` was already
    // stamped at this decision site; it just was not read.
    const volleyFloor = volleyServiceCarry(inboundSenders);
    const neededCarry = Math.max(
      1,
      volleyFloor,
      Math.ceil((linkFed ? parkedRelayCarry(effectiveBodyRate) : carryPartsFor(effectiveBodyRate, distance)) * 1.2)
    );
    const wantedFeeders = Math.ceil(neededCarry / maxCarry);
    const feeders = this.staffedFeeders();
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
      ...(coreDrain > 0 ? { coreDrain } : {}),
      ...(volleyFloor > 0 ? { volleyFloor, inboundSenders } : {}),
      neededCarry,
      wantedFeeders,
      feeders,
      // Throughput vs the parked-cycle premise the volley floor assumes.
      ...(this.moveAlive > 0
        ? {
            movedPerTick: Math.round((this.moveEnergy / this.moveAlive) * 100) / 100,
            moveActiveFrac: Math.round((this.moveActive / this.moveAlive) * 1000) / 1000,
            moveMeterTicks: ctx.tick - this.moveSince
          }
        : {})
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
        why: "infra", // agenda label: DECLARED on every feeder demand, never derived from the role name (spec 35 phase D)
        // Ladder rungs (spawn/demandLadder.ts) - first feeder with energy:
        // above the miner band (the linchpin). First feeder while DRAINED:
        // below miners (income first). Additional feeders: the old infra
        // tier, just below the tender.
        value: firstFeeder ? (drained ? FEEDER_DRAINED : FEEDER_LINCHPIN) : FEEDER,
        // THE HEARTBEAT LANE (owner 2026-08-06, measured t72809037). The rung
        // above is inert without this: spawnPriority adds INCOME_TIER to
        // producers, so FEEDER_LINCHPIN's 150 was compared against 1_000_146
        // and the first feeder ranked below EVERY income demand - dead 190
        // ticks with 153,760 banked, rescued only by the 300-tick starvation
        // lift. Declared ONLY where the rung was written for: first feeder,
        // energy present. While DRAINED it stays off so income rebuilds first.
        linchpin: firstFeeder && !drained,
        blocking: false, // never walls: haulers feed the controller directly until it spawns
        // The first feeder also pierces holds/walls while its post is dark and a
        // real bank stands stranded behind it (the emergency lane, incident
        // t72499165 + the cold-start stream lesson) - a dark post is the E4
        // coupling's trigger.
        infrastructure: firstFeeder && banked >= 10_000,
        producesIncome: false,
        desiredCost: carry * CARRY_MOVE_PAIR_COST,
        minCost: Math.min(carry, 2) * CARRY_MOVE_PAIR_COST,
        since: 0,
        bodyParam: carry
      }
    ];
  }

  // =========================================================================
  // DEPOSIT PORTS (owner 2026-08-08: *"the link+tender+container can all be
  // ruled by the link corp"*). One corp owns the whole link network - core,
  // controller, and every deposit port - because those three are one machine:
  // the container is the mouth, the tender is the throat, the link is the pipe.
  // Splitting them across owners is how the port drain went missing at all (the
  // container had a placement rung, the link had a price, and nothing owned the
  // thing between them).
  // =========================================================================

  private getPortTenders(): Creep[] {
    return this.creepsOfWorkType("porttend", { includeSpawning: false });
  }

  /** A tile adjacent to BOTH the buffer and the link, so the creep withdraws and
   *  transfers from a standstill. */
  private postTile(post: PortPost): RoomPosition | null {
    const room = post.link.room;
    const terrain = room.getTerrain();
    let fallback: RoomPosition | null = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const x = post.buffer.pos.x + dx;
        const y = post.buffer.pos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        const pos = new RoomPosition(x, y, room.name);
        if (pos.getRangeTo(post.link.pos) > 1) continue;
        const blocked = room.lookForAt(LOOK_STRUCTURES, x, y).some(s => s.structureType !== STRUCTURE_ROAD);
        if (!blocked) return pos;
        fallback = fallback ?? pos;
      }
    }
    return fallback;
  }

  /**
   * Run the port tenders: park between buffer and link, and shuttle without
   * moving (withdraw + transfer are both legal in one tick). Kept OFF the
   * feeder's own path entirely - a port tender never touches the core link, so
   * the heartbeat cannot be slowed by port work.
   */
  private runPortPosts(room: Room): void {
    const posts = portPosts(room);
    const tenders = this.getPortTenders();
    if (posts.length === 0 || tenders.length === 0) return;
    tenders.forEach((creep, i) => {
      if (creep.spawning) return;
      const post = posts[i % posts.length];
      const stand = this.postTile(post);
      if (stand && !creep.pos.isEqualTo(stand)) {
        travelToLane(creep, stand, { range: 0, visualizePathStyle: { stroke: "#ffaa00" } });
      }
      // TRANSFER FIRST, then top up: draining into the link is the point, and a
      // creep refilled with nowhere to put its load just parks energy aboard a
      // body instead of leaving it where the haulers can see the free capacity.
      const carrying = creep.store[RESOURCE_ENERGY] ?? 0;
      const linkFree = post.link.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0;
      if (carrying > 0 && linkFree > 0 && creep.pos.getRangeTo(post.link.pos) <= 1) {
        creep.transfer(post.link, RESOURCE_ENERGY, Math.min(carrying, linkFree));
      }
      const free = creep.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0;
      const buffered = post.buffer.store[RESOURCE_ENERGY] ?? 0;
      if (free > 0 && buffered > 0 && creep.pos.getRangeTo(post.buffer.pos) <= 1) {
        creep.withdraw(post.buffer, RESOURCE_ENERGY, Math.min(free, buffered));
      }
    });
  }

  /** One tender per deposit port that HAS a buffer. Appended to the feeder's own
   *  demand, so no new demand SITE joins the spec-39 surface.
   *
   * COSTS ARE NOT OPTIONAL (incident t72865978). This demand shipped through an
   * `as SpawnDemand` cast with neither cost field, and every funding comparison
   * in the scheduler is a numeric `>=` against them - `x >= undefined` is false,
   * so the walk recorded gate "impossible" (the verdict for a body the RCL can
   * never build) forever, at the HEAD of both spawn queues, for 1804+ ticks.
   * `minCost > energyAvailable` was false too, so no `bank>=N` precondition was
   * published and both wedge instruments read benign (S3 "not a stall",
   * `classifySpawnIdle` "hold" = a CHOSEN wait). Meanwhile the plan routed
   * 80 e/t through the ports this body drains and priced its parts via
   * `portTenderSpawnLoad`. The seam in `collectDemandsMatching` now rejects a
   * cost-less demand outright so the class cannot recur silently.
   */
  private portDemands(ctx: SpawnDemandContext): SpawnDemand[] {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];
    const posts = portPosts(spawn.room);
    const staffed = this.getPortTenders().length;
    if (posts.length === 0 || staffed >= posts.length) return [];
    // Ask for exactly the body the PLAN prices (PORT_TENDER_PARTS is
    // `buildTankerBody(PORT_TENDER_CARRY, ..., false)`'s shape), so F1/F2
    // compare the port-tender line against a like-for-like actual. The
    // executor builds through the same builder off `bodyParam`.
    const desired = buildTankerBody(PORT_TENDER_CARRY, ctx.energyCapacity, false);
    if (desired.cost <= 0) return []; // room cannot hold even 1 CARRY+MOVE
    return [
      {
        buyerCorpId: this.id,
        role: "porttender",
        // DECLARED, never derived (spec 35 phase D): the drain beside the depot
        // movers is infra, and `agendaWhy` would otherwise fall through to
        // "consume" - which is what the live agenda printed.
        why: "infra",
        value: 78,
        blocking: false,
        infrastructure: true,
        producesIncome: false,
        desiredCost: desired.cost,
        // The feeder's floor, for the feeder's reason: a PARKED shuttle
        // transfers its whole store every tick, so 2 CARRY already covers a
        // port's ~47 e/t fire rate many times over. A cheap min lets the infra
        // lane pierce a hold promptly - the point of the drain - and in a
        // storage-backed room the grant is the full desired body anyway.
        minCost: Math.min(desired.cost, Math.min(PORT_TENDER_CARRY, 2) * CARRY_MOVE_PAIR_COST),
        since: 0,
        bodyParam: PORT_TENDER_CARRY
      }
    ];
  }

  public serialize(): SerializedLinkCorp {
    return {
      ...super.serialize(),
      controllerAllocation: this.controllerAllocation,
      moveEnergy: this.moveEnergy,
      moveActive: this.moveActive,
      moveAlive: this.moveAlive,
      moveSince: this.moveSince
    };
  }

  public deserialize(data: SerializedLinkCorp): void {
    super.deserialize(data);
    this.controllerAllocation = data.controllerAllocation;
    this.moveEnergy = data.moveEnergy ?? 0;
    this.moveActive = data.moveActive ?? 0;
    this.moveAlive = data.moveAlive ?? 0;
    this.moveSince = data.moveSince ?? 0;
  }
}
