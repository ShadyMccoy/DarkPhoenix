/**
 * @fileoverview HarvestCorp - Manages harvester creeps.
 *
 * Harvesters harvest energy from sources and drop it on the ground
 * for haulers to pick up and deliver.
 *
 * @module corps/HarvestCorp
 */

import {
  HARVEST_RATE,
  SOURCE_ENERGY_CAPACITY,
  SOURCE_REGEN_TIME,
  calculateOptimalWorkParts
} from "../planning/EconomicConstants";
import { effectiveLife, staffsPost } from "../economy/primitives";
import { hostileRooms } from "../utils/RoomDiscovery";
import { Corp, SerializedCorp } from "./Corp";
import { travelTicksPerTile } from "./economics";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { driveRecycle, pickRuntToRecycle } from "./recycle";
import { MinerAssignment } from "../flow/FlowTypes";
import { Position } from "../types/Position";
import { buildMinerBody } from "../spawn/BodyBuilder";
import { coreLink, sourceHarvestSpot, sourceLink } from "./nodeEnergy";
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
  /** The corp's POST - where its miners work (see post field). */
  postPos?: Position;
  /** True once postPos is the exact harvest spot (computed with vision). */
  postExact?: boolean;
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

  /**
   * Flow-based miner assignment from FlowEconomy.
   * When set, this corp uses the assignment for spawn decisions instead
   * of its own hardcoded values.
   */
  private minerAssignment: MinerAssignment | null = null;

  /**
   * The corp's POST: the tile its miners work at. Seeded from the
   * commission's source position (a hint good enough to walk in on), refined
   * to the exact harvest spot the first tick the corp has vision, and
   * persisted - so a no-vision remote corp always directs creeps to the
   * post itself rather than a room-center guess or a frozen no-op.
   */
  private post: Position | null = null;

  /** True once `post` is the exact harvest spot (needs vision to compute). */
  private postExact = false;

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

    // Stamp the assignment on every creep: adoption (OrphanRescue) and the
    // home-saturation gate (IncrementalAnalysis) both key on
    // memory.assignedSourceId, but spawned creeps arrive with only
    // {corpId, workType} - only STAGED test creeps carried it, which made
    // the saturation gate read every organic home source as unmined and
    // remotes never unlocked (measured via SATDIAG probe).
    const realSourceId = this.sourceId.replace("source-", "");
    for (const creep of this.getActiveCreeps()) {
      if (creep.memory.assignedSourceId !== realSourceId) {
        creep.memory.assignedSourceId = realSourceId;
      }
    }

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
      // A REAL-id remote source with no vision (intel captured the game id,
      // then every creep left the room): getObjectById is null until someone
      // walks back in. Returning here froze the corp's miners mid-map (they
      // are claimed, so OrphanRescue never rescues them) while its demand
      // kept churning income-tier replacements - measured live as the spawn
      // monopolized by phantom mining while upgraders/builders never won a
      // slot. Walk the miners to the corp's POST instead: approaching it
      // crosses the border, vision returns, and the source resolves next tick.
      const pos = this.post ?? this.getPosition();
      try {
        targetPos = new RoomPosition(pos.x, pos.y, pos.roomName);
      } catch {
        console.log(`[Harvest] ${this.id}: source ${this.sourceId} not found (no walkable post)`);
        return;
      }
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
    if (creeps.some(c => c.memory.recycling)) return; // one at a time

    // SPAWN-THEN-RECYCLE: the runt keeps mining until its replacement is
    // ALIVE. Two kill-first designs measurably failed here (grid T5
    // pipeline world): recycling on instantaneous affordability lost the
    // money during the runt's walk (the replacement respawned the same
    // size, forever - the runt-miner equilibrium at ~40% source output),
    // and pricing the replacement via a recycle-time promise deadlocked a
    // miner-less room whose bank ceiling (spawn regen 300) sat below the
    // promise. With the overlap there is no race and no mining gap: the
    // upgrade demand (see runtUpgradeDemand) only spawns when the bigger
    // body is affordable AT THAT INSTANT, and the smallest miner is
    // released only once the fleet OVERSHOOTS its target count - which
    // covers both overlap completion and a plan shrink.
    const target = this.minerTargetCount(spawn.room.energyCapacityAvailable);
    // Overshoot is judged on POST-STAFFING creeps only - the same staffsPost
    // lens the demand side used to order the extra body. A dying incumbent
    // inside its replacement lead time is already spoken for by the delivery
    // contract: its successor is NOT surplus, and raw-size overshoot here
    // recycled every contracted newborn at the spawn door, re-firing the
    // replacement demand in a ~25-tick churn loop until the incumbent died
    // with the real successor still in the spawn (measured, grid cell
    // churn-t3-gapless-replacement: 4 miners built for one handoff, 53-tick
    // post gap).
    const walkTicks =
      (this.minerAssignment.spawnDistance ?? 0) * travelTicksPerTile(spawn.room.energyCapacityAvailable);
    const staffing = creeps.filter(c => staffsPost(c.ticksToLive, c.body?.length ?? 0, walkTicks));
    if (staffing.length <= target) return;

    // Release the smallest; on WORK ties, the one FARTHEST from the source -
    // never the seated holder (grid cell move-miner-pocket-holdoff: an
    // index-order tie-break recycled the seated miner and displaced it).
    const source = Game.getObjectById(this.sourceId.replace("source-", "") as Id<Source>);
    let releaseIdx = 0;
    staffing.forEach((c, i) => {
      if (i === 0) return;
      const cur = staffing[releaseIdx];
      const work = c.getActiveBodyparts(WORK);
      const curWork = cur.getActiveBodyparts(WORK);
      if (work < curWork) {
        releaseIdx = i;
      } else if (work === curWork && source) {
        if (c.pos.getRangeTo(source.pos) > cur.pos.getRangeTo(source.pos)) releaseIdx = i;
      }
    });
    staffing[releaseIdx].memory.recycling = true;
  }

  /** Miner count the plan wants - same math as getSpawnDemand's target. */
  private minerTargetCount(energyCapacity: number): number {
    if (!this.minerAssignment) return 1;
    const totalWork = Math.max(1, Math.ceil(this.minerAssignment.harvestRate / 2));
    const affordableWork = Math.max(1, buildMinerBody(totalWork, energyCapacity).workParts);
    const needed = Math.ceil(totalWork / affordableWork);
    return Math.max(1, Math.min(this.minerAssignment.maxMiners || 1, needed));
  }

  /**
   * The overlap half of spawn-then-recycle: when a runt is upgradeable and
   * the bigger body is affordable right now, demand ONE extra miner. The
   * scheduler's min-cost check at the spawn instant is the affordability
   * guarantee (no decision-time/spawn-time race), and the runt keeps mining
   * until flagMinerRuntForRecycling sees the bigger sibling arrive.
   */
  private runtUpgradeDemand(ctx: SpawnDemandContext, creeps: Creep[]): SpawnDemand | null {
    if (!this.minerAssignment) return null;
    if (creeps.some(c => c.memory.recycling)) return null;

    const totalWork = Math.max(1, Math.ceil(this.minerAssignment.harvestRate / 2));
    const maxWorkPerMiner = Math.max(1, buildMinerBody(totalWork, ctx.energyCapacity).workParts);
    const workCounts = creeps.map(c => c.getActiveBodyparts(WORK));
    const runtIdx = pickRuntToRecycle(workCounts, totalWork, maxWorkPerMiner);
    if (runtIdx === null) return null;
    if (creeps.some((c, i) => i !== runtIdx && workCounts[i] > workCounts[runtIdx])) return null; // upgrade already fielded

    const upgradeWork = Math.min(maxWorkPerMiner, workCounts[runtIdx] + 1);
    const upgradeCost = buildMinerBody(upgradeWork, ctx.energyCapacity).cost;
    const desired = buildMinerBody(maxWorkPerMiner, ctx.energyCapacity);
    return {
      buyerCorpId: this.id,
      role: "miner",
      value: 100 + (this.minerAssignment.efficiency ?? 0) * 0.5,
      blocking: false, // an optimization, never worth deadlocking the spawn over
      producesIncome: true,
      desiredCost: desired.cost,
      minCost: upgradeCost, // strictly-bigger enforced at the spawn instant
      since: 0,
      bodyParam: maxWorkPerMiner,
      why: "upsize" // spawn-then-recycle: the agenda names the transition (spec 11 phase 3)
    };
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
    // Record the POST while we can see it: this is the tile a no-vision tick
    // (or a pre-positioning successor) sends creeps to.
    this.post = { x: spot.x, y: spot.y, roomName: spot.roomName };
    this.postExact = true;
    const spotHeldByOther = spot.lookFor(LOOK_CREEPS).some(c => c.name !== creep.name);
    const approach = minerApproach(creep.pos.isEqualTo(spot), creep.pos.isNearTo(source), spotHeldByOther);
    if (approach === "spot") {
      travelTo(creep, spot, { range: 0, visualizePathStyle: { stroke: "#ffaa00" } });
    } else if (approach === "spread") {
      // The static tile is taken; harvest from any other tile adjacent to the source.
      travelTo(creep, source, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
    }

    // Link mining: a full store means the CARRY buffer is ready to ship - feed
    // the adjacent source link so the energy teleports to the core instead of
    // piling up. With no link (or a full one) the store just stays full and
    // harvested energy spills to the ground/container exactly as drop mining
    // always has. Transfer and harvest are separate intents, so both run this tick.
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      const link = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
        filter: s =>
          s.structureType === STRUCTURE_LINK && (s as StructureLink).store.getFreeCapacity(RESOURCE_ENERGY) > 0
      })[0] as StructureLink | undefined;
      if (link) creep.transfer(link, RESOURCE_ENERGY);
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
  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const assignment = this.minerAssignment;
    if (!assignment) return [];

    // DEFENSE ECONOMICS (owner 2026-07-10): while hostiles hold this source's
    // room (sighted, or inside a sighted hostile's TTL bound), buy no bodies
    // for the grinder. Existing miners run out; funding resumes on all-clear.
    if (hostileRooms().has(this.getPosition().roomName)) return [];

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

    // Delivery-aware staffing: an incumbent inside its replacement lead time
    // (build + walk, staffsPost) keeps mining but no longer counts as holding
    // its post, so the successor's demand surfaces exactly early enough to
    // arrive as the incumbent dies. The planner's effectiveLife amortization
    // already prices this gapless handoff; without it every miner generation
    // leaves the source dark for spawnTime + walk ticks.
    const walkTicks = (assignment.spawnDistance ?? 0) * travelTicksPerTile(ctx.energyCapacity);
    const current = this.countStaffing(walkTicks);
    if (current >= target) {
      // Fully staffed by count - but a runt fleet still wants its overlap
      // upgrade (spawn-then-recycle; see runtUpgradeDemand).
      const upgrade = this.runtUpgradeDemand(ctx, this.getActiveCreeps());
      return upgrade ? [upgrade] : [];
    }

    // Desired WORK per miner to cover the source's harvest rate across miners.
    const desiredWork = Math.max(1, Math.ceil(totalWork / target));

    // Floor the miner so the scheduler can't spawn a 1-WORK runt under energy
    // pressure. A 1-WORK miner harvests just 2/tick against a ~10/tick source, so
    // the source stays under-mined, the spawn it feeds stays starved, and every
    // OTHER corp then runts out too - the whole economy collapses to one-useful-
    // part creeps. Even a bare spawn (300) affords a 2-WORK miner (250). The runt
    // floor applies when the SPAWN'S OWN ROOM has no flow miner - the engine
    // that fills this spawn network is dead and must restart fast even if
    // tiny. It is room-scoped, NOT colony-scoped: a remote miner in another
    // room cannot refill this room's extensions, so counting it denied the
    // floor and deadlocked the colony on jack drip (measured, grid T5
    // remote-pipeline: home miner died, replacement demanded the full 700,
    // jacks refill only the spawn's 300, blocking remote haulers ate every
    // 300 - permanent stall). With home income alive, hold out for the full
    // desired body: the income covers the wait, and a source has only so
    // many spots so each should be as large as the room can build.
    // CARRY only when this source feeds a LINK (owner: otherwise it's 50
    // wasted energy + 3 wasted spawn-ticks per generation - the miner drops
    // everything anyway).
    const linkFed = this.sourceIsLinkFed();
    const desired = buildMinerBody(desiredWork, ctx.energyCapacity, linkFed);
    const colonyColdStart = current === 0 && !this.spawnRoomHasMiner();
    const minWork = colonyColdStart ? Math.min(desiredWork, 2) : desiredWork;
    const min = buildMinerBody(minWork, ctx.energyCapacity, linkFed);
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
        // PHYSICAL count, not the delivery-aware one: a lead-time replacement's
        // incumbent is still mining, so the source is not dark and the demand
        // must not claim the blocking EMERGENCY class every generation.
        blocking: this.getTotalCreepCount() === 0,
        // ...but a demand caused by an excluded live incumbent still needs
        // the scheduler's hold (mustFund), or cheap demand streams starve the
        // body until the incumbent dies (measured, W2N6 - the death-gap
        // scramble the delivery contract exists to prevent).
        replacement: this.getTotalCreepCount() > current,
        producesIncome: true,
        desiredCost: desired.cost,
        minCost: min.cost,
        since: 0,
        bodyParam: desiredWork,
        bodyStrategy: linkFed ? "linkFed" : undefined
      }
    ];
  }

  /**
   * Whether this source's output leaves via a LINK: a source link within
   * feeding range and a core link in the room. The only case a miner body
   * needs a CARRY part (to feed the link).
   */
  private sourceIsLinkFed(): boolean {
    const source = Game.getObjectById(this.sourceId as Id<Source>);
    if (!source) return false;
    const core = coreLink(source.room);
    if (!core) return false;
    return sourceLink(source.pos, core.id) !== null;
  }

  /**
   * True if the SPAWN'S ROOM has a flow miner producing income in it, so an
   * additional source's miner is expansion rather than a bootstrap-restart
   * need. Room-scoped (see the floor comment in getSpawnDemand).
   */
  private spawnRoomHasMiner(): boolean {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const spawnRoom = spawn?.room.name;
    // Count only real FLOW miners (a HarvestCorp's creep, corpId "mining-..."),
    // NOT bootstrap jacks - which also carry workType "harvest" but corpId
    // "bootstrap-...". Counting jacks here made every flow miner non-blocking
    // while jacks were alive, so the blocking upgrader/haulers always outranked
    // it and no flow miner ever spawned: the colony could never hand off from
    // bootstrap to the flow economy.
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      const memory = creep.memory;
      if (memory.workType !== "harvest" || !memory.corpId?.startsWith("mining-")) continue;
      // Unknown rooms (unit-harness mocks) count as local - the old colony-wide
      // behavior - so only a KNOWN remote miner is excluded from the floor gate.
      if (!spawnRoom || creep.room?.name === undefined || creep.room.name === spawnRoom) return true;
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
   * Creeps (including spawning ones) that still staff their post for demand
   * purposes: incumbents inside their replacement lead time are excluded
   * (see staffsPost), which is what makes replacement spawning start
   * spawnTime + walk ticks before the incumbent dies.
   */
  private countStaffing(distance: number): number {
    let count = 0;
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId !== this.id) continue;
      // Recycling creeps still count: the pounce-recycle path orders its own
      // successor (runtUpgradeDemand), so excluding them here double-orders
      // and churns spawn energy into runt loops (measured: the synthetic
      // fidelity world stuck at 300 capacity with a 7-runt fleet).
      if (staffsPost(creep.ticksToLive, creep.body?.length ?? 0, distance)) count++;
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
   * Seed the POST from the commission's source position. A hint only: the
   * exact harvest spot replaces it the first tick the corp has vision, and a
   * hint never overwrites an exact post.
   */
  public setPostHint(pos: Position | undefined): void {
    if (!pos || this.postExact) return;
    this.post = pos;
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
      minerAssignment: this.minerAssignment ?? undefined,
      postPos: this.post ?? undefined,
      postExact: this.postExact || undefined
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
    this.post = data.postPos ?? null;
    this.postExact = data.postExact ?? false;
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
