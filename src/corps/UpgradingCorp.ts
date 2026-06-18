/**
 * @fileoverview UpgradingCorp - Manages upgrader creeps.
 *
 * Upgraders pick up energy near the controller and upgrade it.
 *
 * @module corps/UpgradingCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { controllerInputSpot, controllerParkingTiles } from "./nodeEnergy";
import { travelToBypass } from "./movement";
import { driveRecycle } from "./recycle";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { buildUpgraderBody } from "../spawn/BodyBuilder";
import { CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD } from "./CorpConstants";
import { Position } from "../types/Position";
import { SinkAllocation } from "../flow/FlowTypes";
import { effectiveLife } from "../economy/primitives";
import { ChainScene, CorpEconomics, travelTicksPerTile } from "./economics";

/** Safety bound on upgraders per controller (prevents a swarm if an allocation goes stale). */
const UPGRADER_COUNT_CAP = 8;

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
    // Track working state for energy pickup
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
      // Upgrade en route if already in range - no idle ticks while repositioning.
      if (creep.memory.working && creep.pos.getRangeTo(controller) <= 3) this.tryUpgrade(creep, controller);
      return;
    }
    // No parking computed (degenerate layout): fall back to camping within range.
    if (!park && creep.pos.getRangeTo(controller) > 3) {
      creep.moveTo(controller, { visualizePathStyle: { stroke: "#ffffff" } });
      return;
    }

    if (creep.memory.working) {
      this.tryUpgrade(creep, controller);
    } else {
      this.drawFromInput(creep, controller);
    }
  }

  /** Upgrade the controller in place, recording the WORK consumed. */
  private tryUpgrade(creep: Creep, controller: StructureController): void {
    if (creep.pos.getRangeTo(controller) > 3) return;
    if (creep.upgradeController(controller) === OK) {
      const workParts = creep.getActiveBodyparts(WORK);
      this.recordConsumption(workParts);
      this.recordProduction(workParts);
    }
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
   * Get the spawn ID this corp spawns from.
   */
  public getSpawnId(): string {
    return this.spawnId;
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
   * Project the economics of upgrading the scene's controller with the energy
   * allocated to this corp: an upgrader sized to that energy, costed over the
   * life left after walking out to the controller. It is a pure consumer, so it
   * reports cost only (no throughput).
   */
  public project(scene: ChainScene): CorpEconomics {
    const allocated = this.sinkAllocation?.allocated ?? 0;
    if (allocated <= 0 || !scene.controllerPos) return { costPerTick: 0, throughput: 0, spawnPartsPerTick: 0 };

    // Virtual planning estimate: the upgrader is a pure consumer (throughput 0),
    // so this only sizes its cost/part footprint for the planner. Keep the
    // conservative CARRY-heavier estimate here - the realized body (built WORK-heavy
    // in getSpawnDemand) is cheaper per WORK, so this never UNDER-budgets a source.
    const body = buildUpgraderBody(scene.energyCapacity, Math.max(1, Math.ceil(allocated)), "mobile");
    if (body.cost === 0) return { costPerTick: 0, throughput: 0, spawnPartsPerTick: 0 };

    const travel = scene.dist(scene.spawnPos, scene.controllerPos) * travelTicksPerTile(scene.energyCapacity);
    const usefulLife = effectiveLife(travel);
    return { costPerTick: body.cost / usefulLife, throughput: 0, spawnPartsPerTick: body.body.length / usefulLife };
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
    const allocated = spawn ? this.effectiveAllocated(spawn.room, base) : base;

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
    const current = this.getCreepCount();
    if (current >= targetCount) return [];

    const remainingWork = allocated - current * affordableWork;
    const desiredWork = Math.max(1, Math.min(affordableWork, Math.ceil(remainingWork)));
    const desired = buildUpgraderBody(ctx.energyCapacity, desiredWork, "containerFed");
    // Runt policy: a runt permanently occupies one of the few parking slots and the
    // controller under-consumes its allocation for that creep's whole 1500-tick life.
    // A SCALING upgrader (current > 0) therefore holds out for its full intended
    // share - there is always energy at the input tile to feed it, so waiting for a
    // proper body beats fielding a runt forever. Only the FIRST upgrader may spawn
    // small (down to 1 WORK) so the controller starts upgrading immediately at cold
    // start instead of waiting for the spawn to fill a full body.
    const minWork = current === 0 ? 1 : desiredWork;
    const min = buildUpgraderBody(ctx.energyCapacity, minWork, "containerFed");
    if (min.cost === 0) return []; // room cannot afford even a minimal upgrader

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
        // additional upgraders are scaling capacity (non-blocking).
        blocking: current === 0,
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
