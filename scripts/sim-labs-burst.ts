/**
 * sim-labs-burst.ts — CAMPAIGN BURST, unbounded tender (spec 31).
 *
 * The "hit max utilisation regardless of CPU cost" implementation (owner idea).
 * Each tick: pick the most-owed suppliable reaction, hold its two reactants in 2
 * JUST-IN-TIME feeder labs, and fire it on EVERY other off-cooldown free lab
 * (burst). The tender is unbounded — it parks every other compound to the terminal
 * to free labs and reloads feeders. Feeders rotate; no lab is a permanent feeder.
 *
 * RESULT — this DISPROVES the "0.8 utilisation wall" I claimed. Measured, sustainable
 * (verified cooldowns):
 *   XLH2O 87.9% util, 400/1k throughput.  XUHO2 84.4%, 444/1k.  XGH2O 88.3%, 316/1k.
 * Why it beats 0.8: a source holding an INTERMEDIATE can be a lab that just produced
 * it (on cooldown = busy) while being read — only BASE feeders are truly idle. So
 * base-consuming bursts run ~0.8 but compound-consuming bursts read on-cooldown
 * producers (~1.0 that tick); weighted over a real tree it lands at 84-88%, and it
 * RISES with tree depth (XGH2O 88%, and it handles the Ghodium tree that every other
 * scheduler choked on, because bursting only needs 2 feeders at a time, never 7).
 * util = R x Σcd / 50 exactly. Cost: ~350-450 CPU/1k (the tender parks+reloads
 * everything every tick) — "regardless of CPU cost" is load-bearing.
 * NOTE: superseded by the base-rotation schedulers (sim-labs-unity*, sim-labs-batch)
 * which reach ~1.0 — this burst is kept as the intermediate finding that broke 0.8.
 *
 * FEEDERS NEED NOT ROTATE (--fixed, owner): pinning the 2 feeders to labs 0,1
 * instead of chasing any-holder gives XLH2O 80.0% util @ 400/1k for only 0.24
 * CPU/unit — a 3.7x CPU cut for a 4% util loss. Fixed lands exactly on the clean
 * 0.80 (2 permanent idle feeders); the rotation's extra 4% (catching a busy
 * intermediate-producer as a feeder) is not worth its churn. Fixed-feeder burst is
 * the better trade: standard 0.8 utilisation at a quarter the CPU.
 * Run:  npx ts-node -P tsconfig.test.json scripts/sim-labs-burst.ts --target XLH2O [--fixed]
 *
 * NOT wired into the bot. Labs are unmodeled in src/ (no StructureLab, no
 * reaction economy) — this is an exploration tool.
 *
 * Sustainable == CONSERVATION: over the steady window the labs and every
 * intermediate buffer must return to their starting fill, so the only net changes
 * are bases consumed (input) and the top compound produced (output). A drifting
 * intermediate means the rate is borrowed from a bleeding buffer, not earned.
 *
 * CPU: every tender withdraw/deposit is one intent = 0.2 CPU (GRAND_STRATEGY §1).
 * Holding intermediates in-lab and reusing a few base holders keeps intents low.
 *
 * The game constants below are VERIFIED against @screeps/common master (2026-07-26)
 * (@screeps/engine is not vendored). This sim is a design aid, not an acceptance
 * test.
 *
 * Run:  npx ts-node -P tsconfig.test.json scripts/sim-labs.ts [--target XGH2O]
 *                                                             [--ticks 80000]
 *                                                             [--carry 2000]
 *                                                             [--buffer 60]  (in-lab stock kept per intermediate)
 *                                                             [--quiet]
 */

/* eslint-disable no-console */

// ---------------------------------------------------------------------------
// Game constants — VERIFIED against @screeps/common master lib/constants.js (2026-07-26)
// ---------------------------------------------------------------------------
const LAB_MINERAL_CAPACITY = 3000;
const LAB_REACTION_AMOUNT = 5; // produced per reaction; consumed per reactant

const REACTIONS: Record<string, [string, string]> = {
  OH: ["H", "O"],
  ZK: ["Z", "K"],
  UL: ["U", "L"],
  G: ["ZK", "UL"],
  UH: ["U", "H"], UO: ["U", "O"],
  KH: ["K", "H"], KO: ["K", "O"],
  LH: ["L", "H"], LO: ["L", "O"],
  ZH: ["Z", "H"], ZO: ["Z", "O"],
  GH: ["G", "H"], GO: ["G", "O"],
  UH2O: ["UH", "OH"], UHO2: ["UO", "OH"],
  KH2O: ["KH", "OH"], KHO2: ["KO", "OH"],
  LH2O: ["LH", "OH"], LHO2: ["LO", "OH"],
  ZH2O: ["ZH", "OH"], ZHO2: ["ZO", "OH"],
  GH2O: ["GH", "OH"], GHO2: ["GO", "OH"],
  XUH2O: ["X", "UH2O"], XUHO2: ["X", "UHO2"],
  XKH2O: ["X", "KH2O"], XKHO2: ["X", "KHO2"],
  XLH2O: ["X", "LH2O"], XLHO2: ["X", "LHO2"],
  XZH2O: ["X", "ZH2O"], XZHO2: ["X", "ZHO2"],
  XGH2O: ["X", "GH2O"], XGHO2: ["X", "GHO2"],
};

const REACTION_TIME: Record<string, number> = {
  OH: 20, ZK: 5, UL: 5, G: 5,
  UH: 10, UO: 10, KH: 10, KO: 10, LH: 15, LO: 10, ZH: 20, ZO: 10, GH: 10, GO: 10,
  UH2O: 5, UHO2: 5, KH2O: 5, KHO2: 5, LH2O: 10, LHO2: 5, ZH2O: 40, ZHO2: 5, GH2O: 15, GHO2: 30,
  XUH2O: 60, XUHO2: 60, XKH2O: 60, XKHO2: 60, XLH2O: 65, XLHO2: 60,
  XZH2O: 160, XZHO2: 60, XGH2O: 80, XGHO2: 150,
};

const BASES = new Set(["H", "O", "Z", "K", "U", "L", "X"]);
const isBase = (r: string) => BASES.has(r);

// ---------------------------------------------------------------------------
// The layout (spec 31): 10 labs + two feeder SPOTS (walkable tender tiles).
//   c0  c1  c2  c3
// r0 L   L   L   .
// r1 L   F   L   L
// r2 L   L   F   L
// r3 .   L   .   .
// (geometry is validated elsewhere; this phased sim treats the 10 labs as one
//  tender-reachable pool — the two feeder spots reach all 10, spec 31 Layout.)
// ---------------------------------------------------------------------------
const LAB_COUNT = 10;

interface Lab {
  id: number;
  mineral: string | null;
  amount: number;
  cooldown: number;
}

// ---------------------------------------------------------------------------
// Reaction tree expansion
// ---------------------------------------------------------------------------
function treeCompounds(target: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (c: string) => {
    if (isBase(c) || seen.has(c)) return;
    seen.add(c);
    const [a, b] = REACTIONS[c];
    visit(a);
    visit(b);
    order.push(c); // post-order => reactants before product
  };
  visit(target);
  return order;
}
const depthOf = (() => {
  const memo = new Map<string, number>();
  const d = (c: string): number => {
    if (isBase(c)) return 0;
    if (memo.has(c)) return memo.get(c)!;
    const [a, b] = REACTIONS[c];
    const v = 1 + Math.max(d(a), d(b));
    memo.set(c, v);
    return v;
  };
  return d;
})();

// ---------------------------------------------------------------------------
interface Args {
  target: string;
  ticks: number;
  carry: number;
  buffer: number; // in-lab stock kept per intermediate before its lab idles
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const target = get("--target", "XGH2O");
  if (!REACTIONS[target]) {
    console.error(`Unknown target "${target}". Try XGH2O, XGHO2, XLH2O, XZHO2, ...`);
    process.exit(1);
  }
  return {
    target,
    ticks: parseInt(get("--ticks", "80000"), 10),
    carry: parseInt(get("--carry", "2000"), 10),
    buffer: parseInt(get("--buffer", "60"), 10),
    quiet: argv.includes("--quiet"),
  };
}

// ---------------------------------------------------------------------------
function run(args: Args): void {
  const { target } = args;
  const tree = treeCompounds(target); // reactants-before-product; target is last

  const labs: Lab[] = Array.from({ length: LAB_COUNT }, (_, id) => ({
    id, mineral: null, amount: 0, cooldown: 0,
  }));

  if (tree.length > LAB_COUNT) {
    console.error(`${target} needs ${tree.length} producer labs > ${LAB_COUNT}; pick a shallower target.`);
    process.exit(1);
  }

  // STATIC BALANCED-ALLOCATION, REACT-AWAY FLOW. Each lab has ONE permanent job:
  // a base FEEDER (topped by the tender) or a REACTOR for one reaction. Reactor
  // labs are split across the tree's reactions in proportion to COOLDOWN (greedy:
  // the reaction with the worst cd/labs ratio gets the next lab), so the slow top
  // reaction gets the most labs and no reaction is the sole bottleneck. Reactors
  // read their two reactants IN PLACE — bases from feeders, intermediates from the
  // upstream reactors — and fire every time they cool down. The tender only tops
  // feeders and drains the target; it NEVER withdraws a compound (react-away).
  const terminal: Record<string, number> = {};
  const banked: Record<string, number> = {};
  for (const base of BASES) terminal[base] = 0;
  const tender: { carrying: { res: string; amt: number } | null } = { carrying: null };

  // metrics
  let tenderBusyTicks = 0;
  let tenderIntents = 0;
  let reactionsRun = 0;
  let readsAcrossCooldown = 0;
  let producedTarget = 0;
  let busyLabTicks = 0;

  const CAP = LAB_MINERAL_CAPACITY;
  const BUFFER = args.buffer; // intermediate stock cap: a reactor idles above it
                             // (low-tier reactions get >=1 lab but need a fraction,
                             //  so they must idle when stocked or they overproduce)

  // --- CAMPAIGN BURST (unbounded tender / high CPU) -------------------------
  const bases = [...new Set(tree.flatMap((c) => REACTIONS[c].filter(isBase)))];
  const BIG = 1e9;
  for (const base of BASES) terminal[base] = BIG; // bases: unlimited supply

  const stockLabs = (c: string): number => labs.reduce((s, l) => s + (l.mineral === c ? l.amount : 0), 0);
  const totalStock = (c: string): number => stockLabs(c) + (terminal[c] ?? 0);
  const R = (LAB_REACTION_AMOUNT * LAB_COUNT) / tree.reduce((s, c) => s + REACTION_TIME[c], 0);
  const deficit: Record<string, number> = {};
  for (const c of tree) deficit[c] = 0;
  const suppliable = (c: string): boolean => {
    const [a, b] = REACTIONS[c];
    return totalStock(a) >= LAB_REACTION_AMOUNT && totalStock(b) >= LAB_REACTION_AMOUNT;
  };

  // one burst per tick: pick the most-owed suppliable reaction, hold its 2
  // reactants in 2 just-in-time feeder labs, fire it on every OTHER off-cooldown
  // free lab. Park everything else to the terminal to free labs (unbounded intents).
  const burstTick = (): void => {
    for (const c of tree) deficit[c] += R;
    // bank any finished target first (so a single-reaction target doesn't clog)
    for (const P of labs) {
      if (P.mineral === target && P.amount > 0) {
        banked[target] = (banked[target] ?? 0) + P.amount; producedTarget += P.amount;
        P.mineral = null; P.amount = 0; tenderIntents++;
      }
    }
    let camp: string | null = null;
    let best = -Infinity;
    for (const c of tree) if (suppliable(c) && deficit[c] > best) { best = deficit[c]; camp = c; }
    if (!camp) return;
    const [a, b] = REACTIONS[camp];
    const FIXED = process.argv.includes("--fixed"); // pin feeders to labs 0,1 (no rotation)
    // park every lab that isn't the camp product or a potential feeder (1 intent each)
    for (const P of labs) {
      if (FIXED && (P.id === 0 || P.id === 1)) continue; // permanent feeder slots
      if (P.mineral === null || P.mineral === camp || (!FIXED && (P.mineral === a || P.mineral === b))) continue;
      if (P.mineral === target) { banked[target] = (banked[target] ?? 0) + P.amount; producedTarget += P.amount; }
      else terminal[P.mineral] = (terminal[P.mineral] ?? 0) + P.amount;
      P.mineral = null; P.amount = 0; tenderIntents++;
    }
    const need = LAB_REACTION_AMOUNT * (LAB_COUNT - 2);
    const loadInto = (lab: Lab, res: string): Lab | null => {
      if (lab.mineral !== null && lab.mineral !== res && lab.amount > 0) {
        terminal[lab.mineral] = (terminal[lab.mineral] ?? 0) + lab.amount; tenderIntents++; lab.amount = 0;
      }
      lab.mineral = res;
      if (lab.amount < need && (terminal[res] ?? 0) > 0) {
        const want = Math.min(need - lab.amount, terminal[res] ?? 0);
        terminal[res] -= want; lab.amount += want; tenderIntents += 2;
      }
      return lab.amount >= LAB_REACTION_AMOUNT ? lab : null;
    };
    const ensure = (res: string, exclude?: Lab): Lab | null => {
      let f = labs.find((l) => l !== exclude && l.mineral === res && l.amount >= LAB_REACTION_AMOUNT);
      if (!f) { f = labs.find((l) => l !== exclude && l.mineral === null); if (!f) return null; }
      return loadInto(f, res);
    };
    const fA = FIXED ? loadInto(labs[0], a) : ensure(a);
    const fB = FIXED ? loadInto(labs[1], b) : ensure(b, fA ?? undefined);
    if (!fA || !fB || fA === fB) return;
    // burst: fire camp on every off-cooldown free lab (not the 2 feeders)
    for (const P of labs) {
      if (P === fA || P === fB || P.cooldown > 0) continue;
      if (P.mineral !== null && P.mineral !== camp) continue;
      if (P.mineral === camp && P.amount + LAB_REACTION_AMOUNT > CAP) continue;
      if (fA.amount < LAB_REACTION_AMOUNT || fB.amount < LAB_REACTION_AMOUNT) break;
      if (fA.cooldown > 0 || fB.cooldown > 0) readsAcrossCooldown++;
      fA.amount -= LAB_REACTION_AMOUNT;
      fB.amount -= LAB_REACTION_AMOUNT;
      P.amount += LAB_REACTION_AMOUNT;
      P.mineral = camp;
      P.cooldown = REACTION_TIME[camp];
      reactionsRun++;
      deficit[camp] -= LAB_REACTION_AMOUNT;
    }
  };
  const stockOf = stockLabs;
  void stockOf; void tender; void tenderBusyTicks;

  // ---- conservation instrumentation ---------------------------------------
  const heldTotal = (c: string): number => {
    let v = terminal[c] ?? 0;
    for (const l of labs) if (l.mineral === c) v += l.amount;
    if (tender.carrying && tender.carrying.res === c) v += tender.carrying.amt;
    return v;
  };
  // only NON-base material is a conserved buffer; bases in holder labs are input
  // inventory in transit (infinite supply), so exclude them from the drift check.
  const labMaterial = (): number =>
    labs.reduce((s, l) => s + (l.mineral && !isBase(l.mineral) ? l.amount : 0), 0);

  // ---- main loop -----------------------------------------------------------
  const BASE_SUPPLY = 100000; // terminal base minerals = the INPUT (assumed supplied)
  let warmupBanked = 0;
  const snapInter: Record<string, number> = {};
  let snapLabMat = 0;
  const WARMUP = Math.min(8000, Math.floor(args.ticks / 4));
  const busyBy: Record<string, number> = {};

  void busyBy;
  for (let tick = 0; tick < args.ticks; tick++) {
    for (const base of BASES) terminal[base] = BIG;
    for (const l of labs) if (l.cooldown > 0) l.cooldown--;

    burstTick();
    for (const l of labs) if (l.cooldown > 0) busyLabTicks++;

    if (tick === WARMUP) {
      warmupBanked = producedTarget;
      snapLabMat = labMaterial();
      for (const c of tree) if (c !== target) snapInter[c] = heldTotal(c);
    }
  }

  // ---- report --------------------------------------------------------------
  const steadyTicks = args.ticks - WARMUP;
  const steadyProduced = producedTarget - warmupBanked;
  const ratePerK = (steadyProduced / steadyTicks) * 1000;

  let maxDrift = 0;
  let maxDriftC = "";
  const driftRows: Array<[string, number]> = [];
  for (const c of tree) {
    if (c === target) continue;
    const driftPerK = ((heldTotal(c) - (snapInter[c] ?? 0)) / steadyTicks) * 1000;
    driftRows.push([c, driftPerK]);
    if (Math.abs(driftPerK) > Math.abs(maxDrift)) { maxDrift = driftPerK; maxDriftC = c; }
  }
  const labDriftPerK = ((labMaterial() - snapLabMat) / steadyTicks) * 1000;
  const tol = Math.max(0.5, ratePerK * 0.02);
  const conserved = Math.abs(maxDrift) <= tol && Math.abs(labDriftPerK) <= tol;

  const intentsPerK = (tenderIntents / args.ticks) * 1000;

  console.log("");
  console.log(`Lab reaction-network sim  —  spec 31 layout (10 labs, 2 feeder spots, 1 tender)`);
  console.log(`  scheduler       : CAMPAIGN BURST (one reaction bursted across free labs; 2 JIT rotating feeders; unbounded tender)`);
  console.log(`  target compound : ${target}   (tree depth ${depthOf(target)}, bases ${bases.join(" ")})`);
  console.log(`  ticks           : ${args.ticks}  (steady window: last ${steadyTicks})`);
  console.log("");
  console.log(`  OUTPUT`);
  console.log(`    ${target} produced      : ${steadyProduced} over window  (${ratePerK.toFixed(1)} / 1000 ticks)`);
  console.log(`    reactions run        : ${reactionsRun}`);
  console.log(`    LAB UTILISATION      : ${((busyLabTicks / (LAB_COUNT * args.ticks)) * 100).toFixed(1)}%   (fraction of lab-ticks on cooldown; the ceiling question)`);
  console.log(`    reads across cooldown: ${readsAcrossCooldown}`);
  console.log(`    tender CPU           : ${intentsPerK.toFixed(0)} intents/1k = ${(intentsPerK * 0.2).toFixed(1)} CPU/1k ticks (0.2 CPU/intent), ${(producedTarget > 0 ? (tenderIntents * 0.2) / producedTarget : 0).toFixed(3)} CPU per ${target}`);
  console.log("");
  console.log(`  CONSERVATION  (sustainable <=> labs + intermediates return to start fill)`);
  console.log(`    lab material drift    : ${labDriftPerK.toFixed(2)} units / 1000 ticks`);
  console.log(`    worst intermediate    : ${maxDriftC || "-"}  ${maxDrift.toFixed(2)} units / 1000 ticks`);
  if (!args.quiet) {
    for (const [c, d] of driftRows) {
      const flag = Math.abs(d) > tol ? "  <-- DRAINING/PILING" : "";
      console.log(`      ${c.padEnd(6)} held ${String(Math.round(heldTotal(c))).padStart(5)}   drift ${d.toFixed(2)}/1k${flag}`);
    }
  }
  console.log("");
  const verdict = conserved
    ? `SUSTAINABLE — labs + intermediates hold steady (max drift ${maxDrift.toFixed(2)}/1k <= tol ${tol.toFixed(2)}); ` +
      `only bases in, ${target} out, at ${ratePerK.toFixed(1)}/1k ticks for ${(intentsPerK * 0.2).toFixed(1)} CPU/1k.`
    : `NOT SUSTAINABLE — ${maxDriftC || "lab fill"} drifts ${(Math.abs(maxDrift) > Math.abs(labDriftPerK) ? maxDrift : labDriftPerK).toFixed(2)}/1k ` +
      `(> tol ${tol.toFixed(2)}); a buffer is bleeding, the rate above is borrowed not earned.`;
  console.log(`  verdict: ${verdict}`);
  console.log("");
}

run(parseArgs(process.argv.slice(2)));
