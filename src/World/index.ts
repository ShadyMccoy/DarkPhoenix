/**
 * World System - Room-atheist graph representation of the game world
 *
 * Multi-level abstraction:
 * 1. Graph Level: Nodes, edges, territories (spatial representation)
 * 2. Colony Level: Connected graphs + status + resources (game state)
 * 3. World Level: Multiple colonies + management (strategic overview)
 *
 * Main Components:
 * - GraphBuilder: Create graphs from RoomMap data
 * - GraphAnalyzer: Measure and analyze graph structure
 * - GraphVisualizer: Debug graphs with room visuals
 * - ColonyManager: Create/merge/split colonies from graphs
 * - WorldState: Manage all colonies and world state
 *
 * Building Blocks:
 * - PeakClusterer: Group nearby peaks using Delaunay-inspired heuristic
 * - NodeBuilder: Create nodes from clustered peaks
 * - EdgeBuilder: Connect adjacent nodes with territory-based edges
 */

export * from "./interfaces";
export { PeakClusterer } from "./PeakClusterer";
export { NodeBuilder } from "./NodeBuilder";
export { EdgeBuilder } from "./EdgeBuilder";
export { GraphBuilder } from "./GraphBuilder";
export { GraphAnalyzer, type GraphMetrics, type NodeMetrics } from "./GraphAnalyzer";
export {
  GraphVisualizer,
  type VisualizationOptions,
} from "./Visualizer";
export {
  ColonyManager,
  type Colony,
  type ColonyStatus,
  type ColonyResources,
  type OperationInfo,
  type World,
} from "./Colony";
export {
  WorldState,
  type WorldConfig,
  initializeGlobalWorld,
  getGlobalWorld,
} from "./WorldState";
