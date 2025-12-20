import { Offer, Position, sortByEffectivePrice } from "../market/Offer";
import { Corp } from "../corps/Corp";
import { Node } from "../nodes/Node";

/**
 * OfferCollector gathers buy/sell offers from all corps in all nodes.
 *
 * Each tick:
 * 1. Corps post their offers (sells() and buys())
 * 2. OfferCollector aggregates all offers
 * 3. ChainPlanner uses collected offers to find viable chains
 * 4. After planning, offers are cleared for next tick
 */
export class OfferCollector {
  private sellOffers: Map<string, Offer[]> = new Map();
  private buyOffers: Map<string, Offer[]> = new Map();
  private allOffers: Offer[] = [];

  /**
   * Collect offers from all corps in all nodes
   */
  collect(nodes: Node[]): void {
    this.clear();

    for (const node of nodes) {
      for (const corp of node.corps) {
        // Collect sell offers
        for (const offer of corp.sells()) {
          this.addOffer(offer);
        }

        // Collect buy offers
        for (const offer of corp.buys()) {
          this.addOffer(offer);
        }
      }
    }
  }

  /**
   * Collect offers from a flat list of corps
   */
  collectFromCorps(corps: Corp[]): void {
    this.clear();

    for (const corp of corps) {
      for (const offer of corp.sells()) {
        this.addOffer(offer);
      }
      for (const offer of corp.buys()) {
        this.addOffer(offer);
      }
    }
  }

  /**
   * Add a single offer to the collector
   */
  addOffer(offer: Offer): void {
    this.allOffers.push(offer);

    if (offer.type === "sell") {
      const existing = this.sellOffers.get(offer.resource) ?? [];
      existing.push(offer);
      this.sellOffers.set(offer.resource, existing);
    } else {
      const existing = this.buyOffers.get(offer.resource) ?? [];
      existing.push(offer);
      this.buyOffers.set(offer.resource, existing);
    }
  }

  /**
   * Get all sell offers for a resource type
   */
  getSellOffers(resource: string): Offer[] {
    return this.sellOffers.get(resource) ?? [];
  }

  /**
   * Get all buy offers for a resource type
   */
  getBuyOffers(resource: string): Offer[] {
    return this.buyOffers.get(resource) ?? [];
  }

  /**
   * Get sell offers sorted by effective price for a buyer location
   */
  getCheapestSellOffers(resource: string, buyerLocation: Position): Offer[] {
    const offers = this.getSellOffers(resource);
    return sortByEffectivePrice(offers, buyerLocation);
  }

  /**
   * Get all collected offers
   */
  getAllOffers(): Offer[] {
    return [...this.allOffers];
  }

  /**
   * Get all resource types with sell offers
   */
  getAvailableResources(): string[] {
    return Array.from(this.sellOffers.keys());
  }

  /**
   * Get all resource types with buy offers
   */
  getRequestedResources(): string[] {
    return Array.from(this.buyOffers.keys());
  }

  /**
   * Get total sell quantity for a resource
   */
  getTotalSellQuantity(resource: string): number {
    const offers = this.getSellOffers(resource);
    return offers.reduce((sum, o) => sum + o.quantity, 0);
  }

  /**
   * Get total buy quantity for a resource
   */
  getTotalBuyQuantity(resource: string): number {
    const offers = this.getBuyOffers(resource);
    return offers.reduce((sum, o) => sum + o.quantity, 0);
  }

  /**
   * Check if a resource has any sell offers
   */
  hasSellOffers(resource: string): boolean {
    return (this.sellOffers.get(resource)?.length ?? 0) > 0;
  }

  /**
   * Check if a resource has any buy offers
   */
  hasBuyOffers(resource: string): boolean {
    return (this.buyOffers.get(resource)?.length ?? 0) > 0;
  }

  /**
   * Get offers from a specific corp
   */
  getCorpOffers(corpId: string): Offer[] {
    return this.allOffers.filter((o) => o.corpId === corpId);
  }

  /**
   * Get statistics about collected offers
   */
  getStats(): OfferStats {
    const resources = new Set([
      ...this.sellOffers.keys(),
      ...this.buyOffers.keys()
    ]);

    const resourceStats: Record<string, ResourceStat> = {};
    for (const resource of resources) {
      resourceStats[resource] = {
        sellCount: this.getSellOffers(resource).length,
        buyCount: this.getBuyOffers(resource).length,
        sellQuantity: this.getTotalSellQuantity(resource),
        buyQuantity: this.getTotalBuyQuantity(resource)
      };
    }

    // Count sell and buy offers using reduce (ES2018 compatible)
    const sellCount = Array.from(this.sellOffers.values()).reduce(
      (sum, arr) => sum + arr.length,
      0
    );
    const buyCount = Array.from(this.buyOffers.values()).reduce(
      (sum, arr) => sum + arr.length,
      0
    );

    return {
      totalOffers: this.allOffers.length,
      sellOffers: sellCount,
      buyOffers: buyCount,
      resourceCount: resources.size,
      resources: resourceStats
    };
  }

  /**
   * Clear all collected offers (call at end of tick)
   */
  clear(): void {
    this.sellOffers.clear();
    this.buyOffers.clear();
    this.allOffers = [];
  }
}

/**
 * Statistics about a single resource
 */
export interface ResourceStat {
  sellCount: number;
  buyCount: number;
  sellQuantity: number;
  buyQuantity: number;
}

/**
 * Overall offer statistics
 */
export interface OfferStats {
  totalOffers: number;
  sellOffers: number;
  buyOffers: number;
  resourceCount: number;
  resources: Record<string, ResourceStat>;
}
