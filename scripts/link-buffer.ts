/**
 * link-buffer - is a parked CARRY buffer beside a link worth its body?
 *
 * Owner 2026-08-06: *"Maybe we just need a biiit of a buffer at the links.
 * Energy arrives in waves. Either the link is idle sometimes or the hauling is
 * waiting. If it has a smaller Carry creep with the 1 move scale. Maybe a carry
 * per source routing to the link. It could be worth the cost by smoothing out
 * both the link and haulers. But not sure about the numbers."*
 *
 * The proposal is a CAPACITOR: a creep of N CARRY + 1 MOVE parked beside a
 * link, absorbing arrivals the link has no room for and handing them back when
 * it drains. "1 move scale" is exactly right and is why the body is cheap -
 * EMPTY CARRY parts generate no fatigue in Screeps (movement.ts already homes
 * that lens as `isFatigueFreeWhenEmpty`), so a creep that only travels empty
 * needs one MOVE, not one per CARRY.
 *
 * Every formula is imported from economy/primitives - this script must never
 * restate the economics, only tabulate them (the kind-conformance rule).
 *
 *   npx ts-node -P tsconfig.test.json scripts/link-buffer.ts
 */

import {
  BODY_COSTS,
  CARRY_CAPACITY,
  CARRY_MOVE_PAIR_COST,
  CONTAINER_CAP,
  CREEP_LIFETIME,
  LINK_CAPACITY,
  SOURCE_RATE,
  containerDecayEnergy,
  parkedRelayCarry,
  roundTripTicks,
  volleyServiceCarry
} from "../src/economy/primitives";

/** Screeps CONSTRUCTION_COST[STRUCTURE_CONTAINER] - engine constant. */
const CONTAINER_BUILD_COST = 5000;

/** A parked buffer: N CARRY + 1 MOVE (it only ever travels EMPTY). */
function bufferEnergyCost(carryParts: number): number {
  return carryParts * BODY_COSTS.CARRY + BODY_COSTS.MOVE;
}
function bufferEnergyPerTick(carryParts: number): number {
  return bufferEnergyCost(carryParts) / CREEP_LIFETIME;
}
function bufferPartsPerTick(carryParts: number): number {
  return (carryParts + 1) / CREEP_LIFETIME;
}

/** What one hauler body delivers per tick on a route of `distance`. */
function haulerDeliveryPerTick(carryParts: number, distance: number): number {
  return (carryParts * CARRY_CAPACITY) / roundTripTicks(distance);
}

/** A conventional 1:1 CARRY+MOVE hauler of the same capacity, for contrast. */
function haulerEnergyPerTick(carryParts: number): number {
  return (carryParts * CARRY_MOVE_PAIR_COST) / CREEP_LIFETIME;
}

const row = (cells: (string | number)[], w = 13): string =>
  cells.map((c, i) => String(c).padStart(i === 0 ? 9 : w)).join("");

console.log("\n=== 1. WHAT A PARKED BUFFER COSTS (N CARRY + 1 MOVE) ===");
console.log("Contrast: the same capacity bought as a 1:1 CARRY+MOVE hauler body.\n");
console.log(row(["CARRY", "buffer e", "holds e", "e/t cost", "parts/t", "as 1:1 e/t", "saving"]));
for (const n of [1, 2, 4, 8, 16, 24, 32]) {
  console.log(
    row([
      n,
      bufferEnergyCost(n),
      n * CARRY_CAPACITY,
      bufferEnergyPerTick(n).toFixed(3),
      bufferPartsPerTick(n).toFixed(4),
      haulerEnergyPerTick(n).toFixed(3),
      (haulerEnergyPerTick(n) - bufferEnergyPerTick(n)).toFixed(3)
    ])
  );
}

console.log("\n=== 2. THE ARRIVAL QUANTUM - WHY 'A CARRY PER SOURCE' UNDERSIZES ===");
console.log(`One arrival = ${LINK_CAPACITY}e: a full volley AND a full deposit-route`);
console.log(`hauler load are the same quantum (= ${volleyServiceCarry()} CARRY, spec 45 leg 3).\n`);
console.log(row(["sources", "carry/src", "holds e", "of 1 arrival", "absorbs?"], 15));
for (const s of [2, 3, 4, 7, 11, 16, 20]) {
  const holds = s * CARRY_CAPACITY;
  console.log(
    row(
      [
        s,
        1,
        holds,
        `${((holds / LINK_CAPACITY) * 100).toFixed(0)}%`,
        holds >= LINK_CAPACITY ? "whole load" : "PARTIAL only"
      ],
      15
    )
  );
}
console.log(`\n  A LINK SENDER is all-or-nothing under full-volley discipline, so a`);
console.log(`  partial buffer does not unblock it at all. A HAULER can transfer any`);
console.log(`  amount, so a partial buffer shortens its wait but does not end it.`);
console.log(`  The honest sizing unit is ${volleyServiceCarry()} CARRY per SIMULTANEOUS arrival you`);
console.log(`  intend to absorb - not one per source feeding the link.`);

console.log("\n=== 3. BREAK-EVEN: HOW MUCH IDLE MUST IT SAVE? ===");
console.log("A buffer earns its body iff it recovers more than its own e/t.");
console.log("Priced against a hauler's delivered value at three route lengths.\n");
console.log(row(["CARRY", "e/t cost", "d=20 t/1000", "d=30 t/1000", "d=50 t/1000"], 15));
for (const n of [4, 8, 16, 24]) {
  const cost = bufferEnergyPerTick(n);
  const cells = [20, 30, 50].map(d => {
    // Idle ticks per 1000 ticks of ONE hauler that must be recovered to pay.
    const perTick = haulerDeliveryPerTick(16, d);
    return ((cost / perTick) * 1000).toFixed(1);
  });
  console.log(row([n, cost.toFixed(3), ...cells], 15));
}
console.log("\n  Read: a 16-CARRY buffer (0.567 e/t) pays for itself by saving ~44");
console.log("  idle ticks per 1000 from ONE hauler on a d=30 route - i.e. 4.4% of");
console.log("  one hauler's time, or 0.3% spread across a 15-hauler fleet.");

console.log("\n=== 4. WHAT THE MEASURED FLEET WOULD HAVE TO BE LOSING ===");
console.log("Fleet-wide idle share the buffer must recover, by fleet size (d=30).\n");
console.log(row(["CARRY", "e/t cost", "n=5 fleet", "n=10 fleet", "n=15 fleet"], 15));
for (const n of [4, 8, 16, 24]) {
  const cost = bufferEnergyPerTick(n);
  const perTick = haulerDeliveryPerTick(16, 30);
  const cells = [5, 10, 15].map(f => `${((cost / (perTick * f)) * 100).toFixed(2)}%`);
  console.log(row([n, cost.toFixed(3), ...cells], 15));
}

console.log("\n=== 5. THE WAVE IT SMOOTHS (arrival burstiness at one link) ===");
console.log(`A link holds ${LINK_CAPACITY}e. Arrivals of ${LINK_CAPACITY}e each at rate R.`);
console.log("Ticks of headroom the link alone gives before it refuses, vs +buffer.\n");
console.log(row(["inflow e/t", "link only", "+8 CARRY", "+16 CARRY", "+24 CARRY"], 15));
for (const r of [10, 20, 40, 65, 100]) {
  const t = (cap: number) => (cap / r).toFixed(1);
  console.log(
    row(
      [
        r,
        t(LINK_CAPACITY),
        t(LINK_CAPACITY + 8 * CARRY_CAPACITY),
        t(LINK_CAPACITY + 16 * CARRY_CAPACITY),
        t(LINK_CAPACITY + 24 * CARRY_CAPACITY)
      ],
      15
    )
  );
}
console.log(`\n  At the measured deposit-port flow (65 e/t across 7 remote routes) a`);
console.log(`  bare link gives 12.3t of headroom; +16 CARRY gives 24.6t. The buffer`);
console.log(`  DOUBLES the wave it can ride out - but only if the drain behind it`);
console.log(`  keeps up on average. A buffer fixes BURSTINESS, never a rate deficit:`);
console.log(`  if inflow exceeds drain on average it fills once and stays full.`);

console.log(`\n=== 6. SANITY: ONE SOURCE'S WORTH OF BUFFER ===`);
console.log(`A ${SOURCE_RATE} e/t source fills ${(LINK_CAPACITY / SOURCE_RATE).toFixed(0)}t of link, or ${(CARRY_CAPACITY / SOURCE_RATE).toFixed(0)}t per CARRY part added.`);
console.log(`So one buffer CARRY part buys ${(CARRY_CAPACITY / SOURCE_RATE).toFixed(0)} ticks of one source's patience`);
console.log(`for ${bufferEnergyPerTick(1).toFixed(4)} e/t - the cheapest smoothing on the board.\n`);

console.log("\n=== 7. FREE ULLAGE: THE MINER ALREADY STANDING AT THE LINK ===");
console.log("Owner 2026-08-06: a link-served miner is 5 WORK + 1 CARRY + 3 MOVE");
console.log("(verified live on cd90/cd92), parked at the link for its whole life.");
console.log("Its 1 CARRY is 50e of buffer nobody has to buy.\n");
const MINER_ULLAGE = 1 * CARRY_CAPACITY;
// Borrowing it costs the miner's own deposit slot: its harvest drops to the
// ground, which decays at Screeps' ceil(amount/1000) = 1 e/t for a small pile
// until the miner recovers it. That is the whole downside.
const ULLAGE_COST_PER_TICK = 1;
console.log(row(["route d", "hauler e/t", "ullage e/t", "trade ratio", "verdict"], 15));
for (const d of [20, 30, 50, 75]) {
  const h = haulerDeliveryPerTick(16, d);
  console.log(
    row([d, h.toFixed(1), ULLAGE_COST_PER_TICK.toFixed(1), `${(h / ULLAGE_COST_PER_TICK).toFixed(0)}x`, "BORROW"], 15)
  );
}
console.log("\n  The point is not the 50e - it is WHOSE TICK IS SCARCE. A parked");
console.log("  miner's spare capacity costs ~1 e/t (small-pile decay until it");
console.log("  recovers the drop); a hauler's tick is worth 6-13. Borrowing is a");
console.log("  6-13x favourable exchange EVERY time it fires.");
console.log("\n  Why it stays marginal, though:");
console.log(
  `    ullage ${MINER_ULLAGE}e vs the ${LINK_CAPACITY}e arrival quantum = ${((MINER_ULLAGE / LINK_CAPACITY) * 100).toFixed(2)}% of one load.`
);
console.log(`    It converts "wait" into "depart" ONLY when the hauler's residual`);
console.log(`    is <= ${MINER_ULLAGE}e - roughly a ${((MINER_ULLAGE / LINK_CAPACITY) * 100).toFixed(1)}% slice of arrivals.`);
console.log("\n  THE LADDER (use in this order, cheapest first):");
console.log("    1. the link's own free capacity          0.000 e/t");
console.log(`    2. ullage on creeps already standing      ~1 e/t WHILE borrowed, only`);
console.log("                                              when it frees a hauler");
console.log(`    3. a bought buffer creep (16 CARRY)      ${bufferEnergyPerTick(16).toFixed(3)} e/t standing`);

console.log("\n=== 8. CONTAINER + A LIL TENDER vs THE BUFFER CREEP ===");
console.log("Owner 2026-08-06: *\"we could also maybe build containers instead as");
console.log("well by the links... might be better. With a lil tender.\"*\n");
// The lil tender stands adjacent to BOTH container and link, so it is a PARKED
// relay: withdraw tick + transfer tick, zero travel (parkedRelayCarry).
const PORT_FLOW = 65; // measured DEP deposit flow across the 7 candidate routes
const tenderCarry = Math.ceil(parkedRelayCarry(PORT_FLOW));
const tenderCost = (tenderCarry * BODY_COSTS.CARRY + BODY_COSTS.MOVE) / CREEP_LIFETIME;
const ownedRepair = containerDecayEnergy(true);
const remoteRepair = containerDecayEnergy(false);
console.log(row(["option", "holds e", "e/t stand", "spawn p/t", "build e"], 15));
console.log(row(["creep16", 16 * CARRY_CAPACITY, bufferEnergyPerTick(16).toFixed(3), bufferPartsPerTick(16).toFixed(4), 0], 15));
console.log(row(["cont+tend", CONTAINER_CAP, (ownedRepair + tenderCost).toFixed(3), ((tenderCarry + 1) / CREEP_LIFETIME).toFixed(4), CONTAINER_BUILD_COST], 15));
console.log(row(["cont only", CONTAINER_CAP, ownedRepair.toFixed(3), "0.0000", CONTAINER_BUILD_COST], 15));
console.log(
  `\n  The lil tender is TINY: parkedRelayCarry(${PORT_FLOW}) = ${parkedRelayCarry(PORT_FLOW).toFixed(1)} -> ${tenderCarry} CARRY,`
);
console.log(`  ${tenderCarry} CARRY + 1 MOVE = ${tenderCarry * BODY_COSTS.CARRY + BODY_COSTS.MOVE}e = ${tenderCost.toFixed(3)} e/t. Container repair is ${ownedRepair.toFixed(2)} e/t.`);
console.log(`  Together ${(ownedRepair + tenderCost).toFixed(3)} e/t for ${CONTAINER_CAP}e, against ${bufferEnergyPerTick(16).toFixed(3)} e/t for ${16 * CARRY_CAPACITY}e:`);
const perUnitCreep = bufferEnergyPerTick(16) / (16 * CARRY_CAPACITY);
const perUnitCont = (ownedRepair + tenderCost) / CONTAINER_CAP;
console.log(`  ${(perUnitCreep / perUnitCont).toFixed(1)}x cheaper PER UNIT OF CAPACITY.`);
const payback = CONTAINER_BUILD_COST / (bufferEnergyPerTick(16) - (ownedRepair + tenderCost));
console.log(`  The ${CONTAINER_BUILD_COST}e build pays back in ${payback.toFixed(0)}t (${(payback / CREEP_LIFETIME).toFixed(1)} creep lifetimes).`);
console.log("\n  WHY IT REALLY WINS - and it is not the capacity: a container costs");
console.log("  ZERO SPAWN THROUGHPUT, and the spawn is the binding constraint");
console.log("  (S5: building 0.555 of 0.667 p/t physical = 17% surge margin).");
console.log("  A buffer creep conflates CAPACITY and THROUGHPUT in one body and");
console.log("  charges spawn parts for both. Container + tender SEPARATES them:");
console.log("    capacity   -> the container   (burst absorption, 0 spawn parts)");
console.log("    throughput -> the lil tender  (sustained rate, a few CARRY)");
console.log("  Buy each at its own cheapest price.");
console.log(`\n  CAVEAT - PLACEMENT: a remote container costs ${remoteRepair.toFixed(2)} e/t, ${(remoteRepair / ownedRepair).toFixed(0)}x an owned`);
console.log("  one, purely because the engine decays it 5x as fast. This trick is");
console.log("  cheap in the HOME room and much less so anywhere we do not own.");

console.log("\n=== 9. AT A SOURCE LINK THE TENDER IS ALREADY THERE (FREE) ===");
const minerRelayRate = (1 * CARRY_CAPACITY) / 2; // invert parkedRelayCarry for 1 CARRY
console.log(`  A 1-CARRY link-served miner is a parked relay of ${minerRelayRate} e/t`);
console.log(`  (invert parkedRelayCarry), against a source's ${SOURCE_RATE} e/t.`);
console.log(`  ${minerRelayRate} >= ${SOURCE_RATE}, so it can drain its own container unaided:`);
console.log("  a container at a SOURCE link needs NO tender at all - just the");
console.log(`  ${ownedRepair.toFixed(2)} e/t repair. That converts a full link from`);
console.log('  "miner drops and the pile decays" into "miner parks it next door".\n');

console.log("\n=== 10. WHICH LINKS ACTUALLY NEED ONE (the sizing law) ===");
console.log("Owner 2026-08-06: *\"safe to say only links of a certain size");
console.log("(throughput correlates with waves) would normally require it?\"* Yes -");
console.log("but NOT because throughput makes waves bigger. It makes them COLLIDE");
console.log("more often. The criterion is a utilisation, and RANGE is in it:\n");
console.log(`      rho = R * range / ${LINK_CAPACITY}   (arrival rate / one-volley-per-cooldown)\n`);
console.log("  rho is INVARIANT to arrival size, which is why the bands below hold");
console.log("  whatever the haulers weigh. Arrivals of size S come at R/S per tick,");
console.log("  and each needs S/800 volleys to clear, so the service rate for them");
console.log(`  is (${LINK_CAPACITY}/range)/S. rho = (R/S) / (${LINK_CAPACITY}/(S*range)) = R*range/${LINK_CAPACITY} - the S`);
console.log("  cancels. Only the BUFFER SIZE depends on S (table below).\n");
const meanQueueLoads = (rho: number): number => (rho >= 1 ? Infinity : (rho * rho) / (2 * (1 - rho)));
console.log(row(["R e/t", "range 5", "range 10", "range 20", "range 30"], 14));
for (const R of [10, 20, 25, 40, 65, 80, 100]) {
  const cells = [5, 10, 20, 30].map(g => {
    const rho = (R * g) / LINK_CAPACITY;
    return rho >= 1 ? `${rho.toFixed(2)} SAT` : rho >= 0.5 ? `${rho.toFixed(2)} BUF` : `${rho.toFixed(2)} --`;
  });
  console.log(row([R, ...cells], 14));
}
console.log("\n  THREE BANDS, and both live extremes already sit in the outer two:");
console.log("    rho < 0.5   IDLE       nothing to smooth. Measured: link-served");
console.log("                           sources cd90/cd92 hold 21e and 0e of 2000.");
console.log("    0.5 - 1.0   BUFFER     the only band a container earns 0.233 e/t.");
console.log("    rho >= 1.0  SATURATED  rate deficit; fills once, stays full.");
console.log("                           Measured: 5 remote containers 4232e OVER cap.");

console.log("\n=== 11. THE ARRIVAL IS NOT 800e - SIZE THE BUFFER TO THE ROUTE ===");
console.log("Owner 2026-08-06: *\"why is one arrival always 800? Are our haulers in");
console.log("fact sized that way\"* - they are NOT, and the earlier table was wrong");
console.log("to assume it. MEASURED per-body CARRY at t72809560:\n");
const LIVE: [string, number][] = [
  ["cee2", 14.8], ["cbd8", 15.4], ["d01f", 18.9], ["cee0", 19.7],
  ["cd94", 20.4], ["cbd5", 23.0], ["cd98", 24.2], ["c9f9", 35.0]
];
console.log(row(["route", "CARRY", "arrival e", "fits link?", "buffer for 1"], 14));
for (const [id, carry] of LIVE) {
  const arrival = carry * CARRY_CAPACITY;
  const short = Math.max(0, arrival - LINK_CAPACITY);
  console.log(row([id, carry.toFixed(1), arrival.toFixed(0), short === 0 ? "yes" : "NO", short.toFixed(0)], 14));
}
console.log(`\n  ${LINK_CAPACITY}e is a hard cap on a LINK VOLLEY (the engine clamps a fire), so`);
console.log("  that half of the old claim stands. For a HAULER it holds only where");
console.log("  spec 45 leg 3's depositRouteCarryCap is in force - and that fires");
console.log("  only when isDepositRoute is true, which is NEVER today (DEP is");
console.log("  read-only). The quantum was a policy that is not switched on.");
console.log(`\n  So the buffer must cover (arrival - ${LINK_CAPACITY}) before ANY queueing, then the`);
console.log("  queue on top. Sized against the WORST live route (c9f9, 1749e):\n");
console.log(row(["rho", "queue e @1749", "+ 1 arrival", "total need", "2000 container?"], 16));
for (const rho of [0.5, 0.6, 0.7, 0.8]) {
  const q = meanQueueLoads(rho) * 1749;
  const need = q + Math.max(0, 1749 - LINK_CAPACITY);
  console.log(row([rho.toFixed(2), q.toFixed(0), (1749 - LINK_CAPACITY).toFixed(0), need.toFixed(0),
    need <= CONTAINER_CAP ? "covers it" : "UNDERSIZED"], 16));
}
console.log("\n  The old table said one container covers up to rho ~0.8. Against real");
console.log(`  ${1749}e arrivals it covers only to about rho 0.5-0.6. Size the buffer to`);
console.log("  the ROUTE's arrival, never to LINK_CAPACITY.\n");
console.log("  AND A TENSION THIS EXPOSES: leg 3's cap exists to make the quantum");
console.log(`  ${LINK_CAPACITY}e so a deposit hauler always fits. But the routes DEP would serve`);
console.log("  are the LONG ones (cd98 d=99, d01f d=95, cee2 d=87) - exactly the");
console.log("  ones whose efficient body is biggest. Capping them splits each into");
console.log("  2-3 creeps: same total CARRY, but more spawn EVENTS against a spawn");
console.log("  already at 0.92x its ceiling. Whether the cap or the buffer is the");
console.log("  cheaper way to make a big hauler fit a link is an OPEN question, and");
console.log("  it should be decided before DEP routing is switched on.\n");
