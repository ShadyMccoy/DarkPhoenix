/**
 * @fileoverview OfferCollector aggregates buy/sell offers from corps.
 *
 * The collector gathers offers from corp states and provides
 * query methods for the ChainPlanner to match supply and demand.
 *
 * @module planning/OfferCollector
 */

import { AnyCorpState } from "../corps/CorpState";
import { Offer, projectAll } from "./projections";

/**
 * Collected offers organized by resource type.
 */
export interface CollectedOffers {
  /** Sell offers indexed by resource type */
  sells: Map<string, Offer[]>;
  /** Buy offers indexed by resource type */
  buys: Map<string, Offer[]>;
}

/**
 * OfferCollector aggregates and indexes offers from corp states.
 */
export class OfferCollector {
  private sellsByResource: Map<string, Offer[]> = new Map();
  private buysByResource: Map<string, Offer[]> = new Map();

  /**
   * Clear all collected offers.
   */
  clear(): void {
    this.sellsByResource.clear();
    this.buysByResource.clear();
  }

  /**
   * Collect offers from an array of corp states.
   */
  collectFromCorpStates(states: AnyCorpState[], tick: number): void {
    this.clear();

    const projections = projectAll(states, tick);

    for (const projection of projections) {
      // Index sell offers by resource
      for (const offer of projection.sells) {
        const existing = this.sellsByResource.get(offer.resource) ?? [];
        existing.push(offer);
        this.sellsByResource.set(offer.resource, existing);
      }

      // Index buy offers by resource
      for (const offer of projection.buys) {
        const existing = this.buysByResource.get(offer.resource) ?? [];
        existing.push(offer);
        this.buysByResource.set(offer.resource, existing);
      }
    }
  }

  /**
   * Get all sell offers for a resource.
   */
  getSells(resource: string): Offer[] {
    return this.sellsByResource.get(resource) ?? [];
  }

  /**
   * Get all buy offers for a resource.
   */
  getBuys(resource: string): Offer[] {
    return this.buysByResource.get(resource) ?? [];
  }

  /**
   * Get all resources that have sell offers.
   */
  getSellingResources(): string[] {
    return Array.from(this.sellsByResource.keys());
  }

  /**
   * Get all resources that have buy offers.
   */
  getBuyingResources(): string[] {
    return Array.from(this.buysByResource.keys());
  }

  /**
   * Get collected offers summary.
   */
  getCollected(): CollectedOffers {
    return {
      sells: new Map(this.sellsByResource),
      buys: new Map(this.buysByResource)
    };
  }

  /**
   * Get total sell quantity for a resource.
   */
  getTotalSellQuantity(resource: string): number {
    const offers = this.getSells(resource);
    return offers.reduce((sum, o) => sum + o.quantity, 0);
  }

  /**
   * Get total buy quantity for a resource.
   */
  getTotalBuyQuantity(resource: string): number {
    const offers = this.getBuys(resource);
    return offers.reduce((sum, o) => sum + o.quantity, 0);
  }
}
