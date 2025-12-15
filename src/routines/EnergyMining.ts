/**
 * @fileoverview Energy mining routine for harvester management.
 *
 * The EnergyMining routine manages dedicated harvesters at energy sources.
 * Each source gets its own EnergyMining instance, enabling independent
 * scaling and performance tracking.
 *
 * ## Purpose
 * - Maximize energy extraction from sources
 * - Create mining infrastructure (containers)
 * - Track harvesting ROI for economic decisions
 *
 * ## Creep Role: Harvester
 * - Body: [WORK, WORK, MOVE]
 * - Cost: 200 energy
 * - Output: ~10 energy/tick (2 WORK parts * 2 energy/tick/WORK)
 * - Quantity: 1 per harvest position (typically 1-3 per source)
 *
 * ## Economic Contract
 * Requirements:
 * - 2 WORK parts per harvester
 * - 1 MOVE part per harvester
 * - 150 ticks spawn time
 *
 * Outputs:
 * - ~10 energy/tick per harvester
 *
 * @module routines/EnergyMining
 */

import { RoomRoutine } from "../core/RoomRoutine";
import { SourceMine } from "../types/SourceMine";

/**
 * Energy mining routine for managing harvesters at a source.
 *
 * @example
 * const mining = new EnergyMining(source.pos);
 * mining.setSourceMine({
 *   sourceId: source.id,
 *   HarvestPositions: harvestPositions,
 *   distanceToSpawn: 15,
 *   flow: 10
 * });
 * mining.runRoutine(room);
 */
export class EnergyMining extends RoomRoutine {
  name = "energy mining";

  /** Configuration for the source being mined */
  private sourceMine!: SourceMine;

  /** Last recorded energy harvested (for performance tracking) */
  private lastEnergyHarvested: number = 0;

  /**
   * Creates a new EnergyMining routine.
   *
   * @param pos - Position of the energy source
   */
  constructor(pos: RoomPosition) {
    super(pos, { harvester: [] });

    // Define resource requirements
    this.requirements = [
      { type: "work", size: 2 }, // 2 WORK parts per harvester
      { type: "move", size: 1 }, // 1 MOVE part per harvester
      { type: "spawn_time", size: 150 }, // Spawn cost in ticks
    ];

    // Define resource outputs
    this.outputs = [
      { type: "energy", size: 10 }, // ~10 energy/tick with 2 WORK parts
    ];
  }

  /**
   * Calculates expected value based on harvester efficiency.
   *
   * @returns Expected net value per tick
   */
  protected calculateExpectedValue(): number {
    if (!this.sourceMine) return 0;

    // Each WORK part harvests 2 energy/tick
    const workParts = this.creepIds["harvester"].length * 2;
    const energyPerTick = workParts * 2;

    // Cost is spawn energy (200 for [WORK, WORK, MOVE])
    const spawnCost = this.creepIds["harvester"].length * 200;

    // Amortize spawn cost over creep lifetime (~1500 ticks)
    const amortizedCost = spawnCost / 1500;

    return energyPerTick - amortizedCost;
  }

  /**
   * Main mining logic executed each tick.
   *
   * @param room - The room containing the source
   */
  routine(room: Room): void {
    if (!this.sourceMine) {
      return;
    }

    let source = Game.getObjectById(this.sourceMine.sourceId);
    if (source == null) {
      return;
    }

    this.HarvestAssignedEnergySource();
    this.createConstructionSiteOnEnergyPiles();
  }

  /**
   * Calculates spawn queue for harvesters.
   *
   * Spawns one harvester per available harvest position.
   *
   * @param room - The room to spawn in
   */
  calcSpawnQueue(room: Room): void {
    this.spawnQueue = [];

    if (!this.sourceMine || !this.sourceMine.HarvestPositions) {
      return;
    }

    let spawns = room.find(FIND_MY_SPAWNS);
    let spawn = spawns[0];
    if (spawn == undefined) return;

    if (
      this.creepIds["harvester"].length <
      this.sourceMine.HarvestPositions.length
    ) {
      this.spawnQueue.push({
        body: [WORK, WORK, MOVE],
        pos: spawn.pos,
        role: "harvester",
      });
    }
  }

  /**
   * Serializes routine state for persistence.
   */
  serialize(): any {
    return {
      name: this.name,
      position: this.position,
      creepIds: this.creepIds,
      sourceMine: this.sourceMine,
    };
  }

  /**
   * Restores routine state from serialized data.
   */
  deserialize(data: any): void {
    super.deserialize(data);
    this.sourceMine = data.sourceMine;
  }

  /**
   * Sets the source mine configuration.
   *
   * @param sourceMine - Mining configuration for the source
   */
  setSourceMine(sourceMine: SourceMine): void {
    this.sourceMine = sourceMine;
  }

  /**
   * Creates container construction sites on large energy piles.
   *
   * Automatically places containers when dropped energy exceeds 500,
   * indicating a need for storage infrastructure.
   */
  private createConstructionSiteOnEnergyPiles(): void {
    _.forEach(this.sourceMine.HarvestPositions.slice(0, 2), (harvestPos) => {
      let pos = new RoomPosition(
        harvestPos.x,
        harvestPos.y,
        harvestPos.roomName
      );
      let structures = pos.lookFor(LOOK_STRUCTURES);
      let containers = structures.filter(
        (s) => s.structureType == STRUCTURE_CONTAINER
      );

      if (containers.length == 0) {
        let energyPile = pos.lookFor(LOOK_ENERGY).filter((e) => e.amount > 500);

        if (energyPile.length > 0) {
          let constructionSites = pos
            .lookFor(LOOK_CONSTRUCTION_SITES)
            .filter((s) => s.structureType == STRUCTURE_CONTAINER);

          if (constructionSites.length == 0) {
            pos.createConstructionSite(STRUCTURE_CONTAINER);
          }
        }
      }
    });
  }

  /**
   * Directs harvesters to their assigned positions.
   *
   * Each harvester is assigned to a specific position based on index.
   */
  private HarvestAssignedEnergySource(): void {
    let source = Game.getObjectById(this.sourceMine.sourceId);
    if (source == null) {
      return;
    }

    for (let p = 0; p < this.sourceMine.HarvestPositions.length; p++) {
      let pos = this.sourceMine.HarvestPositions[p];
      HarvestPosAssignedEnergySource(
        Game.getObjectById(this.creepIds["harvester"]?.[p]),
        source,
        pos
      );
    }
  }
}

/**
 * Directs a single harvester to harvest at an assigned position.
 *
 * @param creep - The harvester creep
 * @param source - The energy source
 * @param destination - The assigned harvest position
 */
function HarvestPosAssignedEnergySource(
  creep: Creep | null,
  source: Source | null,
  destination: RoomPosition | null
): void {
  if (creep == null) {
    return;
  }
  if (source == null) {
    return;
  }
  if (destination == null) {
    return;
  }

  creep.say("harvest op");

  new RoomVisual(creep.room.name).line(creep.pos, destination);
  creep.moveTo(
    new RoomPosition(destination.x, destination.y, destination.roomName),
    { maxOps: 50 }
  );

  creep.harvest(source);
}
