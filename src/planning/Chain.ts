import { CorpType } from "../corps/Corp";

/**
 * A ChainSegment represents one step in a production chain.
 *
 * Each segment is a corp that transforms inputs into outputs,
 * adding its margin to the cumulative cost.
 */
export interface ChainSegment {
  /** The corp performing this step */
  corpId: string;

  /** Type of corp */
  corpType: CorpType;

  /** Resource being produced/transformed */
  resource: string;

  /** Quantity being processed */
  quantity: number;

  /** Cost of inputs to this segment */
  inputCost: number;

  /** Margin applied by this corp */
  margin: number;

  /** Output price (inputCost * (1 + margin)) */
  outputPrice: number;
}

/**
 * A Chain represents a complete production path from raw resources to a goal.
 *
 * Example chain for upgrading:
 * 1. MiningCorp harvests energy (leaf, inputCost=0, margin=10%)
 * 2. HaulingCorp moves energy (input=energy@0.10, margin=10%)
 * 3. SpawningCorp provides work-ticks (input=energy@0.11, margin=10%)
 * 4. UpgradingCorp upgrades controller (inputs=work-ticks+energy)
 *
 * The chain is viable if mintValue > totalCost.
 */
export interface Chain {
  /** Unique chain identifier */
  id: string;

  /** Ordered segments from leaf (production) to root (goal) */
  segments: ChainSegment[];

  /** Cost at the leaf (usually 0 for raw resources) */
  leafCost: number;

  /** Total accumulated cost including all margins */
  totalCost: number;

  /** Credits minted when goal is achieved */
  mintValue: number;

  /** Profit (mintValue - totalCost) */
  profit: number;

  /** Whether this chain has been funded */
  funded: boolean;

  /** Priority for funding (higher = fund first) */
  priority: number;

  /** Ticks since chain was funded */
  age: number;
}

/**
 * Calculate the profit of a chain
 */
export function calculateProfit(chain: Chain): number {
  return chain.mintValue - chain.totalCost;
}

/**
 * Check if a chain is viable (profit > 0)
 */
export function isViable(chain: Chain): boolean {
  return calculateProfit(chain) > 0;
}

/**
 * Calculate total cost from segments
 */
export function calculateTotalCost(segments: ChainSegment[]): number {
  if (segments.length === 0) return 0;
  // The last segment's output price is the total cost
  return segments[segments.length - 1].outputPrice;
}

/**
 * Calculate ROI for a chain
 */
export function calculateChainROI(chain: Chain): number {
  if (chain.totalCost === 0) return 0;
  return (chain.mintValue - chain.totalCost) / chain.totalCost;
}

/**
 * Build a chain segment with cost-plus pricing
 */
export function buildSegment(
  corpId: string,
  corpType: CorpType,
  resource: string,
  quantity: number,
  inputCost: number,
  margin: number
): ChainSegment {
  return {
    corpId,
    corpType,
    resource,
    quantity,
    inputCost,
    margin,
    outputPrice: inputCost * (1 + margin)
  };
}

/**
 * Create a new chain from segments
 */
export function createChain(
  id: string,
  segments: ChainSegment[],
  mintValue: number
): Chain {
  const totalCost = calculateTotalCost(segments);
  const profit = mintValue - totalCost;
  const leafCost = segments.length > 0 ? segments[0].inputCost : 0;

  return {
    id,
    segments,
    leafCost,
    totalCost,
    mintValue,
    profit,
    funded: false,
    priority: profit, // Higher profit = higher priority
    age: 0
  };
}

/**
 * Sort chains by profitability (highest first)
 */
export function sortByProfit(chains: Chain[]): Chain[] {
  return [...chains].sort((a, b) => b.profit - a.profit);
}

/**
 * Sort chains by ROI (highest first)
 */
export function sortByROI(chains: Chain[]): Chain[] {
  return [...chains].sort(
    (a, b) => calculateChainROI(b) - calculateChainROI(a)
  );
}

/**
 * Filter to only viable chains (profit > 0)
 */
export function filterViable(chains: Chain[]): Chain[] {
  return chains.filter(isViable);
}

/**
 * Get all corp IDs involved in a chain
 */
export function getCorpIds(chain: Chain): string[] {
  return chain.segments.map((s) => s.corpId);
}

/**
 * Check if two chains share any corps (would compete for resources)
 */
export function chainsOverlap(a: Chain, b: Chain): boolean {
  const aCorps = new Set(getCorpIds(a));
  return getCorpIds(b).some((id) => aCorps.has(id));
}

/**
 * Select non-overlapping chains greedily by profit
 */
export function selectNonOverlapping(chains: Chain[]): Chain[] {
  const sorted = sortByProfit(chains);
  const selected: Chain[] = [];
  const usedCorps = new Set<string>();

  for (const chain of sorted) {
    const corpIds = getCorpIds(chain);
    const hasOverlap = corpIds.some((id) => usedCorps.has(id));

    if (!hasOverlap) {
      selected.push(chain);
      corpIds.forEach((id) => usedCorps.add(id));
    }
  }

  return selected;
}

/**
 * Generate a unique chain ID
 */
export function createChainId(goalCorpId: string, tick: number): string {
  return `chain-${goalCorpId}-${tick}`;
}

/**
 * Serialize chain for persistence
 */
export function serializeChain(chain: Chain): SerializedChain {
  return {
    id: chain.id,
    segments: chain.segments,
    leafCost: chain.leafCost,
    totalCost: chain.totalCost,
    mintValue: chain.mintValue,
    profit: chain.profit,
    funded: chain.funded,
    priority: chain.priority,
    age: chain.age
  };
}

/**
 * Serialized chain for memory persistence
 */
export interface SerializedChain {
  id: string;
  segments: ChainSegment[];
  leafCost: number;
  totalCost: number;
  mintValue: number;
  profit: number;
  funded: boolean;
  priority: number;
  age: number;
}

/**
 * Deserialize chain from persistence
 */
export function deserializeChain(data: SerializedChain): Chain {
  return { ...data };
}
