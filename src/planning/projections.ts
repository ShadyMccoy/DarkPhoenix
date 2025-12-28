/**
 * @fileoverview Projection functions for corp states.
 *
 * Projections compute what a corp will buy and sell based on its state.
 * These are pure functions that take state and return offers.
 *
 * @module planning/projections
 */

import { AnyCorpState } from "../corps/CorpState";

/**
 * An offer to buy or sell a resource.
 */
export interface Offer {
  /** Resource type being traded */
  resource: string;
  /** Price per unit */
  price: number;
  /** Quantity available/needed */
  quantity: number;
  /** Corp ID making the offer */
  corpId: string;
}

/**
 * Projection result for a single corp.
 */
export interface CorpProjection {
  /** Corp ID */
  corpId: string;
  /** Resources the corp is selling */
  sells: Offer[];
  /** Resources the corp is buying */
  buys: Offer[];
}

/**
 * Project what a single corp state will buy and sell.
 */
export function projectCorp(state: AnyCorpState, tick: number): CorpProjection {
  const sells: Offer[] = [];
  const buys: Offer[] = [];

  switch (state.type) {
    case "source":
      // Sources sell raw energy
      sells.push({
        resource: "raw-energy",
        price: 0,
        quantity: state.energyCapacity,
        corpId: state.id
      });
      break;

    case "mining":
      // Mining corps buy raw energy and sell harvested energy
      buys.push({
        resource: "raw-energy",
        price: 0.1,
        quantity: state.sourceCapacity,
        corpId: state.id
      });
      sells.push({
        resource: "harvested-energy",
        price: 0.2,
        quantity: state.sourceCapacity,
        corpId: state.id
      });
      break;

    case "spawning":
      // Spawning corps sell spawn capacity
      sells.push({
        resource: "spawn-capacity",
        price: 1.0,
        quantity: state.energyCapacity,
        corpId: state.id
      });
      break;

    case "hauling":
      // Hauling corps buy harvested energy and sell delivered energy
      buys.push({
        resource: "harvested-energy",
        price: 0.3,
        quantity: state.carryCapacity * 10, // approximate per epoch
        corpId: state.id
      });
      sells.push({
        resource: "delivered-energy",
        price: 0.5,
        quantity: state.carryCapacity * 10,
        corpId: state.id
      });
      break;

    case "upgrading":
      // Upgrading corps buy delivered energy and produce controller points
      buys.push({
        resource: "delivered-energy",
        price: 0.6,
        quantity: 1000, // work output estimate
        corpId: state.id
      });
      sells.push({
        resource: "controller-points",
        price: 1.0,
        quantity: 1000,
        corpId: state.id
      });
      break;

    case "building":
      // Building corps buy delivered energy
      buys.push({
        resource: "delivered-energy",
        price: 0.5,
        quantity: state.buildCost,
        corpId: state.id
      });
      break;

    case "bootstrap":
    case "scout":
      // These corps don't participate in normal economic trading
      break;
  }

  return { corpId: state.id, sells, buys };
}

/**
 * Project all corp states at a given tick.
 */
export function projectAll(states: AnyCorpState[], tick: number): CorpProjection[] {
  return states.map((state) => projectCorp(state, tick));
}

/**
 * Collect all buy offers from projections.
 */
export function collectBuys(projections: CorpProjection[]): Offer[] {
  return projections.reduce<Offer[]>((acc, p) => acc.concat(p.buys), []);
}

/**
 * Collect all sell offers from projections.
 */
export function collectSells(projections: CorpProjection[]): Offer[] {
  return projections.reduce<Offer[]>((acc, p) => acc.concat(p.sells), []);
}
