/**
 * @fileoverview Investment contracts for forward capital flow.
 *
 * The BankCorp model flips the economic flow from "trace backwards from demand"
 * to "capital flows forward from source."
 *
 * Current Model (problematic):
 *   Upgrader (infinite demand) ← Hauler ← Mining ← Spawning
 *   └── Mint value appears at the end, traced backwards
 *
 * BankCorp Model:
 *   Bank (source of $)
 *     ↓ loans $ to upgraders (contract: $X per upgrade point)
 *   Upgrader (now has $, can buy services)
 *     ↓ pays haulers for delivered-energy
 *   Hauler (earns $, pays miners + spawn)
 *     ↓
 *   Mining + Spawning (earn $)
 *
 * Key benefits:
 * - Capital flows forward - Bank invests, money cascades down
 * - Throughput determined by investment - Bank decides how much $ to put in
 * - ROI tracking is natural - Each corp earns based on actual work
 * - Investment optimization - Bank can invest MORE in high-ROI chains next cycle
 *
 * @module market/InvestmentContract
 */

import { Position } from "./Offer";

/**
 * Goal types that the bank can invest in.
 * These are the terminal value sinks that justify capital investment.
 */
export type InvestmentGoalType =
  | "rcl-progress"    // Controller upgrades
  | "gcl-progress"    // Global control level
  | "construction"    // Building structures
  | "defense";        // Military operations

/**
 * An investment contract represents capital allocated by the bank to a goal corp.
 *
 * The bank commits to pay a rate per unit of output produced.
 * This gives the goal corp "future earnings" they can use to contract suppliers.
 */
export interface InvestmentContract {
  /** Unique contract identifier */
  id: string;

  /** Bank/investor corp ID */
  bankId: string;

  /** Recipient corp ID (upgrader, builder, etc.) */
  recipientCorpId: string;

  /** Type of goal being invested in */
  goalType: InvestmentGoalType;

  /** Resource produced by the recipient */
  resource: string;

  /** Credits paid per unit of output */
  ratePerUnit: number;

  /** Maximum budget allocated for this contract */
  maxBudget: number;

  /** Tick when contract was created */
  createdAt: number;

  /** Duration in ticks (typically one creep lifetime) */
  duration: number;

  /** Units delivered so far */
  unitsDelivered: number;

  /** Credits paid so far */
  creditsPaid: number;

  /** Priority (higher = more important) */
  priority: number;

  /** Expected ROI based on historical performance */
  expectedROI: number;
}

/**
 * Capital allocation represents contracted future earnings a corp can spend.
 * When a corp has an investment contract, they have capital to buy services.
 */
export interface CapitalAllocation {
  /** Corp ID that has the capital */
  corpId: string;

  /** Total capital available (from investment contracts) */
  totalCapital: number;

  /** Capital already committed to sub-contracts */
  committedCapital: number;

  /** Available capital (total - committed) */
  availableCapital: number;

  /** Source investment contract IDs */
  sourceContracts: string[];
}

/**
 * Sub-contract created when a corp with capital buys from a supplier.
 * This is how capital cascades down the supply chain.
 */
export interface SubContract {
  /** Unique identifier */
  id: string;

  /** Buyer corp ID (has capital from investment) */
  buyerId: string;

  /** Seller corp ID (supplier) */
  sellerId: string;

  /** Resource being purchased */
  resource: string;

  /** Quantity agreed */
  quantity: number;

  /** Total price agreed */
  price: number;

  /** Duration in ticks */
  duration: number;

  /** Start tick */
  startTick: number;

  /** Units delivered */
  delivered: number;

  /** Credits paid */
  paid: number;

  /** Parent investment contract ID (traces back to bank) */
  parentInvestmentId: string;
}

/**
 * Investment performance tracking for ROI optimization.
 */
export interface InvestmentPerformance {
  /** Investment contract ID */
  investmentId: string;

  /** Recipient corp ID */
  recipientCorpId: string;

  /** Goal type */
  goalType: InvestmentGoalType;

  /** Total credits invested */
  totalInvested: number;

  /** Total units produced */
  totalUnitsProduced: number;

  /** Credits per unit (actual cost) */
  actualCostPerUnit: number;

  /** Expected credits per unit (from rate) */
  expectedCostPerUnit: number;

  /** ROI = (mintValue - actualCost) / actualCost */
  roi: number;

  /** Efficiency = actualUnits / expectedUnits */
  efficiency: number;
}

/**
 * Investment decision factors for the bank.
 */
export interface InvestmentOpportunity {
  /** Corp that could receive investment */
  corpId: string;

  /** Goal type */
  goalType: InvestmentGoalType;

  /** Position (for distance calculations) */
  position: Position;

  /** Maximum throughput this corp can handle */
  maxThroughput: number;

  /** Historical ROI (or estimated if new) */
  historicalROI: number;

  /** Suggested rate per unit */
  suggestedRate: number;

  /** Suggested budget */
  suggestedBudget: number;

  /** Supply chain depth estimate */
  supplyChainDepth: number;
}

// =============================================================================
// Pure Functions
// =============================================================================

/**
 * Create a unique investment contract ID.
 */
export function createInvestmentId(
  bankId: string,
  recipientId: string,
  tick: number
): string {
  return `inv-${bankId.slice(-6)}-${recipientId.slice(-6)}-${tick}`;
}

/**
 * Create a new investment contract.
 */
export function createInvestmentContract(
  bankId: string,
  recipientCorpId: string,
  goalType: InvestmentGoalType,
  resource: string,
  ratePerUnit: number,
  maxBudget: number,
  duration: number,
  tick: number,
  priority: number = 1,
  expectedROI: number = 0
): InvestmentContract {
  return {
    id: createInvestmentId(bankId, recipientCorpId, tick),
    bankId,
    recipientCorpId,
    goalType,
    resource,
    ratePerUnit,
    maxBudget,
    createdAt: tick,
    duration,
    unitsDelivered: 0,
    creditsPaid: 0,
    priority,
    expectedROI
  };
}

/**
 * Calculate remaining budget for an investment contract.
 */
export function remainingBudget(contract: InvestmentContract): number {
  return Math.max(0, contract.maxBudget - contract.creditsPaid);
}

/**
 * Calculate expected units remaining.
 */
export function expectedUnitsRemaining(contract: InvestmentContract): number {
  const remaining = remainingBudget(contract);
  return remaining / contract.ratePerUnit;
}

/**
 * Check if investment contract is still active.
 */
export function isInvestmentActive(
  contract: InvestmentContract,
  currentTick: number
): boolean {
  const expired = currentTick >= contract.createdAt + contract.duration;
  const exhausted = contract.creditsPaid >= contract.maxBudget;
  return !expired && !exhausted;
}

/**
 * Record delivery on an investment contract.
 * Returns the credits to pay the recipient.
 */
export function recordInvestmentDelivery(
  contract: InvestmentContract,
  units: number
): number {
  const remainingBudgetAmount = remainingBudget(contract);
  const payment = Math.min(units * contract.ratePerUnit, remainingBudgetAmount);

  contract.unitsDelivered += units;
  contract.creditsPaid += payment;

  return payment;
}

/**
 * Create a capital allocation from investment contracts.
 */
export function createCapitalAllocation(
  corpId: string,
  investments: InvestmentContract[]
): CapitalAllocation {
  const sourceContracts = investments.map(i => i.id);
  const totalCapital = investments.reduce(
    (sum, i) => sum + remainingBudget(i),
    0
  );

  return {
    corpId,
    totalCapital,
    committedCapital: 0,
    availableCapital: totalCapital,
    sourceContracts
  };
}

/**
 * Commit capital from an allocation (for sub-contracting).
 */
export function commitCapital(
  allocation: CapitalAllocation,
  amount: number
): boolean {
  if (amount > allocation.availableCapital) {
    return false;
  }

  allocation.committedCapital += amount;
  allocation.availableCapital -= amount;
  return true;
}

/**
 * Create a sub-contract ID.
 */
export function createSubContractId(
  buyerId: string,
  sellerId: string,
  tick: number
): string {
  return `sub-${buyerId.slice(-6)}-${sellerId.slice(-6)}-${tick}`;
}

/**
 * Create a sub-contract.
 */
export function createSubContract(
  buyerId: string,
  sellerId: string,
  resource: string,
  quantity: number,
  price: number,
  duration: number,
  startTick: number,
  parentInvestmentId: string
): SubContract {
  return {
    id: createSubContractId(buyerId, sellerId, startTick),
    buyerId,
    sellerId,
    resource,
    quantity,
    price,
    duration,
    startTick,
    delivered: 0,
    paid: 0,
    parentInvestmentId
  };
}

/**
 * Calculate investment performance metrics.
 */
export function calculatePerformance(
  contract: InvestmentContract,
  mintValuePerUnit: number
): InvestmentPerformance {
  const actualCostPerUnit = contract.unitsDelivered > 0
    ? contract.creditsPaid / contract.unitsDelivered
    : Infinity;

  const roi = contract.creditsPaid > 0
    ? (mintValuePerUnit * contract.unitsDelivered - contract.creditsPaid) / contract.creditsPaid
    : 0;

  const expectedUnits = contract.maxBudget / contract.ratePerUnit;
  const efficiency = expectedUnits > 0
    ? contract.unitsDelivered / expectedUnits
    : 0;

  return {
    investmentId: contract.id,
    recipientCorpId: contract.recipientCorpId,
    goalType: contract.goalType,
    totalInvested: contract.creditsPaid,
    totalUnitsProduced: contract.unitsDelivered,
    actualCostPerUnit,
    expectedCostPerUnit: contract.ratePerUnit,
    roi,
    efficiency
  };
}

/**
 * Suggest investment rate based on supply chain costs.
 *
 * The rate should be high enough to cover:
 * - Direct supplier costs (energy, labor)
 * - Margins for each supplier in the chain
 * - Some buffer for inefficiency
 *
 * @param mintValuePerUnit - Credits minted when unit is produced
 * @param estimatedSupplyChainCost - Estimated total cost to produce
 * @param targetROI - Desired return on investment (e.g., 0.1 for 10%)
 */
export function suggestInvestmentRate(
  mintValuePerUnit: number,
  estimatedSupplyChainCost: number,
  targetROI: number = 0.1
): number {
  // Rate should allow supplier costs + target ROI
  // rate = cost / (1 - targetROI) would give exact target
  // But we want room for error, so use more conservative formula
  const minRate = estimatedSupplyChainCost * 1.1; // 10% buffer for costs
  const maxRate = mintValuePerUnit * (1 - targetROI); // Leave targetROI for bank

  // Use the higher of minRate or lower of maxRate
  // This ensures suppliers can be paid while bank gets return
  return Math.max(minRate, Math.min(maxRate, mintValuePerUnit * 0.8));
}
