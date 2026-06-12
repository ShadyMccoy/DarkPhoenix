/**
 * @fileoverview HarvestCorp - Manages harvester creeps.
 *
 * Harvesters harvest energy from sources and drop it on the ground
 * for haulers to pick up and deliver.
 *
 * @module corps/HarvestCorp
 */

import {
  CREEP_LIFETIME,
  HARVEST_RATE,
  SOURCE_ENERGY_CAPACITY,
  SOURCE_REGEN_TIME,
  calculateOptimalWorkParts
} from "../planning/EconomicConstants";
import { effectiveLife } from "../economy/primitives";
import { Corp, SerializedCorp } from "./Corp";
import { ChainScene, CorpEconomics, travelTicksPerTile } from "./economics";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { driveRecycle, pickRuntToRecycle } from "./recycle";
import { MinerAssignment } from "../flow/FlowTypes";
import { Position } from "../types/Position";
import { buildMinerBody } from "../spawn/BodyBuilder";
import { sourceHarvestSpot } from "./nodeEnergy";
import { travelTo } from "./movement";

/**
 * How a miner should move this tick.
 * - "spot":   go to the single static harvest tile (range 0) - drops land in the
 *             source container.
 * - "spread": go to ANY free tile adjacent to the source (range 1) - for extra
 *             miners when the static tile is taken.
 * - "stay":   already in position; just harvest.
 */
export type MinerApproach = "spot" | "spread" | "stay";

/**
 * Decide a miner's move. A poor room splits a source across several small miners
 * (see getSpawnDemand), but static mining points them ALL at one tile
 * (sourceHarvestSpot, range 0). If every extra miner insists on that one tile they
 * pile onto the single (occupied) tile, get blocked two tiles out, and never
 * harvest - the "miners standing around a source" bug. So only ONE miner claims the
 * static spot; the rest spread to the source's other adjacent tiles. Pure.
 */
export function minerApproach(onSpot: boolean, adjacentToSource: boolean, spotHeldByOther: boolean): MinerApproach {
  if (onSpot) return "stay";
  if (spotHeldByOther) return adjacentToSource ? "stay" : "spread";
  return "spot";
}

/**
 * Serialized state specific to HarvestCorp
 */
export interface SerializedHarvestCorp extends SerializedCorp {
  spawnId: string;
  sourceId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
  desiredWorkParts: number;
  targetMiners: number;
  /** Flow-based miner assignment (from FlowEconomy) */
  minerAssignment?: MinerAssignment;
}

/**
 * HarvestCorp manages harvester creeps that harvest energy.
 *
 * Harvesters:
 * - Go to assigned source
 * - Harvest energy
 * - Drop energy on ground (for haulers)
 */
/**
 * Fallback WORK parts for standard 3000-capacity sources.
 * Use calculateOptimalWorkParts() for actual capacity-based calculation.
 */
const DEFAULT_DESIRED_WORK = 5;

export class HarvestCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** ID of the source to harvest */
  private sourceId: string;

  /** Last tick we attempted to spawn */
  private lastSpawnAttempt = 0;

  /** Desired WORK parts for this mining operation */
  private desiredWorkParts: number;

  /** Target number of harvesters (computed during planning) */
  private targetMiners = 1;

  /** Creeps we've already recorded expected production for (session-only) */
  private accountedCreeps: Set<string> = new Set();

  /**
   * Flow-based miner assignment from FlowEconomy.
   * When set, this corp uses the assignment for spawn decisions instead
   * of its own hardcoded values.
   */
  private minerAssignment: MinerAssignment | null = null;

  /**
   * Get active creeps assigned to this corp.
   */
  private getActiveCreeps(): Creep[] {
    const creeps: Creep[] = [];

    // Scan for creeps with our corpId
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];

      if (creep.memory.corpId === this.id && !creep.spawning) {
        creeps.push(creep);

        if (!this.accountedCreeps.has(name)) {
          this.accountedCreeps.add(name);
          const workParts = creep.getActiveBodyparts(WORK);
          const expectedEnergy = workParts * 2 * CREEP_LIFETIME;
          this.recordExpectedProduction(expectedEnergy);
        }
      }
    }

    return creeps;
  }

  public constructor(
    nodeId: string,
    spawnId: string,
    sourceId: string,
    desiredWorkParts: number = DEFAULT_DESIRED_WORK,
    customId?: string
  ) {
    super("mining", nodeId, customId);
    this.spawnId = spawnId;
    this.sourceId = sourceId;
    this.desiredWorkParts = desiredWorkParts;
  }

  /**
   * Plan harvesting operations. Called periodically to compute targets.
   */
  public plan(tick: number): void {
    super.plan(tick);
    // One harvester with 5 WORK parts saturates a standard source (10 energy/tick)
    this.targetMiners = 1;
  }

  /**
   * Get the source position as the corp's location.
   */
  public getPosition(): Position {
    const source = Game.getObjectById(this.sourceId as Id<Source>);
    if (source) {
      return { x: source.pos.x, y: source.pos.y, roomName: source.pos.roomName };
    }

    // For intel-based sources, parse position from ID format: "intel-ROOMNAME-X-Y"
    if (this.sourceId.startsWith("intel-")) {
      const match = /^intel-([EW]\d+[NS]\d+)-(\d+)-(\d+)$/.exec(this.sourceId);
      if (match) {
        const [, parsedRoom, x, y] = match;
        return { x: parseInt(x, 10), y: parseInt(y, 10), roomName: parsedRoom };
      }
    }

    // Fallback: extract room name from nodeId
    const roomMatch = /^([EW]\d+[NS]\d+)/.exec(this.nodeId);
    const roomName = roomMatch ? roomMatch[1] : this.nodeId.split("-")[0];
    return { x: 25, y: 25, roomName };
  }

  /**
   * Main work loop - run harvester creeps.
   */
  public work(tick: number): void {
    this.lastActivityTick = tick;

    // Try to get the source object directly
    let source = Game.getObjectById(this.sourceId as Id<Source>);

    // For intel-based sources (remote rooms), source might be null until we have vision
    // Parse position from intel source ID format: "intel-ROOMNAME-X-Y"
    const isIntelSource = this.sourceId.startsWith("intel-");
    let targetPos: RoomPosition | null = null;

    if (!source && isIntelSource) {
      const match = /^intel-([EW]\d+[NS]\d+)-(\d+)-(\d+)$/.exec(this.sourceId);
      if (match) {
        const [, roomName, x, y] = match;
        targetPos = new RoomPosition(parseInt(x, 10), parseInt(y, 10), roomName);

        // If we now have vision of the room, try to find the actual source
        const room = Game.rooms[roomName];
        if (room) {
          const sources = room.find(FIND_SOURCES);
          source = sources.find(s => s.pos.x === parseInt(x, 10) && s.pos.y === parseInt(y, 10)) ?? null;
        }
      }
    }

    if (!source && !targetPos) {
      console.log(`[Harvest] ${this.id}: source ${this.sourceId} not found`);
      return;
    }

    // Run all assigned creeps
    const creeps = this.getActiveCreeps();

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) this.flagMinerRuntForRecycling(creeps, spawn);

    for (const creep of creeps) {
      if (creep.memory.recycling && spawn) {
        driveRecycle(creep, spawn);
      } else if (source) {
        this.runHarvester(creep, source);
      } else if (targetPos) {
        // No vision yet - just move toward the target position
        this.moveToRemoteSource(creep, targetPos);
      }
    }
  }

  /**
   * Retire an undersized bootstrap miner so its corp respawns it at full size.
   * The first miner is floored small so the cold economy can afford it; left
   * alone it caps the source's output for its whole 1500-tick life.
   *
   * We recycle a runt once the room can IMMEDIATELY rebuild it one size larger
   * (energyAvailable covers a bigger body): the replacement is a guaranteed
   * upgrade and spawns with minimal unmined gap. The old gate required the room
   * to be fully maxed (energyAvailable >= energyCapacityAvailable), but a runt
   * under-mines the source that fills the room - so a thin room never reached
   * "maxed" and the runt was immortal, holding the whole economy down (the
   * runt catch-22). The affordability check still keeps us from disrupting a
   * miner in a room that genuinely cannot build a bigger one.
   */
  private flagMinerRuntForRecycling(creeps: Creep[], spawn: StructureSpawn): void {
    if (!this.minerAssignment) return;
    if (spawn.spawning) return; // don't compete with an in-progress spawn
    if (creeps.some(c => c.memory.recycling)) return; // one at a time

    const room = spawn.room;
    const totalWork = Math.max(1, Math.ceil(this.minerAssignment.harvestRate / 2));
    const maxWorkPerMiner = Math.max(1, buildMinerBody(totalWork, room.energyCapacityAvailable).workParts);
    const workCounts = creeps.map(c => c.getActiveBodyparts(WORK));
    const idx = pickRuntToRecycle(workCounts, totalWork, maxWorkPerMiner);
    if (idx === null) return;

    // Only recycle once we can afford to rebuild this runt at least one WORK
    // larger right now - guarantees a real upgrade and no long unmined gap.
    const upgradeWork = Math.min(maxWorkPerMiner, workCounts[idx] + 1);
    const upgradeCost = buildMinerBody(upgradeWork, room.energyCapacityAvailable).cost;
    if (room.energyAvailable < upgradeCost) return;

    creeps[idx].memory.recycling = true;
  }

  /**
   * Move creep toward a remote source position (when we don't have vision).
   */
  private moveToRemoteSource(creep: Creep, targetPos: RoomPosition): void {
    // travelTo crosses the border without bouncing: once the creep enters the
    // target room on its exit edge, it steps inward instead of flipping back.
    travelTo(creep, targetPos, { visualizePathStyle: { stroke: "#ffaa00" } });
  }

  /**
   * Run a single harvester creep.
   */
  private runHarvester(creep: Creep, source: Source): number {
    // Static mining: stand on the ONE designated harvest tile - the source
    // container if built, else the exact tile the container is (or will be) placed
    // on. The miner's dropped energy, the container, and the haulers' pickup all
    // converge on this tile, so the energy never sits on a tile the haulers never
    // visit (the "source piles up un-hauled" bug). Harvest fires whenever we are
    // adjacent to the source, so we still mine while walking onto the spot or if a
    // transient second miner can't claim the exact tile.
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const spot = sourceHarvestSpot(source, spawn?.pos);
    const spotHeldByOther = spot.lookFor(LOOK_CREEPS).some(c => c.name !== creep.name);
    const approach = minerApproach(creep.pos.isEqualTo(spot), creep.pos.isNearTo(source), spotHeldByOther);
    if (approach === "spot") {
      travelTo(creep, spot, { range: 0, visualizePathStyle: { stroke: "#ffaa00" } });
    } else if (approach === "spread") {
      // The static tile is taken; harvest from any other tile adjacent to the source.
      travelTo(creep, source, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
    }

    const result = creep.harvest(source);

    if (result === OK) {
      const energyHarvested = creep.getActiveBodyparts(WORK) * 2;
      this.recordProduction(energyHarvested);
      return energyHarvested;
    }

    // Only log unexpected errors (not source empty, not on cooldown, not range).
    if (result !== ERR_NOT_ENOUGH_RESOURCES && result !== ERR_TIRED && result !== ERR_NOT_IN_RANGE) {
      console.log(`[Harvest] ${creep.name} unexpected error: ${result}`);
    }

    return 0;
  }

  /**
   * Get number of active harvester creeps (excludes spawning).
   */
  public getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  /**
   * Declare this corp's spawn demand for the scheduler.
   *
   * A source needs up to maxMiners creeps sized to harvest its full rate. The
   * first miner is "blocking" (the source produces nothing without it) and
   * produces income; additional miners are scaling demand (non-blocking). Value
   * tracks mining efficiency so better sources are staffed first.
   */
  /**
   * Project the economics of mining this corp's source from a given spawn: a
   * miner sized to the source, costed by its body over the life left after
   * walking out to the source, producing the source's energy/tick.
   */
  public project(scene: ChainScene): CorpEconomics {
    const source = scene.resource(this.sourceId);
    if (!source) return { costPerTick: 0, throughput: 0, spawnPartsPerTick: 0 };

    const capacity = source.capacity ?? SOURCE_ENERGY_CAPACITY;
    const supply = capacity / SOURCE_REGEN_TIME;
    const body = buildMinerBody(calculateOptimalWorkParts(capacity), scene.energyCapacity);
    if (body.cost === 0) return { costPerTick: 0, throughput: 0, spawnPartsPerTick: 0 };

    const harvestRate = Math.min(supply, HARVEST_RATE * body.workParts);
    const travel = scene.dist(scene.spawnPos, source.pos) * travelTicksPerTile(scene.energyCapacity);
    const usefulLife = effectiveLife(travel);
    // A static miner walks out once and dies at the source, so it both costs
    // energy and consumes spawn build-time over its (shortened) useful life.
    return {
      costPerTick: body.cost / usefulLife,
      throughput: harvestRate,
      spawnPartsPerTick: body.body.length / usefulLife
    };
  }

  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const assignment = this.minerAssignment;
    if (!assignment) return [];

    // WORK parts needed to saturate this source (2 energy/tick per WORK part).
    const totalWork = Math.max(1, Math.ceil(assignment.harvestRate / 2));

    // Size the miner COUNT to the source's actual need, not to the number of
    // physical mining spots. A big room fields one large miner; a small room
    // splits the work across a few small ones. Capping by maxMiners alone made
    // an open source with 8 free tiles spawn 8 one-WORK miners that crowd the
    // source and gridlock the surrounding chamber.
    const affordableWork = Math.max(1, buildMinerBody(totalWork, ctx.energyCapacity).workParts);
    const needed = Math.ceil(totalWork / affordableWork);
    const target = Math.max(1, Math.min(assignment.maxMiners || 1, needed));

    const current = this.getTotalCreepCount();
    if (current >= target) return [];

    // Desired WORK per miner to cover the source's harvest rate across miners.
    const desiredWork = Math.max(1, Math.ceil(totalWork / target));

    // Floor the miner so the scheduler can't spawn a 1-WORK runt under energy
    // pressure. A 1-WORK miner harvests just 2/tick against a ~10/tick source, so
    // the source stays under-mined, the spawn it feeds stays starved, and every
    // OTHER corp then runts out too - the whole economy collapses to one-useful-
    // part creeps. Even a bare spawn (300) affords a 2-WORK miner (250). The runt
    // floor is ONLY for the colony's very first miner, which is the bootstrap
    // income and must spawn fast even if tiny. Once income flows (this colony
    // already has a miner elsewhere - e.g. a second source, or a regrow after a
    // runt was recycled), hold out for the full desired body: the income already
    // covers the wait, and a source has only so many spots so each should be as
    // large as the room can build. This also prevents a single-source regrow from
    // respawning as a runt again (thrash).
    const desired = buildMinerBody(desiredWork, ctx.energyCapacity);
    const colonyColdStart = current === 0 && !this.colonyHasMiner();
    const minWork = colonyColdStart ? Math.min(desiredWork, 2) : desiredWork;
    const min = buildMinerBody(minWork, ctx.energyCapacity);
    if (min.cost === 0) return []; // room cannot afford even a minimal miner

    return [
      {
        buyerCorpId: this.id,
        role: "miner",
        value: 100 + (assignment.efficiency ?? 0) * 0.5,
        // A source's first miner is blocking, per SOURCE - an income unit must be
        // staffed before any lower-value work (construction, upgrading). This is
        // not gated on the whole colony having a miner: every source's first miner
        // must outrank consumption and get staffed, in expected-value order. The
        // old failure - a fresh source's miner outranking the haulers that complete
        // an already-started source, so the spawn fields miner after miner while
        // energy strands unhauled - is prevented by spawnPriority's tiers (a started
        // income corp outranks opening a fresh one), not by withholding the block here.
        blocking: current === 0,
        producesIncome: true,
        desiredCost: desired.cost,
        minCost: min.cost,
        since: 0,
        bodyParam: desiredWork
      }
    ];
  }

  /**
   * True if the colony already has a miner producing income anywhere, so an
   * additional source's miner is expansion rather than a blocking bootstrap need.
   */
  private colonyHasMiner(): boolean {
    // Count only real FLOW miners (a HarvestCorp's creep, corpId "mining-..."),
    // NOT bootstrap jacks - which also carry workType "harvest" but corpId
    // "bootstrap-...". Counting jacks here made every flow miner non-blocking
    // while jacks were alive, so the blocking upgrader/haulers always outranked
    // it and no flow miner ever spawned: the colony could never hand off from
    // bootstrap to the flow economy.
    for (const name in Game.creeps) {
      const memory = Game.creeps[name].memory;
      if (memory.workType === "harvest" && memory.corpId?.startsWith("mining-")) return true;
    }
    return false;
  }

  /**
   * Get total creep count including spawning creeps.
   * Used for spawn planning to avoid queueing duplicate miners.
   */
  public getTotalCreepCount(): number {
    let count = 0;
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get the source ID this corp harvests.
   */
  public getSourceId(): string {
    return this.sourceId;
  }

  /**
   * Get the spawn ID this corp spawns from.
   */
  public getSpawnId(): string {
    return this.spawnId;
  }

  /**
   * Get desired work parts for this source.
   */
  public getDesiredWorkParts(): number {
    return this.desiredWorkParts;
  }

  // ===========================================================================
  // FLOW INTEGRATION
  // ===========================================================================

  /**
   * Set the miner assignment from FlowEconomy.
   * This replaces hardcoded spawn/work decisions with flow-optimized values.
   */
  public setMinerAssignment(assignment: MinerAssignment): void {
    this.minerAssignment = assignment;
    // Update spawn ID from flow solution (may be different from original).
    // The flow sink id is prefixed ("spawn-<gameId>"); strip it so spawnId is
    // the real spawn game id - the spawn scheduler matches corps to spawns by
    // this id, and a prefixed value silently excludes the corp (no miners spawn).
    this.spawnId = assignment.spawnId.replace("spawn-", "");
  }

  /**
   * Get the current miner assignment (if set by FlowEconomy).
   */
  public getMinerAssignment(): MinerAssignment | null {
    return this.minerAssignment;
  }

  /**
   * Check if this corp has a flow-based assignment.
   */
  public hasFlowAssignment(): boolean {
    return this.minerAssignment !== null;
  }

  /**
   * Get the expected harvest rate from flow assignment.
   */
  public getExpectedHarvestRate(): number {
    return this.minerAssignment?.harvestRate ?? 10; // Default: 10 e/tick
  }

  /**
   * Budgeted energy/tick: the harvest rate the flow plan commissioned, or 0 when
   * this source has no assignment yet (so it is excluded from variance until the
   * planner funds it). Matches recordProduction's unit (energy harvested).
   */
  public budgetedRate(): number {
    return this.minerAssignment?.harvestRate ?? 0;
  }

  /**
   * Get spawn distance from flow assignment.
   */
  public getSpawnDistance(): number {
    return this.minerAssignment?.spawnDistance ?? 0;
  }

  /**
   * Serialize for persistence.
   */
  public serialize(): SerializedHarvestCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      sourceId: this.sourceId,
      creepNames: [],
      lastSpawnAttempt: this.lastSpawnAttempt,
      desiredWorkParts: this.desiredWorkParts,
      targetMiners: this.targetMiners,
      minerAssignment: this.minerAssignment ?? undefined
    };
  }

  /**
   * Deserialize from persistence.
   */
  public deserialize(data: SerializedHarvestCorp): void {
    super.deserialize(data);
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
    this.desiredWorkParts = data.desiredWorkParts || DEFAULT_DESIRED_WORK;
    this.targetMiners = data.targetMiners || 1;
    this.minerAssignment = data.minerAssignment ?? null;
  }
}

/**
 * Create a HarvestCorp for a source in a room.
 * Calculates optimal work parts based on the source's energy capacity.
 */
export function createHarvestCorp(room: Room, spawn: StructureSpawn, source: Source): HarvestCorp {
  const nodeId = `${room.name}-harvest-${source.id.slice(-4)}`;
  const desiredWorkParts = calculateOptimalWorkParts(source.energyCapacity);
  return new HarvestCorp(nodeId, spawn.id, source.id, desiredWorkParts);
}
