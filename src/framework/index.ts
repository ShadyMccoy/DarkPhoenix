/**
 * @fileoverview Flow-based colony economy framework.
 *
 * This framework models the colony as a flow network where energy flows from
 * sources through haulers to projects. The key innovation is solving the
 * bootstrap problem: hauling requires energy, but getting energy requires hauling.
 *
 * ## Core Concepts
 *
 * ### Nodes (from existing skeleton system)
 * - Territory-based spatial regions derived from peak detection
 * - Contain resources: sources, spawns, controllers, etc.
 *
 * ### Edge Types
 * - **SupplyEdge**: Source → Spawn assignment (mining)
 *   - Weight = net energy production (harvest - miner spawn cost)
 * - **CarryEdge**: Node → Node transport (hauling)
 *   - Weight = transport cost per energy unit
 * - **SpawnEdge**: Internal spawn capacity allocation
 * - **ProjectEdge**: Energy consumption for projects (upgrading, building)
 *
 * ### Flow Balance
 * The system finds an equilibrium where:
 *   Energy Produced = Mining Cost + Hauling Cost + Project Energy
 *
 * We maximize Project Energy subject to this constraint.
 *
 * ## Usage
 *
 * ```typescript
 * import { FlowNetwork, solveFlowBalance } from "./framework";
 *
 * // Create network from nodes
 * const network = new FlowNetwork(nodes, navigator);
 * network.build();
 *
 * // Analyze current state
 * const analysis = network.analyze();
 *
 * // Or solve for optimal allocation
 * const allocation = solveFlowBalance(
 *   network.getSupplyEdges(),
 *   network.getCarryEdges()
 * );
 * ```
 *
 * @module framework
 */

// Edge types and calculations
export {
  FlowEdge,
  FlowEdgeType,
  SupplyEdge,
  CarryEdge,
  SpawnEdge,
  ProjectEdge,
  ProjectType,
  SpawnAllocation as SpawnEdgeAllocation,
  createFlowEdgeId,
  createSupplyEdge,
  createCarryEdge,
  calculateSupplyEdgeNetEnergy,
  calculateSupplyEdgeNetPerTick,
  calculateEffectiveMiningTime,
  calculateTravelTimeLoss,
  calculateCarryEdgeThroughput,
  calculateCarryEdgeCostPerEnergy,
  calculateCarryEdgeEfficiency,
  calculateOptimalMinerSize,
  calculateMinerSpawnCost,
  calculateHaulerSpawnCost,
  BODY_PART_COSTS,
} from "./FlowEdge";

// Flow network
export {
  FlowNetwork,
  FlowNetworkConfig,
  FlowNetworkAnalysis,
  SpawnFlowNode,
  optimizeFlowAllocation,
  calculateMiningMarginalValue,
  calculateHaulingMarginalValue,
} from "./FlowNetwork";

// Balance solver
export {
  solveFlowBalance,
  FlowAllocation,
  SupplyAllocation,
  CarryAllocation,
  BalanceSolverConfig,
  formatFlowAllocation,
} from "./FlowBalance";

// Integration with node system
export { buildFlowNetworkFromNodes } from "./FlowIntegration";
