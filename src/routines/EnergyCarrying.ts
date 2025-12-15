/**
 * @fileoverview Energy carrying routine for logistics management.
 *
 * The EnergyCarrying routine manages carrier creeps that transport
 * energy from production sites (harvesters) to consumption sites
 * (spawns, extensions, towers, storage).
 *
 * ## Purpose
 * - Transport energy from sources to spawn/extensions
 * - Support construction by delivering to builders
 * - Enable mining infrastructure by moving harvested energy
 *
 * ## Creep Role: Carrier
 * - Body: [CARRY, CARRY, MOVE, MOVE]
 * - Cost: 200 energy
 * - Capacity: 100 energy
 *
 * ## Route System
 * Carriers follow predefined routes with waypoints:
 * - **Surplus waypoints**: Pickup locations (containers, dropped energy)
 * - **Deficit waypoints**: Delivery locations (spawn, extensions, towers)
 *
 * Carriers cycle through waypoints continuously:
 * waypoint[0] -> waypoint[1] -> ... -> waypoint[n] -> waypoint[0]
 *
 * @module routines/EnergyCarrying
 */

import { SourceMine } from "../types/SourceMine";
import { forEach, sortBy } from "lodash";
import { EnergyRoute } from "../types/EnergyRoute";
import { RoomRoutine } from "../core/RoomRoutine";

/**
 * Energy carrying routine for logistics management.
 *
 * @example
 * const carrying = new EnergyCarrying(room);
 * carrying.runRoutine(room);
 */
export class EnergyCarrying extends RoomRoutine {
  name = "energy carrying";

  /** Active energy transportation routes */
  energyRoutes: EnergyRoute[] = [];

  /**
   * Creates a new EnergyCarrying routine.
   *
   * @param room - The room to manage logistics for
   * @throws Error if room has no controller
   */
  constructor(room: Room) {
    if (!room.controller) throw new Error("Room has no controller");
    super(room.controller.pos, { carrier: [] });
  }

  /**
   * Main logistics logic executed each tick.
   *
   * Calculates routes if needed and directs carriers.
   *
   * @param room - The room being serviced
   */
  routine(room: Room): void {
    console.log("energy carrying");

    if (!this.energyRoutes.length) {
      this.calculateRoutes(room);
    }

    forEach(this.energyRoutes, (route) => {
      forEach(route.Carriers, (carrier) => {
        let creep = Game.getObjectById(carrier.creepId) as Creep;
        let currentWaypointIdx = carrier.waypointIdx;
        if (creep == null) {
          return;
        }

        if (this.LocalDelivery(creep, currentWaypointIdx, route)) return;
        this.MoveToNextWaypoint(creep, currentWaypointIdx, route, carrier);
      });
    });
  }

  /**
   * Serializes routine state for persistence.
   */
  serialize() {
    return {
      name: this.name,
      position: this.position,
      creepIds: this.creepIds,
      energyRoutes: this.energyRoutes,
    };
  }

  /**
   * Restores routine state from serialized data.
   */
  deserialize(data: any): void {
    this.name = data.name;
    this._position = new RoomPosition(
      data.position.x,
      data.position.y,
      data.position.roomName
    );
    this.creepIds = data.creepIds;
    this.energyRoutes = data.energyRoutes;
  }

  /**
   * Calculates spawn queue for carriers.
   *
   * @param room - The room to spawn in
   */
  calcSpawnQueue(room: Room): void {
    if (this.creepIds.carrier.length < 1) {
      this.spawnQueue.push({
        body: [CARRY, CARRY, MOVE, MOVE],
        pos: this.position,
        role: "carrier",
      });
    }
  }

  /**
   * Handles local delivery/pickup at the current waypoint.
   *
   * When near a waypoint, carriers either:
   * - Pick up energy from surplus points (containers, piles)
   * - Deliver energy to deficit points (spawn, extensions, towers)
   * - Support builders with energy transfers
   *
   * @param creep - The carrier creep
   * @param currentWaypointIdx - Index of current waypoint
   * @param route - The route being followed
   * @returns True if a local action was performed
   */
  LocalDelivery(
    creep: Creep,
    currentWaypointIdx: number,
    route: EnergyRoute
  ): boolean {
    let currentRouteWaypoint = route.waypoints[currentWaypointIdx];
    let currentWaypoint = new RoomPosition(
      currentRouteWaypoint.x,
      currentRouteWaypoint.y,
      currentRouteWaypoint.roomName
    );

    if (creep.pos.getRangeTo(currentWaypoint) > 3) {
      return false;
    }

    // Deliver energy at deficit waypoints
    if (
      creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
      !currentRouteWaypoint.surplus
    ) {
      console.log("delivering energy");
      let nearbyObjects = currentWaypoint.findInRange(FIND_STRUCTURES, 3, {
        filter: (structure) => {
          return (
            (structure.structureType == STRUCTURE_CONTAINER ||
              structure.structureType == STRUCTURE_EXTENSION ||
              structure.structureType == STRUCTURE_SPAWN ||
              structure.structureType == STRUCTURE_TOWER ||
              structure.structureType == STRUCTURE_STORAGE) &&
            structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
          );
        },
      });

      let nearestObject = sortBy(nearbyObjects, (structure) => {
        return creep.pos.getRangeTo(structure);
      })[0];

      if (nearestObject != null) {
        creep.moveTo(nearestObject, { maxOps: 50, range: 1 });
        creep.transfer(nearestObject, RESOURCE_ENERGY);
        return true;
      }
    }

    // Pick up energy at surplus waypoints
    if (currentRouteWaypoint.surplus) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        console.log("picking up energy");

        // Try containers first
        let nearbyObjects = currentWaypoint.findInRange(FIND_STRUCTURES, 3, {
          filter: (structure) => {
            return (
              structure.structureType == STRUCTURE_CONTAINER &&
              structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0
            );
          },
        });

        let nearestObject = sortBy(nearbyObjects, (structure) => {
          return creep.pos.getRangeTo(structure);
        })[0];

        if (nearestObject != null) {
          creep.moveTo(nearestObject, { maxOps: 50, range: 1 });
          creep.withdraw(nearestObject, RESOURCE_ENERGY);
          return true;
        }

        // Try dropped energy piles
        let nearestEnergyPile = sortBy(
          currentWaypoint.findInRange(FIND_DROPPED_RESOURCES, 3),
          (energyPile) => {
            return creep.pos.getRangeTo(energyPile);
          }
        )[0];

        if (nearestEnergyPile != null) {
          creep.moveTo(nearestEnergyPile, { maxOps: 50, range: 1 });
          creep.pickup(nearestEnergyPile);
          return true;
        }
      } else if (creep.store.getUsedCapacity(RESOURCE_ENERGY)) {
        // If full at surplus point, support nearby builders
        console.log("delivering local energy");
        let nearbyObjects = currentWaypoint.findInRange(FIND_CREEPS, 3, {
          filter: (creep) => {
            return (
              creep.memory.role == "busyBuilder" &&
              creep.store.getFreeCapacity(RESOURCE_ENERGY) > 20
            );
          },
        });

        let nearestObject = sortBy(nearbyObjects, (structure) => {
          return creep.pos.getRangeTo(structure);
        })[0];

        if (nearestObject != null) {
          creep.moveTo(nearestObject, { maxOps: 50, range: 1 });
          creep.transfer(nearestObject, RESOURCE_ENERGY);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Moves a carrier toward the next waypoint in the route.
   *
   * Updates carrier state when reaching waypoint proximity.
   *
   * @param creep - The carrier creep
   * @param currentWaypointIdx - Current waypoint index
   * @param route - The route being followed
   * @param carrier - Carrier assignment to update
   */
  MoveToNextWaypoint(
    creep: Creep,
    currentWaypointIdx: number,
    route: EnergyRoute,
    carrier: { creepId: Id<Creep>; waypointIdx: number }
  ): void {
    console.log("Moving to next waypoint: " + currentWaypointIdx);

    let nextWaypointIdx = currentWaypointIdx + 1;
    if (nextWaypointIdx >= route.waypoints.length) {
      nextWaypointIdx = 0;
    }

    let nextMemWaypoint = route.waypoints[nextWaypointIdx];
    let nextWaypoint = new RoomPosition(
      nextMemWaypoint.x,
      nextMemWaypoint.y,
      nextMemWaypoint.roomName
    );

    creep.moveTo(nextWaypoint, { maxOps: 50 });

    new RoomVisual(creep.room.name).line(creep.pos, nextWaypoint);

    if (creep.pos.getRangeTo(nextWaypoint) <= 3) {
      carrier.waypointIdx = nextWaypointIdx;
    }
  }

  /**
   * Calculates energy transportation routes from mines to spawn.
   *
   * Creates one route per energy source with 2 waypoints:
   * - Waypoint 0: Source location (surplus/pickup)
   * - Waypoint 1: Spawn location (deficit/delivery)
   *
   * @param room - The room to calculate routes for
   */
  calculateRoutes(room: Room): void {
    if (!room.memory.routines.energyMines) {
      return;
    }

    let mines = room.memory.routines.energyMines as {
      sourceMine: SourceMine;
    }[];

    let miners = room.find(FIND_MY_CREEPS, {
      filter: (creep) => {
        return creep.memory.role == "busyHarvester";
      },
    });
    if (miners.length == 0) {
      return;
    }

    let spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length == 0) {
      return;
    }
    let spawn = spawns[0];

    this.energyRoutes = [];
    forEach(mines, (mineData) => {
      let mine = mineData.sourceMine;
      if (!mine || !mine.HarvestPositions || mine.HarvestPositions.length == 0) {
        return;
      }

      let harvestPos = new RoomPosition(
        mine.HarvestPositions[0].x,
        mine.HarvestPositions[0].y,
        mine.HarvestPositions[0].roomName
      );

      this.energyRoutes.push({
        waypoints: [
          {
            x: harvestPos.x,
            y: harvestPos.y,
            roomName: harvestPos.roomName,
            surplus: true,
          },
          {
            x: spawn.pos.x,
            y: spawn.pos.y,
            roomName: spawn.pos.roomName,
            surplus: false,
          },
        ],
        Carriers: [],
      });
    });

    this.assignCarriersToRoutes();
  }

  /**
   * Assigns available carriers to routes round-robin style.
   */
  private assignCarriersToRoutes(): void {
    if (this.energyRoutes.length == 0) {
      return;
    }

    let carrierIds = this.creepIds["carrier"] || [];
    let routeIndex = 0;

    forEach(carrierIds, (carrierId) => {
      let creep = Game.getObjectById(carrierId);
      if (creep == null) {
        return;
      }

      let route = this.energyRoutes[routeIndex % this.energyRoutes.length];
      let alreadyAssigned = route.Carriers.some(
        (c) => c.creepId === carrierId
      );

      if (!alreadyAssigned) {
        route.Carriers.push({ creepId: carrierId, waypointIdx: 0 });
      }
      routeIndex++;
    });
  }
}
