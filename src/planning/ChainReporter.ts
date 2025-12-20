/**
 * @fileoverview Human-readable chain report generation.
 *
 * This module generates formatted text output for production chains,
 * making it easy for developers to understand economic flows and
 * identify bottlenecks.
 *
 * Critical Requirement: Output must be readable by developers to
 * collaborate on vision.
 */

import { Chain, ChainSegment, calculateProfit, calculateChainROI } from "./Chain";
import { Corp, CorpType } from "../corps/Corp";
import { Position } from "../market/Offer";
import {
  calculateTravelTime,
  calculateEffectiveWorkTime,
  CREEP_LIFETIME
} from "./EconomicConstants";

/**
 * Detailed step information for reporting
 */
export interface ChainStepReport {
  /** Step number (1-indexed) */
  stepNumber: number;
  /** Corp ID */
  corpId: string;
  /** Corp type */
  corpType: CorpType;
  /** Position where corp operates */
  position: Position;
  /** Resource being produced */
  resource: string;
  /** Quantity produced */
  quantity: number;
  /** Input cost */
  inputCost: number;
  /** Output price */
  outputPrice: number;
  /** Margin applied */
  margin: number;
  /** Profit at this step */
  profit: number;
  /** Travel time to nearest spawn (if applicable) */
  travelTime?: number;
  /** Effective work time (if applicable) */
  effectiveWorkTime?: number;
}

/**
 * Market equilibrium data for a resource
 */
export interface ResourceMarketData {
  /** Resource name */
  resource: string;
  /** Total supply */
  supply: number;
  /** Total demand */
  demand: number;
  /** Clearing price */
  price: number;
  /** Status: BALANCED, SHORTAGE, or SURPLUS */
  status: "BALANCED" | "SHORTAGE" | "SURPLUS";
  /** Imbalance amount (positive for surplus, negative for shortage) */
  imbalance: number;
}

/**
 * Complete chain report
 */
export interface ChainReport {
  /** Chain ID */
  chainId: string;
  /** Total profit */
  totalProfit: number;
  /** Profit margin percentage */
  profitMargin: number;
  /** ROI percentage */
  roi: number;
  /** Step-by-step breakdown */
  steps: ChainStepReport[];
  /** Market equilibrium summary */
  marketSummary: ResourceMarketData[];
  /** Formatted text output */
  formattedText: string;
}

/**
 * ChainReporter generates human-readable reports for production chains.
 *
 * Output format shows:
 * - Chain summary (profit, margin)
 * - Flow diagram (corp types and locations)
 * - Step-by-step breakdown with inputs/outputs
 * - Market equilibrium summary
 */
export class ChainReporter {
  /**
   * Generate a complete report for a chain.
   *
   * @param chain - The chain to report on
   * @param corpRegistry - Map of corp IDs to Corp instances
   * @returns Complete chain report with formatted text
   */
  static generateReport(
    chain: Chain,
    corpRegistry: Map<string, Corp>
  ): ChainReport {
    const steps = this.generateStepReports(chain, corpRegistry);
    const marketSummary = this.generateMarketSummary(chain, corpRegistry);
    const formattedText = this.formatReport(chain, steps, marketSummary, corpRegistry);

    return {
      chainId: chain.id,
      totalProfit: calculateProfit(chain),
      profitMargin: chain.mintValue > 0 ? calculateProfit(chain) / chain.mintValue : 0,
      roi: calculateChainROI(chain),
      steps,
      marketSummary,
      formattedText
    };
  }

  /**
   * Generate step-by-step reports for each segment in the chain.
   */
  private static generateStepReports(
    chain: Chain,
    corpRegistry: Map<string, Corp>
  ): ChainStepReport[] {
    const reports: ChainStepReport[] = [];

    for (let i = 0; i < chain.segments.length; i++) {
      const segment = chain.segments[i];
      const corp = corpRegistry.get(segment.corpId);

      const report: ChainStepReport = {
        stepNumber: i + 1,
        corpId: segment.corpId,
        corpType: segment.corpType,
        position: corp?.getPosition() ?? { x: 0, y: 0, roomName: "unknown" },
        resource: segment.resource,
        quantity: segment.quantity,
        inputCost: segment.inputCost,
        outputPrice: segment.outputPrice,
        margin: segment.margin,
        profit: segment.outputPrice - segment.inputCost
      };

      // Add travel/work time for applicable corps
      if (corp && (corp as any).spawnLocation) {
        const spawnLocation = (corp as any).spawnLocation as Position;
        const travelTime = calculateTravelTime(spawnLocation, corp.getPosition());
        report.travelTime = travelTime;
        report.effectiveWorkTime = CREEP_LIFETIME - travelTime;
      }

      reports.push(report);
    }

    return reports;
  }

  /**
   * Generate market equilibrium summary from chain data.
   */
  private static generateMarketSummary(
    chain: Chain,
    corpRegistry: Map<string, Corp>
  ): ResourceMarketData[] {
    const resourceMap = new Map<
      string,
      { supply: number; demand: number; price: number }
    >();

    // Aggregate from segments
    for (const segment of chain.segments) {
      // Output (supply)
      const existing = resourceMap.get(segment.resource) || {
        supply: 0,
        demand: 0,
        price: 0
      };
      existing.supply += segment.quantity;
      existing.price = segment.outputPrice / segment.quantity; // Unit price
      resourceMap.set(segment.resource, existing);

      // Inputs would need to be tracked separately
      // For now, estimate based on input cost
      if (segment.inputCost > 0) {
        // This segment consumed something
        // The actual resource would be from the previous segment
      }
    }

    // Convert to market data array
    const summary: ResourceMarketData[] = [];
    for (const [resource, data] of resourceMap) {
      let status: "BALANCED" | "SHORTAGE" | "SURPLUS";
      let imbalance = data.supply - data.demand;

      if (imbalance === 0) {
        status = "BALANCED";
      } else if (imbalance < 0) {
        status = "SHORTAGE";
      } else {
        status = "SURPLUS";
      }

      summary.push({
        resource,
        supply: data.supply,
        demand: data.demand,
        price: data.price,
        status,
        imbalance
      });
    }

    return summary;
  }

  /**
   * Format the report as human-readable text.
   */
  private static formatReport(
    chain: Chain,
    steps: ChainStepReport[],
    marketSummary: ResourceMarketData[],
    corpRegistry: Map<string, Corp>
  ): string {
    const lines: string[] = [];
    const separator = "=".repeat(60);

    // Header
    lines.push("");
    lines.push(separator);
    lines.push(`Production Chain: ${chain.id}`);
    lines.push(separator);

    // Summary
    const profit = calculateProfit(chain);
    const profitMargin = chain.mintValue > 0 ? (profit / chain.mintValue) * 100 : 0;
    lines.push(`Profit Margin: ${profitMargin.toFixed(1)}%`);
    lines.push(`Net Profit: ${profit.toFixed(2)} energy`);
    lines.push(`Total Cost: ${chain.totalCost.toFixed(2)} energy`);
    lines.push(`Mint Value: ${chain.mintValue.toFixed(2)} energy`);
    lines.push("");

    // Flow diagram
    lines.push("Flow:");
    lines.push(this.generateFlowDiagram(chain, corpRegistry));
    lines.push("");

    // Step details
    for (const step of steps) {
      lines.push(this.formatStep(step));
      lines.push("");
    }

    // Market summary
    lines.push(this.formatMarketSummary(marketSummary));

    return lines.join("\n");
  }

  /**
   * Generate ASCII flow diagram of the chain.
   */
  private static generateFlowDiagram(
    chain: Chain,
    corpRegistry: Map<string, Corp>
  ): string {
    const flowLines: string[] = [];

    for (let i = 0; i < chain.segments.length; i++) {
      const segment = chain.segments[i];
      const corp = corpRegistry.get(segment.corpId);
      const pos = corp?.getPosition();
      const roomName = pos?.roomName ?? "unknown";

      flowLines.push(`  ${this.formatCorpType(segment.corpType)}@${roomName}`);

      if (i < chain.segments.length - 1) {
        flowLines.push("    |");
        flowLines.push("    v");
      }
    }

    return flowLines.join("\n");
  }

  /**
   * Format a corp type for display (capitalize first letter).
   */
  private static formatCorpType(type: CorpType): string {
    return type.charAt(0).toUpperCase() + type.slice(1) + "Corp";
  }

  /**
   * Format a single step report.
   */
  private static formatStep(step: ChainStepReport): string {
    const lines: string[] = [];

    lines.push(`STEP ${step.stepNumber}: ${this.formatCorpType(step.corpType)} (${step.corpId})`);
    lines.push(`Location: ${step.position.roomName} (${step.position.x}, ${step.position.y})`);

    if (step.travelTime !== undefined) {
      lines.push(
        `Travel Time: ${step.travelTime} ticks (${step.effectiveWorkTime} effective work time)`
      );
    }

    lines.push("");
    lines.push("Inputs:");
    if (step.inputCost > 0) {
      lines.push(`  - Total input cost: ${step.inputCost.toFixed(2)} energy`);
    } else {
      lines.push("  - (Raw production - no inputs)");
    }

    lines.push("Outputs:");
    const unitPrice = step.quantity > 0 ? step.outputPrice / step.quantity : 0;
    lines.push(
      `  - ${step.resource}: ${step.quantity} units @ ${unitPrice.toFixed(4)}/unit = ${step.outputPrice.toFixed(2)} energy`
    );

    lines.push("");
    lines.push(`Margin: ${(step.margin * 100).toFixed(1)}%`);
    lines.push(`Profit: ${step.profit.toFixed(2)} energy`);

    return lines.join("\n");
  }

  /**
   * Format market equilibrium summary.
   */
  private static formatMarketSummary(marketSummary: ResourceMarketData[]): string {
    const lines: string[] = [];

    lines.push("=== Market Equilibrium ===");

    for (const data of marketSummary) {
      lines.push("");
      lines.push(`Resource: ${data.resource}`);
      lines.push(`  Supply: ${data.supply} units`);
      lines.push(`  Demand: ${data.demand} units`);
      lines.push(`  Clearing Price: ${data.price.toFixed(4)}/unit`);

      switch (data.status) {
        case "SHORTAGE":
          lines.push(`  Status: SHORTAGE (need ${Math.abs(data.imbalance)} more)`);
          break;
        case "SURPLUS":
          lines.push(`  Status: SURPLUS (excess ${data.imbalance})`);
          break;
        default:
          lines.push("  Status: BALANCED");
      }
    }

    return lines.join("\n");
  }

  /**
   * Generate a simplified summary for logging.
   */
  static generateSummary(chain: Chain): string {
    const profit = calculateProfit(chain);
    const roi = calculateChainROI(chain);
    const corpTypes = chain.segments.map((s) => s.corpType).join(" -> ");

    return `Chain ${chain.id}: ${corpTypes} | Profit: ${profit.toFixed(2)} | ROI: ${(roi * 100).toFixed(1)}%`;
  }

  /**
   * Generate reports for multiple chains and format as a comparison table.
   */
  static generateComparisonTable(
    chains: Chain[],
    corpRegistry: Map<string, Corp>
  ): string {
    const lines: string[] = [];

    lines.push("");
    lines.push("=== Chain Comparison ===");
    lines.push("");
    lines.push(
      "| Chain ID | Corps | Total Cost | Mint Value | Profit | ROI |"
    );
    lines.push("|----------|-------|------------|------------|--------|-----|");

    for (const chain of chains) {
      const profit = calculateProfit(chain);
      const roi = calculateChainROI(chain);
      const corpCount = chain.segments.length;

      lines.push(
        `| ${chain.id.substring(0, 8)}... | ${corpCount} | ${chain.totalCost.toFixed(0)} | ${chain.mintValue.toFixed(0)} | ${profit.toFixed(0)} | ${(roi * 100).toFixed(0)}% |`
      );
    }

    lines.push("");

    return lines.join("\n");
  }
}
