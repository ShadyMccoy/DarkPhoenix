/**
 * @fileoverview TerminalRunner - execute the plan's cross-hub energy transfers
 * (spec 58 phase 3), the LinkRunner of the terminal network.
 *
 * The plan prices and gates the edge (CorpPlanner.canTransfer: both rooms
 * terminal'd, lender -> borrower, never its own store) and publishes the
 * result as Memory.terminalTransfers; this runner only FOLLOWS it - send is
 * intent-only and cheap (~0.02 CPU per cooldown), so it runs every tick from
 * the main loop and no-ops in the overwhelmingly common case of no planned
 * transfers.
 *
 * Sizing: the published rate is the SPEND at the source (fee inside), so the
 * runner never needs the fee formula to know affordability - it sends the
 * largest amount whose amount+fee fits the terminal's stock
 * (stock x terminalDeliveredFraction), bounded by the destination terminal's
 * free space (both rooms are ours, so the read is live vision, not a guess)
 * and by MAX batching: everything staged is shipped each cooldown, because the
 * hub tender stages exactly what the plan committed (terminalStageTarget) and
 * a bigger batch amortizes the engine's ceil on the fee.
 *
 * Distance uses the engine's own Game.map.getRoomLinearDistance(a, b, true) -
 * the CONTINUOUS form calcTransactionCost charges - so the affordability
 * bound and the engine's debit can never disagree (the roomDist contract).
 *
 * @module execution/TerminalRunner
 */

import "../types/Memory"; // Memory.terminalTransfers augmentation
import { TERMINAL_MIN_SEND, terminalDeliveredFraction } from "../economy/primitives";

/** Run every owned terminal's planned outbound transfer. One send per
 *  terminal per cooldown (the engine's own limit); routes are served
 *  largest-rate first so a multi-destination hub degrades gracefully into
 *  round-robin-by-pressure rather than starving the small route forever. */
export function runTerminals(): void {
  if (typeof Memory === "undefined" || !Memory.terminalTransfers) return;
  for (const fromRoom in Memory.terminalTransfers) {
    const routes = Memory.terminalTransfers[fromRoom];
    if (!routes || routes.length === 0) continue;
    const term = Game.rooms[fromRoom]?.terminal;
    if (!term || !term.my || term.cooldown > 0) continue;
    const stock = term.store[RESOURCE_ENERGY] ?? 0;
    if (stock < TERMINAL_MIN_SEND) continue;
    for (const route of [...routes].sort((a, b) => b.rate - a.rate)) {
      const d =
        typeof Game.map?.getRoomLinearDistance === "function"
          ? Game.map.getRoomLinearDistance(fromRoom, route.to, true)
          : 1;
      // Largest send the stock can afford with its own fee: amount + fee(amount)
      // <= stock  <=>  amount <= stock x deliveredFraction(d).
      const affordable = Math.floor(stock * terminalDeliveredFraction(d));
      // Both hubs are ours, so the destination's free space is a live read; a
      // dark destination (no vision this tick - shouldn't happen for an owned
      // room) skips rather than risking an over-cap send the engine clips.
      const destTerm = Game.rooms[route.to]?.terminal;
      if (!destTerm) continue;
      const amount = Math.min(affordable, destTerm.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0);
      if (amount < TERMINAL_MIN_SEND) continue;
      if (term.send(RESOURCE_ENERGY, amount, route.to) === OK) break; // one send per cooldown
    }
  }
}
