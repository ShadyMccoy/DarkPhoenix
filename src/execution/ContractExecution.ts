/**
 * @fileoverview Contract-driven execution.
 *
 * This module handles the contract-driven execution loop:
 * 1. Collect active contracts from Market
 * 2. Group contracts by corp
 * 3. Call corp.execute(contracts) for each corp
 * 4. Settle payments based on deliveries
 *
 * @module execution/ContractExecution
 */

import { getMarket } from "../market/Market";
import {
  Contract,
  isActive,
  recordPayment,
  paymentDue,
} from "../market/Contract";
import { CorpRegistry } from "./CorpRunner";
import { Corp } from "../corps/Corp";

/**
 * Result of contract execution
 */
export interface ExecutionResult {
  /** Number of corps that executed */
  corpsExecuted: number;
  /** Number of contracts processed */
  contractsProcessed: number;
}

/**
 * Result of contract settlement
 */
export interface SettlementResult {
  /** Number of contracts settled */
  contractsSettled: number;
  /** Total payment transferred */
  totalPayment: number;
}

/**
 * Execute all corps with their contracts.
 *
 * This is the main contract-driven execution loop:
 * 1. Get all active contracts from Market
 * 2. Group contracts by corp ID
 * 3. For each corp, call execute() with its contracts
 */
export function executeContracts(
  registry: CorpRegistry,
  tick: number
): ExecutionResult {
  const market = getMarket();
  const result: ExecutionResult = {
    corpsExecuted: 0,
    contractsProcessed: 0,
  };

  // Collect all active contracts
  const activeContracts = market.getContracts().filter(c => isActive(c, tick));

  // Group contracts by corp ID (both buyer and seller get their contracts)
  const contractsByCorpId = new Map<string, Contract[]>();

  for (const contract of activeContracts) {
    // Add to seller's contracts
    if (!contractsByCorpId.has(contract.sellerId)) {
      contractsByCorpId.set(contract.sellerId, []);
    }
    contractsByCorpId.get(contract.sellerId)!.push(contract);

    // Add to buyer's contracts
    if (!contractsByCorpId.has(contract.buyerId)) {
      contractsByCorpId.set(contract.buyerId, []);
    }
    contractsByCorpId.get(contract.buyerId)!.push(contract);

    result.contractsProcessed++;
  }

  // Execute each corp with its contracts
  const allCorps = getAllCorps(registry);
  for (const corp of allCorps) {
    const contracts = contractsByCorpId.get(corp.id) || [];
    corp.execute(contracts, tick);
    result.corpsExecuted++;
  }

  return result;
}

/**
 * Settle all active contracts - process payments based on deliveries.
 *
 * This should be called after executeContracts().
 * It calculates payment due based on recorded deliveries and
 * transfers credits from buyer to seller.
 */
export function settleContracts(
  registry: CorpRegistry,
  tick: number
): SettlementResult {
  const market = getMarket();
  const result: SettlementResult = {
    contractsSettled: 0,
    totalPayment: 0,
  };

  for (const contract of market.getContracts()) {
    if (!isActive(contract, tick)) continue;

    // Calculate payment due based on delivery
    const payment = paymentDue(contract);
    if (payment <= 0) continue;

    // Find buyer and seller corps
    const buyerCorp = findCorpById(contract.buyerId, registry);
    const sellerCorp = findCorpById(contract.sellerId, registry);

    if (!buyerCorp || !sellerCorp) continue;

    // Transfer payment: buyer pays, seller receives
    buyerCorp.recordCost(payment);
    sellerCorp.recordRevenue(payment);
    recordPayment(contract, payment);

    result.contractsSettled++;
    result.totalPayment += payment;
  }

  return result;
}

/**
 * Get all corps from registry as a flat list.
 */
function getAllCorps(registry: CorpRegistry): Corp[] {
  const corps: Corp[] = [];

  for (const id in registry.harvestCorps) {
    corps.push(registry.harvestCorps[id]);
  }
  for (const id in registry.haulingCorps) {
    corps.push(registry.haulingCorps[id]);
  }
  for (const id in registry.upgradingCorps) {
    corps.push(registry.upgradingCorps[id]);
  }
  for (const id in registry.spawningCorps) {
    corps.push(registry.spawningCorps[id]);
  }
  for (const id in registry.constructionCorps) {
    corps.push(registry.constructionCorps[id]);
  }
  for (const id in registry.bootstrapCorps) {
    corps.push(registry.bootstrapCorps[id]);
  }
  for (const id in registry.scoutCorps) {
    corps.push(registry.scoutCorps[id]);
  }

  return corps;
}

/**
 * Find a corp by ID across all registries.
 */
function findCorpById(corpId: string, registry: CorpRegistry): Corp | null {
  // Check harvest corps
  for (const id in registry.harvestCorps) {
    if (registry.harvestCorps[id].id === corpId) {
      return registry.harvestCorps[id];
    }
  }

  // Check hauling corps
  for (const id in registry.haulingCorps) {
    if (registry.haulingCorps[id].id === corpId) {
      return registry.haulingCorps[id];
    }
  }

  // Check upgrading corps
  for (const id in registry.upgradingCorps) {
    if (registry.upgradingCorps[id].id === corpId) {
      return registry.upgradingCorps[id];
    }
  }

  // Check spawning corps
  for (const id in registry.spawningCorps) {
    if (registry.spawningCorps[id].id === corpId) {
      return registry.spawningCorps[id];
    }
  }

  // Check construction corps
  for (const id in registry.constructionCorps) {
    if (registry.constructionCorps[id].id === corpId) {
      return registry.constructionCorps[id];
    }
  }

  // Check bootstrap corps
  for (const id in registry.bootstrapCorps) {
    if (registry.bootstrapCorps[id].id === corpId) {
      return registry.bootstrapCorps[id];
    }
  }

  // Check scout corps
  for (const id in registry.scoutCorps) {
    if (registry.scoutCorps[id].id === corpId) {
      return registry.scoutCorps[id];
    }
  }

  return null;
}

/**
 * Clean up expired contracts from Market and corps.
 */
export function cleanupExpiredContracts(
  registry: CorpRegistry,
  tick: number
): number {
  let removed = 0;

  // Prune contracts from all corps
  for (const id in registry.harvestCorps) {
    registry.harvestCorps[id].pruneContracts(tick);
  }
  for (const id in registry.haulingCorps) {
    registry.haulingCorps[id].pruneContracts(tick);
  }
  for (const id in registry.upgradingCorps) {
    registry.upgradingCorps[id].pruneContracts(tick);
  }
  for (const id in registry.spawningCorps) {
    registry.spawningCorps[id].pruneContracts(tick);
  }
  for (const id in registry.constructionCorps) {
    registry.constructionCorps[id].pruneContracts(tick);
  }

  // TODO: Also clean up Market's contract store

  return removed;
}
