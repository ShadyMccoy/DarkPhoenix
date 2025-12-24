/**
 * Specification for the type and configuration of creep to spawn.
 * Used in spawn contracts to explicitly define what creep the buyer needs.
 */
export interface CreepSpec {
  /** Type of creep to spawn */
  role: "miner" | "hauler" | "upgrader" | "builder" | "scout";

  /** Target number of WORK parts (for miners, upgraders, builders) */
  workParts?: number;

  /** Target number of CARRY parts (for haulers) */
  carryParts?: number;

  /** Target number of MOVE parts (for scouts, or explicit movement needs) */
  moveParts?: number;

  /** Maximum energy cost for the body (spawn will design within this budget) */
  maxCost?: number;

  /**
   * Maximum number of creeps that can fulfill this specification.
   *
   * - 1: Exactly one creep of specified size (e.g., one upgrader)
   * - 2+: Up to N creeps can share the work (e.g., 2 miners for a source with 2 spots)
   * - undefined: No limit, spawn decides based on available energy
   *
   * When > 1, spawn may create smaller creeps if it can't afford the full size,
   * as long as total capacity meets the requirement.
   *
   * Examples:
   * - Miner at source with 2 spots: maxCreeps: 2
   * - Single upgrader: maxCreeps: 1
   * - Haulers (capacity fungible): maxCreeps: undefined (no limit)
   */
  maxCreeps?: number;
}

/**
 * A Contract represents an agreement between a buyer and seller corp.
 *
 * Contracts are formed when the ChainPlanner matches buy and sell offers
 * and funds a chain. They track delivery progress and payment flow.
 *
 * For spawn contracts (work-ticks, carry-ticks), the contract acts like
 * an option - buyer purchases capacity but chooses when to exercise it.
 */
export interface Contract {
  /** Unique contract identifier */
  id: string;

  /** Corp selling the resource */
  sellerId: string;

  /** Corp buying the resource */
  buyerId: string;

  /** Resource type being traded */
  resource: string;

  /** Total quantity to be delivered */
  quantity: number;

  /** Total price for the full quantity */
  price: number;

  /** Duration in ticks for delivery */
  duration: number;

  /** Game tick when contract started */
  startTick: number;

  /** Amount delivered so far */
  delivered: number;

  /** Amount paid so far */
  paid: number;

  /** Creep IDs assigned to execute this contract */
  creepIds: string[];

  /**
   * Maximum concurrent creeps allowed (for spawn contracts).
   * E.g., mining has limited spots around source.
   * Default: 1 for mining, unlimited (999) for others.
   */
  maxCreeps: number;

  /**
   * Pending creep requests not yet fulfilled.
   * Buyer corp adds requests, SpawningCorp fulfills them.
   */
  pendingRequests: number;

  /**
   * Amount of capacity already claimed (requested + fulfilled).
   * Cannot exceed quantity.
   */
  claimed: number;

  /**
   * Travel time in ticks from seller to buyer location.
   * Used to request replacement creeps ahead of time.
   * E.g., if travelTime=100 and creep TTL=100, request a replacement now.
   */
  travelTime: number;

  /**
   * Creep specification for spawn contracts.
   * Defines the type and body configuration the buyer needs.
   * If not specified, SpawningCorp infers from resource type.
   */
  creepSpec?: CreepSpec;
}

/**
 * Contract status for UI/debugging
 */
export type ContractStatus = "active" | "complete" | "expired" | "defaulted";

/**
 * Check if contract is still active (within duration and not complete)
 */
export function isActive(contract: Contract, currentTick: number): boolean {
  if (isComplete(contract)) return false;
  return currentTick < contract.startTick + contract.duration;
}

/**
 * Check if contract has been fully delivered
 */
export function isComplete(contract: Contract): boolean {
  return contract.delivered >= contract.quantity;
}

/**
 * Check if contract has expired without completion
 */
export function isExpired(contract: Contract, currentTick: number): boolean {
  if (isComplete(contract)) return false;
  return currentTick >= contract.startTick + contract.duration;
}

/**
 * Get remaining quantity to deliver
 */
export function remainingQuantity(contract: Contract): number {
  return Math.max(0, contract.quantity - contract.delivered);
}

/**
 * Get remaining payment due
 */
export function remainingPayment(contract: Contract): number {
  return Math.max(0, contract.price - contract.paid);
}

/**
 * Calculate delivery progress as percentage (0-1)
 */
export function deliveryProgress(contract: Contract): number {
  if (contract.quantity <= 0) return 1;
  return Math.min(1, contract.delivered / contract.quantity);
}

/**
 * Calculate payment progress as percentage (0-1)
 */
export function paymentProgress(contract: Contract): number {
  if (contract.price <= 0) return 1;
  return Math.min(1, contract.paid / contract.price);
}

/**
 * Get the expected delivery rate per tick
 */
export function expectedDeliveryRate(contract: Contract): number {
  if (contract.duration <= 0) return 0;
  return contract.quantity / contract.duration;
}

/**
 * Get actual delivery rate based on current progress
 */
export function actualDeliveryRate(
  contract: Contract,
  currentTick: number
): number {
  const elapsed = currentTick - contract.startTick;
  if (elapsed <= 0) return 0;
  return contract.delivered / elapsed;
}

/**
 * Check if delivery is on track (actual >= expected)
 */
export function isOnTrack(contract: Contract, currentTick: number): boolean {
  const elapsed = currentTick - contract.startTick;
  const expectedDelivered = expectedDeliveryRate(contract) * elapsed;
  return contract.delivered >= expectedDelivered * 0.9; // 10% tolerance
}

/**
 * Get contract status
 */
export function getStatus(
  contract: Contract,
  currentTick: number
): ContractStatus {
  if (isComplete(contract)) return "complete";
  if (isExpired(contract, currentTick)) {
    // Check if significantly under-delivered
    if (contract.delivered < contract.quantity * 0.5) {
      return "defaulted";
    }
    return "expired";
  }
  return "active";
}

/**
 * Calculate payment due based on delivery (pay-as-you-go)
 */
export function paymentDue(contract: Contract): number {
  if (contract.quantity <= 0) return 0;
  const pricePerUnit = contract.price / contract.quantity;
  const owedForDelivered = pricePerUnit * contract.delivered;
  return Math.max(0, owedForDelivered - contract.paid);
}

/**
 * Create a unique contract ID
 */
export function createContractId(
  sellerId: string,
  buyerId: string,
  tick: number
): string {
  return `contract-${sellerId}-${buyerId}-${tick}`;
}

/**
 * Create a new contract from matched offers
 */
export function createContract(
  sellerId: string,
  buyerId: string,
  resource: string,
  quantity: number,
  price: number,
  duration: number,
  startTick: number,
  maxCreeps: number = 999,
  travelTime: number = 0,
  creepSpec?: CreepSpec
): Contract {
  return {
    id: createContractId(sellerId, buyerId, startTick),
    sellerId,
    buyerId,
    resource,
    quantity,
    price,
    duration,
    startTick,
    delivered: 0,
    paid: 0,
    creepIds: [],
    maxCreeps,
    pendingRequests: 0,
    claimed: 0,
    travelTime,
    creepSpec
  };
}

/**
 * Record a delivery on a contract (mutates contract)
 */
export function recordDelivery(contract: Contract, amount: number): void {
  contract.delivered = Math.min(
    contract.quantity,
    contract.delivered + amount
  );
}

/**
 * Record a payment on a contract (mutates contract)
 */
export function recordPayment(contract: Contract, amount: number): void {
  contract.paid = Math.min(contract.price, contract.paid + amount);
}

/**
 * Assign a creep to a contract
 */
export function assignCreep(contract: Contract, creepId: string): void {
  if (!contract.creepIds.includes(creepId)) {
    contract.creepIds.push(creepId);
  }
}

/**
 * Remove a creep from a contract
 */
export function unassignCreep(contract: Contract, creepId: string): void {
  const index = contract.creepIds.indexOf(creepId);
  if (index !== -1) {
    contract.creepIds.splice(index, 1);
  }
}

// ============================================================
// Spawn Capacity Option Mechanism
// ============================================================
// For spawn contracts, the buyer purchases capacity over time but
// chooses when to "exercise" the option by requesting creeps.
// This allows corps like HarvestCorp to buy capacity for 5000 ticks
// but only request creeps when they actually need them.

/**
 * Check if buyer can request more creeps on this contract.
 * Returns true if:
 * - Contract has unclaimed capacity (claimed < quantity)
 * - Current active creeps < maxCreeps limit
 */
export function canRequestCreep(contract: Contract): boolean {
  // Can't claim more than quantity
  if (contract.claimed >= contract.quantity) return false;
  // Can't exceed max concurrent creeps
  if (contract.creepIds.length >= contract.maxCreeps) return false;
  return true;
}

/**
 * Buyer requests a creep from this contract.
 * Increments pendingRequests and claimed counters.
 * Returns true if request was accepted.
 */
export function requestCreep(contract: Contract): boolean {
  if (!canRequestCreep(contract)) return false;
  contract.pendingRequests++;
  contract.claimed++;
  return true;
}

/**
 * Check if contract has pending creep requests to fulfill.
 * SpawningCorp uses this to know when to spawn.
 */
export function hasPendingRequests(contract: Contract): boolean {
  return contract.pendingRequests > 0;
}

/**
 * SpawningCorp fulfills a creep request by assigning the creep.
 * Decrements pendingRequests and assigns creep to contract.
 * Returns true if fulfillment succeeded.
 */
export function fulfillCreepRequest(
  contract: Contract,
  creepId: string
): boolean {
  if (contract.pendingRequests <= 0) return false;
  contract.pendingRequests--;
  assignCreep(contract, creepId);
  return true;
}

/**
 * Get remaining claimable capacity on contract.
 */
export function remainingCapacity(contract: Contract): number {
  return Math.max(0, contract.quantity - contract.claimed);
}

/**
 * Get number of available "slots" for new creeps.
 * This is min(maxCreeps - current, unclaimed capacity).
 */
export function availableSlots(contract: Contract): number {
  const slotsFromMax = contract.maxCreeps - contract.creepIds.length;
  const slotsFromCapacity = remainingCapacity(contract);
  return Math.max(0, Math.min(slotsFromMax, slotsFromCapacity));
}

/**
 * Check if any assigned creep needs a replacement queued.
 * A replacement should be requested when a creep's TTL <= travelTime,
 * so the new creep arrives as the old one dies.
 *
 * @param contract The spawn contract
 * @param getCreepTTL Function to get TTL for a creep ID (returns undefined if not found)
 * @returns Number of replacements that should be requested
 */
export function replacementsNeeded(
  contract: Contract,
  getCreepTTL: (creepId: string) => number | undefined
): number {
  if (contract.travelTime <= 0) return 0;

  let dyingCreeps = 0;
  for (const creepId of contract.creepIds) {
    const ttl = getCreepTTL(creepId);
    // Creep dying soon - needs replacement
    if (ttl !== undefined && ttl <= contract.travelTime) {
      dyingCreeps++;
    }
  }

  // Don't request more than we have slots for
  const slotsAvailable = availableSlots(contract);
  // Account for pending requests already queued
  const alreadyQueued = contract.pendingRequests;

  return Math.max(0, Math.min(dyingCreeps - alreadyQueued, slotsAvailable));
}
