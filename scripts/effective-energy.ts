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
const COST = { WORK: 100, CARRY: 50, MOVE: 50, CLAIM: 600 };
const MINER_COST = 5 * COST.WORK + 3 * COST.MOVE; // 650, a 5W3M miner
const MINER_PARTS = 8; // 5 WORK + 3 MOVE

// Spawn build-time priced in energy (mirrors src/corps/economics.ts).
const SPAWN_PART_ENERGY_VALUE = 155; // energy per part/tick held

// Reserver: a CLAIM+MOVE creep that holds a remote room at the full 3000 cap.
// CLAIM creeps live only ~600 ticks; one CLAIM keeps a room reserved.
const CLAIM_LIFETIME = 600;
const RESERVER_COST = COST.CLAIM + COST.MOVE; // 650
const RESERVER_PARTS = 2; // CLAIM + MOVE

/** Per-ROOM reserver cost in energy-equivalent (upkeep + parts priced), at distance d. */
function reserverCostPerRoom(d: number): number {
  const life = Math.max(1, CLAIM_LIFETIME - d); // walks out, then reserves
  return RESERVER_COST / life + (RESERVER_PARTS / life) * SPAWN_PART_ENERGY_VALUE;
}

/** Round trip ticks for a one-way distance d (matches calculateRoundTrip). */
const roundTrip = (d: number): number => 2 * d + 2;
/** CARRY parts to sustain `rate` e/tick over distance d (matches calculateCarryParts). */
const carryFor = (rate: number, d: number): number => (rate * roundTrip(d)) / 50;
/** Productive life of a creep that must first walk `d` tiles out. */
const usefulLife = (d: number): number => Math.max(1, LIFETIME - d);

interface Row {
  carry: number;
  totalParts: number;
  net: number;
  eff: number;
  spawnLoad: number;
  partPenalty: number;
  effNet: number;
}

function row(rate: number, d: number, ttl: boolean): Row {
  const life = ttl ? usefulLife(d) : LIFETIME;
  const carry = Math.ceil(carryFor(rate, d));
  const totalParts = MINER_PARTS + 2 * carry; // hauler = 1 CARRY + 1 MOVE per unit
  const minerOH = MINER_COST / life;
  const haulerOH = (carry * (COST.CARRY + COST.MOVE)) / life;
  const net = rate - minerOH - haulerOH; // energy profit (after body upkeep)
  // Spawn build-time priced in energy: the second budget. effNet is the number
  // to rank by - a far, part-hungry source is demoted in pure energy.
  const partPenalty = (totalParts / life) * SPAWN_PART_ENERGY_VALUE;
  return {
    carry,
    totalParts,
    net,
    eff: (net / rate) * 100,
    // fraction of ONE spawn's uptime this source's fleet consumes.
    spawnLoad: (totalParts * 3) / life,
    partPenalty,
    effNet: net - partPenalty
  };
}

function breakeven(rate: number, ttl: boolean): number {
  for (let d = 0; d <= 1000; d++) if (row(rate, d, ttl).net < 0) return d - 1;
  return 1000;
}

function printTable(label: string, rate: number): void {
  console.log(`\n=== ${label} (gross ${rate} e/tick) ===`);
  console.log(" dist | carry | bodyParts |  netE  eff% | spawnLoad | partPenalty | effNet");
  for (const d of [0, 25, 50, 75, 100, 150, 200, 250, 300]) {
    const r = row(rate, d, true);
    console.log(
      `  ${String(d).padStart(3)} | ${String(r.carry).padStart(5)} | ${String(r.totalParts).padStart(9)} | ` +
        `${r.net.toFixed(2).padStart(5)} ${r.eff.toFixed(0).padStart(3)} | ${r.spawnLoad.toFixed(3).padStart(9)} | ` +
        `${r.partPenalty.toFixed(2).padStart(11)} | ${r.effNet.toFixed(2).padStart(6)}`
    );
  }
  console.log(`  break-even net=0 (energy): flat ${breakeven(rate, false)}t -> TTL ${breakeven(rate, true)}t`);
}

/**
 * Reserve a remote room (5 -> 10 e/tick) or not? The reserver is a per-ROOM cost
 * amortized over the room's sources, so 2 sources halve it. Shows per-source
 * effNet reserved (with the reserver toll) vs unreserved, for 1 and 2 sources.
 */
function printReserver(): void {
  console.log(`\n=== reserve a remote room? (per-source effNet) ===`);
  console.log(" dist | unreserved | reserved(1src) | reserved(2src) | reserverTollPerRoom");
  for (const d of [25, 50, 75, 100, 150, 200]) {
    const unres = row(5, d, true).effNet;
    const resBase = row(10, d, true).effNet; // a reserved source's effNet before the reserver toll
    const toll = reserverCostPerRoom(d);
    const res1 = resBase - toll; // 1 source bears the whole reserver
    const res2 = resBase - toll / 2; // 2 sources split it
    const win = (a: number, b: number) => (a > b ? "reserve" : "leave ");
    console.log(
      `  ${String(d).padStart(3)} | ${unres.toFixed(2).padStart(10)} | ` +
        `${res1.toFixed(2).padStart(8)} ${win(res1, unres)} | ${res2.toFixed(2).padStart(8)} ${win(res2, unres)} | ${toll.toFixed(2).padStart(8)}`
    );
  }
}

printTable("owned / reserved", 10);
printTable("unreserved", 5);
printReserver();
console.log("\nminerOH=650/(1500-d) (miner dies at source); haulerOH=carry*100/(1500-d); bodyParts=8+2*carry");
console.log(`partPenalty = (bodyParts/life) * ${SPAWN_PART_ENERGY_VALUE} (spawn build-time priced in energy); effNet = netE - partPenalty (rank by this)`);
console.log("reserver = (650 + 2 parts priced) / (600-d) per ROOM, split across the room's sources");
