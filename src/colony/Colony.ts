import { CreditLedger } from "./CreditLedger";
import { MintValues, DEFAULT_MINT_VALUES, getMintValue } from "./MintValues";
import { Corp } from "../corps/Corp";
import { Offer } from "../market/Offer";
import {
  Node,
  collectNodeOffers,
  pruneDead,
  getCorpsByType
} from "../nodes/Node";
import { NodeSurveyor, SurveyResult } from "../nodes/NodeSurveyor";
import { Chain, filterViable, sortByProfit, selectNonOverlapping } from "../planning/Chain";

/**
 * Colony configuration
 */
export interface ColonyConfig {
  /** Tax rate applied per tick (default 0.001 = 0.1%) */
  taxRate: number;
  /** Seed capital for bootstrapping (given to first spawn corp) */
  seedCapital: number;
  /** Grace period for new corps before pruning (ticks) */
  corpGracePeriod: number;
  /** Minimum treasury balance before funding new chains */
  minTreasuryBuffer: number;
}

/**
 * Default colony configuration
 */
export const DEFAULT_COLONY_CONFIG: ColonyConfig = {
  taxRate: 0.001,
  seedCapital: 10000,
  corpGracePeriod: 1500,
  minTreasuryBuffer: 1000
};

/**
 * Colony statistics for monitoring
 */
export interface ColonyStats {
  /** Number of nodes */
  nodeCount: number;
  /** Total corps across all nodes */
  totalCorps: number;
  /** Active corps (in funded chains) */
  activeCorps: number;
  /** Number of funded chains */
  activeChains: number;
  /** Total credits minted this session */
  totalMinted: number;
  /** Total credits taxed this session */
  totalTaxed: number;
  /** Current treasury balance */
  treasuryBalance: number;
  /** Average corp ROI */
  averageROI: number;
}

/**
 * Colony is the top-level orchestrator for the economic system.
 *
 * The colony:
 * 1. Manages nodes (territories)
 * 2. Surveys for potential corps
 * 3. Collects offers from all corps
 * 4. Finds viable chains (profitable paths from resources to goals)
 * 5. Funds chains from treasury
 * 6. Runs all active corps
 * 7. Settles payments for delivered work
 * 8. Mints credits for achievements
 * 9. Applies taxation (money destruction)
 * 10. Prunes dead corps
 */
export class Colony {
  /** All nodes in this colony */
  private nodes: Node[] = [];

  /** The credit ledger (treasury) */
  private ledger: CreditLedger;

  /** Node surveyor for finding opportunities */
  private surveyor: NodeSurveyor;

  /** Active chains being executed */
  private activeChains: Chain[] = [];

  /** Mint values (policy configuration) */
  private mintValues: MintValues;

  /** Colony configuration */
  private config: ColonyConfig;

  /** Current tick */
  private currentTick: number = 0;

  /** Whether colony has been bootstrapped */
  private bootstrapped: boolean = false;

  /** Stats tracking */
  private stats: ColonyStats = {
    nodeCount: 0,
    totalCorps: 0,
    activeCorps: 0,
    activeChains: 0,
    totalMinted: 0,
    totalTaxed: 0,
    treasuryBalance: 0,
    averageROI: 0
  };

  constructor(
    config: Partial<ColonyConfig> = {},
    mintValues: Partial<MintValues> = {}
  ) {
    this.config = { ...DEFAULT_COLONY_CONFIG, ...config };
    this.mintValues = { ...DEFAULT_MINT_VALUES, ...mintValues };
    this.ledger = new CreditLedger();
    this.surveyor = new NodeSurveyor();
  }

  /**
   * Get colony treasury balance
   */
  get treasury(): number {
    return this.ledger.getBalance();
  }

  /**
   * Main colony tick - run all economic activity
   */
  run(tick: number): void {
    this.currentTick = tick;

    // Bootstrap if needed
    if (!this.bootstrapped) {
      this.bootstrap();
    }

    // 1. Survey nodes for new opportunities
    this.surveyNodes();

    // 2. Collect offers from all corps
    const offers = this.collectAllOffers();

    // 3. Find viable chains
    const viableChains = this.findViableChains(offers);

    // 4. Fund best chains
    this.fundChains(viableChains);

    // 5. Run all active corps
    this.runCorps();

    // 6. Settle payments for delivered work
    this.settlePayments();

    // 7. Mint credits for achievements
    this.mintForAchievements();

    // 8. Apply taxation
    this.applyTaxation();

    // 9. Prune dead corps
    this.pruneDead();

    // 10. Age active chains
    this.ageChains();

    // Update stats
    this.updateStats();
  }

  /**
   * Bootstrap the colony with seed capital
   */
  private bootstrap(): void {
    this.ledger.mint(this.config.seedCapital, "bootstrap");
    this.bootstrapped = true;
  }

  /**
   * Add a node to the colony
   */
  addNode(node: Node): void {
    // Check for duplicate
    if (this.nodes.some((n) => n.id === node.id)) {
      return;
    }
    this.nodes.push(node);
  }

  /**
   * Remove a node from the colony
   */
  removeNode(nodeId: string): void {
    this.nodes = this.nodes.filter((n) => n.id !== nodeId);
  }

  /**
   * Get all nodes
   */
  getNodes(): Node[] {
    return [...this.nodes];
  }

  /**
   * Get a node by ID
   */
  getNode(nodeId: string): Node | undefined {
    return this.nodes.find((n) => n.id === nodeId);
  }

  /**
   * Survey all nodes for potential corps
   */
  private surveyNodes(): void {
    for (const node of this.nodes) {
      const result = this.surveyor.survey(node, this.currentTick);
      this.processSurveyResult(result);
    }
  }

  /**
   * Process survey result and potentially create corps
   */
  private processSurveyResult(result: SurveyResult): void {
    // For now, log potential corps
    // In full implementation, would create corps based on ROI
    // and available treasury funds
  }

  /**
   * Collect all offers from all corps in all nodes
   */
  private collectAllOffers(): Offer[] {
    const offers: Offer[] = [];
    for (const node of this.nodes) {
      offers.push(...collectNodeOffers(node));
    }
    return offers;
  }

  /**
   * Find viable chains from offers
   */
  private findViableChains(offers: Offer[]): Chain[] {
    // In full implementation, this would use ChainPlanner
    // For now, return active chains that are still viable
    return filterViable(this.activeChains);
  }

  /**
   * Fund chains from treasury
   */
  private fundChains(chains: Chain[]): void {
    // Sort by profitability
    const sorted = sortByProfit(chains);

    // Select non-overlapping chains
    const selected = selectNonOverlapping(sorted);

    // Fund each chain if we can afford it
    for (const chain of selected) {
      if (chain.funded) continue;

      const canAfford = this.ledger.canAfford(
        chain.totalCost + this.config.minTreasuryBuffer
      );

      if (canAfford) {
        this.ledger.spend(chain.totalCost);
        chain.funded = true;

        // Activate participating corps
        for (const segment of chain.segments) {
          const corp = this.findCorp(segment.corpId);
          if (corp) {
            corp.activate(this.currentTick);
          }
        }

        // Add to active chains if not already there
        if (!this.activeChains.includes(chain)) {
          this.activeChains.push(chain);
        }
      }
    }
  }

  /**
   * Run all active corps
   */
  private runCorps(): void {
    for (const node of this.nodes) {
      for (const corp of node.corps) {
        if (corp.isActive) {
          corp.work(this.currentTick);
        }
      }
    }
  }

  /**
   * Settle payments for delivered work
   */
  private settlePayments(): void {
    for (const chain of this.activeChains) {
      if (!chain.funded) continue;

      // Pay each segment for delivered work
      for (const segment of chain.segments) {
        const corp = this.findCorp(segment.corpId);
        if (!corp) continue;

        // In full implementation, track actual deliveries
        // For now, assume steady delivery over chain duration
        const tickPayment = segment.outputPrice / 1500; // Spread over creep lifetime
        corp.recordRevenue(tickPayment);
      }
    }
  }

  /**
   * Mint credits for achievements
   *
   * TODO: Re-implement when Real*Corps are connected to projections.
   * Previously used UpgradingModel for tracking upgrade work, but that's
   * now handled by projection functions which are for planning, not runtime.
   * Runtime corps (Real*Corps) should implement getUpgradeWorkThisTick().
   */
  private mintForAchievements(): void {
    // TODO: Implement when Real*Corps are connected
    // For now, upgrading corps are tracked via projections for planning,
    // not runtime tracking. Real*Corps will need to implement:
    // - getUpgradeWorkThisTick(): number
    // - getControllerLevel(): number
    //
    // Example future implementation:
    // for (const node of this.nodes) {
    //   const upgraders = getCorpsByType(node, "upgrading");
    //   for (const upgrader of upgraders) {
    //     if ('getUpgradeWorkThisTick' in upgrader) {
    //       const upgradeWork = (upgrader as any).getUpgradeWorkThisTick();
    //       if (upgradeWork > 0) {
    //         const rcl = (upgrader as any).getControllerLevel();
    //         const mintRate = rcl < 8
    //           ? getMintValue(this.mintValues, "rcl_upgrade")
    //           : getMintValue(this.mintValues, "gcl_upgrade");
    //         const mintAmount = upgradeWork * (mintRate / 1000);
    //         this.ledger.mint(mintAmount, `upgrade-rcl${rcl}`);
    //       }
    //     }
    //   }
    // }
  }

  /**
   * Apply taxation to all corps
   */
  private applyTaxation(): void {
    let totalTaxed = 0;

    for (const node of this.nodes) {
      for (const corp of node.corps) {
        const taxAmount = corp.applyTax(this.config.taxRate);
        totalTaxed += taxAmount;
      }
    }

    this.ledger.recordTaxDestroyed(totalTaxed);
  }

  /**
   * Prune dead corps from all nodes
   */
  private pruneDead(): void {
    for (const node of this.nodes) {
      const pruned = pruneDead(
        node,
        this.currentTick,
        this.config.corpGracePeriod
      );

      // Remove pruned corps from active chains
      for (const corp of pruned) {
        this.removeCorpFromChains(corp.id);
      }
    }
  }

  /**
   * Remove a corp from all chains
   */
  private removeCorpFromChains(corpId: string): void {
    // Mark chains using this corp as incomplete
    for (const chain of this.activeChains) {
      const usesCorr = chain.segments.some((s) => s.corpId === corpId);
      if (usesCorr) {
        // Deactivate the chain
        chain.funded = false;
        for (const segment of chain.segments) {
          const corp = this.findCorp(segment.corpId);
          if (corp) {
            corp.deactivate();
          }
        }
      }
    }

    // Remove defunct chains
    this.activeChains = this.activeChains.filter((chain) =>
      chain.segments.every((s) => this.findCorp(s.corpId) !== undefined)
    );
  }

  /**
   * Age all active chains
   */
  private ageChains(): void {
    for (const chain of this.activeChains) {
      chain.age++;
    }

    // Remove chains that are too old (creep lifetime expired)
    this.activeChains = this.activeChains.filter((chain) => chain.age < 1500);
  }

  /**
   * Find a corp by ID across all nodes
   */
  findCorp(corpId: string): Corp | undefined {
    for (const node of this.nodes) {
      const corp = node.corps.find((c) => c.id === corpId);
      if (corp) return corp;
    }
    return undefined;
  }

  /**
   * Get all corps across all nodes
   */
  getAllCorps(): Corp[] {
    const corps: Corp[] = [];
    for (const node of this.nodes) {
      corps.push(...node.corps);
    }
    return corps;
  }

  /**
   * Update colony statistics
   */
  private updateStats(): void {
    const allCorps = this.getAllCorps();
    const activeCorps = allCorps.filter((c) => c.isActive);
    const moneySupply = this.ledger.getMoneySupply();

    const totalROI = allCorps.reduce((sum, c) => sum + c.getActualROI(), 0);
    const avgROI = allCorps.length > 0 ? totalROI / allCorps.length : 0;

    this.stats = {
      nodeCount: this.nodes.length,
      totalCorps: allCorps.length,
      activeCorps: activeCorps.length,
      activeChains: this.activeChains.filter((c) => c.funded).length,
      totalMinted: moneySupply.minted,
      totalTaxed: moneySupply.taxed,
      treasuryBalance: moneySupply.treasury,
      averageROI: avgROI
    };
  }

  /**
   * Get colony statistics
   */
  getStats(): ColonyStats {
    return { ...this.stats };
  }

  /**
   * Get money supply information
   */
  getMoneySupply() {
    return this.ledger.getMoneySupply();
  }

  /**
   * Get active chains
   */
  getActiveChains(): Chain[] {
    return [...this.activeChains];
  }

  /**
   * Get ledger for direct operations
   */
  getLedger(): CreditLedger {
    return this.ledger;
  }

  /**
   * Get mint values
   */
  getMintValues(): MintValues {
    return { ...this.mintValues };
  }

  /**
   * Update mint values (policy change)
   */
  setMintValues(values: Partial<MintValues>): void {
    this.mintValues = { ...this.mintValues, ...values };
  }

  /**
   * Get configuration
   */
  getConfig(): ColonyConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<ColonyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Add a chain to be funded
   */
  addChain(chain: Chain): void {
    if (!this.activeChains.some((c) => c.id === chain.id)) {
      this.activeChains.push(chain);
    }
  }

  /**
   * Manually fund a chain (bypasses normal flow)
   */
  fundChain(chainId: string): boolean {
    const chain = this.activeChains.find((c) => c.id === chainId);
    if (!chain || chain.funded) return false;

    if (!this.ledger.canAfford(chain.totalCost)) return false;

    this.ledger.spend(chain.totalCost);
    chain.funded = true;

    for (const segment of chain.segments) {
      const corp = this.findCorp(segment.corpId);
      if (corp) {
        corp.activate(this.currentTick);
      }
    }

    return true;
  }

  /**
   * Get current tick
   */
  getCurrentTick(): number {
    return this.currentTick;
  }

  /**
   * Serialize colony state for persistence
   */
  serialize(): SerializedColony {
    return {
      bootstrapped: this.bootstrapped,
      currentTick: this.currentTick,
      config: this.config,
      mintValues: this.mintValues,
      ledger: this.ledger.serialize(),
      nodeIds: this.nodes.map((n) => n.id),
      activeChainIds: this.activeChains.map((c) => c.id)
    };
  }

  /**
   * Restore colony state from persistence
   */
  deserialize(data: SerializedColony): void {
    this.bootstrapped = data.bootstrapped ?? false;
    this.currentTick = data.currentTick ?? 0;
    this.config = { ...DEFAULT_COLONY_CONFIG, ...data.config };
    this.mintValues = { ...DEFAULT_MINT_VALUES, ...data.mintValues };
    if (data.ledger) {
      this.ledger.deserialize(data.ledger);
    }
    // Node and chain restoration would need additional logic
  }
}

/**
 * Serialized colony state
 */
export interface SerializedColony {
  bootstrapped: boolean;
  currentTick: number;
  config: ColonyConfig;
  mintValues: MintValues;
  ledger: ReturnType<CreditLedger["serialize"]>;
  nodeIds: string[];
  activeChainIds: string[];
}

/**
 * Create a colony with default configuration
 */
export function createColony(
  config?: Partial<ColonyConfig>,
  mintValues?: Partial<MintValues>
): Colony {
  return new Colony(config, mintValues);
}
