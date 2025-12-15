/**
 * @fileoverview Construction routine for builder management.
 *
 * The Construction routine manages builder creeps that construct
 * structures from construction sites. Each construction site gets
 * its own Construction instance for independent tracking.
 *
 * ## Purpose
 * - Build structures from construction sites
 * - Self-terminate when construction completes
 * - Support energy pickup for builders
 *
 * ## Creep Role: Builder
 * - Body: [WORK, CARRY, MOVE]
 * - Cost: 200 energy
 * - Build rate: 5 energy/tick (1 WORK part)
 *
 * ## Lifecycle
 * Construction routines automatically mark themselves complete
 * when their construction site no longer exists (built or removed).
 *
 * @module routines/Construction
 */

import { RoomRoutine } from "../core/RoomRoutine";

/**
 * Construction routine for managing building at a site.
 *
 * @example
 * const construction = new Construction(site.id);
 * construction.runRoutine(room);
 */
export class Construction extends RoomRoutine {
  name = "construction";

  /** ID of the construction site being built */
  private _constructionSiteId: Id<ConstructionSite>;

  /** Whether construction has completed */
  private _isComplete: boolean;

  /**
   * Creates a new Construction routine.
   *
   * @param constructionSiteId - ID of the construction site
   * @param position - Optional position (defaults to site position)
   */
  constructor(
    constructionSiteId: Id<ConstructionSite>,
    position?: RoomPosition
  ) {
    const site = Game.getObjectById(constructionSiteId);
    const pos = position || site?.pos || new RoomPosition(25, 25, "sim");

    super(pos, { builder: [] });

    this._constructionSiteId = constructionSiteId;
    this._isComplete = !site && !position;
  }

  /**
   * Gets the construction site ID.
   */
  get constructionSiteId(): Id<ConstructionSite> {
    return this._constructionSiteId;
  }

  /**
   * Checks if construction is complete.
   *
   * Returns true if the construction site no longer exists.
   */
  get isComplete(): boolean {
    return (
      this._isComplete ||
      Game.getObjectById(this._constructionSiteId) == null
    );
  }

  /**
   * Main construction logic executed each tick.
   *
   * @param room - The room containing the construction site
   */
  routine(room: Room): void {
    if (this.isComplete) {
      return;
    }
    this.BuildConstructionSite();
  }

  /**
   * Serializes routine state for persistence.
   */
  serialize(): any {
    return {
      name: this.name,
      position: this.position,
      creepIds: this.creepIds,
      constructionSiteId: this._constructionSiteId,
    };
  }

  /**
   * Restores routine state from serialized data.
   */
  deserialize(data: any): void {
    super.deserialize(data);
    this._constructionSiteId = data.constructionSiteId;
  }

  /**
   * Calculates spawn queue for builders.
   *
   * Spawns one builder per active construction site.
   *
   * @param room - The room to spawn in
   */
  calcSpawnQueue(room: Room): void {
    this.spawnQueue = [];

    if (this.isComplete) {
      return;
    }

    if (this.creepIds.builder.length == 0) {
      this.spawnQueue.push({
        body: [WORK, CARRY, MOVE],
        pos: this.position,
        role: "builder",
      });
    }
  }

  /**
   * Directs builders to construct the site.
   *
   * Handles energy pickup when builder is empty.
   */
  BuildConstructionSite(): void {
    let constructionSite = Game.getObjectById(this._constructionSiteId);
    if (constructionSite == null) {
      this._isComplete = true;
      return;
    }

    let builderIds = this.creepIds["builder"];
    if (builderIds == undefined || builderIds.length == 0) {
      return;
    }

    let builders = builderIds
      .map((id) => Game.getObjectById(id))
      .filter((builder): builder is Creep => builder != null);

    if (builders.length == 0) {
      return;
    }
    let builder = builders[0];

    if (builder.store.energy == 0) {
      if (this.pickupEnergyPile(builder)) {
        return;
      }
    }

    if (builder.pos.getRangeTo(constructionSite.pos) > 3) {
      builder.moveTo(constructionSite.pos);
    } else {
      builder.build(constructionSite);
    }
  }

  /**
   * Directs a creep to pick up dropped energy.
   *
   * @param creep - The creep to direct
   * @returns True if energy was found to pick up
   */
  pickupEnergyPile(creep: Creep): boolean {
    let droppedEnergies = creep.room.find(FIND_DROPPED_RESOURCES, {
      filter: (resource) =>
        resource.resourceType == RESOURCE_ENERGY && resource.amount > 50,
    });

    if (droppedEnergies.length == 0) return false;

    let sortedEnergies = _.sortBy(droppedEnergies, (e) =>
      creep.pos.getRangeTo(e.pos)
    );
    let e = sortedEnergies[0];

    creep.say("pickup energy");
    new RoomVisual(creep.room.name).line(
      creep.pos.x,
      creep.pos.y,
      e.pos.x,
      e.pos.y
    );

    creep.moveTo(e, { maxOps: 50, range: 1 });
    creep.pickup(e);

    return true;
  }
}
