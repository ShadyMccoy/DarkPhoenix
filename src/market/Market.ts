/**
 * @fileoverview Market - Matches buy and sell offers and creates transactions.
 *
 * The Market is the central clearing house for the economy:
 * - Collects offers from all corps
 * - Matches buyers with sellers based on price
 * - Creates contracts for matched trades
 * - Records revenue/cost for both parties
 *
 * Pricing Rules:
 * - Final price = max(seller's ask, buyer's bid)
 * - Seller won't sell below their marginal cost + margin
 * - Buyer pays their bid if it exceeds seller's ask (captures urgency value)
 *
 * @module market/Market
 */

import { Offer, canMatch, effectivePrice, sortByEffectivePrice } from "./Offer";
import { Contract, createContract, recordDelivery, paymentDue } from "./Contract";
import { Corp } from "../corps/Corp";

/**
 * Result of a market clearing operation
 */
export interface ClearingResult {
  /** Contracts created from matched offers */
  contracts: Contract[];
  /** Total volume traded */
  totalVolume: number;
  /** Average price per unit */
  averagePrice: number;
  /** Unmatched buy offers */
  unmatchedBuys: Offer[];
  /** Unmatched sell offers */
  unmatchedSells: Offer[];
}

/**
 * Transaction record for a completed trade
 */
export interface Transaction {
  /** Tick when transaction occurred */
  tick: number;
  /** Seller corp ID */
  sellerId: string;
  /** Buyer corp ID */
  buyerId: string;
  /** Resource traded */
  resource: string;
  /** Quantity traded */
  quantity: number;
  /** Price paid per unit */
  pricePerUnit: number;
  /** Total payment */
  totalPayment: number;
}

/**
 * Market class for matching offers and recording transactions.
 */
export class Market {
  /** Active contracts */
  private contracts: Map<string, Contract> = new Map();

  /** Transaction history for analysis */
  private transactions: Transaction[] = [];

  /** Corp registry for recording revenue/cost */
  private corps: Map<string, Corp> = new Map();

  /** Current game tick */
  private currentTick: number = 0;

  /**
   * Register a corp with the market
   */
  registerCorp(corp: Corp): void {
    this.corps.set(corp.id, corp);
  }

  /**
   * Unregister a corp from the market
   */
  unregisterCorp(corpId: string): void {
    this.corps.delete(corpId);
  }

  /**
   * Clear the market: match all compatible offers and create contracts.
   *
   * @param tick Current game tick
   * @returns Clearing result with contracts and statistics
   */
  clear(tick: number): ClearingResult {
    this.currentTick = tick;

    // Collect all offers from registered corps
    const buyOffers: Offer[] = [];
    const sellOffers: Offer[] = [];

    for (const corp of this.corps.values()) {
      buyOffers.push(...corp.buys());
      sellOffers.push(...corp.sells());
    }

    // Group offers by resource type
    const buysByResource = this.groupByResource(buyOffers);
    const sellsByResource = this.groupByResource(sellOffers);

    const contracts: Contract[] = [];
    const unmatchedBuys: Offer[] = [];
    const unmatchedSells: Offer[] = [];
    let totalVolume = 0;
    let totalValue = 0;

    // Match offers for each resource type
    const allResources = new Set([
      ...buysByResource.keys(),
      ...sellsByResource.keys()
    ]);

    for (const resource of allResources) {
      const buys = buysByResource.get(resource) || [];
      const sells = sellsByResource.get(resource) || [];

      const result = this.matchOffers(buys, sells, tick);
      contracts.push(...result.contracts);
      unmatchedBuys.push(...result.unmatchedBuys);
      unmatchedSells.push(...result.unmatchedSells);
      totalVolume += result.totalVolume;
      totalValue += result.totalVolume * result.averagePrice;
    }

    // Store contracts
    for (const contract of contracts) {
      this.contracts.set(contract.id, contract);
    }

    return {
      contracts,
      totalVolume,
      averagePrice: totalVolume > 0 ? totalValue / totalVolume : 0,
      unmatchedBuys,
      unmatchedSells
    };
  }

  /**
   * Match buy and sell offers for a single resource type.
   *
   * Uses a hybrid pricing model:
   * - Seller sets floor price (marginal cost + margin)
   * - Buyer sets bid price (value × urgency)
   * - Final price = max(seller's ask, buyer's bid)
   */
  private matchOffers(
    buys: Offer[],
    sells: Offer[],
    tick: number
  ): ClearingResult {
    const contracts: Contract[] = [];
    const unmatchedBuys: Offer[] = [];
    const unmatchedSells: Offer[] = [];
    let totalVolume = 0;
    let totalValue = 0;

    // Sort buys by bid price (highest first) - most urgent buyers get served first
    const sortedBuys = [...buys].sort((a, b) => b.price - a.price);

    // Track remaining quantities
    const buyRemaining = new Map<string, number>();
    const sellRemaining = new Map<string, number>();

    for (const buy of sortedBuys) {
      buyRemaining.set(buy.id, buy.quantity);
    }
    for (const sell of sells) {
      sellRemaining.set(sell.id, sell.quantity);
    }

    // Match each buy with available sells
    for (const buyOffer of sortedBuys) {
      let buyQty = buyRemaining.get(buyOffer.id) || 0;
      if (buyQty <= 0) continue;

      // Sort sells by price for this buyer (cheapest first, considering distance)
      const availableSells = sells
        .filter(s => (sellRemaining.get(s.id) || 0) > 0)
        .map(s => ({
          offer: s,
          effectivePrice: buyOffer.location
            ? effectivePrice(s, buyOffer.location)
            : s.price
        }))
        .sort((a, b) => a.effectivePrice - b.effectivePrice);

      for (const { offer: sellOffer, effectivePrice: sellPrice } of availableSells) {
        if (buyQty <= 0) break;

        const sellQty = sellRemaining.get(sellOffer.id) || 0;
        if (sellQty <= 0) continue;

        // Check if trade is viable: buyer willing to pay >= seller's ask
        if (buyOffer.price < sellPrice) {
          continue; // Buyer not willing to pay enough
        }

        // Calculate trade quantity and price
        const tradeQty = Math.min(buyQty, sellQty);
        // Price = max(seller's ask, buyer's bid) - captures urgency premium
        const tradePrice = Math.max(sellPrice, buyOffer.price);

        // Create contract
        const contract = createContract(
          sellOffer.corpId,
          buyOffer.corpId,
          sellOffer.resource,
          tradeQty,
          tradePrice * tradeQty,
          Math.min(sellOffer.duration, buyOffer.duration),
          tick
        );
        contracts.push(contract);

        // Record transaction
        this.recordTransaction(
          tick,
          sellOffer.corpId,
          buyOffer.corpId,
          sellOffer.resource,
          tradeQty,
          tradePrice
        );

        // Update remaining quantities
        buyQty -= tradeQty;
        buyRemaining.set(buyOffer.id, buyQty);
        sellRemaining.set(sellOffer.id, sellQty - tradeQty);

        totalVolume += tradeQty;
        totalValue += tradeQty * tradePrice;
      }

      // If any buy quantity remains unmatched
      if (buyQty > 0) {
        unmatchedBuys.push({
          ...buyOffer,
          quantity: buyQty
        });
      }
    }

    // Collect unmatched sells
    for (const sell of sells) {
      const remaining = sellRemaining.get(sell.id) || 0;
      if (remaining > 0) {
        unmatchedSells.push({
          ...sell,
          quantity: remaining
        });
      }
    }

    return {
      contracts,
      totalVolume,
      averagePrice: totalVolume > 0 ? totalValue / totalVolume : 0,
      unmatchedBuys,
      unmatchedSells
    };
  }

  /**
   * Record a transaction and update corp balances.
   */
  private recordTransaction(
    tick: number,
    sellerId: string,
    buyerId: string,
    resource: string,
    quantity: number,
    pricePerUnit: number
  ): void {
    const totalPayment = quantity * pricePerUnit;

    // Record transaction
    this.transactions.push({
      tick,
      sellerId,
      buyerId,
      resource,
      quantity,
      pricePerUnit,
      totalPayment
    });

    // Update seller: receive revenue
    const seller = this.corps.get(sellerId);
    if (seller) {
      seller.recordRevenue(totalPayment);
    }

    // Update buyer: record cost
    const buyer = this.corps.get(buyerId);
    if (buyer) {
      buyer.recordCost(totalPayment);
      // For middleman corps (hauling), also record acquisition cost
      if (buyer.type === "hauling") {
        buyer.recordAcquisition(totalPayment, quantity);
      }
    }
  }

  /**
   * Group offers by resource type
   */
  private groupByResource(offers: Offer[]): Map<string, Offer[]> {
    const grouped = new Map<string, Offer[]>();
    for (const offer of offers) {
      const existing = grouped.get(offer.resource) || [];
      existing.push(offer);
      grouped.set(offer.resource, existing);
    }
    return grouped;
  }

  /**
   * Get active contracts
   */
  getContracts(): Contract[] {
    return Array.from(this.contracts.values());
  }

  /**
   * Get transaction history
   */
  getTransactions(): Transaction[] {
    return [...this.transactions];
  }

  /**
   * Get recent transactions (last N ticks)
   */
  getRecentTransactions(ticks: number = 100): Transaction[] {
    const cutoff = this.currentTick - ticks;
    return this.transactions.filter(t => t.tick >= cutoff);
  }

  /**
   * Get market price for a resource (average of recent transactions)
   */
  getMarketPrice(resource: string, ticks: number = 100): number {
    const recent = this.getRecentTransactions(ticks)
      .filter(t => t.resource === resource);

    if (recent.length === 0) return 0;

    const totalValue = recent.reduce((sum, t) => sum + t.totalPayment, 0);
    const totalVolume = recent.reduce((sum, t) => sum + t.quantity, 0);

    return totalVolume > 0 ? totalValue / totalVolume : 0;
  }

  /**
   * Get price spread for a resource
   */
  getPriceSpread(resource: string): { bid: number; ask: number; spread: number } {
    // Collect current offers
    const buys: Offer[] = [];
    const sells: Offer[] = [];

    for (const corp of this.corps.values()) {
      buys.push(...corp.buys().filter(o => o.resource === resource));
      sells.push(...corp.sells().filter(o => o.resource === resource));
    }

    const highestBid = buys.length > 0
      ? Math.max(...buys.map(o => o.price))
      : 0;
    const lowestAsk = sells.length > 0
      ? Math.min(...sells.map(o => o.price))
      : Infinity;

    return {
      bid: highestBid,
      ask: lowestAsk === Infinity ? 0 : lowestAsk,
      spread: lowestAsk === Infinity ? 0 : lowestAsk - highestBid
    };
  }

  /**
   * Serialize market state for persistence
   */
  serialize(): {
    contracts: Contract[];
    transactions: Transaction[];
  } {
    return {
      contracts: Array.from(this.contracts.values()),
      transactions: this.transactions.slice(-1000) // Keep last 1000 transactions
    };
  }

  /**
   * Deserialize market state from persistence
   */
  deserialize(data: {
    contracts?: Contract[];
    transactions?: Transaction[];
  }): void {
    this.contracts.clear();
    for (const contract of data.contracts || []) {
      this.contracts.set(contract.id, contract);
    }
    this.transactions = data.transactions || [];
  }
}

/**
 * Create a singleton market instance
 */
let marketInstance: Market | null = null;

export function getMarket(): Market {
  if (!marketInstance) {
    marketInstance = new Market();
  }
  return marketInstance;
}

export function resetMarket(): void {
  marketInstance = null;
}
