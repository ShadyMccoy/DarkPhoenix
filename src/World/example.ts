/**
 * World Graph System - Usage Examples
 *
 * This file demonstrates how to use the world graph system for:
 * 1. Creating graphs from game rooms
 * 2. Analyzing graph structure
 * 3. Visualizing graphs for debugging
 *
 * Copy and adapt these examples to integrate the system into your game logic.
 */

import {
  GraphBuilder,
  GraphAnalyzer,
  GraphVisualizer,
  ColonyManager,
  WorldState,
  initializeGlobalWorld,
  getGlobalWorld,
  type GraphMetrics,
  type VisualizationOptions,
  type Colony,
  type ColonyResources,
} from "./index";

/**
 * Example 1: Build a graph from a single room and analyze it
 */
export function exampleBuildAndAnalyze(roomName: string): void {
  // Build the graph from RoomMap data
  const graph = GraphBuilder.buildRoomGraph(roomName);

  console.log(`Built graph for ${roomName}:`);
  console.log(`  Nodes: ${graph.nodes.size}`);
  console.log(`  Edges: ${graph.edges.size}`);

  // Analyze the graph structure
  const metrics = GraphAnalyzer.analyzeGraph(graph);

  console.log("Graph Metrics:");
  console.log(`  Average Degree: ${metrics.averageDegree.toFixed(2)}`);
  console.log(`  Max Degree: ${metrics.maxDegree}`);
  console.log(`  Connected: ${metrics.isConnected}`);
  console.log(`  Territory Balance: ${(metrics.territoryBalance * 100).toFixed(1)}%`);
  console.log(
    `  Average Territory Size: ${metrics.averageTerritorySize.toFixed(1)}`
  );

  if (metrics.hasProblems) {
    console.log("Problems detected:");
    for (const problem of metrics.problems) {
      console.log(`  - ${problem}`);
    }
  }

  // Find critical nodes
  const articulations = GraphAnalyzer.findArticulationPoints(graph);
  if (articulations.length > 0) {
    console.log(`Articulation points (critical nodes): ${articulations.length}`);
  }

  const weak = GraphAnalyzer.findWeakNodes(graph);
  if (weak.length > 0) {
    console.log(`Weak nodes (low connectivity): ${weak.length}`);
  }
}

/**
 * Example 2: Visualize a graph in a room with different visualization modes
 */
export function exampleVisualize(roomName: string): void {
  const room = Game.rooms[roomName];
  if (!room) {
    console.log(`Room ${roomName} not found`);
    return;
  }

  // Build the graph
  const graph = GraphBuilder.buildRoomGraph(roomName);

  // Option 1: Basic visualization (nodes and edges only)
  const basicOptions: VisualizationOptions = {
    showNodes: true,
    showEdges: true,
    showTerritories: false,
    showLabels: true,
  };

  GraphVisualizer.visualize(room, graph, basicOptions);
}

/**
 * Example 3: Visualize with territories and debug info
 */
export function exampleVisualizeDebug(roomName: string): void {
  const room = Game.rooms[roomName];
  if (!room) return;

  const graph = GraphBuilder.buildRoomGraph(roomName);

  const debugOptions: VisualizationOptions = {
    showNodes: true,
    showEdges: true,
    showTerritories: true,
    showLabels: true,
    showDebug: true,
    colorScheme: "temperature",
  };

  GraphVisualizer.visualize(room, graph, debugOptions);
}

/**
 * Example 4: Store and reuse graph structure (for optimization)
 */
export function exampleStoreGraph(room: Room): void {
  // Build graph once
  const graph = GraphBuilder.buildRoomGraph(room.name);

  // Store in room memory for later use
  room.memory.worldGraph = {
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.size,
    timestamp: Game.time,
  };

  // Store full graph data if needed (for analysis)
  // room.memory.worldGraphData = JSON.stringify({...graph});

  console.log(`Stored graph snapshot in ${room.name}`);
}

/**
 * Example 5: Analyze a specific node
 */
export function exampleAnalyzeNode(roomName: string, nodeId: string): void {
  const graph = GraphBuilder.buildRoomGraph(roomName);

  const nodeMetrics = GraphAnalyzer.analyzeNode(graph, nodeId);
  if (!nodeMetrics) {
    console.log(`Node ${nodeId} not found`);
    return;
  }

  console.log(`Node Analysis: ${nodeId}`);
  console.log(`  Type: ${nodeMetrics.importance}`);
  console.log(`  Degree (connections): ${nodeMetrics.degree}`);
  console.log(`  Territory Size: ${nodeMetrics.territorySize}`);
  console.log(`  Closeness: ${nodeMetrics.closeness.toFixed(3)}`);
  console.log(`  Betweenness (importance): ${nodeMetrics.betweenness}`);
  console.log(`  Redundancy (failure tolerance): ${nodeMetrics.redundancy}`);
}

/**
 * Example 6: Monitor graph health over time
 */
export function exampleMonitorHealth(roomName: string): void {
  const graph = GraphBuilder.buildRoomGraph(roomName);
  const metrics = GraphAnalyzer.analyzeGraph(graph);

  // Could store this data in memory for trend analysis
  if (!Memory.worldHealthHistory) {
    Memory.worldHealthHistory = [];
  }

  Memory.worldHealthHistory.push({
    room: roomName,
    tick: Game.time,
    nodeCount: metrics.nodeCount,
    edgeCount: metrics.edgeCount,
    connected: metrics.isConnected,
    balance: metrics.territoryBalance,
    hasProblems: metrics.hasProblems,
  });

  // Keep last 1000 ticks
  if (Memory.worldHealthHistory.length > 1000) {
    Memory.worldHealthHistory.shift();
  }

  // Log if problems detected
  if (metrics.hasProblems) {
    console.log(
      `[WORLD] Health issues in ${roomName} at ${Game.time}: ${metrics.problems.join(", ")}`
    );
  }
}

/**
 * Example 7: Compare two graph configurations (for refinement)
 *
 * Use this to test different clustering thresholds or heuristics.
 */
export function exampleCompareGraphs(roomName: string): void {
  // Current configuration
  const graph1 = GraphBuilder.buildRoomGraph(roomName);
  const metrics1 = GraphAnalyzer.analyzeGraph(graph1);

  console.log("Configuration 1 (current):");
  console.log(`  Nodes: ${metrics1.nodeCount}, Balance: ${(metrics1.territoryBalance * 100).toFixed(1)}%`);

  // To test a different configuration:
  // 1. Modify PeakClusterer threshold
  // 2. Build a new graph
  // 3. Compare metrics

  // This is where empirical refinement happens:
  // - Adjust MERGE_THRESHOLD in PeakClusterer
  // - Test on multiple maps
  // - Compare balance and connectivity
  // - Find optimal values for your maps
}

/**
 * Example 8: Use graph for creep routing (future integration)
 *
 * This shows how creeps will eventually route through the node network.
 */
export function exampleRoutingPlaceholder(
  creep: Creep,
  targetRoom: string
): void {
  // Future: Replace basic moveTo() with node-based routing
  //
  // const currentRoom = creep.room.name;
  // const graph = GraphBuilder.buildRoomGraph(currentRoom);
  //
  // // Find creep's current node
  // let currentNode = null;
  // for (const node of graph.nodes.values()) {
  //   if (node.room === currentRoom &&
  //       node.territory.some(pos => pos.equals(creep.pos))) {
  //     currentNode = node;
  //     break;
  //   }
  // }
  //
  // // Find target node in target room
  // const targetGraph = GraphBuilder.buildRoomGraph(targetRoom);
  // const targetNode = Array.from(targetGraph.nodes.values())[0]; // Pick hub
  //
  // // Calculate path through node network
  // const path = this.findPathThroughNodes(graph, currentNode, targetNode);
  // creep.moveToNextNode(path[0]);
}

/**
 * Setup: Call this once per reset to initialize world graph monitoring
 */
export function setupWorldGraphMonitoring(): void {
  console.log("[WORLD] Initializing graph monitoring");

  // Build graphs for all controlled rooms
  for (const room of Object.values(Game.rooms)) {
    try {
      const graph = GraphBuilder.buildRoomGraph(room.name);
      console.log(`[WORLD] Built graph for ${room.name}: ${graph.nodes.size} nodes, ${graph.edges.size} edges`);

      // Store metadata
      if (!room.memory.world) {
        room.memory.world = {};
      }
      room.memory.world.lastGraphUpdate = Game.time;
      room.memory.world.nodeCount = graph.nodes.size;
    } catch (err) {
      console.log(`[WORLD] Error building graph for ${room.name}: ${err}`);
    }
  }

  console.log("[WORLD] Graph monitoring initialized");
}

/**
 * Periodic update: Call this occasionally to refresh graphs and check health
 */
export function updateWorldGraphs(): void {
  for (const room of Object.values(Game.rooms)) {
    // Only update every 100 ticks to save CPU
    if (Game.time % 100 !== room.name.charCodeAt(0) % 100) {
      continue;
    }

    try {
      exampleMonitorHealth(room.name);
    } catch (err) {
      console.log(`[WORLD] Error updating graph for ${room.name}: ${err}`);
    }
  }
}

// ============================================================================
// COLONY EXAMPLES - Managing multiple isolated colonies
// ============================================================================

/**
 * Example 9: Create colonies from a merged world graph
 *
 * A colony is a connected component of the world graph.
 * Multiple colonies can exist (e.g., initial base + scouted outpost).
 */
export function exampleCreateColonies(
  controlledRooms: string[]
): Map<string, Colony> {
  // Build graphs for all rooms
  const roomGraphs = new Map();
  for (const room of controlledRooms) {
    try {
      roomGraphs.set(room, GraphBuilder.buildRoomGraph(room));
    } catch (err) {
      console.log(`[Colonies] Error building graph for ${room}: ${err}`);
    }
  }

  if (roomGraphs.size === 0) {
    console.log("[Colonies] No valid room graphs");
    return new Map();
  }

  // Merge all room graphs into one world graph
  const mergedGraph = GraphBuilder.mergeRoomGraphs(roomGraphs);

  // Split into colonies (one per connected component)
  const coloniesWorld = ColonyManager.buildColonies(
    mergedGraph,
    controlledRooms[0]
  );

  console.log(`[Colonies] Created ${coloniesWorld.colonies.size} colonies:`);
  for (const colony of coloniesWorld.colonies.values()) {
    console.log(`  - ${colony.id}: ${colony.graph.nodes.size} nodes in ${colony.controlledRooms.size} rooms`);
  }

  return coloniesWorld.colonies;
}

/**
 * Example 10: Manage world state with colonies
 *
 * The WorldState class handles colony updates, merging, and status tracking.
 */
export function exampleWorldStateManagement(controlledRooms: string[]): void {
  // Initialize global world
  const world = initializeGlobalWorld();

  // Rebuild world (rebuilds all graphs and colonies)
  world.rebuild(controlledRooms);

  // Get all colonies
  const colonies = world.getColonies();
  console.log(`[World] Total colonies: ${colonies.length}`);

  // Get status summary
  const statusSummary = world.getStatusSummary();
  for (const [status, count] of statusSummary) {
    console.log(`  ${status}: ${count}`);
  }

  // Get total resources across all colonies
  const totalResources = world.getTotalResources();
  console.log(`[World] Total energy: ${totalResources.energy}`);
}

/**
 * Example 11: Track individual colony status
 */
export function exampleColonyStatus(colonyId: string): void {
  const world = getGlobalWorld();
  const colony = world.getColony(colonyId);

  if (!colony) {
    console.log(`Colony ${colonyId} not found`);
    return;
  }

  console.log(`Colony: ${colony.name} (${colony.id})`);
  console.log(`  Status: ${colony.status}`);
  console.log(`  Primary Room: ${colony.primaryRoom}`);
  console.log(`  Controlled Rooms: ${Array.from(colony.controlledRooms).join(", ")}`);
  console.log(`  Nodes: ${colony.graph.nodes.size}`);
  console.log(`  Edges: ${colony.graph.edges.size}`);
  console.log(`  Energy: ${colony.resources.energy}`);
  console.log(`  Created: ${colony.createdAt}`);
}

/**
 * Example 12: Detect and merge adjacent colonies
 *
 * When you expand to a new room and connect it to an existing colony,
 * they should merge into one.
 */
export function exampleMergeColonies(controlledRooms: string[]): void {
  const world = getGlobalWorld();
  world.rebuild(controlledRooms);

  const colonies = world.getColonies();

  if (colonies.length < 2) {
    console.log("[Merge] Only 1 colony, nothing to merge");
    return;
  }

  // Check each pair of colonies
  for (let i = 0; i < colonies.length; i++) {
    for (let j = i + 1; j < colonies.length; j++) {
      const colonyA = colonies[i];
      const colonyB = colonies[j];

      if (world.checkMergeOpportunity(colonyA, colonyB)) {
        console.log(
          `[Merge] Opportunity to merge ${colonyA.id} + ${colonyB.id}`
        );
        // Merge them
        world.mergeColonies(colonyA.id, colonyB.id);
        console.log(`[Merge] Merged! Now have ${world.getColonies().length} colonies`);
        return;
      }
    }
  }

  console.log("[Merge] No merge opportunities found");
}

/**
 * Example 13: Update colony resources from game state
 *
 * After rebuilding the world, update it with actual game resources.
 */
export function exampleUpdateColonyResources(
  roomResources: Map<string, ColonyResources>
): void {
  const world = getGlobalWorld();

  // Update all colonies with their resources
  world.updateResources(roomResources);

  // Check colony status
  for (const colony of world.getColonies()) {
    console.log(
      `${colony.name}: ${colony.status} (${colony.resources.energy} energy)`
    );
  }
}

/**
 * Example 14: Save and load world state
 *
 * Persist colony metadata to memory for long-term tracking.
 */
export function examplePersistWorld(): void {
  const world = getGlobalWorld();

  // Save to memory
  world.save(Memory);
  console.log("[World] Saved colony state to memory");

  // Later: Load from memory
  // const loaded = WorldState.load(Memory);
  // Note: Full graphs not persisted (too large), would need to rebuild
}

/**
 * Example 15: Visualize all colonies
 *
 * Show the graph structure for each colony.
 */
export function exampleVisualizeColonies(): void {
  const world = getGlobalWorld();

  for (const colony of world.getColonies()) {
    // Visualize in one of the colony's rooms
    const roomName = colony.primaryRoom;
    const room = Game.rooms[roomName];
    if (!room) continue;

    console.log(`[Vis] Visualizing ${colony.name} in ${roomName}`);

    // Basic visualization
    GraphVisualizer.visualize(room, colony.graph, {
      showNodes: true,
      showEdges: true,
      showTerritories: true,
      showLabels: true,
    });
  }
}

/**
 * Example 16: Split a colony if it becomes disconnected
 *
 * If part of your base is sieged/destroyed, split into separate colonies.
 */
export function exampleHandleColonySplit(colonyId: string): void {
  const world = getGlobalWorld();
  const colony = world.getColony(colonyId);

  if (!colony) return;

  // Check if colony is still connected
  const splitColonies = ColonyManager.splitColonyIfNeeded(colony);

  if (splitColonies.length === 1) {
    console.log(`[Split] ${colonyId} is still connected`);
    return;
  }

  console.log(
    `[Split] Colony split into ${splitColonies.length} separate colonies!`
  );
  for (const col of splitColonies) {
    console.log(`  - ${col.name}: ${col.graph.nodes.size} nodes`);
  }

  // Update world with new colonies
  world.colonies.delete(colonyId);
  for (const col of splitColonies) {
    world.colonies.set(col.id, col);
  }
}

declare global {
  interface Memory {
    worldHealthHistory?: Array<{
      room: string;
      tick: number;
      nodeCount: number;
      edgeCount: number;
      connected: boolean;
      balance: number;
      hasProblems: boolean;
    }>;
    world?: {
      version: number;
      timestamp: number;
      colonies: Array<{
        id: string;
        name: string;
        status: string;
        primaryRoom: string;
        controlledRooms: string[];
        resources: {
          energy: number;
          power: number;
          lastUpdated: number;
        };
        metadata: Record<string, any>;
      }>;
      metadata: {
        totalNodes: number;
        totalEdges: number;
        totalEnergy: number;
        missionStatus?: string;
      };
    };
  }
}
