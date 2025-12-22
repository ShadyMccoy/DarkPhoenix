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
 * Colony is the top-level economic coordinator.
 *
 * The colony manages:
 * 1. Nodes (territories) - spatial regions identified by peak detection
 * 2. Treasury (CreditLedger) - seed capital and money supply
 * 3. Surveys - identifying potential corps in territories
 * 4. Statistics - tracking economic health
 *
 * NOTE: Actual corp execution is handled by CorpRunner in the execution module.
 * Real*Corps (RealMiningCorp, RealHaulingCorp, etc.) are managed via CorpRegistry,
 * not via node.corps. This class provides economic infrastructure (treasury,
 * surveying) but doesn't directly run corps.
 *
 * See main.ts for the full game loop orchestration.
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
   * Main colony tick - run economic coordination.
   *
   * NOTE: This does NOT run corps - that's handled by CorpRunner in main.ts.
   * This method handles:
   * - Bootstrap (initial seed capital)
   * - Node surveying (identify potential corps)
   * - Chain aging (lifecycle management)
   * - Stats updates
   *
   * The node.corps arrays are unused in the current architecture.
   * Real corps execution happens via CorpRegistry/CorpRunner.
   */
  run(tick: number): void {
    this.currentTick = tick;

    // Bootstrap if needed (mint seed capital)
    if (!this.bootstrapped) {
      this.bootstrap();
    }

    // Survey nodes for new opportunities (ROI calculation)
    this.surveyNodes();

    // Age active chains (lifecycle tracking)
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

  // ===========================================================================
  // DEPRECATED: These methods operate on node.corps which is always empty.
  // Real corps are managed by CorpRegistry/CorpRunner, not stored in nodes.
  // Kept for reference and potential future refactoring.
  // ===========================================================================

  /**
   * @deprecated node.corps is always empty - real corps use CorpRegistry
   */
  private collectAllOffers(): Offer[] {
    const offers: Offer[] = [];
    for (const node of this.nodes) {
      offers.push(...collectNodeOffers(node));
    }
    return offers;
  }

  /**
   * @deprecated Uses offers from empty node.corps
   */
  private findViableChains(_offers: Offer[]): Chain[] {
    return filterViable(this.activeChains);
  }

  /**
   * @deprecated Operates on empty node.corps
   */
  private fundChains(chains: Chain[]): void {
    const sorted = sortByProfit(chains);
    const selected = selectNonOverlapping(sorted);

    for (const chain of selected) {
      if (chain.funded) continue;

      const canAfford = this.ledger.canAfford(
        chain.totalCost + this.config.minTreasuryBuffer
      );

      if (canAfford) {
        this.ledger.spend(chain.totalCost);
        chain.funded = true;

        for (const segment of chain.segments) {
          const corp = this.findCorp(segment.corpId);
          if (corp) {
            corp.activate(this.currentTick);
          }
        }

        if (!this.activeChains.includes(chain)) {
          this.activeChains.push(chain);
        }
      }
    }
  }

  /**
   * @deprecated node.corps is always empty - real corps use CorpRunner
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
   * @deprecated Operates on empty node.corps
   */
  private settlePayments(): void {
    for (const chain of this.activeChains) {
      if (!chain.funded) continue;

      for (const segment of chain.segments) {
        const corp = this.findCorp(segment.corpId);
        if (!corp) continue;

        const tickPayment = segment.outputPrice / 1500;
        corp.recordRevenue(tickPayment);
      }
    }
  }

  /**
   * @deprecated Needs Real*Corps data from CorpRegistry, not node.corps
   */
  private mintForAchievements(): void {
    // Not implemented - would need access to CorpRegistry
  }

  /**
   * @deprecated node.corps is always empty
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
   * @deprecated node.corps is always empty
   */
  private pruneDead(): void {
    for (const node of this.nodes) {
      const pruned = pruneDead(
        node,
        this.currentTick,
        this.config.corpGracePeriod
      );

      for (const corp of pruned) {
        this.removeCorpFromChains(corp.id);
      }
    }
  }

  /**
   * @deprecated Operates on activeChains which use empty node.corps
   */
  private removeCorpFromChains(corpId: string): void {
    for (const chain of this.activeChains) {
      const usesCorr = chain.segments.some((s) => s.corpId === corpId);
      if (usesCorr) {
        chain.funded = false;
        for (const segment of chain.segments) {
          const corp = this.findCorp(segment.corpId);
          if (corp) {
            corp.deactivate();
          }
        }
      }
    }

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
   * Find a corp by ID across all nodes.
   * @deprecated node.corps is always empty - real corps use CorpRegistry
   */
  findCorp(corpId: string): Corp | undefined {
    for (const node of this.nodes) {
      const corp = node.corps.find((c) => c.id === corpId);
      if (corp) return corp;
    }
    return undefined;
  }

  /**
   * Get all corps across all nodes.
   * @deprecated node.corps is always empty - real corps use CorpRegistry
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
