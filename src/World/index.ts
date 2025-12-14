/**
 * World System - Room-atheist graph representation of the game world
 *
 * Exports all interfaces and builders for constructing and manipulating
 * the world graph structure.
 *
 * Main Components:
 * - GraphBuilder: Create graphs from RoomMap data
 * - GraphAnalyzer: Measure and analyze graph structure
 * - GraphVisualizer: Debug graphs with room visuals
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
