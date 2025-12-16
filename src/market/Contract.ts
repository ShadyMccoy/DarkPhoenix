/**
 * A Contract represents an agreement between a buyer and seller corp.
 *
 * Contracts are formed when the ChainPlanner matches buy and sell offers
 * and funds a chain. They track delivery progress and payment flow.
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
  startTick: number
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
    paid: 0
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
