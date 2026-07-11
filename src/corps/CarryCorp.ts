/**
 * @fileoverview CarryCorp - Manages hauler creeps.
 *
 * CarryCorp is a transport service that moves energy from sources to destinations.
 *
 * @module corps/CarryCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { CoreDepot, controllerDeliverySpot, coreDepot, scavengeSpot, sourcePickupSpot, workSpot } from "./nodeEnergy";
import { travelTo, travelToQueued } from "./movement";
import { driveRecycle, pickRuntToRecycle } from "./recycle";
import { CARRY_CAPACITY, CREEP_LIFETIME, carryPartsFor, effectiveLife, staffsPost } from "../economy/primitives";
import { HaulerAssignment } from "../flow/FlowTypes";
import { buildHaulerBody } from "../spawn/BodyBuilder";
import { ChainScene, CorpEconomics, travelTicksPerTile } from "./economics";
import { nextStop, roomCircuit } from "./refillCircuit";
import { hostileRooms } from "../utils/RoomDiscovery";
import { Position } from "../types/Position";

// Re-exported so existing call sites/tests can import it from CarryCorp.
export { pickRuntToRecycle };

/** Transport fee per energy unit (base cost before margin) */

/**
 * Decide which local sink a CarryCorp should deliver its next load to, balancing
 * deliveries across the node's sinks in proportion to the flow solver's
 * allocations (each assignment's flowRate). `delivered` is the running count of
 * loads sent to each sink so far. Pure so it can be unit tested directly.
 *
 * Sinks are classified by their flow `toId`: a "controller-*" destination is the
 * controller; anything else (spawn/extension network) is treated as the spawn.
 */
export type LocalSink = "spawn" | "controller" | "founding";

/**
 * Free capacity (energy) in the spawn network at or above which a hauler diverts
 * to refill it before anything else. The spawn + extensions are the colony's
 * most important sink - nothing can be spawned without them - but their flow
 * allocation is only the small staffing overhead, so a purely proportional split
 * lets the high-volume controller starve them. One extension's worth of free
 * space is enough to act on; smaller dribbles are left to the proportional split.
 */
const SPAWN_PRIORITY_FREE_CAPACITY = 50;

/**
 * Fill fraction below which a controller-bound hauler abandons its route to
 * refill the spawn network. The spawn keeps priority when it is seriously
 * depleted (would soon block spawning), but once it is at least this full the
 * controller gets its allocated share. Without this gate the controller hauler
 * diverted on a single empty extension (free >= 50, i.e. anything short of 100%
 * full) every trip, so the controller never received energy and RCL2 stalled.
 */
const SPAWN_DIVERT_FILL = 0.5;

/**
 * Small energy buffer kept in the core depot so the extension tender always has a
 * load on hand. Deliberately modest: it only needs to bridge between hauler drop-offs,
 * not bankroll the whole network - a large buffer would pull haulers off the
 * controller to keep refilling the depot (the energy split is the flow solver's job).
 */
const DEPOT_BUFFER = 150;

/**
 * Energy the spawn-circuit haulers keep BANKED in a real storage before spilling
 * surplus to the controller. A container depot only bridges between hauler
 * drop-offs (DEPOT_BUFFER); storage is the colony's bank - hold a real reserve
 * for spawn surges and downgrade insurance. Banking only redirects haulers
 * already on the spawn circuit (deliverToSpawn), never diverts controller-bound
 * ones (spawnNetworkHungry still uses the small bridge buffer), so the flow
 * solver's spawn/controller split is preserved while the bank slowly fills.
 */
const STORAGE_BANK = 10000;

/** The fill level deliverToSpawn tops the depot to before spilling surplus on. */
function depotBankTarget(depot: CoreDepot): number {
  return depot.structureType === STRUCTURE_STORAGE ? STORAGE_BANK : DEPOT_BUFFER;
}

/**
 * Fill fraction at which a dedicated build source's container is judged to be
 * "backing up": the builder isn't draining the source's full output (a runt
 * builder, or no active consumption), so the energy just accumulates in the
 * container and, once it caps out, overflows onto the ground and decays - wasted.
 * Above this the source's haulers resume and move the surplus to the core instead,
 * so the economy rebalances around whatever the builder actually consumes rather
 * than stranding the rest at the source. Half-full leaves ample headroom before
 * the container caps out.
 */
const DEDICATED_SOURCE_DRAIN_FILL = 0.5;

/**
 * Dropped energy (within range 1 of a dedicated build source) above which the
 * source's haulers RESUME and clear the surplus instead of yielding to the builder.
 * Without a container the miner drops straight on the ground, and the container
 * fill check above can't see it - so a bare-pile source would otherwise leave the
 * hauler frozen while a big pile grows and decays. This is the ground-pile analogue
 * of DEDICATED_SOURCE_DRAIN_FILL: a pile this size means the builder isn't keeping
 * pace, so the overflow should flow to the core.
 */
const DEDICATED_SOURCE_DRAIN_PILE = 300;

/**
 * Whether a hauler on the dedicated build source should RESUME hauling (drain the
 * surplus) rather than yield: true when energy is backing up - a container past the
 * drain fill, OR a ground pile past the drain threshold - meaning the builder isn't
 * consuming the source's full output. Pure so it can be unit tested directly.
 */
export function shouldDrainDedicatedSource(
  containerEnergy: number | null,
  containerCapacity: number,
  groundPile: number
): boolean {
  if (containerEnergy !== null && containerCapacity > 0) {
    if (containerEnergy >= containerCapacity * DEDICATED_SOURCE_DRAIN_FILL) return true;
  }
  return groundPile >= DEDICATED_SOURCE_DRAIN_PILE;
}

/**
 * Is the spawn network critically low ENOUGH to steal a controller-bound
 * hauler's trip, given the energy already aboard fleet-mates committed to the
 * spawn this trip? "Critical" must mean "and help is not already on the way":
 * during buildout the bank sits below the raw {@link SPAWN_DIVERT_FILL} gate
 * almost continuously (every spawn drains 200-500 from a 300-550 pool), so a
 * store-only test diverts the controller hauler on EVERY flip and the flow
 * solver's controller allocation - including the anti-downgrade reserve - is
 * never physically delivered (controller progress measured at zero for 700+
 * ticks; grid cells haul-t1-circuit-split / plan-t1-single-source-loop).
 * Counting inbound committed cargo keeps the true emergency behavior (nothing
 * inbound -> divert) while letting the controller keep its share whenever the
 * deficit is already covered. Pure so it can be unit tested directly.
 */
export function isSpawnNetworkCritical(used: number, capacity: number, inboundCommitted: number): boolean {
  if (capacity <= 0) return false;
  return (used + inboundCommitted) / capacity < SPAWN_DIVERT_FILL;
}

/**
 * Choose which local sink to commit a load to. The spawn network has strict
 * priority: whenever it has real free capacity, fill it first regardless of the
 * proportional allocation (the spawn is critical but small, so it tops up fast
 * and the surplus then flows on to construction/controller). Otherwise fall back
 * to the flow-proportional split. Pure so it can be unit tested directly.
 */
export function pickDeliverySink(
  spawnFreeCapacity: number,
  assignments: { toId: string; flowRate: number }[],
  delivered: { [sink: string]: number }
): LocalSink {
  if (spawnFreeCapacity >= SPAWN_PRIORITY_FREE_CAPACITY) return "spawn";
  return pickSinkByAllocation(assignments, delivered);
}

export function pickSinkByAllocation(
  assignments: { toId: string; flowRate: number }[],
  delivered: { [sink: string]: number },
  foundingSinks: ReadonlySet<string> = new Set()
): LocalSink {
  // Haulers serve the spawn network and the controller. IN-ROOM construction is
  // deliberately excluded - feeding builders is the construction tankers' job, not
  // the haulers' - so a local construction route never pulls a hauler off its
  // circuit. CROSS-ROOM construction (the expansion FOUNDING, spec 06) is the
  // exception: tankers are intra-room apparatus, so a route that crosses a border
  // has no tanker shortcut and the hauler runs it like any other circuit.
  const flows: Record<LocalSink, number> = { spawn: 0, controller: 0, founding: 0 };
  for (const a of assignments) {
    if (a.toId.startsWith("controller-")) flows.controller += a.flowRate;
    else if (a.toId.startsWith("construction-")) {
      if (foundingSinks.has(a.toId)) flows.founding += a.flowRate;
    } else flows.spawn += a.flowRate;
  }

  // Pick whichever sink with positive allocated flow is furthest behind its
  // share so far, distributing loads in proportion to the flow solver's per-sink
  // allocations.
  let best: LocalSink = "spawn";
  let bestScore = Infinity;
  let anyPositive = false;
  for (const sink of ["spawn", "controller", "founding"] as const) {
    if (flows[sink] <= 0) continue;
    anyPositive = true;
    const score = (delivered[sink] ?? 0) / flows[sink];
    if (score < bestScore) {
      bestScore = score;
      best = sink;
    }
  }
  return anyPositive ? best : "spawn";
}

/**
 * Serialized state specific to CarryCorp
 */
export interface SerializedCarryCorp extends SerializedCorp {
  spawnId: string;
  /** Flow-based hauler assignments (from FlowEconomy) */
  haulerAssignments?: HaulerAssignment[];
}

/**
 * CarryCorp manages hauler creeps that move energy around.
 */
export class CarryCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Creeps we've already recorded expected production for (session-only) */
  private accountedCreeps: Set<string> = new Set();

  /**
   * Flow-based hauler assignments from FlowEconomy.
   * Each assignment specifies a source → sink route with CARRY requirements.
   */
  private haulerAssignments: HaulerAssignment[] = [];

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

        if (!this.accountedCreeps.has(name)) {
          this.accountedCreeps.add(name);
          const carryCapacity = creep.store.getCapacity();
          const expectedDeliveries = (carryCapacity * CREEP_LIFETIME) / CARRY_CAPACITY; // Estimate
          this.recordExpectedProduction(expectedDeliveries);
        }
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

    this.flagRuntForRecycling(creeps, room, spawn);

    for (const creep of creeps) {
      if (creep.memory.recycling) {
        driveRecycle(creep, spawn);
      } else {
        this.runHauler(creep, room, spawn);
      }
    }
  }

  /** CARRY parts a single hauler can be built with at the room's full capacity. */
  private maxCarryPerHauler(room: Room): number {
    return Math.max(1, Math.min(Math.floor(room.energyCapacityAvailable / 100), 25));
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

    // Conditions ready: the spawn can immediately build a hauler with at least one
    // more CARRY than the smallest runt (1 CARRY + 1 MOVE = 100 energy per step).
    const PART_PAIR_COST = 100;
    if (room.energyAvailable < (minCarry + 1) * PART_PAIR_COST) return;

    creeps[carry.indexOf(minCarry)].memory.recycling = true;
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
      creep.say(creep.memory.deliverSinkId === "controller" ? "→ctrl" : creep.memory.deliverSinkId === "founding" ? "→found" : "→spawn");
    }

    // A clean bus: it fills completely at its source stop, then runs the route and
    // empties completely at its sink stop - no grabbing energy off-route mid-trip
    // (that energy belongs to its own source's bus). The state flips above only on
    // full and on empty, so the hauler waits at each stop until the transaction is
    // done rather than leaving with a partial load.
    if (creep.memory.working) {
      this.deliverEnergy(creep, room, spawn);
    } else {
      this.pickupEnergy(creep, room);
    }
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
   * Check if a hauler is already close to their target (within transfer range).
   * Used to anticipate arrival and prepare for delivery.
   */
  private isAtDeliveryTarget(creep: Creep): boolean {
    if (!creep.memory.deliveryTargetId) return false;
    const target = Game.getObjectById(creep.memory.deliveryTargetId as Id<Structure>);
    return target ? creep.pos.getRangeTo(target) <= 1 : false;
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
      const sourceGameId = assignment.fromId.replace("source-", "");

      // Scavenger: the "source" is a ground stock (no live object). Parse its
      // position from the id (scavenge-ROOM-X-Y) the same way as an intel source.
      if (sourceGameId.startsWith("scavenge-")) {
        const match = /^scavenge-([EW]\d+[NS]\d+)-(\d+)-(\d+)$/.exec(sourceGameId);
        if (match) {
          const [, roomName, x, y] = match;
          creep.memory.assignedSourcePos = { x: parseInt(x, 10), y: parseInt(y, 10), roomName };
        }
        return null;
      }

      // Check if this is an intel-based source (remote room without vision)
      if (sourceGameId.startsWith("intel-")) {
        // Intel source: parse position from ID format "intel-ROOMNAME-X-Y"
        const match = /^intel-([EW]\d+[NS]\d+)-(\d+)-(\d+)$/.exec(sourceGameId);
        if (match) {
          const [, roomName, x, y] = match;
          // Store position for navigation even without source object
          creep.memory.assignedSourcePos = { x: parseInt(x, 10), y: parseInt(y, 10), roomName };
        }
        return null; // No live source object for intel sources
      }

      const source = Game.getObjectById(sourceGameId as Id<Source>);
      if (source) {
        creep.memory.assignedSourceId = source.id;
        return source;
      }
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
    if (this.yieldsToBuild()) return;

    // DEGRADED-MODE REFILL (owner SLA 2026-07-10: extensions refill before the
    // draining spawn finishes): when NO tender is alive, the depot's bank is
    // otherwise invisible to refill - only tenders move depot -> extensions -
    // so a drained bank waits a full source round-trip while 2000 energy sits
    // one tile from the spawn. A spawn-circuit hauler reloads from the stocked
    // depot instead of trekking to its source whenever the network is short.
    // Tender alive -> the flag is true and this never triggers (the depot
    // stays the tender's exclusive reserve).
    // Unassigned haulers (pre-first-circuit) count as spawn-circuit here: the
    // earliest drains land exactly when nothing has flipped to working yet.
    if ((creep.memory.homeSink ?? "spawn") === "spawn" && room.memory.extensionTenderActive !== true) {
      const need = room.energyCapacityAvailable - room.energyAvailable;
      if (need > 0) {
        const depot = coreDepot(room);
        if (depot && depot.store[RESOURCE_ENERGY] > 0) {
          if (creep.withdraw(depot, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            travelTo(creep, depot, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
          }
          return;
        }
      }
    }

    const sources = room.find(FIND_SOURCES);
    const assignedSource = this.getAssignedSource(creep, sources);

    // The one fixed pickup stop on this hauler's bus route: its assigned source.
    let targetPos: RoomPosition | null = null;
    if (assignedSource) {
      targetPos = assignedSource.pos;
    } else if (creep.memory.assignedSourcePos) {
      const p = creep.memory.assignedSourcePos;
      targetPos = new RoomPosition(p.x, p.y, p.roomName);
    }
    if (!targetPos) return;

    if (targetPos.roomName !== creep.room.name) {
      travelTo(creep, targetPos, { visualizePathStyle: { stroke: "#ffaa00" } });
      return;
    }

    // A scavenger draws from a ground stock (tombstone / ruin / pile); an ordinary
    // hauler from its source's output spot (container / drop pile / wait tile). The
    // stock spot is null once drained - the scavenger then just carries home what
    // it has and stands down (re-detection drops the stock next economy rebuild).
    if (this.isScavenger()) {
      const spot = scavengeSpot(targetPos);
      if (spot) workSpot(creep, spot, "collect");
      return;
    }
    workSpot(creep, sourcePickupSpot(targetPos), "collect");
  }

  /** True when this corp serves a transient ground stock rather than a source. */
  private isScavenger(): boolean {
    return this.haulerAssignments[0]?.fromId.startsWith("scavenge-") ?? false;
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
    if (room.memory.extensionTenderActive) return this.spawnNetworkHungry(room);
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
    if (room.memory.extensionTenderActive) {
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
    const flows: Record<LocalSink, number> = { spawn: 0, controller: 0, founding: 0 };
    for (const a of this.haulerAssignments) {
      if (a.toId.startsWith("controller-")) flows.controller += a.flowRate;
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
    return this.deliverToSpawn(creep, room);
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
      travelTo(creep, site.pos, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
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
    // When the extension tender is active, haulers run the dumb source->depot bus:
    // keep the spawn STRUCTURE itself topped (one tile, no fanning across extensions)
    // so a dead tender can never deadlock the colony, then dump everything else into
    // the depot for the tender to distribute. This is what stops the schooling - the
    // haulers no longer chase a dozen half-full extensions.
    if (room.memory.extensionTenderActive) {
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
      if (r === ERR_NOT_IN_RANGE) travelTo(creep, busTarget, { visualizePathStyle: { stroke: "#ffffff" } });
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
          c.memory.workType === "tank" &&
          String(c.memory.corpId ?? "").includes("tender") &&
          c.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
          c.store[RESOURCE_ENERGY] < bankCapacity
      );
      if (tender && creep.store[RESOURCE_ENERGY] > 0) {
        const r = creep.transfer(tender, RESOURCE_ENERGY);
        if (r === ERR_NOT_IN_RANGE) travelTo(creep, tender, { range: 1, visualizePathStyle: { stroke: "#ffff88" } });
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
        this.recordProduction(Math.min(creep.store[RESOURCE_ENERGY], adjacent.store.getFreeCapacity(RESOURCE_ENERGY)));
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
   * Deliver to the controller's consumers: an upgrader container, then the
   * upgrader/builder creeps directly, then dropping adjacent to the controller.
   * Returns false when the room has no controller.
   */
  private deliverToController(creep: Creep, room: Room): boolean {
    const controller = room.controller;
    if (!controller) return false;

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
  /**
   * Project the economics of hauling this corp's routes from a given spawn: one
   * hauler per route, sized to its flow and distance, costed over the life left
   * after walking out to the pickup. Throughput is the energy it moves.
   */
  public project(scene: ChainScene): CorpEconomics {
    let costPerTick = 0;
    let throughput = 0;
    let spawnPartsPerTick = 0;
    for (const a of this.haulerAssignments) {
      const body = buildHaulerBody(a.flowRate, a.distance, scene.energyCapacity);
      if (body.cost === 0 || body.carryCapacity === 0) continue;
      // Energy in flight over the round trip sets the carry needed (1.2x margin
      // for path variability); one capped body may not cover a long/high-flow
      // route, so run as many as it takes - this is what makes hauling cost rise
      // properly with distance.
      const carryEnergyNeeded = carryPartsFor(a.flowRate, a.distance) * CARRY_CAPACITY * 1.2;
      const haulers = Math.max(1, Math.ceil(carryEnergyNeeded / body.carryCapacity));
      const pickup = scene.resource(a.fromId);
      const travel = pickup ? scene.dist(scene.spawnPos, pickup.pos) * travelTicksPerTile(scene.energyCapacity) : 0;
      const usefulLife = effectiveLife(travel);
      costPerTick += (haulers * body.cost) / usefulLife;
      // The hauler fleet is the part-hungry one: more haulers, each a bigger
      // body, the farther the route - this is the term that makes a far source
      // exhaust the spawn's build-rate budget.
      spawnPartsPerTick += (haulers * body.body.length) / usefulLife;
      throughput += a.flowRate;
    }
    return { costPerTick, throughput, spawnPartsPerTick };
  }

  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const assignments = this.getHaulerAssignments();
    if (assignments.length === 0) return [];

    // DEFENSE ECONOMICS (owner 2026-07-10): no new haulers for a route whose
    // pickup room is hostile (sighted, or inside a sighted hostile's TTL
    // bound). Existing haulers run out; funding resumes on all-clear. The
    // room comes from the nodeId (its leading segment is the source's room),
    // which needs no Game objects - harness-safe.
    if (hostileRooms().has(this.nodeId.split("-")[0])) return [];

    // If this source is reserved for the builder, field no haulers - its energy
    // belongs to the construction tankers.
    if (this.yieldsToBuild()) return [];

    const carryNeeded = this.haulCarryNeeded();
    if (carryNeeded <= 0) return [];

    const PART_PAIR_COST = 100; // 1 CARRY + 1 MOVE
    const maxCarryPerHauler = Math.max(1, Math.min(Math.floor(ctx.energyCapacity / PART_PAIR_COST), 25));
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
    if (current >= targetHaulers && fieldedCarry >= carryNeeded) return [];
    // The swarm cap stays on the PHYSICAL count: replacement overlap may field
    // one extra body per expiring hauler, but never an unbounded swarm.
    if (this.getCreepCount() >= targetHaulers * 2) return [];

    // Size while FILLING the planned fleet by an EVEN share of the route's carry -
    // not a greedy "max out each body and leave whatever is left for the last one",
    // which leaves a runt tail whenever the route doesn't divide into full bodies
    // (a 4-CARRY route at a 3-CARRY-body cap builds 3 + 1, and that 1-CARRY runt
    // moves only 50 energy a round trip yet holds a fleet slot for its whole life;
    // the even split makes it 2 + 2). Each index gets the floor share and the first
    // `remainder` get one more - deterministic from spawn order. Once PAST the
    // planned count we are healing a runt fleet (bootstrap under-built the bodies),
    // so target a FULL body: the scheduler scales it down to whatever energy is on
    // hand, but on a flush tick it lands a big hauler that flagRuntForRecycling can
    // then swap a runt for - converging toward fewer, full-size bodies.
    let desiredCarry: number;
    if (current < targetHaulers) {
      const base = Math.floor(carryNeeded / targetHaulers);
      const remainder = carryNeeded % targetHaulers;
      desiredCarry = base + (current < remainder ? 1 : 0);
    } else {
      desiredCarry = maxCarryPerHauler;
    }
    desiredCarry = Math.max(1, Math.min(maxCarryPerHauler, desiredCarry));
    const desiredCost = desiredCarry * PART_PAIR_COST;

    // Don't let the scheduler spawn a 1-CARRY runt under energy pressure: it
    // moves only 50 energy per round trip - useless on a real route - yet it
    // occupies one of the fleet's few slots for its whole 1500-tick life, so
    // realized throughput falls far below the planned fleet. Floor every hauler
    // at a useful minimum body. We deliberately do NOT hold out for the full
    // desired body: the first hauler is what refills the spawn, so requiring a
    // full-size body before the spawn is full would deadlock the bootstrap. The
    // floor is cheap enough that a partly-drained spawn can still afford it, the
    // scheduler scales up toward desiredCost whenever more energy is on hand, and
    // any undersized survivors are recycled and replaced once we are maxed out
    // and the spawn would otherwise idle.
    const HAULER_MIN_CARRY = 3;
    const minCost = Math.min(desiredCarry, HAULER_MIN_CARRY) * PART_PAIR_COST;

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
   * Check if this corp has flow-based assignments.
   */
  public hasFlowAssignments(): boolean {
    return this.haulerAssignments.length > 0;
  }

  /**
   * Get total CARRY parts needed from flow assignments.
   */
  public getTotalCarryPartsNeeded(): number {
    return this.haulerAssignments.reduce((sum, h) => sum + h.carryParts, 0);
  }

  /**
   * CARRY parts the hauler fleet should staff: this source's SPAWN + CONTROLLER
   * routes only. Construction is excluded because the builder is fed by the
   * construction tankers - sizing (and therefore sending) haulers for the
   * builder's energy is what lets them show up and grab it. A source routed
   * entirely to construction yields zero here, so it fields no haulers and its
   * energy is left for the tankers.
   */
  private haulCarryNeeded(): number {
    return Math.ceil(
      this.haulerAssignments
        .filter(a => !(a.toId ?? "").startsWith("construction-"))
        .reduce((sum, a) => sum + a.carryParts, 0)
    );
  }

  /** This corp's source game id (from its flow assignments). */
  private mySourceId(): string | undefined {
    const a = this.haulerAssignments[0];
    return a ? a.fromId.replace("source-", "") : undefined;
  }

  /**
   * True when this corp's source has been reserved for the builder: it must stand
   * down (field no haulers, and existing ones stop drawing from it) so the
   * construction tankers get the source's full output. The reservation is set by
   * ConstructionCorp in room memory while a build is active.
   *
   * The reservation holds only while the builder keeps the source's container
   * drained. If energy backs up past DEDICATED_SOURCE_DRAIN_FILL the builder can't
   * consume the source's full output (a runt builder, or no active consumption),
   * so we resume hauling the surplus to the core: the accumulated energy goes home
   * instead of overflowing the container and decaying on the ground. The builder,
   * sized to the whole source, holds the container near-empty in the normal case,
   * so haulers stay stood down.
   */
  private yieldsToBuild(): boolean {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const dedicated = spawn?.room.memory.dedicatedBuildSourceId;
    if (!dedicated || this.mySourceId() !== dedicated) return false;

    const source = Game.getObjectById(dedicated as Id<Source>);
    if (!source) return true;

    const container = this.sourceContainerAt(source);
    const containerEnergy = container ? container.store[RESOURCE_ENERGY] : null;
    const containerCapacity = container ? container.store.getCapacity(RESOURCE_ENERGY) || 2000 : 0;
    // The miner drops on the ground when there is no container; count that pile too,
    // so a bare-pile source doesn't leave the hauler frozen while energy decays.
    const groundPile = source.pos
      .findInRange(FIND_DROPPED_RESOURCES, 1, { filter: r => r.resourceType === RESOURCE_ENERGY })
      .reduce((sum, r) => sum + r.amount, 0);

    // Resume hauling (don't yield) whenever the surplus is backing up - the builder
    // is not keeping pace with the miner, so the overflow should flow to the core.
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
      haulerAssignments: this.haulerAssignments.length > 0 ? this.haulerAssignments : undefined
    };
  }

  /**
   * Deserialize from persistence.
   */
  public deserialize(data: SerializedCarryCorp): void {
    super.deserialize(data);
    this.haulerAssignments = data.haulerAssignments ?? [];
  }
}

/**
 * Create a CarryCorp for a room.
 */
export function createCarryCorp(room: Room, spawn: StructureSpawn): CarryCorp {
  const nodeId = `${room.name}-hauling`;
  return new CarryCorp(nodeId, spawn.id);
}
