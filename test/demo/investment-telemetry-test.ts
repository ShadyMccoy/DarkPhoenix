/**
 * Test InvestmentPlanner against telemetry cache data.
 *
 * Run with: npx ts-node test/demo/investment-telemetry-test.ts
 */

import * as fs from "fs";
import * as path from "path";
import { InvestmentPlanner, createInvestmentPlanner } from "../../src/planning/InvestmentPlanner";
import { createMintValues, MintValues } from "../../src/colony/MintValues";
import {
  AnyCorpState,
  MiningCorpState,
  HaulingCorpState,
  UpgradingCorpState,
  SpawningCorpState,
  BuildingCorpState,
  createMiningState,
  createHaulingState,
  createUpgradingState,
  createSpawningState
} from "../../src/corps/CorpState";
import { Position } from "../../src/market/Offer";
import { SerializedCorp } from "../../src/corps/Corp";

// ANSI colors
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m"
};

function colorize(text: string, color: keyof typeof colors): string {
  return `${colors[color]}${text}${colors.reset}`;
}

interface TelemetryCorpData {
  id: string;
  type: string;
  nodeId: string;
  roomName: string;
  balance: number;
  totalRevenue: number;
  totalCost: number;
  profit: number;
  roi: number;
  isActive: boolean;
  creepCount: number;
  createdAt: number;
  lastActivityTick: number;
}

interface TelemetryNode {
  id: string;
  roomName: string;
  peakPosition: { x: number; y: number; roomName: string };
  territorySize: number;
  resources: Array<{ type: string; x: number; y: number }>;
}

interface TelemetryOffer {
  corpId: string;
  corpType: string;
  resource: string;
  quantity: number;
  price: number;
  unitPrice: number;
}

interface TelemetryCache {
  core: {
    tick: number;
    money: { treasury: number };
    rooms: Array<{ name: string; rcl: number }>;
  };
  nodes: {
    tick: number;
    nodes: TelemetryNode[];
  };
  corps: {
    tick: number;
    corps: TelemetryCorpData[];
    summary: {
      totalCorps: number;
      activeCorps: number;
      totalBalance: number;
    };
  };
  market: {
    tick: number;
    offers: {
      buys: TelemetryOffer[];
      sells: TelemetryOffer[];
    };
  };
}

/**
 * Convert telemetry corps data to CorpState objects
 */
function convertToCorpStates(
  telemetry: TelemetryCache
): { corpStates: AnyCorpState[]; issues: string[] } {
  const corpStates: AnyCorpState[] = [];
  const issues: string[] = [];
  const nodes = new Map<string, TelemetryNode>();

  // Build node lookup
  for (const node of telemetry.nodes.nodes) {
    nodes.set(node.id, node);
  }

  // Find spawn position (first node with spawn resource)
  let spawnPosition: Position | null = null;
  for (const node of telemetry.nodes.nodes) {
    const spawnResource = node.resources.find(r => r.type === "spawn");
    if (spawnResource) {
      spawnPosition = {
        x: spawnResource.x,
        y: spawnResource.y,
        roomName: node.roomName
      };
      break;
    }
  }

  if (!spawnPosition) {
    // Fallback to first node position
    const firstNode = telemetry.nodes.nodes[0];
    if (firstNode) {
      spawnPosition = {
        x: firstNode.peakPosition.x,
        y: firstNode.peakPosition.y,
        roomName: firstNode.roomName
      };
    }
  }

  for (const corpData of telemetry.corps.corps) {
    try {
      // Find associated node
      const nodeId = corpData.nodeId;
      let position: Position = spawnPosition || { x: 25, y: 25, roomName: corpData.roomName };

      // Try to find node position from resources
      for (const node of telemetry.nodes.nodes) {
        if (node.id === nodeId || nodeId.includes(node.id.split("-").slice(0, 2).join("-"))) {
          position = {
            x: node.peakPosition.x,
            y: node.peakPosition.y,
            roomName: node.roomName
          };
          break;
        }
      }

      // Create appropriate CorpState based on type
      switch (corpData.type) {
        case "mining": {
          const state = createMiningState(
            corpData.id,
            nodeId,
            `source-${nodeId}`,
            `spawning-${corpData.roomName}`,
            position,
            3000, // Default source capacity
            spawnPosition
          );
          state.balance = corpData.balance;
          state.totalRevenue = corpData.totalRevenue;
          state.totalCost = corpData.totalCost;
          state.isActive = corpData.isActive;
          state.createdAt = corpData.createdAt;
          state.lastActivityTick = corpData.lastActivityTick;
          corpStates.push(state);
          break;
        }

        case "hauling": {
          const state = createHaulingState(
            corpData.id,
            nodeId,
            `mining-${corpData.roomName}`,
            `spawning-${corpData.roomName}`,
            position,
            spawnPosition || position,
            500, // Default carry capacity
            spawnPosition
          );
          state.balance = corpData.balance;
          state.totalRevenue = corpData.totalRevenue;
          state.totalCost = corpData.totalCost;
          state.isActive = corpData.isActive;
          state.createdAt = corpData.createdAt;
          state.lastActivityTick = corpData.lastActivityTick;
          corpStates.push(state);
          break;
        }

        case "upgrading": {
          // Find controller position
          let controllerPos = position;
          for (const node of telemetry.nodes.nodes) {
            const controller = node.resources.find(r => r.type === "controller");
            if (controller) {
              controllerPos = {
                x: controller.x,
                y: controller.y,
                roomName: node.roomName
              };
              break;
            }
          }

          const state = createUpgradingState(
            corpData.id,
            nodeId,
            `spawning-${corpData.roomName}`,
            controllerPos,
            telemetry.core.rooms[0]?.rcl || 1,
            spawnPosition
          );
          state.balance = corpData.balance;
          state.totalRevenue = corpData.totalRevenue;
          state.totalCost = corpData.totalCost;
          state.isActive = corpData.isActive;
          state.createdAt = corpData.createdAt;
          state.lastActivityTick = corpData.lastActivityTick;
          corpStates.push(state);
          break;
        }

        case "spawning": {
          const state = createSpawningState(
            corpData.id,
            nodeId,
            spawnPosition || position,
            450, // Energy capacity from telemetry
            0,
            false
          );
          state.balance = corpData.balance;
          state.totalRevenue = corpData.totalRevenue;
          state.totalCost = corpData.totalCost;
          state.isActive = corpData.isActive;
          state.createdAt = corpData.createdAt;
          state.lastActivityTick = corpData.lastActivityTick;
          corpStates.push(state);
          break;
        }

        case "building": {
          // Skip building corps for now, they don't participate in investment
          break;
        }

        default:
          issues.push(`Unknown corp type: ${corpData.type} for ${corpData.id}`);
      }
    } catch (err) {
      issues.push(`Error converting ${corpData.id}: ${err}`);
    }
  }

  return { corpStates, issues };
}

/**
 * Run the investment planner test
 */
function runTest(): void {
  console.log("\n" + "=".repeat(70));
  console.log(colorize("INVESTMENT PLANNER TELEMETRY TEST", "bright"));
  console.log("=".repeat(70));

  // Load telemetry cache
  const telemetryPath = path.join(__dirname, "../../telemetry-app/telemetry-cache.json");
  if (!fs.existsSync(telemetryPath)) {
    console.log(colorize("ERROR: telemetry-cache.json not found", "red"));
    process.exit(1);
  }

  console.log(`\nLoading telemetry from: ${telemetryPath}`);
  const telemetry: TelemetryCache = JSON.parse(fs.readFileSync(telemetryPath, "utf-8"));

  console.log(`\n${colorize("Telemetry Summary:", "cyan")}`);
  console.log(`  Tick: ${telemetry.core.tick}`);
  console.log(`  Treasury: ${telemetry.core.money.treasury}`);
  console.log(`  Corps: ${telemetry.corps.corps.length}`);
  console.log(`  Total Balance: ${telemetry.corps.summary.totalBalance.toFixed(2)}`);

  // Convert to CorpStates
  console.log(`\n${colorize("Converting corps to CorpState...", "cyan")}`);
  const { corpStates, issues: conversionIssues } = convertToCorpStates(telemetry);

  if (conversionIssues.length > 0) {
    console.log(colorize("\nConversion Issues:", "yellow"));
    for (const issue of conversionIssues) {
      console.log(`  - ${issue}`);
    }
  }

  console.log(`\nConverted ${corpStates.length} corps:`);
  for (const state of corpStates) {
    console.log(`  - ${state.type}: ${state.id} (balance: ${state.balance.toFixed(2)})`);
  }

  // Create investment planner
  const mintValues = createMintValues({
    rcl_upgrade: 1.0,
    gcl_upgrade: 1.0,
    remote_source_tap: 0.5,
    container_built: 0.1
  });

  const planner = createInvestmentPlanner(mintValues);

  // Register corp states
  const tick = telemetry.core.tick;
  planner.registerCorpStates(corpStates, tick);

  // Run investment planning
  console.log(`\n${colorize("Running Investment Planning...", "cyan")}`);
  console.log(`  Budget: ${telemetry.core.money.treasury}`);
  console.log(`  Tick: ${tick}`);

  const issues: string[] = [];

  try {
    const result = planner.plan(telemetry.core.money.treasury, tick);

    console.log(`\n${colorize("Investment Plan Results:", "bright")}`);
    console.log(`  Investments created: ${result.investments.length}`);
    console.log(`  Chains built: ${result.chains.length}`);
    console.log(`  Sub-contracts: ${result.subContracts.length}`);
    console.log(`  Budget allocated: ${result.totalBudget.toFixed(2)}`);
    console.log(`  Budget remaining: ${result.remainingBudget.toFixed(2)}`);

    // Check for potential issues
    if (result.investments.length === 0) {
      issues.push("No investments created - no upgrading corps found?");
    }

    if (result.chains.length === 0 && result.investments.length > 0) {
      issues.push("Investments created but no chains built - supply chain broken?");
    }

    for (const investment of result.investments) {
      console.log(`\n  ${colorize(`Investment: ${investment.id}`, "cyan")}`);
      console.log(`    Recipient: ${investment.recipientCorpId}`);
      console.log(`    Goal: ${investment.goalType}`);
      console.log(`    Budget: ${investment.maxBudget.toFixed(2)}`);
      console.log(`    Rate: ${investment.ratePerUnit.toFixed(4)}/unit`);
      console.log(`    Expected ROI: ${(investment.expectedROI * 100).toFixed(1)}%`);

      // Validate investment
      if (investment.ratePerUnit <= 0) {
        issues.push(`Investment ${investment.id} has invalid rate: ${investment.ratePerUnit}`);
      }
      if (investment.maxBudget <= 0) {
        issues.push(`Investment ${investment.id} has invalid budget: ${investment.maxBudget}`);
      }
      if (investment.expectedROI < -1 || investment.expectedROI > 10) {
        issues.push(`Investment ${investment.id} has suspicious ROI: ${investment.expectedROI}`);
      }
    }

    for (const chain of result.chains) {
      console.log(`\n  ${colorize(`Chain: ${chain.id}`, "cyan")}`);
      console.log(`    Segments: ${chain.segments.length}`);
      console.log(`    Total Capital: ${chain.totalCapital.toFixed(2)}`);
      console.log(`    Expected Output: ${chain.expectedOutput.toFixed(2)}`);
      console.log(`    Expected Mint Value: ${chain.expectedMintValue.toFixed(2)}`);
      console.log(`    Expected ROI: ${(chain.expectedROI * 100).toFixed(1)}%`);

      // Validate chain
      if (chain.totalCapital <= 0) {
        issues.push(`Chain ${chain.id} has no capital`);
      }
      if (chain.expectedOutput <= 0) {
        issues.push(`Chain ${chain.id} has no expected output`);
      }
      if (chain.expectedMintValue < chain.totalCapital) {
        issues.push(`Chain ${chain.id} has negative expected ROI (mint ${chain.expectedMintValue} < capital ${chain.totalCapital})`);
      }

      for (const segment of chain.segments) {
        console.log(`      ${segment.corpType} (${segment.corpId})`);
        console.log(`        Resource: ${segment.resource}, Qty: ${segment.quantity}`);
        console.log(`        Capital In: ${segment.capitalReceived.toFixed(2)}, Out: ${segment.capitalSpent.toFixed(2)}`);
        console.log(`        Margin: ${segment.marginEarned.toFixed(2)}`);

        // Validate segment
        if (segment.capitalReceived < segment.capitalSpent) {
          issues.push(`Segment ${segment.corpId} spends more than it receives`);
        }
      }
    }

  } catch (err) {
    issues.push(`Planning error: ${err}`);
    console.log(colorize(`\nPlanning Error: ${err}`, "red"));
  }

  // Compare with telemetry market offers
  console.log(`\n${colorize("Comparing with Telemetry Market Offers:", "cyan")}`);
  if (telemetry.market && telemetry.market.offers) {
    console.log(`  Buy offers: ${telemetry.market.offers.buys.length}`);
    console.log(`  Sell offers: ${telemetry.market.offers.sells.length}`);

    // Check for unrealistic prices in market
    for (const offer of [...telemetry.market.offers.buys, ...telemetry.market.offers.sells]) {
      if (offer.unitPrice < 0) {
        issues.push(`Negative unit price for ${offer.resource} from ${offer.corpId}: ${offer.unitPrice}`);
      }
      if (offer.unitPrice > 1000) {
        issues.push(`Very high unit price for ${offer.resource} from ${offer.corpId}: ${offer.unitPrice}`);
      }
    }
  }

  // Print summary
  console.log("\n" + "=".repeat(70));
  if (issues.length === 0) {
    console.log(colorize("RESULT: No issues detected!", "green"));
  } else {
    console.log(colorize(`RESULT: ${issues.length} issue(s) found:`, "red"));
    for (const issue of issues) {
      console.log(colorize(`  - ${issue}`, "yellow"));
    }
  }
  console.log("=".repeat(70) + "\n");
}

// Run the test
runTest();
