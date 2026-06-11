#!/usr/bin/env ts-node
/* eslint-disable no-console */
/**
 * effective-energy - what does a source TRULY net, after creep overhead?
 *
 * Models the net energy/tick a source delivers once you subtract the spawn cost
 * of the creeps needed to harvest and haul it - and, crucially, accounts for
 * travel TIME-TO-LIVE: a static miner walks `d` tiles out and then dies at the
 * source, so it only mines for (LIFETIME - d) ticks and must be respawned that
 * much more often. That raises BOTH its amortized energy cost (more bodies per
 * unit time) and the spawn-time it consumes. The same initial walk-out shortens
 * a hauler's productive life too.
 *
 * Constants mirror src/flow/FlowTypes.ts so this tracks the live economy.
 *
 * Usage: npx ts-node -P tsconfig.test.json scripts/effective-energy.ts
 */

const LIFETIME = 1500;
const COST = { WORK: 100, CARRY: 50, MOVE: 50 };
const MINER_COST = 5 * COST.WORK + 3 * COST.MOVE; // 650, a 5W3M miner
const MINER_PARTS = 8; // 5 WORK + 3 MOVE

/** Round trip ticks for a one-way distance d (matches calculateRoundTrip). */
const roundTrip = (d: number): number => 2 * d + 2;
/** CARRY parts to sustain `rate` e/tick over distance d (matches calculateCarryParts). */
const carryFor = (rate: number, d: number): number => (rate * roundTrip(d)) / 50;
/** Productive life of a creep that must first walk `d` tiles out. */
const usefulLife = (d: number): number => Math.max(1, LIFETIME - d);

interface Row {
  carry: number;
  totalParts: number;
  minerOH: number;
  haulerOH: number;
  net: number;
  eff: number;
  spawnLoad: number;
}

function row(rate: number, d: number, ttl: boolean): Row {
  const life = ttl ? usefulLife(d) : LIFETIME;
  const carry = Math.ceil(carryFor(rate, d));
  const totalParts = MINER_PARTS + 2 * carry; // hauler = 1 CARRY + 1 MOVE per unit
  const minerOH = MINER_COST / life;
  const haulerOH = (carry * (COST.CARRY + COST.MOVE)) / life;
  const net = rate - minerOH - haulerOH;
  return {
    carry,
    totalParts,
    minerOH,
    haulerOH,
    net,
    eff: (net / rate) * 100,
    // fraction of ONE spawn's uptime this source's fleet consumes:
    // parts*3 ticks to build, divided by how long each fleet lives.
    spawnLoad: (totalParts * 3) / life
  };
}

function breakeven(rate: number, ttl: boolean): number {
  for (let d = 0; d <= 1000; d++) if (row(rate, d, ttl).net < 0) return d - 1;
  return 1000;
}

function printTable(label: string, rate: number): void {
  console.log(`\n=== ${label} (gross ${rate} e/tick) ===`);
  console.log(" dist | carry | bodyParts | minerOH haulerOH |  netE  eff% | spawnLoad");
  for (const d of [0, 25, 50, 75, 100, 150, 200, 250, 300]) {
    const r = row(rate, d, true);
    console.log(
      `  ${String(d).padStart(3)} | ${String(r.carry).padStart(5)} | ${String(r.totalParts).padStart(9)} | ` +
        `${r.minerOH.toFixed(2).padStart(6)} ${r.haulerOH.toFixed(2).padStart(7)} | ` +
        `${r.net.toFixed(2).padStart(5)} ${r.eff.toFixed(0).padStart(3)} | ${r.spawnLoad.toFixed(3)}`
    );
  }
  console.log(`  break-even net=0:  flat (no TTL) ${breakeven(rate, false)} tiles  ->  TTL-adjusted ${breakeven(rate, true)} tiles`);
}

printTable("owned / reserved", 10);
printTable("unreserved", 5);
console.log("\nminerOH = 650/(1500-d)  (static miner dies at source);  haulerOH = carry*100/(1500-d)");
console.log("bodyParts = 8 (miner) + 2*carry (haulers);  spawnLoad = bodyParts*3/(1500-d) = fraction of one spawn's uptime");
