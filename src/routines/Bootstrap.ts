/**
 * @fileoverview Bootstrap routine for early-game colony setup.
 *
 * The Bootstrap routine manages the initial phase of colony development
 * (RCL 1-2). It spawns multi-purpose "jack" creeps that handle all basic
 * tasks: harvesting, spawning, controller upgrades, and recovery.
 *
 * ## Purpose
 * - Get the colony running from a fresh spawn
 * - Handle emergency recovery if all specialized creeps die
 * - Upgrade controller to RCL 2+ to enable specialization
 *
 * ## Creep Role: Jack
 * - Body: [WORK, CARRY, MOVE]
 * - Cost: 200 energy
 * - Quantity: 2 (maintained)
 *
 * ## Behavior Priority
 * 1. If full and spawn needs energy -> deliver to spawn
 * 2. If has energy and spawn is stable and RCL < 2 -> upgrade controller
 * 3. If dropped energy nearby -> pick it up
 * 4. Otherwise -> harvest from nearest source
 *
 * @module routines/Bootstrap
 */

import { RoomRoutine } from "../core/RoomRoutine";

/**
 * Bootstrap routine for early-game colony initialization.
 *
 * Manages jack creeps to bootstrap the colony from scratch.
 *
 * @example
 * const bootstrap = new Bootstrap(room.controller.pos);
 * bootstrap.runRoutine(room);
 */
export class Bootstrap extends RoomRoutine {
  name = "bootstrap";

  /**
   * Creates a new Bootstrap routine.
   *
   * @param pos - Position to operate around (typically the controller)
   */
  constructor(pos: RoomPosition) {
    super(pos, { jack: [] });
  }

  /**
   * Main bootstrap logic executed each tick.
   *
   * Directs jack creeps based on colony needs and their current state.
   *
   * @param room - The room being bootstrapped
   */
  routine(room: Room): void {
    let spawns = room.find(FIND_MY_SPAWNS);
    let spawn = spawns[0];
    if (spawn == undefined) return;

    let jacks = this.creepIds.jack
      .map((id) => Game.getObjectById(id))
      .filter((jack): jack is Creep => jack != null);

    jacks.forEach((jack) => {
      if (
        jack.store.energy == jack.store.getCapacity() &&
        spawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0
      ) {
        this.DeliverEnergyToSpawn(jack, spawn);
      } else if (
        jack.store.energy > 0 &&
        spawn.store.getUsedCapacity(RESOURCE_ENERGY) > 150 &&
        room?.controller?.level &&
        room.controller.level < 2
      ) {
        this.upgradeController(jack);
      } else {
        if (!this.pickupEnergyPile(jack)) {
          this.HarvestNearestEnergySource(jack);
        }
      }
    });
  }

  /**
   * Calculates spawn queue for jack creeps.
   *
   * Maintains 2 jacks for redundancy and parallelism.
   *
   * @param room - The room to spawn in
   */
  calcSpawnQueue(room: Room): void {
    const spawns = room.find(FIND_MY_SPAWNS);
    const spawn = spawns[0];
    if (!spawn) return;

    this.spawnQueue = [];

    if (this.creepIds.jack.length < 2) {
      this.spawnQueue.push({
        body: [WORK, CARRY, MOVE],
        pos: spawn.pos,
        role: "jack",
      });
    }
  }

  /**
   * Directs a creep to harvest from the nearest available energy source.
   *
   * Finds sources with open adjacent positions to avoid congestion.
   *
   * @param creep - The creep to direct
   * @returns True if a valid source was found
   */
  HarvestNearestEnergySource(creep: Creep): boolean {
    let energySources = creep.room.find(FIND_SOURCES);
    energySources = _.sortBy(energySources, (s) =>
      creep.pos.getRangeTo(s.pos)
    );

    let e = energySources.find((e) => {
      let adjacentSpaces = creep.room.lookForAtArea(
        LOOK_TERRAIN,
        e.pos.y - 1,
        e.pos.x - 1,
        e.pos.y + 1,
        e.pos.x + 1,
        true
      );

      let openSpaces = 0;
      adjacentSpaces.forEach((space) => {
        if (space.terrain == "plain" || space.terrain == "swamp") {
          let pos = new RoomPosition(space.x, space.y, creep.room.name);
          let creepsAtPos = pos.lookFor(LOOK_CREEPS);
          if (creepsAtPos.length == 0 || creepsAtPos[0].id == creep.id) {
            openSpaces++;
          }
        }
      });

      return openSpaces > 0;
    });

    if (e == undefined) return false;

    creep.say("harvest");
    new RoomVisual(creep.room.name).line(
      creep.pos.x,
      creep.pos.y,
      e.pos.x,
      e.pos.y
    );

    creep.moveTo(e, { maxOps: 50, range: 1 });
    creep.harvest(e);

    return true;
  }

  /**
   * Directs a creep to build a container at a construction site.
   *
   * Used during early game to establish mining infrastructure.
   *
   * @param creep - The creep to direct
   */
  BuildMinerContainer(creep: Creep): void {
    let constructionSites = creep.room.find(FIND_CONSTRUCTION_SITES);
    if (constructionSites.length == 0) return;
    let site = constructionSites[0];

    creep.say("build");
    new RoomVisual(creep.room.name).line(
      creep.pos.x,
      creep.pos.y,
      site.pos.x,
      site.pos.y
    );

    creep.moveTo(site, { maxOps: 50, range: 2 });
    creep.build(site);
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

  /**
   * Directs a creep to deliver energy to the spawn.
   *
   * @param creep - The creep carrying energy
   * @param spawn - The spawn to deliver to
   * @returns Result of the transfer action
   */
  DeliverEnergyToSpawn(creep: Creep, spawn: StructureSpawn): number {
    creep.say("deliver");
    new RoomVisual(creep.room.name).line(
      creep.pos.x,
      creep.pos.y,
      spawn.pos.x,
      spawn.pos.y
    );

    creep.moveTo(spawn, { maxOps: 50, range: 1 });
    return creep.transfer(spawn, RESOURCE_ENERGY);
  }

  /**
   * Directs a creep to upgrade the room controller.
   *
   * @param creep - The creep to direct
   */
  upgradeController(creep: Creep): void {
    let c = creep.room.controller;
    if (c == undefined) return;

    creep.say("upgrade");
    new RoomVisual(creep.room.name).line(
      creep.pos.x,
      creep.pos.y,
      c.pos.x,
      c.pos.y
    );

    creep.moveTo(c, { maxOps: 50, range: 1 });
    creep.upgradeController(c);
  }

  /**
   * Directs a creep to dismantle walls near spawns.
   *
   * Used for emergency recovery when creeps are trapped.
   *
   * @param creep - The creep to direct
   */
  dismantleWalls(creep: Creep): void {
    let walls = creep.room.find(FIND_STRUCTURES, {
      filter: (structure) => structure.structureType == STRUCTURE_WALL,
    });

    if (walls.length == 0) return;

    // Find wall closest to a spawn
    let spawns = creep.room.find(FIND_MY_SPAWNS);
    if (spawns.length == 0) return;

    let sortedWalls = _.sortBy(walls, (w) => {
      let closestSpawn = _.min(spawns.map((s) => w.pos.getRangeTo(s.pos)));
      return closestSpawn;
    });
    let wall = sortedWalls[0];

    creep.say("dismantle");
    new RoomVisual(creep.room.name).line(
      creep.pos.x,
      creep.pos.y,
      wall.pos.x,
      wall.pos.y
    );

    creep.moveTo(wall, { maxOps: 50, range: 1 });
    creep.dismantle(wall);
  }

  /**
   * Utility to scale a body part pattern.
   *
   * @param body - Base body parts to scale
   * @param scale - Number of times to repeat each part
   * @returns Scaled body array
   */
  getScaledBody(
    body: BodyPartConstant[],
    scale: number
  ): BodyPartConstant[] {
    let newBody: BodyPartConstant[] = [];

    body.forEach((part) => {
      for (let i = 0; i < scale; i++) {
        newBody.push(part);
      }
    });

    return newBody;
  }
}
