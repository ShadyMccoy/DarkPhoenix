/**
 * @fileoverview Integration between flow network and existing node system.
 *
 * This module provides the bridge between the new flow-based framework
 * and the existing node/skeleton infrastructure.
 *
 * @module framework/FlowIntegration
 */

import { Node } from "../nodes/Node";
import { NodeNavigator } from "../nodes/NodeNavigator";
import { FlowNetwork, FlowNetworkConfig, FlowNetworkAnalysis } from "./FlowNetwork";
import { solveFlowBalance, FlowAllocation, formatFlowAllocation } from "./FlowBalance";

/**
 * Result of building a flow network from nodes.
 */
export interface FlowNetworkBuildResult {
  /** The flow network */
  network: FlowNetwork;

  /** Analysis of the network */
  analysis: FlowNetworkAnalysis;

  /** Optimal allocation solution */
  allocation: FlowAllocation;

  /** Summary for logging */
  summary: string;
}

/**
 * Builds a flow network from the existing node system.
 *
 * This is the main entry point for integrating the flow framework
 * with the existing colony infrastructure.
 *
 * @param nodes - All nodes in the colony
 * @param navigator - Node navigator with spatial edges
 * @param config - Optional network configuration
 */
export function buildFlowNetworkFromNodes(
  nodes: Node[],
  navigator: NodeNavigator,
  config?: Partial<FlowNetworkConfig>
): FlowNetworkBuildResult {
  // Create and build the flow network
  const network = new FlowNetwork(nodes, navigator, config);
  network.build();

  // Analyze current state
  const analysis = network.analyze();

  // Solve for optimal allocation
  const allocation = solveFlowBalance(
    network.getSupplyEdges(),
    network.getCarryEdges()
  );

  // Build summary
  const summary = buildSummary(analysis, allocation);

  return {
    network,
    analysis,
    allocation,
    summary,
  };
}

/**
 * Builds a human-readable summary of the flow analysis.
 */
function buildSummary(
  analysis: FlowNetworkAnalysis,
  allocation: FlowAllocation
): string {
  const lines: string[] = [
    "╔════════════════════════════════════════╗",
    "║       FLOW NETWORK ANALYSIS            ║",
    "╠════════════════════════════════════════╣",
    "",
    "┌─ Network Structure ─────────────────────",
    `│ Spawn Nodes:     ${analysis.spawnNodes.length}`,
    `│ Supply Edges:    ${allocation.supplies.length}`,
    `│ Carry Edges:     ${allocation.carries.filter(c => c.haulerCount > 0).length}`,
    "",
    "┌─ Energy Flow (per tick) ────────────────",
    `│ Production:      ${analysis.totalProduction.toFixed(2)}`,
    `│ Mining Cost:     ${analysis.miningOverhead.toFixed(2)}`,
    `│ Hauling Cost:    ${analysis.haulingOverhead.toFixed(2)}`,
    `│ ─────────────────────────`,
    `│ Project Energy:  ${analysis.projectEnergy.toFixed(2)}`,
    "",
    "┌─ Allocation Result ─────────────────────",
    `│ Sustainable:     ${allocation.isSustainable ? "✓ YES" : "✗ NO"}`,
    `│ Optimized:       ${allocation.projectEnergy.toFixed(2)}/tick for projects`,
  ];

  if (!allocation.isSustainable) {
    lines.push(
      "",
      "⚠ WARNING: System not self-sustaining!",
      `  Deficit: ${(-allocation.projectEnergy).toFixed(2)}/tick`
    );
  }

  // Per-spawn breakdown
  if (analysis.spawnNodes.length > 0) {
    lines.push("", "┌─ Per-Spawn Breakdown ────────────────────");

    for (const spawn of analysis.spawnNodes) {
      lines.push(
        `│ ${spawn.spawnId}:`,
        `│   Income: ${spawn.energyIncome.toFixed(1)}/tick`,
        `│   Cost:   ${spawn.energyCost.toFixed(1)}/tick`,
        `│   Net:    ${spawn.netEnergy.toFixed(1)}/tick`,
        `│   Sources: ${spawn.supplyEdges.length}`
      );
    }
  }

  lines.push(
    "",
    "╚════════════════════════════════════════╝"
  );

  return lines.join("\n");
}

/**
 * Calculates key economic ratios for the colony.
 */
export interface EconomicRatios {
  /** Mining efficiency: net energy / gross energy */
  miningEfficiency: number;

  /** Hauling efficiency: energy delivered / (energy + cost) */
  haulingEfficiency: number;

  /** Overall efficiency: project energy / gross production */
  overallEfficiency: number;

  /** Spawn utilization: used capacity / total capacity */
  spawnUtilization: number;
}

/**
 * Calculates economic efficiency ratios from a flow allocation.
 */
export function calculateEconomicRatios(
  allocation: FlowAllocation
): EconomicRatios {
  const grossProduction = allocation.supplies.reduce(
    (sum, s) => sum + s.harvestPerTick,
    0
  );

  const miningCost = allocation.supplies.reduce(
    (sum, s) => sum + s.spawnCostPerTick,
    0
  );

  const haulingCost = allocation.carries.reduce(
    (sum, c) => sum + c.spawnCostPerTick,
    0
  );

  const energyHauled = allocation.carries.reduce(
    (sum, c) => sum + c.energyCarried,
    0
  );

  return {
    miningEfficiency:
      grossProduction > 0 ? (grossProduction - miningCost) / grossProduction : 0,

    haulingEfficiency:
      energyHauled + haulingCost > 0
        ? energyHauled / (energyHauled + haulingCost)
        : 1,

    overallEfficiency:
      grossProduction > 0 ? allocation.projectEnergy / grossProduction : 0,

    // Spawn utilization would need spawn capacity info
    spawnUtilization: 0, // TODO: calculate from spawn data
  };
}

/**
 * Identifies bottlenecks in the flow network.
 */
export interface FlowBottleneck {
  type: "spawn_capacity" | "hauling_capacity" | "source_saturation" | "distance";
  description: string;
  severity: "low" | "medium" | "high";
  suggestion: string;
}

/**
 * Identifies bottlenecks in the flow network.
 */
export function identifyBottlenecks(
  analysis: FlowNetworkAnalysis,
  allocation: FlowAllocation
): FlowBottleneck[] {
  const bottlenecks: FlowBottleneck[] = [];

  // Check for unsustainable network
  if (!allocation.isSustainable) {
    bottlenecks.push({
      type: "spawn_capacity",
      description: "Network is not self-sustaining",
      severity: "high",
      suggestion: "Reduce mining or hauling allocation, or add more local sources",
    });
  }

  // Check for source saturation
  for (const supply of allocation.supplies) {
    const harvestRate = supply.minerCount * supply.edge.minerWorkParts * 2;
    const sourceLimit = supply.edge.sourceCapacity / 300;

    if (harvestRate < sourceLimit * 0.9 && supply.minerCount > 0) {
      bottlenecks.push({
        type: "source_saturation",
        description: `Source ${supply.edge.sourceId} under-harvested (${((harvestRate / sourceLimit) * 100).toFixed(0)}%)`,
        severity: "low",
        suggestion: "Add more miners if spawn capacity allows",
      });
    }
  }

  // Check for high hauling costs
  const haulingCost = allocation.carries.reduce((sum, c) => sum + c.spawnCostPerTick, 0);
  const miningProduction = allocation.supplies.reduce((sum, s) => sum + s.harvestPerTick, 0);

  if (miningProduction > 0 && haulingCost / miningProduction > 0.2) {
    bottlenecks.push({
      type: "hauling_capacity",
      description: `High hauling overhead (${((haulingCost / miningProduction) * 100).toFixed(0)}% of production)`,
      severity: "medium",
      suggestion: "Consider building containers/links or mining closer sources",
    });
  }

  // Check for long distance sources
  for (const supply of allocation.supplies) {
    if (!supply.isLocal && supply.edge.spawnToSourceDistance > 100) {
      bottlenecks.push({
        type: "distance",
        description: `Source ${supply.edge.sourceId} is far from spawn (${supply.edge.spawnToSourceDistance} tiles)`,
        severity: "low",
        suggestion: "Consider building a closer spawn or using links",
      });
    }
  }

  return bottlenecks;
}
