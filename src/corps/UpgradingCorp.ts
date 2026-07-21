/**
 * @fileoverview UpgradingCorp - Manages upgrader creeps.
 *
 * Upgraders pick up energy near the controller and upgrade it.
 *
 * @module corps/UpgradingCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { controllerInputSpot, controllerParkingTiles, controllerSideStock } from "./nodeEnergy";
import { travelToBypass } from "./movement";
import { driveRecycle } from "./recycle";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { buildUpgraderBody } from "../spawn/BodyBuilder";
import { CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD } from "./CorpConstants";
import { Position } from "../types/Position";
import { SinkAllocation } from "../flow/FlowTypes";
import { effectiveLife, staffsPost, sustainableConsumptionRate } from "../economy/primitives";
import { bankSurplusRate, feederRelayRate } from "../economy/bank";
import { FEEDER_STOCK_HEADROOM } from "./ControllerFeederCorp";
import { buildPoolAbsorbRate } from "./ConstructionCorp";
import { travelTicksPerTile } from "./economics";

/** Safety bound on upgraders per controller (prevents a swarm if an allocation goes stale). */
const UPGRADER_COUNT_CAP = 8;

/** Rolling window for the WORK-utilization meter (spawn-meter cadence). */
export const UPGRADE_METER_WINDOW = 1500;

/**
 * One creep-tick observation for the WORK-utilization meter (pure seam,
 * spawn-meter pattern): `fired` on OK, `dry` on ERR_NOT_ENOUGH_RESOURCES
 * (the starved-buffer tick an endpoint stock read hides). Windows roll
 * after UPGRADE_METER_WINDOW ticks.
 */
export function tallyUpgradeAttempt(
  meter: NonNullable<Memory["upgradeMeter"]>,
  room: string,
  tick: number,
  rc: number
): void {
  let w = meter[room];
  if (!w || tick - w.t0 >= UPGRADE_METER_WINDOW) {
    w = meter[room] = { t0: tick, ticks: 0, fired: 0, dry: 0 };
  }
  w.ticks++;
  if (rc === OK) w.fired++;
  else if (rc === ERR_NOT_ENOUGH_RESOURCES) w.dry++;
}

/**
 * Tighter ceiling at RCL <= 2: the tiny spawn network can't both staff a big
 * upgrader camp AND keep full-size haulers running, so a swarm of upgraders
 * starves the supply chain into a runt death-spiral. A handful ramps to RCL3
 * fastest, after which the full UPGRADER_COUNT_CAP applies. See getSpawnDemand.
 */
const RCL2_UPGRADER_CAP = 3;

/**
 * How many upgraders to field (pure, unit-tested). Sized to consume the controller
 * allocation (1 WORK ~ 1 e/tick) at the affordable body size, but bounded by:
 *  - UPGRADER_COUNT_CAP   - hard safety bound against a stale/huge allocation;
 *  - the RCL ceiling      - RCL2_UPGRADER_CAP while the spawn network is tiny
 *                           (controllerLevel <= 2), the full cap above that. An
 *                           unknown level (no controller in view) imposes no RCL
 *                           ceiling, so allocation alone drives the count;
 *  - parkingTiles         - never field more upgraders than can ring the input
 *                           spot and actually work (0 is treated as "unknown").
 * Always at least 1 so the controller is never wholly abandoned.
 */
export function upgraderTargetCount(
  allocated: number,
  affordableWork: number,
  parkingTiles: number,
  controllerLevel: number | undefined
): number {
  const rclCap = (controllerLevel ?? 99) <= 2 ? RCL2_UPGRADER_CAP : UPGRADER_COUNT_CAP;
  const byAllocation = Math.ceil(allocated / Math.max(1, affordableWork));
  return Math.max(1, Math.min(UPGRADER_COUNT_CAP, rclCap, parkingTiles || UPGRADER_COUNT_CAP, byAllocation));
}

/**
 * The energy/tick the upgrader fleet is sized to consume (pure, unit-tested):
 * STOCK-GROUNDED sizing (owner doctrine 2026-07-10) - the stock at the work
 * site drained over a creep generation, plus what measurably flows in - capped
 * by the plan's allocation so upgraders never out-eat what the solver routes.
 *
 * The inflow term is the anti-downgrade trickle (2)... UNLESS the room's bank
 * is in SURPLUS and a feeder is actively relaying it (bankedBehindFeeder is
 * the storage's energy when `controllerFeederActive`, null otherwise). Then
 * the relay rate (economy/bank.feederRelayRate - the same primitive that
 * sizes the feeder fleet) is the real inflow, and the fleet scales up to the
 * plan. This is the consumption half of the spec-03 surplus draw: while the
 * warchest FILLS the sip keeps the bank accumulating (the pinned save
 * regime); once it is FULL the windfall doctrine applies - "a windfall ->
 * consumers scale up to eat it" - which a feeder-capped 2000 input stock
 * otherwise hides (measured live: 100k banked, upgraders sized to ~3.3 e/t).
 */
export function upgraderSizing(
  planAllocated: number,
  stock: number | null,
  bankedBehindFeeder: number | null,
  constructionAbsorb = 0
): { allocated: number; inflow: number | null } {
  if (stock === null) return { allocated: planAllocated, inflow: null };
  const surplus = bankedBehindFeeder !== null && bankSurplusRate(bankedBehindFeeder) > 0;
  // In a construction-free SURPLUS the plan is NOT a cap (prod t72448020:
  // planAllocated pinned at the reserve 2 by a parts-exhausted fill while
  // stock 2000 + relay 115 + 234k banked stood ready - the goal-plan cap
  // held the burn at 2 e/t forever; consumers are "sized from ACTUAL stock
  // at their work site, never from the goal plan"). The NOW-walk arbitrates
  // spawn time, so an actuals-sized demand cannot displace producers.
  //
  // CONSTRUCTION-FIRST, ABSORB-BOUNDED (owner 2026-07-21: "upgrading is
  // secondary to construction ... an investment in our future upgrading
  // abilities"; prod t72478939): the build set eats what it CAN absorb
  // (constructionAbsorb = buildPoolAbsorbRate, the same projectAbsorbRate
  // lens that sizes the crew and the plan's construction sink) and the
  // fleet eats the REMAINING share of the surplus as its inflow - the same
  // relay feederRelayTarget will actually run, so the chain cannot fight
  // itself. The boolean form of this clamp treated 12 road sites (absorb
  // ~5 e/t) exactly like a 100k build-out: allocated pinned at the plan
  // residual 2 while surplus 115 stood - the freed energy BANKED (+20.18/t
  // at 474k, 17x target). Only a build-out that absorbs the whole draw
  // (share <= planAllocated + headroom) returns the plan's residual clamp -
  // the link-era behavior, preserved. While the warchest FILLS, the
  // plan-capped sip remains the pinned save regime.
  const share = surplus ? feederRelayRate(bankedBehindFeeder!) - constructionAbsorb : 0;
  const unclamped = surplus && (constructionAbsorb <= 0 || share > planAllocated + FEEDER_STOCK_HEADROOM);
  const inflow = unclamped
    ? share
    : surplus
      ? planAllocated + FEEDER_STOCK_HEADROOM
      : 2;
  const sustainable = sustainableConsumptionRate(stock, inflow);
  return { allocated: Math.max(2, unclamped ? sustainable : Math.min(planAllocated, sustainable)), inflow };
}

export function upgraderAllocation(
  planAllocated: number,
  stock: number | null,
  bankedBehindFeeder: number | null,
  constructionAbsorb = 0
): number {
  return upgraderSizing(planAllocated, stock, bankedBehindFeeder, constructionAbsorb).allocated;
}

/**
 * Serialized state specific to UpgradingCorp
 */
export interface SerializedUpgradingCorp extends SerializedCorp {
  spawnId: string;
  targetUpgraders: number;
  /** Flow-based sink allocation (from FlowEconomy) */
  sinkAllocation?: SinkAllocation;
}

/**
 * UpgradingCorp manages upgrader creeps that upgrade the controller.
 *
 * Upgraders:
 * - Stay near the controller
 * - Pick up dropped energy or withdraw from containers
 * - Upgrade the controller
 */
export class UpgradingCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Target number of upgraders (computed during planning) */
  private targetUpgraders = 2;

  /**
   * Flow-based sink allocation from FlowEconomy.
   * Specifies the energy rate allocated to this controller.
   */
  private sinkAllocation: SinkAllocation | null = null;

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("upgrading", nodeId, customId);
    this.spawnId = spawnId;
  }

  /**
   * Get active creeps assigned to this corp.
   */
  private getActiveCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && creep.memory.workType === "upgrade" && !creep.spawning) {
        creeps.push(creep);
      }
    }
    return creeps;
  }

  /**
   * Plan upgrading operations. Called periodically to compute targets.
   * Adjusts target upgraders based on controller level and downgrade risk.
   */
  public plan(tick: number): void {
    super.plan(tick);

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn?.room.controller) {
      this.targetUpgraders = 1;
      return;
    }

    const controller = spawn.room.controller;
    const rcl = controller.level;

    let target = rcl <= 2 ? 1 : 2;

    if (controller.ticksToDowngrade < CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD * 0.3) {
      target = Math.max(target, 3);
    }

    this.targetUpgraders = target;
  }

  /**
   * Get the controller position as the corp's location.
   */
  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn && spawn.room.controller) {
      const ctrl = spawn.room.controller;
      return { x: ctrl.pos.x, y: ctrl.pos.y, roomName: ctrl.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /**
   * Main work loop - run upgrader creeps.
   */
  public work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const room = spawn.room;
    const controller = room.controller;
    if (!controller) return;

    const creeps = this.getActiveCreeps();
    this.flagExcessForRecycling(creeps, spawn);
    for (const creep of creeps) {
      if (creep.memory.recycling) {
        driveRecycle(creep, spawn);
      } else {
        this.runUpgrader(creep, room, controller);
      }
    }
  }

  /**
   * Run behavior for an upgrader creep.
   * Upgraders are stationary - they stay near the controller and only pick up nearby energy.
   */
  private runUpgrader(creep: Creep, room: Room, controller: StructureController): void {
    // `working` is kept for external readers/telemetry, but the parked action
    // below is driven directly off the store: a container-fed upgrader tops up
    // AND upgrades in the SAME tick (see the parked block), so it never needs the
    // collect/deposit oscillation the flag used to gate.
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
    }

    // PARKED MODEL: each upgrader owns a fixed tile ringing the one dedicated
    // input spot (the controller container, or the shared drop pile before it is
    // built). It walks there ONCE, then withdraws from that single input and
    // upgrades in place - never chasing scattered drops, never shuffling into
    // another upgrader. This is what lets many upgraders consume the delivered
    // energy without blocking each other or idling on a fetch cycle.
    const park = this.parkingTileFor(creep, controller);
    if (park && !creep.pos.isEqualTo(park)) {
      // travelToBypass so an upgrader can swap through an already-parked sibling on
      // the way to its own tile instead of stalling in the cramped controller ring.
      travelToBypass(creep, park, { range: 0, visualizePathStyle: { stroke: "#ffffff" } });
      // Upgrade en route if it has energy and is already in range - no idle WORK
      // ticks while repositioning.
      if (creep.store[RESOURCE_ENERGY] > 0 && creep.pos.getRangeTo(controller) <= 3) this.tryUpgrade(creep, controller);
      return;
    }
    // No parking computed (degenerate layout): fall back to camping within range.
    if (!park && creep.pos.getRangeTo(controller) > 3) {
      creep.moveTo(controller, { visualizePathStyle: { stroke: "#ffffff" } });
      return;
    }

    // Parked at the input: refill and upgrade in the SAME tick so the buffer never
    // goes dry (withdraw/pickup and upgradeController are independent intents - the
    // canonical static-upgrader idiom), but do NOT withdraw every tick. Each
    // withdraw/pickup intent costs ~0.2 CPU, so sipping a few energy every tick
    // wastes it fleet-wide. Refill just-in-time: only when the buffer can no longer
    // cover a full WORK cycle next tick (energy < 2x the per-tick burn). The top-up
    // lands THIS tick, so a full workParts still fires every tick while draws batch
    // into one every several ticks. The old oscillation (working ? upgrade : draw)
    // instead went fully dry each cycle and spent a whole tick refilling with the
    // WORK parts idle (~11% throughput on a WORK-heavy body; measured live
    // 2026-07-17). A buffer too small to hold two cycles necessarily draws every
    // tick - unavoidable to stay fed. drawFromInput itself issues no intent when the
    // input is dry, so a starved upgrader spends no CPU either.
    const workParts = Math.max(1, creep.getActiveBodyparts(WORK));
    if (creep.store[RESOURCE_ENERGY] < 2 * workParts && creep.store.getFreeCapacity() > 0) {
      this.drawFromInput(creep, controller);
    }
    this.tryUpgrade(creep, controller);
  }

  /** Upgrade the controller in place, recording the WORK produced. */
  private tryUpgrade(creep: Creep, controller: StructureController): void {
    if (creep.pos.getRangeTo(controller) > 3) return;
    const rc = creep.upgradeController(controller);
    if (rc === OK) {
      const workParts = creep.getActiveBodyparts(WORK);
      this.recordProduction(workParts);
    }
    // WORK-utilization meter, tallied where the intent resolves (prod
    // t72482220: burn 48.7 of ~100 e/t standing WORK with the stock
    // endpoint full - supply gap vs idling was unmeasurable).
    tallyUpgradeAttempt((Memory.upgradeMeter = Memory.upgradeMeter ?? {}), controller.pos.roomName, Game.time, rc);
  }

  /**
   * Draw from the SINGLE dedicated input spot (container/link, else the shared
   * drop pile at that tile). The upgrader is parked within range 1 of it, so this
   * never moves it.
   *
   * If the input is dry the upgrader simply WAITS on its tile - it does NOT chase
   * scattered drops. Chasing was the RCL2 oscillation: the creep would leave its
   * park tile for a stray pile, then parkingTileFor would march it back next tick,
   * and it never settled long enough to actually upgrade. Standing put keeps it in
   * upgrade range and on its withdraw tile for the moment energy lands.
   */
  private drawFromInput(creep: Creep, controller: StructureController): void {
    const input = controllerInputSpot(controller);
    if (input.structure && (input.structure as StructureContainer).store[RESOURCE_ENERGY] > 0) {
      creep.withdraw(input.structure, RESOURCE_ENERGY);
      return;
    }
    // The pile lands on the input tile but a parked upgrader stands range 1 from it;
    // scan range 1 so it can pick up the shared pile (and any of its own slop).
    const pile = creep.pos
      .findInRange(FIND_DROPPED_RESOURCES, 1, { filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0 })
      .sort((a, b) => b.amount - a.amount)[0];
    if (pile) creep.pickup(pile);
  }

  /**
   * Assign (and cache) this upgrader a stable parking tile ringing the input
   * spot. New upgraders take the first free slot; existing ones keep theirs as
   * long as it is still a valid parking tile.
   */
  private parkingTileFor(creep: Creep, controller: StructureController): RoomPosition | null {
    const input = controllerInputSpot(controller);
    const tiles = controllerParkingTiles(controller, input.pos);
    if (tiles.length === 0) return null;

    const key = (p: { x: number; y: number }): string => `${p.x},${p.y}`;
    const cached = creep.memory.upgradeSpot as { x: number; y: number } | undefined;
    if (cached && tiles.some(t => t.x === cached.x && t.y === cached.y)) {
      return new RoomPosition(cached.x, cached.y, controller.pos.roomName);
    }
    const taken = new Set<string>();
    for (const other of this.getActiveCreeps()) {
      if (other.name === creep.name) continue;
      const s = other.memory.upgradeSpot as { x: number; y: number } | undefined;
      if (s) taken.add(key(s));
    }
    const free = tiles.find(t => !taken.has(key(t))) ?? tiles[0];
    creep.memory.upgradeSpot = { x: free.x, y: free.y };
    return free;
  }

  /**
   * Get number of active upgrader creeps.
   */
  public getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  /**
   * Creeps (including spawning ones) that still staff the controller post for
   * demand purposes: incumbents inside their replacement lead time are
   * excluded (see staffsPost) so successors spawn build + walk ticks early.
   */
  private countStaffing(walkTicks: number): number {
    let count = 0;
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId !== this.id || creep.memory.workType !== "upgrade") continue;
      if (staffsPost(creep.ticksToLive, creep.body?.length ?? 0, walkTicks)) count++;
    }
    return count;
  }

  /**
   * Get the spawn ID this corp spawns from.
   */
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

  /**
   * True if the room already has a real flow hauler in the field (corpId
   * "hauling-..."), i.e. the mining->spawn delivery loop is closed. Bootstrap
   * jacks (which also move energy) are deliberately excluded - see the
   * supply-before-demand gate in getSpawnDemand.
   */
  private roomHasHauler(room: Room): boolean {
    for (const creep of room.find(FIND_MY_CREEPS)) {
      const memory = creep.memory;
      if (memory.workType === "haul" && memory.corpId?.startsWith("hauling-")) return true;
    }
    return false;
  }

    /**
   * Declare this corp's spawn demand for the scheduler.
   *
   * The upgrader is what drives RCL progress, so its demand is blocking when no
   * upgrader exists. Its value comes from the flow solution's controller-sink
   * priority, and it is sized to the allocated energy rate (but can be spawned
   * small and scaled up). It does not produce income - the scheduler's
   * wait-for-blocking logic is what lets it accumulate energy against a steady
   * trickle of mining demand.
   */
  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const controller = spawn?.room.controller;

    // SUPPLY BEFORE DEMAND: don't fund flow upgraders until the room's delivery
    // loop exists (a real hauler in the field). At cold start the first miner
    // spawns and then travels to its source; while it is not yet mining,
    // withMinerPrecedence holds that source's haulers back, leaving the blocking
    // first upgrader (and its non-blocking siblings) as the top *eligible* demand.
    // They then drain the spawn's starting energy before the hauler is ever
    // eligible, and the room freezes: the spawn empties with no hauler to refill
    // it and no way to afford one (the cold-start delivery deadlock). Gating
    // upgraders on an established hauler reserves that energy for the hauler that
    // closes the supply loop; the controller is kept alive meanwhile by the
    // bootstrap corp's anti-downgrade upgrading. Bootstrap jacks do NOT count -
    // we want their deliveries to fund the first hauler, not be spent upgrading.
    if (spawn && !this.roomHasHauler(spawn.room)) return [];

    // Energy/tick the controller is allocated; that is the WORK the upgraders
    // must total to consume it (1 energy/tick per WORK part). Without an
    // allocation, ask for a minimal upgrader to keep the controller alive. While
    // a source is reserved for the builder, the allocation is scaled to the
    // sources still feeding the core (see effectiveAllocated) so we don't field
    // upgraders the remaining supply can't feed.
    const base = this.sinkAllocation && this.sinkAllocation.allocated > 0 ? this.sinkAllocation.allocated : 2;
    const planAllocated = spawn ? this.effectiveAllocated(spawn.room, base) : base;
    // STOCK-GROUNDED sizing (owner doctrine 2026-07-10): the upgrader fleet is
    // sized to the energy ACTUALLY at the controller side - stock drained over
    // a creep lifetime plus the measured-shape inflow - not to the goal plan's
    // allocation (see upgraderAllocation). Under-delivery keeps upgraders
    // minimal (spawn capacity stays on the supply side, macro: income first);
    // a full warchest behind an active feeder relay scales them up to be
    // spent. No visible controller (harness stubs, degenerate rooms): the
    // stock is unmeasurable, so trust the plan rather than clamping to the floor.
    const stock = spawn && controller ? this.controllerSideStock(controller) : null;
    const bankedBehindFeeder =
      spawn && spawn.room.memory.controllerFeederActive && spawn.room.storage?.my
        ? spawn.room.storage.store.energy ?? 0
        : null;
    // ONE absorb lens with the feeder AND the crew (owner 2026-07-21 + prod
    // t72478939): construction eats what it can absorb; the fleet is sized
    // to the remaining share of the surplus.
    const constructionAbsorb = spawn?.pos?.roomName ? buildPoolAbsorbRate(spawn.pos.roomName, spawn.pos) : 0;
    const { allocated, inflow } = upgraderSizing(planAllocated, stock, bankedBehindFeeder, constructionAbsorb);

    // One upgrader can only afford so many WORK parts at the current capacity;
    // a single small upgrader cannot consume a whole source. Size the COUNT to
    // the allocation, so consumption scales with supply (this is what lets a
    // second source actually help instead of being wasted).
    const affordableWork = Math.max(1, buildUpgraderBody(ctx.energyCapacity, 99, "containerFed").workParts);
    // Cap the count as a safety bound: should a stale/over-large allocation slip
    // through, we never spawn a swarm of upgraders. The plan keeps `allocated`
    // bounded by real supply in normal operation. ALSO bounded by the parking
    // tiles around the controller's input spot: an upgrader with nowhere to park
    // would just block another, so never field more than can stand and work.
    const parking = controller
      ? controllerParkingTiles(controller, controllerInputSpot(controller).pos).length
      : UPGRADER_COUNT_CAP;
    const targetCount = upgraderTargetCount(allocated, affordableWork, parking, controller?.level);

    // Decision-symmetry stamp (spec 14 phase 2): record the inputs THIS sizing
    // read, for telemetry to export verbatim. Answers "why is the upgrader N
    // WORK" from a capture: plan vs stock vs inflow vs what won.
    // `demand`/`cap` join the stamp because prod t72455355 showed targetCount 6
    // with ONE fielded upgrader and NO agenda entry - which of the exits below
    // swallowed the demand (and under which energyCapacity) was invisible in
    // the capture. The verdict names the exit; never guess twice.
    // WORK-utilization window (Memory.upgradeMeter, tallied in tryUpgrade):
    // workUtil = OK share of attempted creep-ticks, dryShare = starved-buffer
    // share. Reads the same window the intents wrote - never recomputed from
    // stock/burn (prod t72482220's invisible half).
    const meterW = spawn?.pos?.roomName ? Memory.upgradeMeter?.[spawn.pos.roomName] : undefined;
    this.lastSizing = {
      tick: ctx.tick,
      planAllocated,
      stock,
      banked: bankedBehindFeeder,
      inflow,
      allocated,
      targetCount,
      parking,
      cap: ctx.energyCapacity,
      construction: constructionAbsorb > 0,
      ...(constructionAbsorb > 0 ? { constructionAbsorb } : {}),
      ...(meterW && meterW.ticks > 0
        ? {
            workUtil: +(meterW.fired / meterW.ticks).toFixed(3),
            dryShare: +(meterW.dry / meterW.ticks).toFixed(3),
            meterTicks: meterW.ticks
          }
        : {}),
      demand: "demanded"
    };
    // Delivery-aware staffing (staffsPost): an upgrader inside its replacement
    // lead time (build + walk to the controller) keeps working but no longer
    // counts, so its successor spawns early enough for the controller's
    // allocation to be consumed without a per-generation gap. getRangeTo is a
    // straight-line UNDERestimate of the real walk on wall-heavy maps; the
    // lead's 1.5x + 10 pad absorbs modest detours, and a path-true distance
    // is a known sharpening once one is cheaply available here.
    const ctrlWalkTicks =
      spawn && controller ? spawn.pos.getRangeTo(controller.pos) * travelTicksPerTile(ctx.energyCapacity) : 0;
    const current = this.countStaffing(ctrlWalkTicks);
    this.lastSizing.staffing = current;
    if (current >= targetCount) {
      this.lastSizing.demand = "staffed";
      return [];
    }
    // Physical swarm cap (mirrors CarryCorp): replacement overlap may field one
    // extra body per expiring incumbent, never more - parking tiles are few.
    if (this.getCreepCount() >= targetCount * 2) {
      this.lastSizing.demand = "swarm-cap";
      return [];
    }

    const remainingWork = allocated - current * affordableWork;
    const desiredWork = Math.max(1, Math.min(affordableWork, Math.ceil(remainingWork)));
    const desired = buildUpgraderBody(ctx.energyCapacity, desiredWork, "containerFed");
    // Runt policy: a runt permanently occupies one of the few parking slots and the
    // controller under-consumes its allocation for that creep's whole 1500-tick life.
    // A SCALING upgrader (current > 0) therefore holds out for its full intended
    // share - there is always energy at the input tile to feed it, so waiting for a
    // proper body beats fielding a runt forever. Only the FIRST upgrader may spawn
    // small (down to 1 WORK) so the controller starts upgrading immediately at cold
    // start instead of waiting for the spawn to fill a full body. "None exists"
    // means none in ANY form: getCreepCount() misses a mid-spawn first upgrader
    // (getActiveCreeps excludes spawning), and countStaffing misses an expiring
    // incumbent - either alone would let a runt sneak in while the controller
    // is in fact covered.
    const anyUpgrader = current > 0 || this.getCreepCount() > 0;
    const minWork = anyUpgrader ? desiredWork : 1;
    const min = buildUpgraderBody(ctx.energyCapacity, minWork, "containerFed");
    if (min.cost === 0) {
      this.lastSizing.demand = "unaffordable";
      return []; // room cannot afford even a minimal upgrader
    }
    this.lastSizing.demandMin = min.cost;

    return [
      {
        buyerCorpId: this.id,
        role: "upgrader",
        // Spawn priority is decoupled from the controller's ROUTING value (~50,
        // which keeps construction ranked above it). Consuming the energy the
        // plan budgets for upgrading is as essential as the producers/haulers that
        // supply it - otherwise producers win the queue forever and the budgeted
        // upgraders only trickle in via anti-starvation aging, so a second source
        // is mined and wasted. Rank them alongside haulers.
        value: 90,
        // The first upgrader is blocking (controller would otherwise stall);
        // additional upgraders are scaling capacity (non-blocking). Any-form
        // count: a lead-time replacement is not "the controller stalled".
        blocking: !anyUpgrader,
        // Excluded live incumbents make this a replacement: it must HOLD
        // (mustFund) or cheap streams starve it until the incumbent dies.
        replacement: this.getCreepCount() > current,
        producesIncome: false,
        desiredCost: desired.cost,
        minCost: min.cost,
        since: 0,
        bodyParam: desiredWork,
        bodyStrategy: "containerFed"
      }
    ];
  }

  // ===========================================================================
  // FLOW INTEGRATION
  // ===========================================================================

  /**
   * Scale the raw energy allocation down to the sources still feeding the core
   * economy. While the builder has a whole source reserved (its haulers stand
   * down - see CarryCorp.yieldsToBuild), only the remaining sources deliver to
   * the spawn/controller. Sizing upgrading to the full allocation then fields
   * more upgraders than that reduced supply can feed: they sit starved at the
   * controller while the spawn (fed by the same shrunken supply) can't refill,
   * which in turn keeps the lone remaining miner a runt that can't regrow.
   * Scaling the target to the core's source share lets the spawn keep its fill,
   * the miner regrow, and the single source become "plenty" - the economy
   * rebalances around the build instead of starving for it.
   */
  /**
   * Energy ACTUALLY available at the controller's work site: the input
   * container/storage plus ground piles around the input spot. This is the
   * "2000 in a storage by the controller" the fleet should be sized to -
   * primitive piles and proper structures obey the same principle.
   */
  private controllerSideStock(controller: StructureController): number {
    // Shared lens (nodeEnergy.controllerSideStock): the telemetry room ledger
    // reads the SAME function, so the dashboard number is the decision's number.
    return controllerSideStock(controller);
  }

  private effectiveAllocated(room: Room, base: number): number {
    if (!room.memory.dedicatedBuildSourceId) return base;
    const total = room.find(FIND_SOURCES).length || 1;
    return (base * Math.max(0, total - 1)) / total;
  }

  /**
   * Shed the smallest upgrader when the fleet's total WORK over-shoots what the
   * (build-aware) allocation can actually feed - the "recycle if needed" half of
   * the rebalance. Only sheds when retiring the runt still leaves us at or above
   * the target, so a correctly-sized fleet is never disturbed and we can't thrash
   * below target. The retired creep walks to the spawn and recycles, returning
   * its body energy to the economy that now needs it.
   *
   * Scoped to the dedicated-build rebalance only: without a reserved build source
   * the upgrade target equals the full allocation (effectiveAllocated is a no-op),
   * so this is exactly the situation the recycle is for. Firing it more broadly
   * churned upgraders against the normal fallback target and stole spawn ticks
   * from a second source's miner during the cold ramp.
   */
  private flagExcessForRecycling(creeps: Creep[], spawn: StructureSpawn): void {
    if (!spawn.room.memory.dedicatedBuildSourceId) return; // only rebalance during a dedicated build
    if (spawn.spawning) return; // don't compete with an in-progress spawn
    if (creeps.some(c => c.memory.recycling)) return; // one at a time
    if (creeps.length === 0) return;

    const base = this.sinkAllocation && this.sinkAllocation.allocated > 0 ? this.sinkAllocation.allocated : 2;
    const target = this.effectiveAllocated(spawn.room, base);

    let smallest: Creep | null = null;
    let smallestWork = Infinity;
    let totalWork = 0;
    for (const c of creeps) {
      const w = c.getActiveBodyparts(WORK);
      totalWork += w;
      if (w < smallestWork) {
        smallestWork = w;
        smallest = c;
      }
    }
    if (smallest && totalWork - smallestWork >= target) smallest.memory.recycling = true;
  }

  /**
   * Set the sink allocation from FlowEconomy.
   * This determines how much energy should flow to upgrading.
   */
  public setSinkAllocation(allocation: SinkAllocation): void {
    this.sinkAllocation = allocation;
    // Dynamically adjust target upgraders based on allocated energy
    // Each upgrader with ~3 WORK parts uses about 3 energy/tick
    const workPerUpgrader = 3;
    this.targetUpgraders = Math.max(1, Math.ceil(allocation.allocated / workPerUpgrader));
  }

  /**
   * Get the current sink allocation (if set by FlowEconomy).
   */
  public getSinkAllocation(): SinkAllocation | null {
    return this.sinkAllocation;
  }

  /**
   * Check if this corp has a flow-based allocation.
   */
  public hasFlowAllocation(): boolean {
    return this.sinkAllocation !== null;
  }

  /**
   * Get the allocated energy rate from flow solution.
   */
  public getAllocatedEnergyRate(): number {
    return this.sinkAllocation?.allocated ?? 0;
  }

  /**
   * Budgeted energy/tick: the controller allocation the plan routed here. Matches
   * recordProduction's unit (WORK consumed ~ 1 energy/tick per WORK). 0 when
   * unallocated, excluding the corp from variance.
   */
  public budgetedRate(): number {
    return this.sinkAllocation?.allocated ?? 0;
  }

  /**
   * Get the demanded energy rate from flow solution.
   */
  public getDemandedEnergyRate(): number {
    return this.sinkAllocation?.demand ?? 0;
  }

  /**
   * Get the priority from flow solution.
   */
  public getFlowPriority(): number {
    return this.sinkAllocation?.priority ?? 60; // Default controller priority
  }

  /**
   * Serialize for persistence.
   */
  public serialize(): SerializedUpgradingCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      targetUpgraders: this.targetUpgraders,
      sinkAllocation: this.sinkAllocation ?? undefined
    };
  }

  /**
   * Deserialize from persistence.
   */
  public deserialize(data: SerializedUpgradingCorp): void {
    super.deserialize(data);
    this.targetUpgraders = data.targetUpgraders || 2;
    this.sinkAllocation = data.sinkAllocation ?? null;
  }
}

/**
 * Create an UpgradingCorp for a room.
 */
export function createUpgradingCorp(room: Room, spawn: StructureSpawn): UpgradingCorp {
  const nodeId = `${room.name}-upgrading`;
  return new UpgradingCorp(nodeId, spawn.id);
}
