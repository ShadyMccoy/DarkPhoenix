/**
 * @fileoverview UpgradingCorp - Manages upgrader creeps.
 *
 * Upgraders pick up energy near the controller and upgrade it.
 *
 * @module corps/UpgradingCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { blankDutyHistogram, recordDutyTick } from "../telemetry/dutyHistogram";
import { roomHasFlowHauler } from "./censusLens";
import { controllerInputSpot, controllerParkingTiles, controllerSideStock } from "./nodeEnergy";
import { travelToBypass } from "./movement";
import { driveRecycle, worthABody } from "./recycle";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { buildUpgraderBody } from "../spawn/BodyBuilder";
import { Position } from "../types/Position";
import { SinkAllocation } from "../flow/FlowTypes";
import { CREEP_LIFETIME, WARTIME_BACKLOG_THRESHOLD, staffsPost, travelTicksPerTile } from "../economy/primitives";
import { bankSurplusRate, resolveReserveTarget } from "../economy/bank";
import { CONTROLLER_STARVE_FLOOR } from "./haulPolicy";
import { buildPoolAbsorbRate, buildPoolBacklog } from "./constructionLedger";

/** Safety bound on upgraders per controller (prevents a swarm if an allocation goes stale). */
const UPGRADER_COUNT_CAP = 8;

/** Rolling window for the WORK-utilization meter (spawn-meter cadence: one creep generation). */
export const UPGRADE_METER_WINDOW = CREEP_LIFETIME;

/**
 * Rooms whose meter this HEAP has already tallied. A fresh heap (global
 * reset - every deploy) forces a window roll on each room's first tally:
 * a Memory-persisted window SPANNING a deploy poisons every reader with
 * pre-deploy weighting (measured t72744628: workUtil 0.999 / X1 0.10 read
 * healthy across a window straddling the 4b deploy while the post-deploy
 * truth was burn 18 of 57 standing WORK - the stale meter cost the whole
 * acceptance read). The duty HISTOGRAM still survives the roll, as on any
 * roll. Exported reset is a TEST HOOK only.
 */
let meterRoomsSeenThisHeap = new Set<string>();
export function resetUpgradeMeterHeapMarker(): void {
  meterRoomsSeenThisHeap = new Set();
}

/**
 * One creep-tick observation for the WORK-utilization meter (pure seam,
 * spawn-meter pattern): `fired` on OK, `dry` on ERR_NOT_ENOUGH_RESOURCES
 * (the starved-buffer tick an endpoint stock read hides). Windows roll
 * after UPGRADE_METER_WINDOW ticks, and on the first tally of a fresh heap
 * (see meterRoomsSeenThisHeap).
 */
export function tallyUpgradeAttempt(
  meter: NonNullable<Memory["upgradeMeter"]>,
  room: string,
  tick: number,
  rc: number
): void {
  let w = meter[room];
  const freshHeap = !meterRoomsSeenThisHeap.has(room);
  meterRoomsSeenThisHeap.add(room);
  if (!w || freshHeap || tick - w.t0 >= UPGRADE_METER_WINDOW) {
    // The duty HISTOGRAM survives the window roll (spec 40-B): percentiles
    // need shape across regimes, and the roll is exactly when a mean resets
    // its amnesia. Sub-windows keep closing into the same buckets.
    const hist = w?.hist;
    w = meter[room] = { t0: tick, ticks: 0, fired: 0, dry: 0, ...(hist ? { hist } : {}) };
  }
  w.ticks++;
  if (rc === OK) w.fired++;
  else if (rc === ERR_NOT_ENOUGH_RESOURCES) w.dry++;
  // Spec 40-B: the same per-tick observation feeds the percentile histogram -
  // a mean over bimodal duty hid the border-bounce 37x defect for hours; the
  // buckets show mass at both ends where the mean shows 0.5.
  if (!w.hist) w.hist = blankDutyHistogram();
  recordDutyTick(w.hist, rc === OK);
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
 * Zero allocation fields zero (danger-gated floor re-arms it via the plan).
 */
export function upgraderTargetCount(
  allocated: number,
  affordableWork: number,
  parkingTiles: number,
  controllerLevel: number | undefined
): number {
  // ZERO allocation fields ZERO upgraders (owner 2026-08-04, the danger-gated
  // floor): the old "always at least 1 so the controller is never wholly
  // abandoned" was the count-side half of the constant trickle. When the
  // downgrade timer runs low the PLAN's floor re-arms the allocation and the
  // count follows - one valve, no runtime guard.
  if (allocated <= 0) return 0;
  const rclCap = (controllerLevel ?? 99) <= 2 ? RCL2_UPGRADER_CAP : UPGRADER_COUNT_CAP;
  const byAllocation = Math.ceil(allocated / Math.max(1, affordableWork));
  return Math.max(1, Math.min(UPGRADER_COUNT_CAP, rclCap, parkingTiles || UPGRADER_COUNT_CAP, byAllocation));
}

/**
 * Is the fleet's remaining WORK gap worth a SPAWN PURCHASE (owner 2026-08-05:
 * "With the amount of work why do we even need 8 spots at all? We can make
 * creeps big enough to avoid that constraint")?
 *
 * The owner's arithmetic is the point. At RCL7 capacity a containerFed
 * upgrader packs **39 WORK for 4,450e in 50 parts**, so a 60.21 allocation
 * wants TWO bodies (39 + 21) - and `upgraderTargetCount` computes exactly 2.
 * The parking ring never binds at that size; it only binds on a fleet made
 * of runts.
 *
 * And runts are what the corp was buying. The order size is the REMAINING
 * gap with no floor, so once the fleet is near its allocation the gap is a
 * 2-6 WORK sliver and the corp spends a body on it - a body that then holds
 * a parking slot for its whole 1500-tick life. Measured t72804439: 4 bodies
 * carrying 58 WORK (one ~39 plus three ~6-WORK slivers) where two bodies
 * would have carried 60, with "recycled why: runt-upsize 83%" in the same
 * window naming the churn that follows.
 *
 * This is the upgrader's version of the even-share treadmill the haulers
 * were cured of on 2026-08-03, so it takes the SAME predicate -
 * corps/recycle.worthABody - rather than a second rule that could drift
 * from it: a deficit under HALF a body share is not worth a purchase, it
 * rides to EOL, which re-sizes for free.
 *
 * Sizing to the GAP is kept (it is what makes the second body 21 rather than
 * a wasteful full 39); only the sliver PURCHASE goes.
 *
 * BOOTSTRAP IS EXEMPT, exactly as on the hauler side ("Bootstrap keeps every
 * crank - escape velocity, cee0 doctrine"). A pre-storage room cannot build
 * big bodies at all (800 capacity affords 6 WORK), so the sliver rule there
 * would abandon ~10% of the allocation permanently instead of the ~4% it
 * leaves at RCL7 - and early RCL progress is exactly what buys the capacity
 * that makes big bodies possible. Maturity is the SAME lens the haulers use:
 * the room is storage-backed.
 */
export function upgraderWorthABody(remainingWork: number, affordableWork: number, mature = true): boolean {
  if (!mature) return true; // bootstrap: close every gap, escape velocity first
  return worthABody(remainingWork, affordableWork);
}

/**
 * The physical swarm cap: how many upgrader bodies may stand at once (pure,
 * unit-tested). The cap exists for REPLACEMENT OVERLAP - one extra body per
 * expiring incumbent - and its own reason is physical: "parking tiles are
 * few". So the bound it wants is the parking ring, and `targetCount * 2` is
 * only the overlap allowance for a fleet that is already big enough.
 *
 * THE DEADLOCK IT FIXES (measured t72804439, the first clean month-cadence
 * window): targetCount comes from `affordableWork`, the body the room COULD
 * build at full energyCapacity (~30 WORK at 5600). Bodies are actually built
 * at the energy AVAILABLE when the spawn fires - ~14.5 WORK in that window,
 * with "recycled why: runt-upsize 83%" confirming it. So the fleet reached
 * targetCount*2 = 4 bodies carrying 58 WORK against a 60.21 allocation:
 * NOT satisfied (the count-vs-capacity invariant one gate above says so),
 * yet capped from ever ordering the body that would close it. The controller
 * took 27.32 e/t of its 60.21 budget (P7 0.66x) while the residual banked at
 * +14.83 e/t and the parking ring stood 8 wide with 4 tiles empty.
 *
 * A WORK-SHORT fleet is therefore bounded by PARKING, not by headcount:
 * extra bodies there are not a swarm, they are the compensation for
 * undersized ones, and targetCount is already parking-bounded so this can
 * never exceed what the ring holds. A fleet whose WORK covers its allocation
 * keeps the tight 2x overlap cap - a stale or over-large allocation still
 * cannot buy a swarm, which is what the cap was built to prevent.
 */
export function upgraderSwarmCap(
  targetCount: number,
  parkingTiles: number,
  fieldedWork: number,
  allocated: number
): number {
  const overlap = targetCount * 2;
  if (fieldedWork >= allocated) return overlap;
  // Parking 0 means "unknown" (the same convention upgraderTargetCount uses),
  // so it must never strand replacement below the overlap allowance.
  return Math.max(overlap, parkingTiles || 0);
}

/**
 * Is the standing fleet DONE - both enough bodies and enough WORK to burn the
 * allocation (pure, unit-tested)?
 *
 * The count alone is not enough, and CarryCorp has carried the matching
 * invariant since the runt-fleet fix (`current >= targetHaulers &&
 * fieldedCarry >= carryNeeded`) with the reason in its comment: under energy
 * pressure bodies spawn at the floor, so the planned COUNT can be reached
 * while the fielded CAPACITY still falls short of the post. The upgrader is
 * the same post with the same failure mode.
 *
 * Measured live (t72706408): `allocated 75.098`, `targetCount 2`,
 * `staffing 3`, `demand "staffed"` - and **41 WORK** standing. The three
 * bodies were built in the trough of the bank cycle, when the allocation was
 * the anti-downgrade sip; once the valve reopened to 74.64 e/t they satisfied
 * the count gate and NO full-size body was ever ordered. The fleet stayed
 * stuck for a creep generation while the plan asked for 140 e/t, the spawn
 * idled 14% of the window (55% of that "no demand") and the bank climbed
 * +25.88 e/t to 159,463. P7 read 0.22x - the worst of the session.
 *
 * This is also the asymmetry in the bank saw-tooth (ledger OSC): the fleet
 * over-shoots freely on the down-stroke but cannot re-grow on the up-stroke,
 * because small survivors hold the count gate shut.
 */
export function upgraderFleetSatisfied(
  current: number,
  targetCount: number,
  fieldedWork: number,
  allocated: number
): boolean {
  return current >= targetCount && fieldedWork >= allocated;
}

/**
 * The energy/tick the upgrader fleet is sized to consume.
 *
 * THE PLAN ALLOCATION IS THE VALVE (owner 2026-08-02: *"we had a valve for the
 * upgrader consumer sizing that was independent of the plan allocation.
 * However, realized that the plan allocation IS the valve. That other valve
 * might've been good in the short term, but it should be removed entirely and
 * consolidated behind the plan."*).
 *
 * What was removed: a stock-grounded valve that sized the fleet from the work
 * site's stock drained over a creep generation, with `feederRelayRate` as its
 * inflow - a SECOND drain rate computed independently of the controller
 * allocation the solver had just routed. It existed because the plan
 * UNDER-STATED (prod t72448020: planAllocated pinned at the reserve 2 by a
 * parts-exhausted fill while 234k sat banked), and bypassing the plan was the
 * short-term fix.
 *
 * By 2026-08-02 it had inverted and was throttling BELOW a plan that no longer
 * under-states - the very failure it was built to prevent, sign flipped:
 *
 *     tick          plan says   valve allowed
 *     t72717545       79.11         2.00
 *     t72721419       66.31        40.46
 *     t72722670       81.19        47.70
 *
 * That is CLAUDE.md's trap by the letter - the second patch on a mechanism
 * means the mechanism is the bug - and it is why the controller variance would
 * not close: the plan routed 81 and the consumer was built to eat 48.
 *
 * So sizing is the plan and nothing else. If the plan is wrong the fix belongs
 * IN THE PLAN, where one number can be audited rather than two disagreeing
 * quietly. Wartime relegation is gone with it: the plan's controller sink
 * already relegates on the same backlog lens, and it "moved no energy" only
 * because a stock-sized fleet ignored it. One valve, one place.
 *
 * The bank survives for ONE job, and it is not sizing: FINANCING. Whether the
 * spawn walk should wait to afford a full-size body (`surplus` -> holdToFund,
 * incident t72503018) is a different question from how much the fleet should
 * burn. Conflating the two is what produced two valves in the first place.
 */
export function upgraderSizing(
  planAllocated: number,
  financing: { bankedBehindFeeder: number | null; reserveTarget: number } | null = null
): { allocated: number; inflow: number; surplus: boolean } {
  // ONE VALVE (owner 2026-08-04, danger-gated floor): the fleet follows the
  // plan's allocation exactly - the anti-downgrade response lives in the
  // PLAN's floor (armed only when the downgrade timer is low), never as a
  // runtime clamp that burns a constant trickle the plan didn't allocate.
  const allocated = Math.max(0, planAllocated);
  const surplus =
    financing != null &&
    financing.bankedBehindFeeder !== null &&
    bankSurplusRate(financing.bankedBehindFeeder, financing.reserveTarget) > 0;
  // There is no longer a second rate to report: the plan IS the inflow the
  // fleet is sized against. Kept in the stamp so a capture still answers "what
  // did this decision read" with one number instead of none.
  return { allocated, inflow: allocated, surplus };
}

export function upgraderAllocation(planAllocated: number): number {
  return upgraderSizing(planAllocated).allocated;
}

/**
 * The storage energy the upgrader fleet may size against as bank-relayed inflow
 * - or null when the relay is not effectively operating. This is the DURABLE
 * form of the feeder signal, and the fix for the upgrader body flap (incident
 * t72571505): the single, non-blocking feeder dies and respawns every ~N
 * ticks, and gating `bankedBehindFeeder` SOLELY on the transient
 * `controllerFeederActive` flag tore the upgrader body down to the
 * anti-downgrade sip on EVERY feeder death and rebuilt it on every respawn
 * (measured: inflow flapping 2<->115, the body flapping w49<->w3, ~3 excess
 * upgrader respawns per 2808t on a spawn-bound 0.97-util colony - pure churn,
 * and the w3 windows halved RCL delivery).
 *
 * The maintained controller buffer is the durable evidence the relay is running
 * (across a feeder gap the haulers deliver directly - CarryCorp.shouldBankControllerLoad,
 * "a dead feeder never starves upgrading"), so ride the gap out exactly as the
 * haulers do, off the SAME buffer floor - one lens, two readers. Only genuine
 * starvation (buffer drained below the floor AND no feeder) drops the bank from
 * view; a bank that falls below its reserve is handled downstream by `surplus`.
 */
export function bankBehindFeeder(params: {
  /** The owned storage's energy, or null when there is no owned storage bank. */
  storageEnergy: number | null;
  /** A live feeder is relaying storage -> controller this tick. */
  feederActive: boolean;
  /** Energy staged at the controller input right now (container/link + piles). */
  controllerInputStock: number;
  /** Override the starvation floor (defaults to {@link CONTROLLER_STARVE_FLOOR}). */
  starveFloor?: number;
}): number | null {
  if (params.storageEnergy === null) return null;
  const relayOperating =
    params.feederActive || params.controllerInputStock >= (params.starveFloor ?? CONTROLLER_STARVE_FLOOR);
  return relayOperating ? params.storageEnergy : null;
}

/**
 * Serialized state specific to UpgradingCorp
 */
export interface SerializedUpgradingCorp extends SerializedCorp {
  spawnId: string;
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
    for (const creep of creeps) {
      if (creep.memory.recycling) {
        driveRecycle(creep, spawn);
      } else {
        this.runUpgrader(creep, controller);
      }
    }
  }

  /**
   * Run behavior for an upgrader creep.
   * Upgraders are stationary - they stay near the controller and only pick up nearby energy.
   */
  private runUpgrader(creep: Creep, controller: StructureController): void {
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
      // EN-ROUTE FEED (P7, live t72744628+: a 39-WORK upgrader stood at range
      // 1 of a 729-energy controller link with store 0 - this branch never
      // drew, so a creep that hasn't won its exact tile STARVED BESIDE THE
      // SUPPLY while bypass-shuffling for its park; burn ran 18 of 57
      // standing WORK and the whole link relay sat in the matching low
      // equilibrium, banking the plan's 58 e/t controller allocation
      // instead). Withdraw is a different action group from movement, so
      // drawing while repositioning costs nothing; drawFromInput no-ops
      // out of range.
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) this.drawFromInput(creep, controller);
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
    const room = controller.room as Room;
    const isRoad = (p: { x: number; y: number }): boolean =>
      typeof room.lookForAt === "function" &&
      room.lookForAt(LOOK_STRUCTURES, p.x, p.y).some(s => s.structureType === STRUCTURE_ROAD);
    const taken = new Set<string>();
    for (const other of this.getActiveCreeps()) {
      if (other.name === creep.name) continue;
      const s = other.memory.upgradeSpot as { x: number; y: number } | undefined;
      if (s) taken.add(key(s));
    }
    const cached = creep.memory.upgradeSpot as { x: number; y: number } | undefined;
    if (cached && tiles.some(t => t.x === cached.x && t.y === cached.y)) {
      // OFF-ROAD HOP (owner 2026-07-22: standing workers stand off the
      // roads): a spot cached in the road-blind era stays "valid", so a
      // parked upgrader would plug a delivery lane for its whole life. If
      // the cached tile is a road and a NON-road slot is genuinely free,
      // drop the cache and fall through to assignment (which sorts off-road
      // first) - one hop, then the new cache is off-road and this never
      // fires again. No shuffle: the hop only ever targets an UNTAKEN slot.
      const hop = isRoad(cached) && tiles.some(t => !taken.has(key(t)) && !isRoad(t));
      if (!hop) return new RoomPosition(cached.x, cached.y, controller.pos.roomName);
      delete creep.memory.upgradeSpot;
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
  private countStaffing(walkTicks: number): { count: number; work: number } {
    let count = 0;
    let work = 0;
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId !== this.id || creep.memory.workType !== "upgrade") continue;
      if (!staffsPost(creep.ticksToLive, creep.body?.length ?? 0, walkTicks)) continue;
      count += 1;
      // The fleet's real burn capacity, not its headcount - see
      // upgraderFleetSatisfied for why the two must both be checked.
      // Spawning-aware (audit t72941602, third instance of the in-flight-body
      // hole): an assembling upgrader has no ACTIVE parts, so it counted
      // toward the headcount while contributing 0 WORK - the work side of
      // upgraderFleetSatisfied stayed unmet and the demand re-fired at every
      // free spawn for the whole build (live: 7 fielded against target 3).
      work += creep.spawning
        ? (creep.body ?? []).filter(p => p.type === WORK).length
        : creep.getActiveBodyparts(WORK);
    }
    return { count, work };
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
    if (spawn && !roomHasFlowHauler(spawn.room)) return [];

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
    // DURABLE feeder-relay verdict (bankBehindFeeder, incident t72571505): the
    // bank is in view whenever a feeder is alive OR the controller buffer still
    // holds - a transient feeder death no longer recycles the upgrader body to
    // the sip and back (haulers cover the gap directly, same buffer floor the
    // hauler redirect rides). Solely gating on controllerFeederActive flapped
    // inflow 2<->115 and the body w49<->w3 for 170k+ ticks.
    const bankedBehindFeeder =
      spawn && spawn.room.storage?.my
        ? bankBehindFeeder({
            storageEnergy: spawn.room.storage.store.energy ?? 0,
            feederActive: !!spawn.room.memory.controllerFeederActive,
            controllerInputStock: stock ?? 0
          })
        : null;
    // ONE absorb lens with the feeder AND the crew (owner 2026-07-21 + prod
    // t72478939): construction eats what it can absorb; the fleet is sized
    // to the remaining share of the surplus.
    const constructionAbsorb = spawn?.pos?.roomName ? buildPoolAbsorbRate(spawn.pos.roomName, spawn.pos) : 0;
    const reserveTarget = resolveReserveTarget(Memory.warchestTarget);
    // WARTIME (spec 33 physical relegation, t72598913): a meaningful build
    // backlog stands, so relegate this fleet to the anti-downgrade sip and let
    // the surplus the link delivers fund building instead. Same backlog lens
    // (buildPool, WARTIME_BACKLOG_THRESHOLD) the plan's controller sink
    // relegates on - the two shift together (coherent ladder, not an isolated
    // nudge). Read only with a real home room (harness stubs skip it).
    const wartime =
      !!spawn?.pos?.roomName && buildPoolBacklog(spawn.pos.roomName) >= WARTIME_BACKLOG_THRESHOLD;
    // ONE VALVE: the plan's controller allocation. The bank rides along only as
    // a FINANCING verdict (holdToFund), never as a second sizing rate.
    const { allocated, inflow, surplus } = upgraderSizing(planAllocated, {
      bankedBehindFeeder,
      reserveTarget
    });

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
      ...(wartime ? { wartime: true } : {}),
      ...(meterW && meterW.ticks > 0
        ? {
            workUtil: +(meterW.fired / meterW.ticks).toFixed(3),
            dryShare: +(meterW.dry / meterW.ticks).toFixed(3),
            meterTicks: meterW.ticks
          }
        : {}),
      ...(surplus ? { hold: true } : {}),
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
    const { count: current, work: fieldedWork } = this.countStaffing(ctrlWalkTicks);
    this.lastSizing.staffing = current;
    // The fleet's real burn capacity joins the stamp: "3 creeps but 41 WORK
    // against a 75 e/t allocation" is the whole diagnosis, and headcount alone
    // hid it for a full creep generation (t72706408).
    this.lastSizing.fieldedWork = fieldedWork;
    if (upgraderFleetSatisfied(current, targetCount, fieldedWork, allocated)) {
      this.lastSizing.demand = "staffed";
      return [];
    }
    // Physical swarm cap (mirrors CarryCorp): replacement overlap may field one
    // extra body per expiring incumbent - but a WORK-SHORT fleet is bounded by
    // the PARKING ring instead, or the undersized-body case deadlocks one body
    // short of its own allocation forever (t72804439; see upgraderSwarmCap).
    const swarmCap = upgraderSwarmCap(targetCount, parking, fieldedWork, allocated);
    this.lastSizing.swarmCap = swarmCap;
    if (this.getCreepCount() >= swarmCap) {
      this.lastSizing.demand = "swarm-cap";
      return [];
    }

    // The gap against the fleet's ACTUAL WORK, not `current * affordableWork`
    // (the ideal per-body share). With small survivors standing, the ideal form
    // over-states what is fielded and under-orders the body that closes the gap
    // - the same count-vs-capacity drift the exit above just fixed.
    const remainingWork = allocated - fieldedWork;
    // A WORK SLIVER IS NOT WORTH A BODY (owner 2026-08-05, see
    // upgraderWorthABody): a 2-6 WORK gap buys a runt that then holds one of
    // the few parking slots for 1500 ticks. Ride it to EOL, which re-sizes
    // for free. The FIRST body is exempt by construction - with nothing
    // fielded the gap is the whole allocation, which always clears half a
    // share - so a cold controller still starts upgrading immediately.
    const mature = !!spawn?.room?.storage?.my;
    if (current > 0 && !upgraderWorthABody(remainingWork, affordableWork, mature)) {
      this.lastSizing.demand = "sliver";
      return [];
    }
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
        // SCALING under a bank surplus holds too (incident t72503018): the
        // full-capacity body (min == desired == cap, runt policy) is never
        // organically affordable against cheap partial-fill buys, so without
        // a wall the fleet grows only at starvation-lull cadence - measured
        // frozen at 2 of targetCount 6 for 2600+ ticks while 191k idled
        // (6.9x warchest) and controller delivery ran 0.39x the plan with
        // the controller-side stock STANDING. Same lens that scaled the
        // fleet up (upgraderSizing's surplus): cold start / save regime
        // never sets it, so the fleet-first doctrine is untouched there.
        ...(surplus ? { holdToFund: true } : {}),
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
   * EXCESS-SHED RETIRED (owner 2026-08-03: "Do we really need the excess
   * shed. I'm fine with just letting die out... it shouldn't happen too
   * often. Our colony conditions are essentially unchanged"). Upgraders are
   * ATTRITION-ONLY: an over-target fleet shrinks by natural EOL, never by
   * mid-life cull. The shed was the revocation class the trap list warns
   * about - it amplified PLAN swings (the 85->15 bank-refill flip; a pad
   * build setting dedicatedBuildSourceId) into 980e/window of body churn
   * while the world was unchanged. Scarcity still acts at the SPAWN: the
   * plan-sized demand + effectiveAllocated damping buy no NEW bodies over
   * target; standing WORK costs nothing to keep and burns stock into score
   * until it dies. Pinned by recycleReasonRatchet ("upgraders are
   * attrition-only").
   */

  /**
   * Set the sink allocation from FlowEconomy.
   * This determines how much energy should flow to upgrading.
   */
  public setSinkAllocation(allocation: SinkAllocation): void {
    this.sinkAllocation = allocation;
  }

  /**
   * Get the current sink allocation (if set by FlowEconomy).
   */
  public getSinkAllocation(): SinkAllocation | null {
    return this.sinkAllocation;
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
   * Serialize for persistence.
   */
  public serialize(): SerializedUpgradingCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      sinkAllocation: this.sinkAllocation ?? undefined
    };
  }

  /**
   * Deserialize from persistence.
   */
  public deserialize(data: SerializedUpgradingCorp): void {
    super.deserialize(data);
    this.sinkAllocation = data.sinkAllocation ?? null;
  }
}

