/**
 * haul-vs-link - the exchange rate between a CARRY part and a link hop.
 *
 * Owner 2026-08-06: *"every tick that a hauler spends not moving is going to
 * hit our income statement as a negative variance somewhere. So consider the
 * per tick value of the hauler ... compared to 3% link tax. The links are
 * infrastructure that expand our carry budget but only if we use it."*
 *
 * This prices both carriers in the SAME two currencies the economy is scarce
 * in - energy/tick delivered, and spawn parts/tick consumed - so the 3% tax
 * can be compared against what it actually buys instead of being feared as a
 * loss. Every formula is imported from economy/primitives: this script must
 * never restate the economics, only tabulate them (the kind-conformance rule).
 *
 *   npx ts-node -P tsconfig.test.json scripts/haul-vs-link.ts
 */

import {
  CARRY_CAPACITY,
  CARRY_MOVE_PAIR_COST,
  CREEP_LIFETIME,
  LINK_CAPACITY,
  LINK_TRANSFER_LOSS,
  SOURCE_RATE,
  carryPartsFor,
  linkTransferTax,
  roundTripTicks
} from "../src/economy/primitives";

/** Screeps: a link's cooldown after firing is LINK_COOLDOWN (1) x range. */
const LINK_COOLDOWN_PER_RANGE = 1;

/** One hauler body's delivered energy per tick on a route of `distance`. */
function haulerDeliveryPerTick(carryParts: number, distance: number): number {
  return (carryParts * CARRY_CAPACITY) / roundTripTicks(distance);
}

/** Spawn parts/tick a standing hauler body consumes (CARRY+MOVE, amortized). */
function haulerPartsPerTick(carryParts: number): number {
  return (2 * carryParts) / CREEP_LIFETIME;
}

/** Energy/tick a standing hauler body costs at the spawn. */
function haulerEnergyPerTick(carryParts: number): number {
  return (carryParts * CARRY_MOVE_PAIR_COST) / CREEP_LIFETIME;
}

/** A link's delivered energy per tick at `range`: one volley per cooldown. */
function linkDeliveryPerTick(range: number, volley = LINK_CAPACITY): number {
  return (volley * (1 - LINK_TRANSFER_LOSS)) / (LINK_COOLDOWN_PER_RANGE * Math.max(1, range));
}

const row = (cells: (string | number)[], w = 12): string =>
  cells.map((c, i) => String(c).padStart(i === 0 ? 8 : w)).join("");

console.log("\n=== 1. WHAT ONE HAULER IS WORTH PER TICK (the owner's ~6 e/t) ===");
console.log("A 16-CARRY body (the landing quantum) on routes of each distance.\n");
console.log(row(["dist", "roundTrip", "e/t deliv", "parts/t", "e/t cost", "net e/t"]));
for (const d of [1, 5, 10, 20, 30, 50, 75, 100]) {
  const carry = 16;
  const deliv = haulerDeliveryPerTick(carry, d);
  console.log(
    row([
      d,
      roundTripTicks(d),
      deliv.toFixed(2),
      haulerPartsPerTick(carry).toFixed(4),
      haulerEnergyPerTick(carry).toFixed(2),
      (deliv - haulerEnergyPerTick(carry)).toFixed(2)
    ])
  );
}

console.log("\n=== 2. WHAT ONE LINK IS WORTH PER TICK ===");
console.log("A full 800 volley per cooldown, cooldown = 1 tick per range unit.\n");
console.log(row(["range", "cooldown", "e/t deliv", "tax e/t", "= haulers", "= CARRY"]));
for (const r of [1, 2, 5, 10, 15, 20, 25]) {
  const deliv = linkDeliveryPerTick(r);
  // How many 16-CARRY haulers on a d=r walk it would take to match it.
  const perHauler = haulerDeliveryPerTick(16, r);
  console.log(
    row([
      r,
      r,
      deliv.toFixed(1),
      ((LINK_CAPACITY * LINK_TRANSFER_LOSS) / r).toFixed(2),
      (deliv / perHauler).toFixed(1),
      Math.ceil(deliv / perHauler) * 16
    ])
  );
}

console.log("\n=== 3. THE TAX, PRICED IN HAULER-TICKS (the owner's comparison) ===");
console.log("What the 3% on one 800 volley costs, vs what the hop SAVES.\n");
console.log(row(["dist", "tax e", "hauler-t", "walk saved", "verdict"], 14));
for (const d of [5, 10, 20, 30, 50, 75, 100]) {
  const taxEnergy = LINK_CAPACITY * LINK_TRANSFER_LOSS; // 24e on a full volley
  const perTick = haulerDeliveryPerTick(16, d);
  const taxInHaulerTicks = taxEnergy / perTick;
  // Walking that 800 instead costs a full round trip of hauler time.
  const walkTicks = roundTripTicks(d);
  console.log(
    row(
      [
        d,
        taxEnergy.toFixed(0),
        taxInHaulerTicks.toFixed(1),
        walkTicks,
        walkTicks > taxInHaulerTicks ? `LINK by ${(walkTicks / taxInHaulerTicks).toFixed(0)}x` : "haul"
      ],
      14
    )
  );
}

console.log("\n=== 4. THE IDLE-HAULER PRICE OF A HELD VOLLEY ===");
console.log("If holding a volley one beat idles N haulers, what did it cost?\n");
console.log(row(["hold t", "1 hauler", "3 haulers", "5 haulers", "vs 1 tax"], 14));
for (const hold of [1, 2, 5, 10, 20]) {
  const per = haulerDeliveryPerTick(16, 30); // a typical mid remote
  console.log(
    row(
      [hold, (hold * per).toFixed(1), (hold * per * 3).toFixed(1), (hold * per * 5).toFixed(1), (LINK_CAPACITY * LINK_TRANSFER_LOSS).toFixed(0)],
      14
    )
  );
}

console.log("\n=== 5. THE CARRY BUDGET A LINK REPLACES (per funded source) ===");
console.log(`A ${SOURCE_RATE} e/t source: CARRY the plan must buy to walk it home,`);
console.log("vs the link that carries it for a fixed 3%.\n");
console.log(row(["dist", "CARRY", "parts/t", "e/t bodies", "link tax e/t", "saving"], 14));
for (const d of [10, 20, 30, 50, 75, 100, 150]) {
  const carry = carryPartsFor(SOURCE_RATE, d);
  const partsT = haulerPartsPerTick(carry);
  const bodyCost = haulerEnergyPerTick(carry);
  const tax = linkTransferTax(SOURCE_RATE);
  console.log(
    row([d, carry.toFixed(1), partsT.toFixed(4), bodyCost.toFixed(2), tax.toFixed(2), (bodyCost - tax).toFixed(2)], 14)
  );
}

console.log("\nNOTE: column 'e/t bodies' is the SPAWN cost of the carry fleet only.");
console.log("It excludes the spawn-TIME cost (parts/t), which is the binding");
console.log("constraint whenever the spawn saturates - see P4/S5 in the ledger.\n");
