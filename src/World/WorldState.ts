/**
 * World State Management - High-level API for the entire world
 *
 * Orchestrates:
 * - Multiple colonies (isolated node networks)
 * - Inter-colony relationships (distance, potential merging)
 * - Global resource tracking
 * - Mission-level decisions (expansion, defense, etc.)
 *
 * This is the primary interface for game logic that needs to think
 * about the colony/world level rather than individual rooms.
 */

import { WorldGraph } from "./interfaces";
import { GraphBuilder, GraphAnalyzer } from "./index";
import {
  Colony,
  ColonyManager,
  ColonyResources,
  World,
  ColonyStatus,
} from "./Colony";

export interface WorldConfig {
  /** Auto-detect disconnected components and create colonies */
  autoCreateColonies: boolean;

  /** Try to merge adjacent colonies */
  autoMergeColonies: boolean;

  /** Update colony status automatically */
  autoUpdateStatus: boolean;

  /** How often to rebuild the world graph (in ticks) */
  rebuildInterval: number;
}

const DEFAULT_CONFIG: WorldConfig = {
  autoCreateColonies: true,
  autoMergeColonies: true,
  autoUpdateStatus: true,
  rebuildInterval: 50,
};

/**
 * WorldState - Manages all colonies and the global world state.
 *
 * Call periodically to keep world state in sync with actual game state.
 */
export class WorldState {
  private world: World;
  private config: WorldConfig;
  private lastRebuild: number = 0;

  constructor(world: World, config: Partial<WorldConfig> = {}) {
    this.world = world;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get all colonies.
   */
  getColonies(): Colony[] {
    return Array.from(this.world.colonies.values());
  }

  /**
   * Get a colony by ID.
   */
  getColony(colonyId: string): Colony | undefined {
    return this.world.colonies.get(colonyId);
  }

  /**
   * Find which colony owns a node.
   */
  findColonyByNode(nodeId: string): Colony | undefined {
    const colonyId = this.world.nodeToColony.get(nodeId);
    if (!colonyId) return undefined;
    return this.world.colonies.get(colonyId);
  }

  /**
   * Find colonies in a specific room.
   */
  findColoniesInRoom(roomName: string): Colony[] {
    return this.getColonies().filter(c => c.controlledRooms.has(roomName));
  }

  /**
   * Get total resources across all colonies.
   */
  getTotalResources(): ColonyResources {
    const total: ColonyResources = {
      energy: 0,
      power: 0,
      minerals: new Map(),
      lastUpdated: Game.time,
    };

    for (const colony of this.getColonies()) {
      total.energy += colony.resources.energy;
      total.power += colony.resources.power;

      for (const [mineral, amount] of colony.resources.minerals) {
        total.minerals.set(mineral, (total.minerals.get(mineral) || 0) + amount);
      }
    }

    return total;
  }

  /**
   * Get status summary of all colonies.
   */
  getStatusSummary(): Map<ColonyStatus, number> {
    const summary = new Map<ColonyStatus, number>();

    for (const colony of this.getColonies()) {
      summary.set(colony.status, (summary.get(colony.status) || 0) + 1);
    }

    return summary;
  }

  /**
   * Rebuild world from scratch (call periodically).
   *
   * Rebuilds graphs from RoomMap for all controlled rooms,
   * detects colonies, and updates state.
   */
  rebuild(controlledRooms: string[]): void {
    if (Game.time - this.lastRebuild < this.config.rebuildInterval) {
      return; // Skip rebuild, use cached state
    }

    this.lastRebuild = Game.time;

    // Build graphs for all rooms
    const roomGraphs = new Map<string, WorldGraph>();
    for (const roomName of controlledRooms) {
      try {
        roomGraphs.set(roomName, GraphBuilder.buildRoomGraph(roomName));
      } catch (err) {
        console.log(`[World] Error building graph for ${roomName}: ${err}`);
      }
    }

    if (roomGraphs.size === 0) {
      console.log("[World] No valid room graphs built");
      return;
    }

    // Merge all room graphs into one world graph
    const mergedGraph = GraphBuilder.mergeRoomGraphs(roomGraphs);

    // Create colonies from merged graph
    if (this.config.autoCreateColonies) {
      this.world = ColonyManager.buildColonies(
        mergedGraph,
        Array.from(controlledRooms)[0]
      );
    }

    // Update status for all colonies
    if (this.config.autoUpdateStatus) {
      for (const colony of this.getColonies()) {
        ColonyManager.updateColonyStatus(colony);
      }
    }

    this.world.timestamp = Game.time;
    this.world.version++;
  }

  /**
   * Update resource levels for colonies from actual game state.
   *
   * Call this after rebuild() with actual room resource data.
   */
  updateResources(roomResources: Map<string, ColonyResources>): void {
    for (const colony of this.getColonies()) {
      ColonyManager.updateColonyResources(colony, roomResources);
    }

    this.world.metadata.totalEnergy = this.getTotalResources().energy;
  }

  /**
   * Check if two colonies should merge (are adjacent with path between them).
   */
  checkMergeOpportunity(colonyA: Colony, colonyB: Colony): boolean {
    // Check if they are in adjacent rooms
    const roomsA = Array.from(colonyA.controlledRooms);
    const roomsB = Array.from(colonyB.controlledRooms);

    for (const roomA of roomsA) {
      for (const roomB of roomsB) {
        if (this.areRoomsAdjacent(roomA, roomB)) {
          return true; // Adjacent - could merge if we build a bridge
        }
      }
    }

    return false;
  }

  /**
   * Remove a colony by ID.
   */
  removeColony(colonyId: string): boolean {
    return this.world.colonies.delete(colonyId);
  }

  /**
   * Add a colony.
   */
  addColony(colony: Colony): void {
    this.world.colonies.set(colony.id, colony);
    for (const nodeId of colony.graph.nodes.keys()) {
      this.world.nodeToColony.set(nodeId, colony.id);
    }
  }

  /**
   * Merge two colonies.
   */
  mergeColonies(colonyIdA: string, colonyIdB: string): void {
    const colonyA = this.world.colonies.get(colonyIdA);
    const colonyB = this.world.colonies.get(colonyIdB);

    if (!colonyA || !colonyB) {
      console.log(
        `[World] Cannot merge: colonies not found (${colonyIdA}, ${colonyIdB})`
      );
      return;
    }

    // Perform merge
    const merged = ColonyManager.mergeColonies(colonyA, colonyB);

    // Update world
    this.world.colonies.delete(colonyIdA);
    this.world.colonies.delete(colonyIdB);
    this.world.colonies.set(merged.id, merged);

    // Update node mappings
    for (const nodeId of merged.graph.nodes.keys()) {
      this.world.nodeToColony.set(nodeId, merged.id);
    }

    console.log(
      `[World] Merged colonies ${colonyIdA} + ${colonyIdB} -> ${merged.id}`
    );

    this.world.version++;
  }

  /**
   * Save world state to memory for persistence.
   */
  save(memory: any): void {
    // Save colony metadata (full graphs too large for typical memory)
    memory.world = {
      version: this.world.version,
      timestamp: this.world.timestamp,
      colonies: Array.from(this.world.colonies.values()).map(c => ({
        id: c.id,
        name: c.name,
        status: c.status,
        primaryRoom: c.primaryRoom,
        controlledRooms: Array.from(c.controlledRooms),
        resources: {
          energy: c.resources.energy,
          power: c.resources.power,
          lastUpdated: c.resources.lastUpdated,
        },
        metadata: c.metadata,
      })),
      metadata: this.world.metadata,
    };
  }

  /**
   * Load world state from memory.
   */
  static load(memory: any): WorldState {
    // For now, just create an empty world
    // Full deserialization would require rebuilding graphs
    const world: World = {
      colonies: new Map(),
      nodeToColony: new Map(),
      timestamp: Game.time,
      version: memory.world?.version || 1,
      metadata: memory.world?.metadata || {
        totalNodes: 0,
        totalEdges: 0,
        totalEnergy: 0,
      },
    };

    return new WorldState(world);
  }

  // ==================== Helpers ====================

  private areRoomsAdjacent(roomA: string, roomB: string): boolean {
    // Parse room coordinates
    const parseRoom = (
      roomName: string
    ): { x: number; y: number } | null => {
      const match = roomName.match(/([WE])(\d+)([NS])(\d+)/);
      if (!match) return null;

      const x = parseInt(match[2], 10) * (match[1] === "W" ? -1 : 1);
      const y = parseInt(match[4], 10) * (match[3] === "N" ? -1 : 1);
      return { x, y };
    };

    const coordA = parseRoom(roomA);
    const coordB = parseRoom(roomB);

    if (!coordA || !coordB) return false;

    const dist = Math.max(
      Math.abs(coordA.x - coordB.x),
      Math.abs(coordA.y - coordB.y)
    );
    return dist === 1; // Adjacent if max coordinate difference is 1
  }
}

/**
 * Global world state instance.
 * Manages all colonies for the entire game.
 */
let globalWorldState: WorldState | null = null;

export function initializeGlobalWorld(): WorldState {
  const world: World = {
    colonies: new Map(),
    nodeToColony: new Map(),
    timestamp: Game.time,
    version: 1,
    metadata: {
      totalNodes: 0,
      totalEdges: 0,
      totalEnergy: 0,
    },
  };

  globalWorldState = new WorldState(world, {
    autoCreateColonies: true,
    autoMergeColonies: false, // Be conservative with merging
    autoUpdateStatus: true,
    rebuildInterval: 50,
  });

  return globalWorldState;
}

export function getGlobalWorld(): WorldState {
  if (!globalWorldState) {
    globalWorldState = initializeGlobalWorld();
  }
  return globalWorldState;
}
