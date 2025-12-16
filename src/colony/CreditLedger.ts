/**
 * CreditLedger manages the colony's treasury and tracks monetary flow.
 *
 * The ledger is responsible for:
 * - Minting new credits (from achievements like upgrades, bounties)
 * - Spending credits (funding chains)
 * - Recording tax destruction (to control money supply)
 * - Tracking money supply health
 */
export class CreditLedger {
  private treasury: number = 0;
  private totalMinted: number = 0;
  private totalTaxed: number = 0;
  private mintHistory: MintRecord[] = [];

  /**
   * Get the current colony treasury balance
   */
  getBalance(): number {
    return this.treasury;
  }

  /**
   * Mint new credits into the treasury.
   * Credits are created from achievements (upgrades, bounties, etc.)
   */
  mint(amount: number, reason: string): void {
    if (amount <= 0) return;

    this.treasury += amount;
    this.totalMinted += amount;
    this.mintHistory.push({
      amount,
      reason,
      tick: this.getCurrentTick()
    });

    // Keep history bounded
    if (this.mintHistory.length > 100) {
      this.mintHistory.shift();
    }
  }

  /**
   * Spend credits from the treasury.
   * Returns true if successful, false if insufficient funds.
   */
  spend(amount: number): boolean {
    if (amount <= 0) return true;
    if (amount > this.treasury) return false;

    this.treasury -= amount;
    return true;
  }

  /**
   * Record tax destruction (removes credits from circulation).
   * Tax is applied to corp balances and destroyed to control inflation.
   */
  recordTaxDestroyed(amount: number): void {
    if (amount <= 0) return;
    this.totalTaxed += amount;
  }

  /**
   * Get money supply statistics for economic health monitoring.
   */
  getMoneySupply(): MoneySupply {
    return {
      minted: this.totalMinted,
      taxed: this.totalTaxed,
      net: this.totalMinted - this.totalTaxed,
      treasury: this.treasury
    };
  }

  /**
   * Get recent mint history for debugging/analysis.
   */
  getMintHistory(): MintRecord[] {
    return [...this.mintHistory];
  }

  /**
   * Check if the treasury can afford a given amount.
   */
  canAfford(amount: number): boolean {
    return amount <= this.treasury;
  }

  /**
   * Transfer credits directly to a corp's balance.
   * Deducts from treasury and returns the amount transferred.
   */
  transferTo(amount: number): number {
    if (amount <= 0) return 0;
    const actual = Math.min(amount, this.treasury);
    this.treasury -= actual;
    return actual;
  }

  /**
   * Serialize ledger state for persistence.
   */
  serialize(): SerializedLedger {
    return {
      treasury: this.treasury,
      totalMinted: this.totalMinted,
      totalTaxed: this.totalTaxed,
      mintHistory: this.mintHistory.slice(-20) // Keep last 20 for persistence
    };
  }

  /**
   * Restore ledger state from persistence.
   */
  deserialize(data: SerializedLedger): void {
    this.treasury = data.treasury ?? 0;
    this.totalMinted = data.totalMinted ?? 0;
    this.totalTaxed = data.totalTaxed ?? 0;
    this.mintHistory = data.mintHistory ?? [];
  }

  /**
   * Get current game tick. Override for testing.
   */
  protected getCurrentTick(): number {
    // In production, this would return Game.time
    // Abstract model returns 0 - will be overridden
    return 0;
  }
}

/**
 * Record of a mint operation
 */
export interface MintRecord {
  amount: number;
  reason: string;
  tick: number;
}

/**
 * Money supply statistics
 */
export interface MoneySupply {
  minted: number;
  taxed: number;
  net: number;
  treasury: number;
}

/**
 * Serialized ledger state for persistence
 */
export interface SerializedLedger {
  treasury: number;
  totalMinted: number;
  totalTaxed: number;
  mintHistory: MintRecord[];
}
