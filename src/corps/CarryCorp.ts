/**
 * @fileoverview CarryCorp - Manages hauler creeps.
 *
 * CarryCorp is a transport service that moves energy from sources to destinations.
 *
 * This is the corp RUNTIME (spec 35 phase H): work loops, delivery legs, the
 * duty meter, recycling, and spawn demand. The pure routing/banking POLICY it
 * executes (sink choice, storage banking, depot refill, dedicated-source
 * drain, duty classification) lives in ./haulPolicy - Game-free, ratcheted.
 *
 * @module corps/CarryCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { isIntelId, isScavengeId, parsePositionalId, stripSourcePrefix } from "../economy/ids";
import { SCAVENGE_THRESHOLD } from "../economy/scavenge";
import { isTenderCreep } from "./censusLens";
import { tenderOwnsExtensions } from "./regimes";
import { CoreDepot, controllerDeliverySpot, coreDepot, scavengeSpot, sourcePickupSpot, workSpot } from "./nodeEnergy";
import { travelToLane, travelToQueued } from "./movement";
import { driveRecycle, runtUpsizeThreshold } from "./recycle";
import {
  CARRY_MOVE_PAIR_COST,
  CREEP_LIFETIME,
  bufferDrainCarry,
  carryPartsFor,
  haulerBodyCarry,
  haulerBodyCost,
  maxCarryPairs,
  roundTripTicks,
  staffsPost
} from "../economy/primitives";
import { HaulerAssignment } from "../flow/FlowTypes";
import { travelTicksPerTile } from "./economics";
import { traceHaulTick } from "../telemetry/HaulTrace";

/**
 * Hard backstop on bodies per hauling corp - the pathological case where the
 * fielded bodies are so small that even twice the route's carry would take a
 * crowd. Generous on purpose: the CARRY cap above it is the real bound, and
 * this only exists so a degenerate room cannot spawn without limit.
 */
const HAULER_BODY_CEILING = 12;
import { nextStop, roomCircuit } from "./refillCircuit";
import { hostileRooms, routeIsDangerous } from "../utils/RoomDiscovery";
import { Position } from "../types/Position";
import {
  DEPOT_BUFFER,
  LocalSink,
  SPAWN_PRIORITY_FREE_CAPACITY,
  classifyHaulerTick,
  depotBankTarget,
  isSpawnNetworkCritical,
  pickSinkByAllocation,
  pickStorageDeposit,
  shouldBankControllerLoad,
  shouldDrainDedicatedSource,
  shouldRefillFromDepot
} from "./haulPolicy";

/**
 * Serialized state specific to CarryCorp
 */
export interface SerializedCarryCorp extends SerializedCorp {
  spawnId: string;
  /** Flow-based hauler assignments (from FlowEconomy) */
  haulerAssignments?: HaulerAssignment[];
  /** Where this corp's route picks up (see CarryCorp.pickupPos). */
  pickupPos?: Position;
  /** Duty-meter counters (rolling ~1500t window, survives resets). */
  dutyAlive?: number;
  dutyActive?: number;
  dutyIdleSource?: number;
  dutyIdleSink?: number;
  dutyIdleSinkAtSink?: number;
  dutyIdleSinkStorageRoom?: number;
  dutySince?: number;
}

/**
 * CarryCorp manages hauler creeps that move energy around.
 */
export class CarryCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /**
   * Flow-based hauler assignments from FlowEconomy.
   * Each assignment specifies a source → sink route with CARRY requirements.
   */
  private haulerAssignments: HaulerAssignment[] = [];

  /**
   * Hauler duty meter (owner 2026-07-25): rolling ~1500t window counting
   * alive-ticks by realized activity, so "our haulers aren't enough" can be
   * split into a plan under-ask (high duty, buffers still grow) vs an
   * execution loss (haulers idle/blocked). Serialized so a global reset
   * mid-window doesn't read as a duty collapse (the tender-meter pattern).
   */
  private dutyAlive = 0;
  /** Which gate ended the last hauler-sizing walk (spec 14 exit verdict). */
  private lastExit: "staffed" | "swarm-cap" | "asking" | undefined;
  private dutyActive = 0;
  private dutyIdleSource = 0;
  private dutyIdleSink = 0;
  /** Of the idleSink ticks, those spent ADJACENT to the deposit (storage/port):
   * the sink refused the load (link clamped / bank full) vs the complement,
   * blocked EN-ROUTE in the approach lane (traffic / a standing blocker). The
   * split names the fix: at-sink => deposit throughput; en-route => decongest
   * the lane / relocate the parked blocker. */
  private dutyIdleSinkAtSink = 0;
  /** Of the atSink idle ticks, those where the STORAGE still had free capacity
   * (the deposit target was NOT saturated). atSink WITH storage room => the
   * block is SPATIAL contention (queuing for the deposit tile / a parked mover
   * in the way), so the fix is geometry / deposit-spread, NOT a bigger fleet.
   * atSink WITHOUT storage room => genuine sink saturation (spill the load).
   * The fork the coarse atSink split could not name (owner 2026-07-27, the
   * post-feeder-router pile: atSink 0.21, storage far from full). */
  private dutyIdleSinkStorageRoom = 0;
  private dutySince = 0;

  /**
   * Where this corp's route picks up - the CarryCorp analogue of HarvestCorp's
   * POST. Seeded from the commission (consumes.at) and refined to the live
   * source position whenever the source resolves, so a hauler whose real-id
   * source is momentarily out of vision keeps walking the route instead of
   * being round-robined onto a source in whatever room it stands in (a sticky
   * mis-assignment that outlived the vision gap).
   */
  private pickupPos: Position | null = null;

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("hauling", nodeId, customId);
    this.spawnId = spawnId;
  }

  /**
   * Get all creeps assigned to this corp.
   */
  private getAssignedCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (
        (creep.memory.corpId === this.id || creep.memory.corpId === this.nodeId) &&
        creep.memory.workType === "haul" &&
        !creep.spawning
      ) {
        creeps.push(creep);
      }
    }
    return creeps;
  }

  /**
   * Get the spawn position as the corp's location.
   */
  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /**
   * Main work loop - run hauler creeps.
   */
  public work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const room = spawn.room;
    const creeps = this.getAssignedCreeps();

    // Stranded-hauler diagnostic (4-30 lingers across captures despite the
    // retiring-recycle fix): stamp the exact state the recycle paths read -
    // is the corp retiring? how many routes does it still hold? how many of
    // its creeps are LOADED (flagRetiringForRecycling skips loaded ones)? One
    // recapture resolves whether it's stuck-loaded vs never-flagged-retiring.
    // Execution meter BEFORE the creeps act this tick: pos/store still hold
    // last tick's realized result, so we measure movement that HAPPENED, not
    // intents (a blocked creep reads idle). Recycling creeps are excluded -
    // they are heading to the spawn to die, not hauling.
    this.meterExecution(creeps.filter(c => !c.memory.recycling), tick, room);

    const pickup = this.readPickupBuffer();
    this.lastSizing = {
      tick,
      retiring: this.retiring,
      routes: this.getHaulerAssignments().length,
      creeps: creeps.length,
      loaded: creeps.filter(c => (c.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) > 0).length,
      // Source-pileup instrument (2026-07-26): the ACTUAL pickup buffer vs
      // the carry the fleet is sized to (haulCarryNeeded - plan routes only
      // when mature, +drain in bootstrap), plus the source link state - so
      // the next capture names whether a standing pile is hauler
      // under-sizing or a link backlog.
      carryNeeded: this.haulCarryNeeded(this.homeStorageBacked()),
      ...(this.lastExit ? { exit: this.lastExit } : {}),
      staged: pickup.staged,
      srcLinkEnergy: pickup.srcLinkEnergy,
      srcLinkCap: pickup.srcLinkCap,
      // Duty split (owner 2026-07-25): active vs idle-empty (load leg) vs
      // idle-loaded (deliver leg). Low duty w/ full source buffers = execution
      // loss; high duty w/ full buffers = the plan under-asks (inflow-sized).
      ...(this.dutyAlive > 0
        ? {
            duty: Math.round((this.dutyActive / this.dutyAlive) * 1000) / 1000,
            idleSourceFrac: Math.round((this.dutyIdleSource / this.dutyAlive) * 1000) / 1000,
            idleSinkFrac: Math.round((this.dutyIdleSink / this.dutyAlive) * 1000) / 1000,
            // of idleSink: adjacent to the deposit (sink refused) vs the
            // complement, blocked en-route (lane traffic / standing blocker).
            idleSinkAtSinkFrac: Math.round((this.dutyIdleSinkAtSink / this.dutyAlive) * 1000) / 1000,
            // of the atSink idle: the hub storage HAD room (=> spatial
            // contention at the deposit, not sink saturation - the fix fork).
            idleSinkStorageRoomFrac: Math.round((this.dutyIdleSinkStorageRoom / this.dutyAlive) * 1000) / 1000,
            meterTicks: tick - this.dutySince
          }
        : {})
    };

    this.flagRuntForRecycling(creeps, room, spawn);
    this.flagEndOfLifeForRecycling(creeps);
    this.flagRetiringForRecycling(creeps);

    for (const creep of creeps) {
      if (creep.memory.recycling) {
        driveRecycle(creep, spawn);
      } else {
        this.runHauler(creep, room, spawn);
      }
    }
  }

  /**
   * Accumulate the hauler duty meter over a rolling ~1500t window. For each
   * live creep, compare this tick's position + carried energy to last tick's
   * snapshot (creep memory, so it survives global resets): a change in either
   * is a productive tick, otherwise the creep stood still - split by whether it
   * was loaded (waiting to deliver) or empty (waiting to load). A creep with no
   * snapshot yet (just spawned / first observation) only seeds it, uncounted.
   */
  private meterExecution(creeps: Creep[], tick: number, room: Room): void {
    if (tick - this.dutySince >= 1500) {
      this.dutyAlive = 0;
      this.dutyActive = 0;
      this.dutyIdleSource = 0;
      this.dutyIdleSink = 0;
      this.dutyIdleSinkAtSink = 0;
      this.dutyIdleSinkStorageRoom = 0;
      this.dutySince = tick;
    }
    // The deposit points a loaded hauler waits AT: the room storage and (spec
    // 26) its port link. Adjacent-but-idle = the sink refused; not adjacent =
    // blocked en-route in the approach lane.
    const depositPos = this.storageDepositPort();
    const sinks: RoomPosition[] = [];
    if (room.storage) sinks.push(room.storage.pos);
    if (depositPos && depositPos.roomName === room.name) {
      sinks.push(new RoomPosition(depositPos.x, depositPos.y, depositPos.roomName));
    }
    for (const creep of creeps) {
      const energy = creep.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
      const prev = creep.memory.dutyPos;
      const prevEnergy = creep.memory.dutyEnergy;
      if (prev === undefined || prevEnergy === undefined) {
        // First observation: seeds the snapshot, counts toward nothing. The
        // trace still records it so a life starts at tick one rather than two.
        traceHaulTick(creep, this.id, tick, energy, "seed");
      }
      if (prev !== undefined && prevEnergy !== undefined) {
        const moved = prev.x !== creep.pos.x || prev.y !== creep.pos.y || prev.roomName !== creep.pos.roomName;
        const transacted = prevEnergy !== energy;
        this.dutyAlive += 1;
        const verdict = classifyHaulerTick(moved, transacted, energy > 0);
        // PER-TICK TRACE (owner 2026-08-02). The duty counters below aggregate
        // this same verdict into a mean; the trace keeps it unaggregated for
        // ONE armed creep, because a mean cannot show a hauler standing on one
        // tile for forty ticks and a timeline can.
        traceHaulTick(creep, this.id, tick, energy, verdict);
        switch (verdict) {
          case "active":
            this.dutyActive += 1;
            break;
          case "idleSource":
            this.dutyIdleSource += 1;
            break;
          case "idleSink":
            this.dutyIdleSink += 1;
            if (
              creep.pos.roomName === room.name &&
              sinks.some(p => creep.pos.getRangeTo(p) <= 1)
            ) {
              this.dutyIdleSinkAtSink += 1;
              // Was the hub sink actually saturated, or does it have room (so the
              // block is spatial contention, not sink refusal)? One cheap read.
              const storageRoom = room.storage
                ? (room.storage.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0
                : false;
              if (storageRoom) this.dutyIdleSinkStorageRoom += 1;
            }
            break;
        }
      }
      creep.memory.dutyPos = { x: creep.pos.x, y: creep.pos.y, roomName: creep.pos.roomName };
      creep.memory.dutyEnergy = energy;
    }
  }

  /**
   * END-OF-LIFE recycle (owner 2026-07-22: "a hauler with less ttl than it
   * takes to round trip after dropping off the energy might be able to
   * recycle itself"): an EMPTY hauler that cannot complete even its
   * SHORTEST route's round trip would spend its last ticks walking out and
   * dying - loaded at worst (cargo dropped mid-route), pointlessly at best.
   * Recycling instead refunds the remaining-TTL share of its body cost at
   * the spawn. Empty-only (never strands cargo), and min-distance
   * conservative (a creep that can still finish SOME route keeps working).
   * staffsPost already excludes these from staffing (recycling creeps order
   * their successors - the trap-list rule), so no double-ordering.
   */
  /**
   * RETIRING recycle: the planner stopped commissioning this corp (its route
   * vanished) but it is kept while it has live creeps (materializeCommissions'
   * hysteresis, so they're never orphaned). A hauler with no route has no work
   * to "finish", so "run to natural death" meant idling ~1500 ticks (live
   * t72525241: hauling-W44N23-hauling-4-30, a stranded 6-part creep with no plan
   * route). Recycle an EMPTY retiring hauler NOW - refunds the body, orders no
   * successor (retiring already cuts demand). A LOADED one keeps working so
   * runHauler delivers its cargo first (never strand it); it recycles next tick
   * once empty. Generalises the scavenger-stock recycle (pickupEnergy) to any
   * route that vanished.
   */
  private flagRetiringForRecycling(creeps: Creep[]): void {
    if (!this.retiring) return;
    for (const creep of creeps) {
      if (creep.memory.recycling || creep.spawning) continue;
      if ((creep.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) === 0) {
        creep.memory.recycling = true;
        creep.memory.recycleReason = "retiring-demob";
      }
    }
  }

  private flagEndOfLifeForRecycling(creeps: Creep[]): void {
    const assignments = this.getHaulerAssignments();
    if (assignments.length === 0) return;
    const minRoundTrip = Math.min(...assignments.map(a => roundTripTicks(a.distance)));
    for (const creep of creeps) {
      if (creep.memory.recycling || creep.spawning) continue;
      if ((creep.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) > 0) continue;
      if (creep.ticksToLive !== undefined && creep.ticksToLive < minRoundTrip) {
        creep.memory.recycling = true;
        creep.memory.recycleReason = "eol-tail";
      }
    }
  }

  /**
   * CARRY parts a single hauler on THIS corp's route is worth building with:
   * the route's even per-body share at the room's capacity, not the room's
   * capacity alone (see primitives.haulerBodyCarry). Referencing the capacity
   * made a body that fully covered a short route read as a runt forever.
   */
  private maxCarryPerHauler(room: Room): number {
    return haulerBodyCarry(room.energyCapacityAvailable, this.haulCarryNeeded(room.storage?.my === true));
  }

  /**
   * Actively heal a runt fleet by retiring the smallest hauler so getSpawnDemand
   * rebuilds it bigger - but ONLY once conditions are ready: the spawn must already
   * hold enough energy to rebuild a body strictly bigger than that runt RIGHT NOW.
   * That gate is the whole trick. We do NOT wait for the runt to die of old age
   * (1500 ticks of capped throughput), and we do NOT hold the spawn for a full body
   * (that stalls - this colony's spawn is a flow-through conduit that rarely fills).
   * We simply pounce whenever the spawn momentarily carries a full-ish load, swap a
   * runt out for the bigger body it can afford on that tick, and converge the fleet
   * upward one rung at a time. When the spawn is starved the gate stays shut, so we
   * never disrupt deliveries to chase a body we cannot afford - no thrash.
   */
  private flagRuntForRecycling(creeps: Creep[], room: Room, spawn: StructureSpawn): void {
    if (spawn.spawning) return; // a body is already mid-build; don't pile on
    if (creeps.some(c => c.memory.recycling)) return; // one at a time
    if (creeps.length < 2) return; // never strand the source

    const carry = creeps.map(c => c.getActiveBodyparts(CARRY));
    const minCarry = Math.min(...carry);
    const maxCarry = this.maxCarryPerHauler(room);
    if (minCarry >= maxCarry) return; // nothing under-built to heal

    // Replacement affordability: in a STORAGE-BACKED room the pounce waits
    // for the FULL-SIZE body - one recycle, one buy (the cee0 ladder bought
    // five stepping-stones because this gate fired at +1 CARRY while each
    // purchase drained the bank the next buy scaled to). Bootstrap keeps the
    // +1 crank: escape velocity beats waiting when nothing guarantees refill.
    const runtRatio = this.getHaulerAssignments()[0]?.haulerRatio ?? "1:1";
    if (room.energyAvailable < runtUpsizeThreshold(minCarry, maxCarry, room.storage?.my === true, runtRatio)) return;

    creeps[carry.indexOf(minCarry)].memory.recycling = true;
    creeps[carry.indexOf(minCarry)].memory.recycleReason = "runt-upsize";
  }

  /**
   * Run behavior for a hauler creep.
   */
  private runHauler(creep: Creep, room: Room, spawn: StructureSpawn): void {
    // State transition
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
      creep.say("pickup");
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      this.depart(creep, room);
    }

    // A clean bus: it fills completely at its source stop, then runs the route and
    // empties completely at its sink stop - no grabbing energy off-route mid-trip
    // (that energy belongs to its own source's bus). The state flips above only on
    // full and on empty, so the hauler waits at each stop until the transaction is
    // done rather than leaving with a partial load.
    //
    // The EN-ROUTE LOOT GRAB below is not an exception to the bus doctrine -
    // it recovers energy that belongs to NO bus (tombstones, ruins, unclaimed
    // dust piles), same-tick with the walk, zero detour. See grabAdjacentLoot.
    this.grabAdjacentLoot(creep);
    if (creep.memory.working) {
      this.deliverEnergy(creep, room, spawn);
    } else {
      this.pickupEnergy(creep, room);
    }
  }

  /**
   * EN-ROUTE LOOT GRAB (owner 2026-08-03: "cleaning out some of the decay and
   * tombstones would be a huge boost - that's bottom-line energy that we paid
   * the claiming, mining and at least half the hauling cost for").
   *
   * Measured t72744219: 11.95 e/t pile decay + 5.73 e/t net tombstone loss,
   * 1103e standing in tombstones, 1.0 e/t recovered - and 87% of tombstone
   * cargo is haul-role, killed ON the corridors the surviving haulers walk
   * every trip. The planner cannot recover this class: sub-threshold stocks
   * are priced out by design (a spawned body costs more than a small pile
   * repays - the micro-route floor) and tombstones decay faster than a
   * scavenger can arrive. "Every recovery path needs a creep already beside
   * it" - so the creeps already beside it do it: pickup/withdraw are a
   * DIFFERENT ACTION GROUP from movement, so an adjacent grab mid-walk costs
   * zero ticks and zero detour.
   *
   * Bus-doctrine boundaries, explicit:
   *  - tombstones and ruins belong to NO bus - always fair game;
   *  - dropped piles only UNDER the scavenge threshold (unclaimed dust that
   *    rots to zero) - a bigger pile is some route's staged stock (its drain
   *    term prices it) and stays on its own bus;
   *  - the feeder-managed controller bucket is DELIVERED energy - grabbing
   *    it would un-deliver (the scavenge scanner's same exclusion).
   */
  private grabAdjacentLoot(creep: Creep): void {
    if ((creep.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) <= 0) return;
    const tomb = creep.pos.findInRange(FIND_TOMBSTONES, 1, {
      filter: t => (t.store[RESOURCE_ENERGY] ?? 0) > 0
    })[0];
    if (tomb) {
      creep.withdraw(tomb, RESOURCE_ENERGY);
      return;
    }
    const ruin = creep.pos.findInRange(FIND_RUINS, 1, {
      filter: r => (r.store[RESOURCE_ENERGY] ?? 0) > 0
    })[0];
    if (ruin) {
      creep.withdraw(ruin, RESOURCE_ENERGY);
      return;
    }
    const ctrl = creep.room.controller;
    const feederManaged = !!ctrl && ctrl.my && !!creep.room.memory?.controllerFeederActive;
    const pile = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
      filter: r => {
        if (r.resourceType !== RESOURCE_ENERGY) return false;
        if (r.amount <= 20 || r.amount >= SCAVENGE_THRESHOLD) return false;
        if (feederManaged && ctrl && r.pos && Math.max(Math.abs(r.pos.x - ctrl.pos.x), Math.abs(r.pos.y - ctrl.pos.y)) <= 3)
          return false;
        return true;
      }
    })[0];
    if (pile) creep.pickup(pile);
  }

  /**
   * Send a loaded hauler out on its delivery leg: commit to a home circuit and fix
   * this trip's destination. Called on the normal full-load state flip, and by the
   * scavenger path when its transient stock runs dry mid-load (a drained stock can
   * never top the hauler up to full, so waiting for the flip would freeze it).
   */
  private depart(creep: Creep, room: Room): void {
    creep.memory.working = true;
    // Each hauler has ONE permanent home circuit (assigned in proportion to the
    // flow solver's per-sink allocations - see assignCircuit), so it is a dumb
    // automaton on a defined route, not re-rolling its destination every trip.
    // Re-assign only when it has no circuit or its route's flow has vanished
    // (e.g. construction finished).
    const home = creep.memory.homeSink as LocalSink | undefined;
    if (!home || !this.committedSinkHasFlow(home) || this.foundingUnderstaffed(home)) {
      this.assignCircuit(creep);
    }
    // This trip's destination is decided ONCE, here: top up a hungry spawn
    // (the critical bottleneck, under-weighted by its tiny flow share), else run
    // the home circuit. Fixed for the whole trip, so no mid-route thrash.
    const homeSink = creep.memory.homeSink as LocalSink;
    creep.memory.deliverSinkId = homeSink !== "spawn" && this.spawnNetworkCritical(room) ? "spawn" : homeSink;
    creep.say(
      creep.memory.deliverSinkId === "controller"
        ? "→ctrl"
        : creep.memory.deliverSinkId === "founding"
        ? "→found"
        : creep.memory.deliverSinkId === "storage"
        ? "→bank"
        : "→spawn"
    );
  }

  // ===========================================================================
  // FLEET COORDINATION - Belt/Bus Circulation System
  // ===========================================================================

  /**
   * Get the canonical list of all spawn/extension structures in this room.
   * Sorted by ID for consistent ordering across all ticks and haulers.
   * This is the "route" that haulers circulate through.
   */
  private getSpawnZoneStructures(room: Room): (StructureSpawn | StructureExtension)[] {
    const structures = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION
    }) as (StructureSpawn | StructureExtension)[];

    // Sort by ID for consistent ordering
    return structures.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Get the source this CarryCorp's haulers should serve.
   * With per-source CarryCorps, each corp has exactly one source from its hauler assignment.
   * Falls back to round-robin distribution for legacy room-based corps.
   */
  private getAssignedSource(creep: Creep, sources: Source[]): Source | null {
    // Per-source CarryCorp: use the source from hauler assignment
    if (this.haulerAssignments.length > 0) {
      const assignment = this.haulerAssignments[0];
      // Extract source game ID from flow source ID (e.g., "source-abc123" → "abc123")
      const sourceGameId = stripSourcePrefix(assignment.fromId);

      // Scavenger: the "source" is a ground stock (no live object). Parse its
      // position from the id (scavenge-ROOM-X-Y) the same way as an intel source.
      if (isScavengeId(sourceGameId)) {
        const parsed = parsePositionalId(sourceGameId);
        if (parsed) {
          creep.memory.assignedSourcePos = { ...parsed.pos };
        }
        return null;
      }

      // Check if this is an intel-based source (remote room without vision)
      if (isIntelId(sourceGameId)) {
        // Intel source: parse position from ID format "intel-ROOMNAME-X-Y"
        const parsed = parsePositionalId(sourceGameId);
        if (parsed) {
          // Store position for navigation even without source object
          creep.memory.assignedSourcePos = { ...parsed.pos };
        }
        return null; // No live source object for intel sources
      }

      const source = Game.getObjectById(sourceGameId as Id<Source>);
      if (source) {
        creep.memory.assignedSourceId = source.id;
        // Remember where the route picks up, for ticks with no vision of it.
        this.pickupPos = { x: source.pos.x, y: source.pos.y, roomName: source.pos.roomName };
        return source;
      }

      // Real id, no vision (getObjectById resolves only visible rooms): HOLD
      // THE ROUTE. Falling through to the legacy round-robin here latched the
      // hauler onto a source in whatever room it stood in - and stamped
      // assignedSourceId, so the mis-assignment was sticky for the creep's
      // whole life. Navigate to the remembered pickup position instead, the
      // same shape as the intel path above; approaching it restores vision
      // and the source resolves.
      if (this.pickupPos) {
        creep.memory.assignedSourcePos = { ...this.pickupPos };
      }
      return null;
    }

    // Fallback: legacy round-robin distribution (for transition period)
    if (sources.length === 0) return null;

    if (creep.memory.assignedSourceId) {
      const assigned = Game.getObjectById(creep.memory.assignedSourceId as Id<Source>);
      if (assigned) return assigned;
      delete creep.memory.assignedSourceId;
    }

    const allHaulers = this.getAssignedCreeps();
    const myIndex = allHaulers.findIndex(c => c.name === creep.name);
    const sourceIndex = myIndex >= 0 ? myIndex % sources.length : 0;
    const assignedSource = sources[sourceIndex];

    creep.memory.assignedSourceId = assignedSource.id;
    return assignedSource;
  }

  /**
   * Pick up energy from the ground or containers.
   * Haulers are assigned to specific sources to prevent thrashing.
   */
  private pickupEnergy(creep: Creep, room: Room): void {
    // Our source is reserved for the builder: don't draw from it. Stand by (idle
    // until the build finishes) so the construction tankers get its full output.
    // STAND-DOWN NEVER FREEZES CARGO (fid-t4-synthetic probe, t800-1100): a
    // controller-circuit hauler entered pickup at 99/100, its source was
    // dedicated to the build, and this return froze it LOADED for 300+ ticks
    // while the upgrader one tile away starved at 0 - the cell's controller
    // line read 0.0 of a 2.0 plan. Yielding means no NEW pickups; anything
    // already aboard delivers first, then the empty creep stands by.
    if (this.yieldsToBuild()) {
      if (creep.store[RESOURCE_ENERGY] > 0) this.depart(creep, room);
      return;
    }

    // Resolve this hauler's ONE pickup stop first: both the degraded-refill
    // locality check below and the normal pickup leg need it, and getAssignedSource
    // carries memory side effects that must run exactly once per tick.
    const sources = room.find(FIND_SOURCES);
    const assignedSource = this.getAssignedSource(creep, sources);
    let targetPos: RoomPosition | null = null;
    if (assignedSource) {
      targetPos = assignedSource.pos;
    } else if (creep.memory.assignedSourcePos) {
      const p = creep.memory.assignedSourcePos;
      targetPos = new RoomPosition(p.x, p.y, p.roomName);
    }

    // DEGRADED-MODE REFILL, UNCOVERED rooms only (a depot exists but no
    // extensions yet - early RCL2): the depot's bank is otherwise invisible
    // to refill, so a spawn-circuit hauler reloads from the stocked depot
    // instead of trekking to its source whenever the network is short. In a
    // COVERED room this never fires, tender alive or dead (owner 2026-07-22
    // accountability ruling): the depot is the tender corp's exclusive
    // reserve, and a dead tender is re-fielded by its bootstrap demand, not
    // covered for by hauler trips.
    // Unassigned haulers (pre-first-circuit) count as spawn-circuit here: the
    // earliest drains land exactly when nothing has flipped to working yet.
    //
    // LOCALITY GATE (fixes "an empty hauler heading back home"): this is a
    // reload-from-the-NEARBY-bank shortcut, so it fires only when the depot is
    // actually the shorter reload than the trek to this hauler's own source. The
    // depot lives beside the home spawn, so its range only counts when the creep
    // is in that room; a room away it is never the near bank. The source pickup
    // range is Infinity when the source is out of the creep's room this tick, so a
    // hauler AT HOME still tops up from the depot rather than run a whole remote
    // round-trip - but one out at (or walking toward) its far/remote source is left
    // to pick up there instead of being dragged home (see shouldRefillFromDepot).
    if ((creep.memory.homeSink ?? "spawn") === "spawn" && !tenderOwnsExtensions(room.memory)) {
      const depot = coreDepot(room);
      const rangeToDepot = depot && creep.room.name === room.name ? creep.pos.getRangeTo(depot) : Infinity;
      const rangeToPickup =
        targetPos && targetPos.roomName === creep.room.name ? creep.pos.getRangeTo(targetPos) : Infinity;
      if (
        depot &&
        shouldRefillFromDepot({
          depotEnergy: depot.store[RESOURCE_ENERGY],
          networkNeed: room.energyCapacityAvailable - room.energyAvailable,
          rangeToDepot,
          rangeToPickup
        })
      ) {
        if (creep.withdraw(depot, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          travelToLane(creep, depot, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
        }
        return;
      }
    }

    // The one fixed pickup stop on this hauler's bus route: its assigned source.
    if (!targetPos) return;

    if (targetPos.roomName !== creep.room.name) {
      travelToLane(creep, targetPos, { visualizePathStyle: { stroke: "#ffaa00" } });
      return;
    }

    // A scavenger draws from a ground stock (tombstone / ruin / pile / summed
    // container); an ordinary hauler from its source's output spot (container /
    // drop pile / wait tile). The stock spot is null once drained - the scavenger
    // then carries home what it has and stands down (re-detection drops the stock
    // next economy rebuild).
    if (this.isScavenger()) {
      const spot = scavengeSpot(targetPos);
      if (spot) {
        workSpot(creep, spot, "collect");
      } else if (creep.store[RESOURCE_ENERGY] > 0) {
        // Drained stock, partial load aboard: DEPART NOW. The clean-bus state
        // machine only flips to delivering on a FULL load, and a stock that no
        // longer exists can never provide the top-up - waiting for the flip
        // froze the scavenger beside its dead stock for the rest of its life
        // (observed live 2026-07-17, 744/800 aboard).
        this.depart(creep, room);
      } else {
        // Drained stock AND empty-handed: this scavenger will never scavenge
        // again (re-detection dropped the stock; the corp is retiring and its
        // demand is already cut, so no successor is ordered). RECYCLE NOW.
        // The retained-but-retiring corp is NOT orphaned, so OrphanRescue never
        // collects the creep (investigation 2026-07-23) - without this it idles
        // beside the dead stock for the rest of its ~1500-tick life, the parked
        // runt the "fewer creeps" goal is about. driveRecycle refunds the body.
        creep.memory.recycling = true;
        creep.memory.recycleReason = "scavenge-drained";
      }
      return;
    }
    // DEPART ON DRY, ordinary haulers too (fid-t4-synthetic probe, t800-1100):
    // the scavenger branch above has ALWAYS departed a drained stock with a
    // partial load, but a regular hauler waited at its pickup for the full-load
    // flip - and a pickup that yields nothing (a phantom assignedSourcePos from
    // a long-gone transient stock, or a source at its regen gap with no pile)
    // froze one at (23,13) holding 99 of 100 for 300+ ticks while the upgrader
    // one tile away starved at 0 and the cell's controller line read 0.0 of
    // 2.0. Carrying SOMETHING at a dry stop: deliver it and come back - the
    // regen-gap case is also just correct economics (the 99 beats waiting out
    // a 300-tick regen for the last 1). Empty-handed at a dry REAL source
    // still waits (it regenerates); the phantom-pos case falls to the
    // orphan/retire machinery as before.
    const spot = sourcePickupSpot(targetPos);
    const spotStocked =
      (spot.structure && ((spot.structure as StructureContainer).store?.[RESOURCE_ENERGY] ?? 0) > 0) ||
      (typeof spot.pos?.findInRange === "function" &&
        spot.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
          filter: (r: Resource) => r.resourceType === RESOURCE_ENERGY && r.amount > 0
        }).length > 0) ||
      (assignedSource ? (assignedSource.energy ?? 0) > 0 : false);
    if (!spotStocked && creep.store[RESOURCE_ENERGY] > 0 && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      this.depart(creep, room);
      return;
    }
    workSpot(creep, spot, "collect");
  }

  /** True when this corp serves a transient ground stock rather than a source. */
  private isScavenger(): boolean {
    return isScavengeId(this.haulerAssignments[0]?.fromId ?? "");
  }

  /**
   * Deliver energy to the spawn network or the controller (a hauler's only two
   * sinks; construction is fed by tankers, not haulers).
   */
  private deliverEnergy(creep: Creep, room: Room, _spawn: StructureSpawn): void {
    // Deliver to this trip's destination (fixed at fill-up; see runHauler). No
    // re-decision here - that mid-route flip-flopping is exactly the thrash we are
    // removing.
    const target = (creep.memory.deliverSinkId as LocalSink | undefined) ?? "spawn";
    if (this.tryDeliverTo(creep, room, target)) return;

    // The destination momentarily can't take it (full): help the other sink rather
    // than idle, without disturbing the permanent home circuit. Spawn first -
    // surplus is most valuable kept in the spawn network.
    const fallback: LocalSink[] = ["spawn", "controller"];
    for (const sink of fallback) {
      if (sink === target) continue;
      if (this.tryDeliverTo(creep, room, sink)) return;
    }
  }

  /**
   * Should a controller-bound hauler abandon its route to refill the spawn? Only
   * when the spawn network is CRITICALLY low - less than {@link SPAWN_DIVERT_FILL}
   * full - so a nearly-full network never steals the controller's allocated share.
   * Under the extension tender the depot-bridge regime (spawnNetworkHungry) governs
   * instead. This is the fix for the RCL2 stall: the old test diverted on any free
   * capacity, so the lone controller hauler fed the spawn every trip and the
   * controller got nothing.
   */
  private spawnNetworkCritical(room: Room): boolean {
    if (tenderOwnsExtensions(room.memory)) return this.spawnNetworkHungry(room);
    let used = 0;
    let cap = 0;
    for (const s of this.getSpawnZoneStructures(room)) {
      used += s.store[RESOURCE_ENERGY];
      cap += s.store.getCapacity(RESOURCE_ENERGY) ?? 0;
    }
    // Energy already aboard fleet-mates committed to the spawn this trip: the
    // deficit they cover is not an emergency (see isSpawnNetworkCritical).
    // Per-corp only - other sources' fleets are invisible here, which errs on
    // the side of diverting slightly too often, never too rarely.
    const inbound = this.getAssignedCreeps().reduce((sum, h) => {
      if (!h.memory.working || h.memory.deliverSinkId !== "spawn") return sum;
      return sum + h.store[RESOURCE_ENERGY];
    }, 0);
    return isSpawnNetworkCritical(used, cap, inbound);
  }

  /** Free energy capacity across the spawn network is worth a hauler's divert. */
  private spawnNetworkHungry(room: Room): boolean {
    // When the tender owns the extensions, haulers are responsible only for the
    // SPAWN structure itself - so judge hunger by the spawn alone. Counting the
    // extensions here (which the tender fills, slower than haulers used to) would
    // keep the network looking perpetually hungry and divert EVERY controller-bound
    // hauler to the spawn, starving the controller.
    if (tenderOwnsExtensions(room.memory)) {
      const spawn = room.find(FIND_MY_SPAWNS)[0];
      if ((spawn?.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) >= SPAWN_PRIORITY_FREE_CAPACITY) return true;
      // The depot is the tender's reserve. Keep only a SMALL buffer there: divert a
      // hauler when it's nearly empty so the tender never starves, but no more - a
      // big reserve would make haulers refill the depot constantly and starve the
      // controller (the total energy is fixed and the flow solver already split it).
      // Once the buffer is met, haulers go back to feeding the controller.
      // (Deliberately the small BRIDGE buffer even for storage: the bank fills
      // from the spawn circuit's own surplus, never by diverting controller flow.)
      const depot = coreDepot(room);
      return !!depot && depot.store[RESOURCE_ENERGY] < DEPOT_BUFFER;
    }
    const free = this.getSpawnZoneStructures(room).reduce(
      (sum, s) => sum + s.store.getFreeCapacity(RESOURCE_ENERGY),
      0
    );
    return free >= SPAWN_PRIORITY_FREE_CAPACITY;
  }

  /** Per-sink-type flow this corp's source feeds (spawn + controller +
   * cross-room founding; local construction is excluded - tankers serve it). */
  private flowsBySink(): Record<LocalSink, number> {
    const founding = this.foundingSinkIds();
    const flows: Record<LocalSink, number> = { spawn: 0, controller: 0, founding: 0, storage: 0 };
    for (const a of this.haulerAssignments) {
      if (a.toId.startsWith("controller-")) flows.controller += a.flowRate;
      else if (a.toId.startsWith("storage-")) flows.storage += a.flowRate;
      else if (a.toId.startsWith("construction-")) {
        if (founding.has(a.toId)) flows.founding += a.flowRate;
      } else flows.spawn += a.flowRate;
    }
    return flows;
  }

  /**
   * Construction sinks this corp is routed to that sit in ANOTHER room (the
   * expansion founding): no tanker can ferry across a border, so these routes
   * belong to the haulers (see pickSinkByAllocation).
   */
  private foundingSinkIds(): Set<string> {
    const out = new Set<string>();
    const myRoom = this.nodeId.split("-")[0];
    for (const a of this.haulerAssignments) {
      if (!a.toId.startsWith("construction-")) continue;
      const site = Game.getObjectById(a.toId.replace("construction-", "") as Id<ConstructionSite>);
      if (site && site.pos.roomName !== myRoom) out.add(a.toId);
    }
    return out;
  }

  /**
   * Is a hauler's committed circuit still real? Spawn is always a valid home (it
   * perpetually needs topping). The controller is valid only while the flow solver
   * still routes energy there - when its flow drops to zero its haulers re-assign.
   */
  private committedSinkHasFlow(sink: LocalSink): boolean {
    if (sink === "spawn") return true;
    return this.flowsBySink()[sink] > 0;
  }

  /**
   * A founding route staffed BELOW its proportional share of this corp's
   * fleet: circuits are permanent (spawn is always a valid home), so when the
   * founding sink appears mid-life no committed hauler would ever re-evaluate
   * and the new room got exactly one body regardless of how much flow the
   * solver routed there (measured: first delivery t=1260 of 1400 with zero;
   * still delivery-starved and high-variance with the single-hauler version).
   * Full haulers re-run assignCircuit while founding trails its share; the
   * committed-count proportionality routes exactly the trailing ones there,
   * and the per-trip spawn-critical override still tops a hungry spawn first.
   */
  private foundingUnderstaffed(home: LocalSink): boolean {
    if (home === "founding") return false;
    const flows = this.flowsBySink();
    if (flows.founding <= 0) return false;
    const total = flows.spawn + flows.controller + flows.founding;
    const fleet = this.getAssignedCreeps();
    const committed = fleet.filter(h => h.memory.homeSink === "founding").length;
    const share = Math.max(1, Math.floor((flows.founding / total) * fleet.length));
    return committed < share;
  }

  /**
   * Permanently assign this hauler to one delivery circuit, picking the sink type
   * that is most under-staffed relative to its share of the flow. Counting the
   * haulers already committed to each sink and handing the newcomer the one
   * furthest behind its flow share spreads the fleet across circuits in proportion
   * to the solver's allocations - the same proportional rule the old per-load
   * chooser used, applied once per hauler instead of every trip.
   */
  private assignCircuit(creep: Creep): void {
    const committed: { [sink: string]: number } = {};
    for (const h of this.getAssignedCreeps()) {
      if (h.name === creep.name) continue;
      const s = h.memory.homeSink;
      if (s) committed[s] = (committed[s] ?? 0) + 1;
    }
    creep.memory.homeSink = pickSinkByAllocation(this.haulerAssignments, committed, this.foundingSinkIds());
  }

  /** Attempt delivery to a specific local sink; returns true if it took action. */
  private tryDeliverTo(creep: Creep, room: Room, sink: LocalSink): boolean {
    if (sink === "controller") return this.deliverToController(creep, room);
    if (sink === "founding") return this.deliverToFounding(creep);
    if (sink === "storage") return this.deliverToStorage(creep, room);
    return this.deliverToSpawn(creep, room);
  }

  /**
   * Bank a load in the room's storage. This is the deposit half of the storage
   * bank: the flow planner routes the surplus here (surplus the controller no
   * longer mops up once a storage exists - see flowAdapter's STORAGE_UPGRADE_TARGET),
   * so the hauler drives to the storage and dumps everything into it. The energy
   * is then distributed LOCALLY from the depot - the extension tender already
   * refills the spawn/extensions from it (coreDepot), and the spawn-critical
   * override still tops a hungry spawn first. Unlike deliverToSpawn's small bridge
   * bank (STORAGE_BANK, then spill to the controller), this keeps filling the
   * storage so it can accumulate the expansion capital the trigger saves toward.
   *
   * Returns false when the route has vanished (no storage) or the bank is
   * physically full, so deliverEnergy spills the load to the spawn/controller.
   */
  private deliverToStorage(creep: Creep, room: Room): boolean {
    const storage = room.storage;
    // DEPOSIT PORT (spec 26): the plan may have priced this deposit's haul-home to
    // a nearer link (a controller link) it turns around at. Deliver there first;
    // on a FULL drop the clean-bus state machine flips to pickup next tick (the
    // hauler turns around, round trip = the short port leg). A PARTIAL drop leaves
    // energy aboard, so next tick the now-full port yields "storage" and the
    // remainder hauls on to the hub - the emergent port-full fallback. The port is
    // read from the plan's assignment, never re-derived (delivery/pricing symmetry).
    const depositPos = this.storageDepositPort();
    const port = depositPos ? this.resolvePortLink(depositPos) : null;
    const portWaitedTicks = creep.memory.portWaitSince !== undefined ? Game.time - creep.memory.portWaitSince : 0;
    const decision = pickStorageDeposit({
      depositPos,
      portFree: port ? port.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0 : 0,
      storageFree: storage && storage.my ? storage.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0 : 0,
      portWaitedTicks
    });
    if (decision === "wait" && port) {
      // Hold at the link (owner 2026-07-24): the source link fires to core within
      // its cooldown, so waiting a few ticks beats bouncing to the hub and back.
      // Start the wait clock on the first hold; PORT_WAIT_CAP bounds it.
      if (creep.memory.portWaitSince === undefined) creep.memory.portWaitSince = Game.time;
      if (creep.pos.getRangeTo(port.pos) > 1) {
        travelToLane(creep, port.pos, { range: 1, visualizePathStyle: { stroke: "#88ffff" } });
      }
      return true; // idle-in-place with the load until the port drains or the cap trips
    }
    // Any non-wait outcome ends the hold: clear the clock so the next full-port
    // encounter starts a fresh window (a deposit or a fallback both reset it).
    if (creep.memory.portWaitSince !== undefined) delete creep.memory.portWaitSince;
    if (decision === "port" && port) {
      if (creep.pos.getRangeTo(port.pos) > 1) {
        travelToLane(creep, port.pos, { range: 1, visualizePathStyle: { stroke: "#88ffff" } });
        return true;
      }
      const moved = Math.min(creep.store[RESOURCE_ENERGY], port.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0);
      if (creep.transfer(port, RESOURCE_ENERGY) === OK) {
        this.recordProduction(moved);
        creep.memory.lastDeliver = { to: "deposit-port", amount: moved, tick: Game.time };
      }
      return true;
    }
    // "storage" or "none": the existing hub delivery. "none" (port + storage both
    // full) falls through to the return-false below so deliverEnergy spills the
    // load to a hungry spawn/controller (never camp a full port).
    if (!storage || !storage.my) return false; // route gone; caller re-assigns / falls back
    if (storage.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return false; // bank full: spill to consumers
    if (creep.pos.getRangeTo(storage) > 1) {
      travelToLane(creep, storage, { range: 1, visualizePathStyle: { stroke: "#ffffff" } });
      return true;
    }
    const moved = Math.min(creep.store[RESOURCE_ENERGY], storage.store.getFreeCapacity(RESOURCE_ENERGY));
    if (creep.transfer(storage, RESOURCE_ENERGY) === OK) {
      this.recordProduction(moved);
      // Intent-level receipt: a same-tick tender/feeder withdrawal can mask
      // this deposit from any outside store-delta observer (haul-t4 lesson).
      creep.memory.lastDeliver = { to: "storage", amount: moved, tick: Game.time };
    }
    return true;
  }

  /**
   * The deposit port the plan chose for this corp's haul-home route (spec 26),
   * read FRESH from the storage-bound assignment every call - assignments are
   * fully replaced each solve (setHaulerAssignments), so this can never go stale
   * the way a sticky corp field would (immortal-field trap). Undefined = no port,
   * haul the full hub leg.
   */
  private storageDepositPort(): Position | undefined {
    for (const a of this.haulerAssignments) {
      if ((a.toId ?? "").startsWith("storage-") && a.depositPos) return a.depositPos;
    }
    return undefined;
  }

  /** Resolve a deposit port position to its live link, or null if it is gone /
   * not ours (delivery then falls back to the storage hub). */
  private resolvePortLink(pos: Position): StructureLink | null {
    const room = Game.rooms[pos.roomName];
    if (!room) return null;
    const link = room
      .lookForAt(LOOK_STRUCTURES, pos.x, pos.y)
      .find(s => s.structureType === STRUCTURE_LINK) as StructureLink | undefined;
    return link && link.my ? link : null;
  }

  /**
   * Deliver to the expansion founding site in its (spawn-less) room: hand the
   * load to a hungry builder beside the site, else drop it there - builders
   * self-serve dropped energy within range 4 (doPickup). Returns false when the
   * founding route has vanished (site finished), so the caller re-assigns.
   */
  private deliverToFounding(creep: Creep): boolean {
    const sinkId = [...this.foundingSinkIds()][0];
    if (!sinkId) return false;
    const site = Game.getObjectById(sinkId.replace("construction-", "") as Id<ConstructionSite>);
    if (!site) return false;
    if (creep.room.name !== site.pos.roomName || creep.pos.getRangeTo(site.pos) > 1) {
      travelToLane(creep, site.pos, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
      return true;
    }
    const builder = creep.pos.findInRange(FIND_MY_CREEPS, 1, {
      filter: c => c.memory.workType === "build" && c.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    })[0];
    const carried = creep.store[RESOURCE_ENERGY];
    if (builder) {
      creep.transfer(builder, RESOURCE_ENERGY);
      this.recordProduction(Math.min(carried, builder.store.getFreeCapacity(RESOURCE_ENERGY)));
      return true;
    }
    creep.drop(RESOURCE_ENERGY);
    this.recordProduction(carried);
    return true;
  }

  /**
   * Deliver to the spawn/extension network via the circulation system.
   * Returns false when there is no spawn structure that needs energy.
   */
  private deliverToSpawn(creep: Creep, room: Room): boolean {
    // In a tender-COVERED room haulers run the dumb source->depot bus,
    // PERMANENTLY (tender alive or dead - accountability ruling): keep the
    // spawn STRUCTURE itself topped (one tile, no fanning across extensions)
    // so a tender gap can never deadlock the colony, then dump everything else
    // into the depot for the tender to distribute. This is what stops the
    // schooling - the haulers never chase a dozen half-full extensions.
    if (tenderOwnsExtensions(room.memory)) {
      const spawnNeedsEnergy = room.find(FIND_MY_SPAWNS).find(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
      const depot = coreDepot(room);
      // Fill the spawn structure first (keep it alive), then top the depot only to
      // its bank target: a small bridge buffer for a container, a real banked
      // reserve for storage. Crucially, once both are satisfied we return FALSE
      // rather than dumping more into the never-full depot - that lets
      // deliverEnergy spill the surplus to the controller, exactly as it did in the
      // pre-depot model when the spawn network filled up. Without this the depot
      // soaks up every spare load and the controller starves.
      const busTarget: StructureSpawn | CoreDepot | undefined =
        spawnNeedsEnergy ?? (depot && depot.store[RESOURCE_ENERGY] < depotBankTarget(depot) ? depot : undefined);
      if (!busTarget) return false;
      const r = creep.transfer(busTarget, RESOURCE_ENERGY);
      if (r === ERR_NOT_IN_RANGE) travelToLane(creep, busTarget, { visualizePathStyle: { stroke: "#ffffff" } });
      else if (r === OK)
        this.recordProduction(Math.min(creep.store[RESOURCE_ENERGY], busTarget.store.getFreeCapacity(RESOURCE_ENERGY)));
      return true;
    }

    const allSpawnStructures = this.getSpawnZoneStructures(room);
    if (allSpawnStructures.length === 0) return false;

    const needy = allSpawnStructures.filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    if (needy.length === 0) {
      // Bank full, no depot regime: top up the TENDER itself with the
      // leftovers - it is the room's mobile forward magazine (refill SLA;
      // measured: a depot-less tender reloading from a source container 15
      // tiles out blew the deadline on back-to-back drains). Only while it
      // has real free capacity; otherwise fall through to the controller
      // spill exactly as before.
      // Capped at ONE bank's worth: an uncapped top-up turned the tender's
      // big body into a hoard - every spawn-circuit load ended in the tender
      // instead of spilling to the controller (measured: maze sinks 7.8 ->
      // 2.2 e/t, upgraders starved while stock climbed).
      const bankCapacity = allSpawnStructures.reduce(
        (sum, st) => sum + (st.store.getCapacity(RESOURCE_ENERGY) ?? 0),
        0
      );
      const tender = Object.values(Game.creeps).find(
        c =>
          c.room.name === room.name &&
          isTenderCreep(c.memory) &&
          c.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
          c.store[RESOURCE_ENERGY] < bankCapacity
      );
      if (tender && creep.store[RESOURCE_ENERGY] > 0) {
        const r = creep.transfer(tender, RESOURCE_ENERGY);
        if (r === ERR_NOT_IN_RANGE) travelToLane(creep, tender, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
        else if (r === OK)
          this.recordProduction(Math.min(creep.store[RESOURCE_ENERGY], tender.store.getFreeCapacity(RESOURCE_ENERGY)));
        return true;
      }
      return false; // all full
    }

    // NEVER walk past an empty extension (owner, measured live: the old
    // ID-ordered "belt" rotation toured the cluster in spatially RANDOM order,
    // walking right past adjacent empties). Whatever the destination, if a
    // needy structure is adjacent right now, fill it THIS tick - the transfer
    // rides alongside the move for free.
    const adjacent = needy.find(s => creep.pos.isNearTo(s.pos));
    if (adjacent) {
      const r = creep.transfer(adjacent, RESOURCE_ENERGY);
      if (r === OK) {
        const amount = Math.min(creep.store[RESOURCE_ENERGY], adjacent.store.getFreeCapacity(RESOURCE_ENERGY));
        this.recordProduction(amount);
        // Intent receipt for the accountability doctrine (owner 2026-07-22):
        // a hauler filling an EXTENSION is the legacy fan path, legitimate
        // ONLY in uncovered rooms - harnesses assert this receipt never
        // appears in a tender-covered room (spatial linger proxies false-
        // positived on transit congestion; the receipt cannot).
        if (adjacent.structureType === STRUCTURE_EXTENSION) {
          creep.memory.lastDeliver = { to: "extension-fan", amount, tick: Game.time };
        }
      }
      if (adjacent.id === creep.memory.deliveryTargetId) delete creep.memory.deliveryTargetId;
      return true;
    }

    // BUS CIRCUIT (owner directive 2026-07-10): follow the room's fixed
    // refill tour - same path every lap, skip full stops. Each hauler joins
    // the loop AT ITS OWN position (nearest stop), so a fleet spaces itself
    // spatially - the old ID-rotation "belt" faked spacing while touring the
    // cluster in random order, walking right past adjacent empties (observed
    // live). Spawning drains in the same order (SpawningCorp), so holes form
    // a contiguous run the bus sweeps.
    const circuit = roomCircuit(room);
    const needySet = new Map<string, StructureSpawn | StructureExtension>(needy.map(s => [s.id as string, s]));
    let fromIdx = creep.memory.circuitIdx;
    if (fromIdx === undefined || !circuit[fromIdx]) {
      // Join the loop at the stop nearest the creep.
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < circuit.length; i++) {
        const s = needySet.get(circuit[i]);
        if (!s) continue;
        const d = creep.pos.getRangeTo(s.pos);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      fromIdx = best;
    }
    const stopIdx = nextStop(circuit, fromIdx, id => needySet.has(id));
    if (stopIdx === null) return false; // every stop full
    creep.memory.circuitIdx = stopIdx;
    const dest = needySet.get(circuit[stopIdx]);
    if (!dest) return false;
    if (creep.pos.isNearTo(dest.pos)) {
      // Serving this stop (the adjacent-first rule above already transferred
      // if possible); advance the tour for next tick.
      creep.memory.circuitIdx = (stopIdx + 1) % circuit.length;
    } else {
      // travelToQueued: refillers converge on the same tight cluster, so line up
      // behind whoever is already ahead toward this stop instead of swarming it -
      // and force-swap through a parked sibling that has no travel intent (a stuck
      // drop-off ring), rather than deadlocking behind it.
      travelToQueued(creep, dest, { range: 1, visualizePathStyle: { stroke: "#ffffff" } });
    }
    return true;
  }

  /**
   * Energy staged at the controller input right now: its container/link buffer,
   * else the bare drop pile on the input tile. The gauge {@link shouldBankControllerLoad}
   * reads to tell a healthy (feeder-maintained) buffer from genuine starvation.
   */
  private controllerInputStock(controller: StructureController): number {
    const spot = controllerDeliverySpot(controller);
    if (spot.structure) return spot.structure.store[RESOURCE_ENERGY] ?? 0;
    let stock = 0;
    for (const r of spot.pos.findInRange(FIND_DROPPED_RESOURCES, 1)) {
      if (r.resourceType === RESOURCE_ENERGY) stock += r.amount;
    }
    return stock;
  }

  /**
   * Deliver to the controller's consumers: an upgrader container, then the
   * upgrader/builder creeps directly, then dropping adjacent to the controller.
   * Returns false when the room has no controller.
   */
  private deliverToController(creep: Creep, room: Room): boolean {
    const controller = room.controller;
    if (!controller) return false;

    // STORAGE-FIRST HUB: the long-range haulers stop at the storage and the feeder
    // runs the short last leg (owner 2026-07-11: "storage is primary, dedicated
    // feeder for controller"). Bank the load instead of hauling all the way to the
    // controller - but key the redirect off the controller INPUT BUFFER, not just a
    // live feeder: gating solely on the feeder meant that the instant the single,
    // non-blocking feeder died the whole controller-bound fleet reverted to the one
    // drop tile at once (the measured RCL-drop-off jam). See shouldBankControllerLoad:
    // haulers keep banking across a transient feeder gap while the buffer lasts, and
    // only feed the controller directly when it actually runs low (starvation) or the
    // bank is missing/full - so energy is never stranded.
    const bank = room.storage;
    const hasBankCapacity = !!(bank && bank.my && bank.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    if (
      shouldBankControllerLoad({
        hasBankCapacity,
        feederActive: !!room.memory.controllerFeederActive,
        controllerInputStock: this.controllerInputStock(controller)
      })
    ) {
      return this.deliverToStorage(creep, room);
    }

    // The controller node resolves its own input spot (upgrader container, else the
    // shared drop tile the camping upgraders ring - see nodeEnergy). The hauler just
    // routes there and deposits; no chasing whichever upgrader has the most room
    // (that pick flips every tick and turns the route into a shuffle).
    const spot = controllerDeliverySpot(controller);
    if (spot.structure) {
      // Container/link: transfer from range 1, no need to stand on it. travelToQueued
      // so a fleet routed here lines up rather than swarming the buffer, and a ring
      // of parked upgraders still can't wall the hauler out of range-1 access.
      if (creep.pos.getRangeTo(spot.pos) > 1) {
        travelToQueued(creep, spot.pos, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
        return true;
      }
      const moved = Math.min(
        creep.store[RESOURCE_ENERGY],
        spot.structure.store.getFreeCapacity(RESOURCE_ENERGY) ?? creep.store[RESOURCE_ENERGY]
      );
      creep.transfer(spot.structure, RESOURCE_ENERGY);
      this.recordProduction(moved);
      return true;
    }
    // Bare drop tile (no container yet): the pile must land EXACTLY on the input
    // tile so every parked upgrader ringing it (range 1) can withdraw from one
    // shared pile. A range-2 drop lands on the hauler's own tile, scattered out of
    // the ring's reach - the RCL2 starve. So stand ON the input tile and drop there;
    // travelToQueued lines up multiple haulers behind the one servicing the tile and
    // still force-swaps through a parked upgrader when the ring has no open gap.
    if (!creep.pos.isEqualTo(spot.pos)) {
      travelToQueued(creep, spot.pos, { range: 0, visualizePathStyle: { stroke: "#ffaa00" } });
      return true;
    }
    const carried = creep.store[RESOURCE_ENERGY];
    creep.drop(RESOURCE_ENERGY);
    this.recordProduction(carried);
    return true;
  }

  /**
   * Get number of active hauler creeps.
   */
  public getCreepCount(): number {
    return this.getAssignedCreeps().length;
  }

  /**
   * Total CARRY parts the fleet currently fields. Used to size the fleet by actual
   * capacity rather than creep count, so a fleet of runts (spawned small under
   * energy pressure) is recognised as under-capacity and topped up.
   */
  private fieldedCarry(): number {
    return this.getAssignedCreeps().reduce((sum, c) => sum + c.getActiveBodyparts(CARRY), 0);
  }

  /**
   * Delivery-aware fleet strength for spawn planning: creeps (INCLUDING ones
   * still spawning - the successor already in the pipe) that will still staff
   * the route past their replacement lead time (see staffsPost). Excludes
   * expiring incumbents so their successors spawn spawnTime + walk early, and
   * recycling runts (already retiring by choice).
   */
  private staffing(distance: number): { count: number; carry: number } {
    let count = 0;
    let carry = 0;
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId !== this.id && creep.memory.corpId !== this.nodeId) continue;
      if (creep.memory.workType !== "haul") continue;
      // Recycling creeps still count (parity with getAssignedCreeps): the
      // pounce swap manages its own replacement; excluding them double-orders.
      if (!staffsPost(creep.ticksToLive, creep.body?.length ?? 0, distance)) continue;
      count += 1;
      carry += creep.getActiveBodyparts(CARRY);
    }
    return { count, carry };
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
   * A source's hauler carries its harvested energy to the spawn/controller. The
   * first hauler is "blocking" - without it the paired miner's energy is
   * stranded - and produces income. The hauler is sized (CARRY:MOVE pairs) to
   * the flow-solved carry-part requirement; it can be spawned small and scaled.
   */
    public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const assignments = this.getHaulerAssignments();
    if (assignments.length === 0) return [];

    // DEFENSE ECONOMICS (owner 2026-07-10): no new haulers for a route whose
    // pickup room is hostile (sighted, or inside a sighted hostile's TTL
    // bound). Existing haulers run out; funding resumes on all-clear. The
    // room comes from the nodeId (its leading segment is the source's room),
    // which needs no Game objects - harness-safe.
    if (hostileRooms().has(this.nodeId.split("-")[0])) return [];

    // Spec 13 phase 2b (The International's pathsThrough): the circuit is
    // also defunded when any room it TRANSITS is hostile - a clear pickup
    // room two rooms out does not make the drive through the raid safe.
    // Route check only when the spawn resolves (harness degrades to above).
    const homeSpawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (homeSpawn && routeIsDangerous(this.nodeId.split("-")[0], homeSpawn.room.name)) return [];

    // If this source is reserved for the builder, field no haulers - its energy
    // belongs to the construction tankers.
    if (this.yieldsToBuild()) return [];

    const carryNeeded = this.haulCarryNeeded(ctx.storageBacked === true);
    if (carryNeeded <= 0) return [];

    const maxCarryPerHauler = maxCarryPairs(ctx.energyCapacity);
    const targetHaulers = Math.max(1, Math.ceil(carryNeeded / maxCarryPerHauler));

    // Delivery-aware staffing (staffsPost): a hauler inside its replacement
    // lead time keeps driving its circuit but stops counting toward the fleet,
    // so its successor spawns early enough to take over without a carry dip.
    // The LONGEST route's one-way distance approximates the walk to the
    // pickup post (max, not assignments[0]: route order is not meaningful,
    // and over-leading costs a few overlap ticks while under-leading
    // reintroduces the carry dip on the long route).
    const routeWalkTicks = Math.max(...assignments.map(a => a.distance)) * travelTicksPerTile(ctx.energyCapacity);
    const { count: current, carry: fieldedCarry } = this.staffing(routeWalkTicks);

    // Stop once the fleet has BOTH the planned count and enough total CARRY. The
    // count alone is not enough: under energy pressure haulers spawn at the runt
    // floor (see minCost below), so the planned count can be reached while the
    // fielded CARRY still falls short of the route. A source left under-hauled piles
    // its energy up, which keeps the spawn starved and the next hauler a runt too -
    // a self-sustaining stall. Keep adding haulers until the CARRY is actually
    // covered, capped at twice the planned count so a pathologically starved room
    // can't spawn an unbounded swarm.
    // EXIT VERDICT (spec 14): which gate ended this sizing walk. The upgrader
    // has carried a `demand` verdict since t72455355 for exactly this reason -
    // "targetCount 6 with ONE fielded creep and NO agenda entry" was
    // undiagnosable without it. The fidelity cells show fielded carry landing
    // at 53-74% of plan with the spawn 54-82% IDLE, so the shortfall is a
    // DEMAND-side gate, not affordability - and two gates here can produce it.
    this.lastExit = "staffed";
    if (current >= targetHaulers && fieldedCarry >= carryNeeded) return [];
    // The swarm cap stays on the PHYSICAL count: replacement overlap may field
    // one extra body per expiring hauler, but never an unbounded swarm.
    // THE SWARM CAP IS DENOMINATED IN CARRY, like the gate above it.
    //
    // It used to cap the physical COUNT at 2x targetHaulers while the gate
    // above stops on CARRY. Those are different currencies, and when the
    // fielded bodies are smaller than the planner sized them, 2x the count is
    // reachable while the carry is still short - so the corp stopped asking at
    // a PERMANENT deficit, with spawn capacity going spare.
    //
    // Measured 2026-08-02 in all three plan-fidelity cells: fielded carry
    // 53-74% of plan with the spawn 54-82% IDLE, and the controller shortfall
    // tracking the carry shortfall across every one (74%->46%, 67%->42%,
    // 53%->34%). Reproduced deterministically in CarryCorp.behavior: four
    // 1-CARRY runts satisfy a 2x count cap on a 6-CARRY route carrying 4.
    //
    // The runaway protection is real and kept - a starved room must not spawn
    // an unbounded swarm - but it belongs in the same unit as the need. A fleet
    // already carrying twice the route's requirement is a swarm by any
    // definition; one that is count-heavy but carry-short is just undersized.
    // The absolute body ceiling stays as a hard backstop for the pathological
    // case where bodies are so small that even 2x carry needs a crowd.
    this.lastExit = "swarm-cap";
    if (fieldedCarry >= carryNeeded * 2) return [];
    if (this.getCreepCount() >= HAULER_BODY_CEILING) return [];
    this.lastExit = "asking";

    // Size while FILLING the planned fleet by an EVEN share of the route's carry -
    // not a greedy "max out each body and leave whatever is left for the last one",
    // which leaves a runt tail whenever the route doesn't divide into full bodies
    // (a 4-CARRY route at a 3-CARRY-body cap builds 3 + 1, and that 1-CARRY runt
    // moves only 50 energy a round trip yet holds a fleet slot for its whole life;
    // the even split makes it 2 + 2). Each index gets the floor share and the first
    // `remainder` get one more - deterministic from spawn order. Once PAST the
    // planned count we are healing a runt fleet (bootstrap under-built the bodies),
    // so target the ROUTE'S per-body share: the scheduler scales it down to
    // whatever energy is on hand, but on a flush tick it lands a right-sized
    // hauler that flagRuntForRecycling can then swap a runt for - converging
    // toward fewer bodies that between them cover the route exactly.
    //
    // That share, NOT the room's maxCarryPerHauler (production audit
    // 2026-07-31, t72695674): sizing the heal to spawn capacity bought a
    // 25-CARRY / 2500e body to close a 4-CARRY hole on a 7-CARRY route, and the
    // recycle path then retired the 8-CARRY incumbent that had covered it. A
    // standing churn loop on every short route, measured at 2.1x the plan's
    // hauler spawn load while the STANDING fleet matched the plan's carry.
    let desiredCarry: number;
    if (current < targetHaulers) {
      const base = Math.floor(carryNeeded / targetHaulers);
      const remainder = carryNeeded % targetHaulers;
      desiredCarry = base + (current < remainder ? 1 : 0);
    } else {
      desiredCarry = haulerBodyCarry(ctx.energyCapacity, carryNeeded);
    }
    desiredCarry = Math.max(1, Math.min(maxCarryPerHauler, desiredCarry));
    // The grant IS the debit (methodology #8): price the body this demand
    // actually elicits at its route's ratio, not a flat 100e/CARRY. The flat
    // price over-granted 2:1 road bodies ~33% (75e/CARRY built) - and the
    // scheduler debits st.energyLeft by the GRANT, so the over-ask also
    // suppressed same-tick purchases further down the agenda - while 1:2
    // swamp bodies (150e/CARRY) were under-granted and built short.
    const ratio = assignments[0].haulerRatio ?? "1:1";
    const desiredCost = haulerBodyCost(desiredCarry, ratio);

    // HOLD TO FUND on served routes (owner 2026-08-03: "we have basically
    // over-spawned the haulers... choosing to spawn an extra creep"). The
    // cheap floor below let EVERY purchase execute at whatever the bank held,
    // and the blackbox ring caught the consequence: cd94 bought three haulers
    // in 325 ticks sized 18 -> 30 -> 33 parts - each affordability-scaled,
    // each shortfall then legitimately HEALED with another body, every small
    // body persisting its full 1500 ticks. Raid-route fleets measured 2.2x
    // their route need (cbd5 50/22, cd94 42/19) while single-body routes sat
    // at 1.0-1.3x. So the upgraders' holdToFund doctrine applies here too:
    // with a body already DRIVING the route (physical count, nothing
    // stranded), a heal/replacement WAITS for the full even-share body. The
    // floor survives only where its own defense holds - the FIRST hauler on
    // a dark route, where income is stranded and restart speed beats body
    // size (requiring a full-size body before the spawn is full would
    // deadlock the bootstrap).
    const HAULER_MIN_CARRY = 3;
    // Same basis as desiredCost: the floor body's TRUE cost at this route's
    // ratio, never above the full ask.
    // STORAGE-BACKED rooms hold to fund even on a DARK route (owner
    // 2026-08-03: the floor is an upstart mechanism; the tender refills the
    // bank from the warchest regardless of this route's income, so the
    // deadlock the floor defends against cannot occur - and the floor body
    // is what STARTS the cee0 runt ladder).
    const minCost =
      this.getCreepCount() >= 1 || ctx.storageBacked === true
        ? desiredCost
        : Math.min(haulerBodyCost(Math.min(desiredCarry, HAULER_MIN_CARRY), ratio), desiredCost);

    return [
      {
        buyerCorpId: this.id,
        role: "hauler",
        value: 90 + Math.min(carryNeeded, 20),
        // The first hauler is blocking (the source's energy is stranded without
        // any carrier); additional haulers are scaling capacity (non-blocking).
        // PHYSICAL count: a lead-time replacement's incumbent is still driving
        // its circuit, so nothing is stranded and the demand must not trigger
        // the scheduler's strict blocking hold every hauler generation.
        blocking: this.getCreepCount() === 0,
        // Excluded live incumbents make this a replacement: it must HOLD
        // (mustFund) or cheap streams starve it until the incumbent dies.
        replacement: this.getCreepCount() > current,
        producesIncome: true,
        desiredCost,
        minCost,
        since: 0,
        bodyParam: desiredCarry,
        haulerRatio: assignments[0].haulerRatio
      }
    ];
  }

  // ===========================================================================
  // FLOW INTEGRATION
  // ===========================================================================

  /**
   * Set hauler assignments from FlowEconomy.
   * Each assignment describes a route from source to sink with CARRY requirements.
   */
  public setHaulerAssignments(assignments: HaulerAssignment[]): void {
    this.haulerAssignments = assignments;
  }

  /**
   * Get all hauler assignments for this corp.
   */
  public getHaulerAssignments(): HaulerAssignment[] {
    return this.haulerAssignments;
  }

  /**
   * Seed the pickup position from the commission (consumes.at = the source's
   * haul spot). A hint only: the live source position replaces it whenever the
   * source resolves, and a hint never overwrites what vision established.
   */
  public setPickupHint(pos: Position | undefined): void {
    if (!pos || this.pickupPos) return;
    this.pickupPos = pos;
  }

  /**
   * CARRY parts the hauler fleet should staff: this source's SPAWN + CONTROLLER
   * routes only. Construction is excluded because the builder is fed by the
   * construction tankers - sizing (and therefore sending) haulers for the
   * builder's energy is what lets them show up and grab it. A source routed
   * entirely to construction yields zero here, so it fields no haulers and its
   * energy is left for the tankers.
   */
  private haulCarryNeeded(storageBacked: boolean): number {
    const routes = this.haulerAssignments.filter(a => !(a.toId ?? "").startsWith("construction-"));
    if (routes.length === 0) return 0; // construction-only: the tankers own this energy, pile or no pile
    const sustained = routes.reduce((sum, a) => sum + a.carryParts, 0);

    // MATURE (storage-backed): ONE VALVE - the ask IS the sum of the
    // plan-priced routes, nothing added (the double-drain, F1 ask-gap
    // t72760734). The corp's own bufferDrainCarry(staged, d) re-add - born
    // 2026-07-29 when the plan was drain-blind (cd8e staged 3874,
    // carryNeeded 1, t72654979) - became a DOUBLE-COUNT the day the phase-1
    // repricing priced the same law into the routes themselves: staged
    // mining routes in carryParts (CorpPlanner `h.carryParts +=
    // drainCarry`), scavenge routes in their very rate (scavengeRate =
    // amount/2 / effectiveLife), the bank in bankSurplusRate. Measured
    // live: cbd8 plan 37.5 CARRY, corp ask 45 = 37.5 + its own ~7.5 again.
    // If a pile grows between solves the replan reprices the routes (spec
    // 36); if the plan under-asks, FIX THE PLAN.
    if (storageBacked) return Math.ceil(sustained);

    // BOOTSTRAP keeps the belt-and-suspenders drain (the same doctrine that
    // keeps runtUpsizeThreshold's +1 crank: escape velocity beats waiting
    // when nothing guarantees refill). Here the pile-clearance margin IS the
    // ramp - measured 2026-08-03: with this term removed the runt-economy
    // world plateaued at 300/550 for 900 ticks and the recycled miner's
    // full-size successor never afforded (the plan's once-per-solve drain
    // was too slow for a cold economy living solve-to-solve). A cold room
    // over-asking by one drain share buys its escape; a mature room doing
    // the same buys F1's breach - the regimes genuinely differ.
    const staged = this.readPickupBuffer().staged;
    if (staged === null || staged <= 0) return Math.ceil(sustained);
    const drain = routes.reduce((sum, a) => {
      const share = sustained > 0 ? a.carryParts / sustained : 1 / routes.length;
      return sum + bufferDrainCarry(staged * share, a.distance ?? 0);
    }, 0);
    return Math.ceil(sustained + drain);
  }

  /**
   * The bootstrap/mature discriminator at call sites that carry no
   * SpawnDemandContext: is this corp's HOME (spawn) room storage-backed?
   * Same `.my === true` shape the SpawnDirector stamps into
   * ctx.storageBacked, so the two paths cannot disagree. False on any
   * harness gap - degrading keeps the bootstrap (belt-and-suspenders) path
   * and never fabricates maturity from a read we do not have.
   */
  private homeStorageBacked(): boolean {
    try {
      const sp = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
      return sp?.room?.storage?.my === true;
    } catch {
      return false;
    }
  }

  /**
   * Decision-site read (spec 14, source-pileup instrument 2026-07-26): the
   * ACTUAL energy staged at this corp's source pickup and whether that source
   * is served by a LINK - the two facts hauler sizing does NOT currently read.
   * `haulCarryNeeded` sizes to sustained inflow only (carryPartsFor, no
   * buffer-drain term), so a delivery gap ratchets the pile up permanently
   * (~8.5k rotting above the 2000 container cap, measured t72588289). This
   * stamp lets the next capture distinguish the two candidate mechanisms
   * WITHOUT changing behaviour:
   *  - staged high, NO link (or a link with headroom) => the fleet is
   *    under-sized (the missing drain term is the fix);
   *  - staged high, an adjacent link at/near capacity => a LINK-throughput
   *    backlog (the hub link is clamped, the source link can't offload - a
   *    different fix, on the link network, not the haulers).
   * `staged` is null when the pickup room is not visible this tick (remote, no
   * creep on station) - a different fact from zero, and the signal that a
   * remote drain term must read a durable buffer signal, not live vision.
   * Harness-safe: room.find + a Chebyshev range filter, guarded.
   */
  private readPickupBuffer(): {
    staged: number | null;
    srcLinkEnergy: number | null;
    srcLinkCap: number | null;
  } {
    const none = { staged: null, srcLinkEnergy: null, srcLinkCap: null };
    const pos = this.pickupPos;
    if (!pos) return none;
    const room = Game.rooms[pos.roomName];
    if (!room) return none; // not visible => unmeasurable, distinct from zero
    const near = (p: { x: number; y: number }, range: number): boolean =>
      Math.max(Math.abs(p.x - pos.x), Math.abs(p.y - pos.y)) <= range;
    try {
      let staged = 0;
      for (const s of room.find(FIND_STRUCTURES) as AnyStructure[]) {
        if (s.structureType === STRUCTURE_CONTAINER && near(s.pos, 1)) {
          staged += (s as StructureContainer).store?.[RESOURCE_ENERGY] ?? 0;
        }
      }
      for (const r of room.find(FIND_DROPPED_RESOURCES)) {
        if (r.resourceType === RESOURCE_ENERGY && near(r.pos, 1)) staged += r.amount ?? 0;
      }
      const link = (room.find(FIND_MY_STRUCTURES) as AnyOwnedStructure[]).find(
        s => s.structureType === STRUCTURE_LINK && near(s.pos, 2)
      ) as StructureLink | undefined;
      return {
        staged,
        srcLinkEnergy: link ? link.store[RESOURCE_ENERGY] ?? 0 : null,
        srcLinkCap: link ? link.store.getCapacity(RESOURCE_ENERGY) ?? 0 : null
      };
    } catch {
      return none; // partial mock without a wired find - unmeasurable
    }
  }

  /** This corp's source game id (from its flow assignments). */
  private mySourceId(): string | undefined {
    const a = this.haulerAssignments[0];
    return a ? stripSourcePrefix(a.fromId) : undefined;
  }

  /**
   * True when this corp's source has been reserved for the builder: it stands
   * down (fields no haulers, and existing ones stop drawing from it) so the
   * construction tankers get the source's full output. The reservation is set
   * by ConstructionCorp in room memory while a build is active.
   *
   * The stand-down holds only while the crew KEEPS PACE. Stock backing up
   * past the drain lens (shouldDrainDedicatedSource) means the crew is not
   * consuming the output whatever its body count says - standing WORK is
   * capability, not throughput (crews walk, split across sites, wait on
   * tankers) - so the haulers keep their routes and the un-eaten output flows
   * home. This is the macro doctrine's actual-stock signal, not a fallback:
   * retiring it (owner directive 2026-07-28, attempted same day) broke the
   * refill-SLA class deterministically and collapsed fid-t5-real-maze 50->16%
   * gross. The reservation/valve/tanker-pinning/upgrader-damping bundle is
   * coupled - the redesign fork is spec 34 open item 5, owner-gated.
   */
  private yieldsToBuild(): boolean {
    // Spec 25 phase 3: the trunk-receipt stand-down is retired - the PLAN now
    // routes a trunk-building source's output (local sinks first, residual
    // home), and this corp fields haulers only for planned routes, so the
    // stand-down is the routing itself. Only the home-room dedicated-source
    // mechanism below remains (predates trunks).
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const dedicated = spawn?.room.memory.dedicatedBuildSourceId;
    if (!dedicated || this.mySourceId() !== dedicated) return false;

    const source = Game.getObjectById(dedicated as Id<Source>);
    if (!source) return true;

    const container = this.sourceContainerAt(source);
    const containerEnergy = container ? container.store[RESOURCE_ENERGY] : null;
    const containerCapacity = container ? container.store.getCapacity(RESOURCE_ENERGY) || 2000 : 0;
    // The miner drops on the ground when there is no container; count that pile
    // too, so a bare-pile source doesn't leave the route frozen while energy decays.
    const groundPile = source.pos
      .findInRange(FIND_DROPPED_RESOURCES, 1, { filter: r => r.resourceType === RESOURCE_ENERGY })
      .reduce((sum, r) => sum + r.amount, 0);

    if (shouldDrainDedicatedSource(containerEnergy, containerCapacity, groundPile)) return false;
    return true;
  }

  /** The static container on a source's tile, if any (where the miner deposits). */
  private sourceContainerAt(source: Source): StructureContainer | null {
    const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: s => s.structureType === STRUCTURE_CONTAINER
    }) as StructureContainer[];
    return containers[0] ?? null;
  }

  /**
   * Get total flow rate from all assignments.
   */
  public getTotalFlowRate(): number {
    return this.haulerAssignments.reduce((sum, h) => sum + h.flowRate, 0);
  }

  /**
   * Budgeted energy/tick: the total flow the plan routed through this corp's
   * haul assignments. Matches recordProduction's unit (energy delivered). 0 when
   * unassigned, excluding the corp from variance until the planner funds it.
   */
  public budgetedRate(): number {
    return this.getTotalFlowRate();
  }

  /**
   * Get the assignment for a specific source (by game ID).
   * Returns the route a hauler should take from this source.
   */
  public getAssignmentForSource(sourceGameId: string): HaulerAssignment | undefined {
    const sourceFlowId = `source-${sourceGameId}`;
    return this.haulerAssignments.find(h => h.fromId === sourceFlowId);
  }

  /**
   * Serialize for persistence.
   */
  public serialize(): SerializedCarryCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      haulerAssignments: this.haulerAssignments.length > 0 ? this.haulerAssignments : undefined,
      pickupPos: this.pickupPos ?? undefined,
      dutyAlive: this.dutyAlive,
      dutyActive: this.dutyActive,
      dutyIdleSource: this.dutyIdleSource,
      dutyIdleSink: this.dutyIdleSink,
      dutyIdleSinkAtSink: this.dutyIdleSinkAtSink,
      dutyIdleSinkStorageRoom: this.dutyIdleSinkStorageRoom,
      dutySince: this.dutySince
    };
  }

  /**
   * Deserialize from persistence.
   */
  public deserialize(data: SerializedCarryCorp): void {
    super.deserialize(data);
    this.haulerAssignments = data.haulerAssignments ?? [];
    this.pickupPos = data.pickupPos ?? null;
    this.dutyAlive = data.dutyAlive ?? 0;
    this.dutyActive = data.dutyActive ?? 0;
    this.dutyIdleSource = data.dutyIdleSource ?? 0;
    this.dutyIdleSink = data.dutyIdleSink ?? 0;
    this.dutyIdleSinkAtSink = data.dutyIdleSinkAtSink ?? 0;
    this.dutyIdleSinkStorageRoom = data.dutyIdleSinkStorageRoom ?? 0;
    this.dutySince = data.dutySince ?? 0;
  }
}

/**
 * Create a CarryCorp for a room.
 */
export function createCarryCorp(room: Room, spawn: StructureSpawn): CarryCorp {
  const nodeId = `${room.name}-hauling`;
  return new CarryCorp(nodeId, spawn.id);
}
