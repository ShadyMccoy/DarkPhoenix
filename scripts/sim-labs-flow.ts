/**
 * sim-labs-flow.ts — STATIC ∝-COOLDOWN ALLOCATION, REACT-AWAY FLOW (spec 31).
 *
 * The "keep every lab always reacting" implementation. Each lab has ONE permanent
 * job — a base FEEDER (topped by the tender) or a REACTOR for one reaction —
 * split so reactor labs go to the tree's reactions IN PROPORTION TO COOLDOWN
 * (greedy: the reaction with the worst cd/labs ratio gets the next lab). The slow
 * top reaction therefore gets the MOST labs and stays the busy bottleneck.
 * Reactors read reactants in place (bases from feeders, intermediates from
 * upstream reactors) and fire every cooldown; a per-intermediate BUFFER cap idles
 * the over-served fast tiers so they don't overproduce (conservation). The tender
 * only tops feeders and drains the target — never withdraws a compound (react-away).
 *
 * RESULT (vs the fungible sim-labs-mix.ts one-lab-per-compound scheduler):
 *   XLH2O 230.8/1k (2.7x the fungible 85.6) @ 0.006 CPU/unit, conserving.
 *   XUHO2 253.8/1k (2.75x) @ 0.006. XZHO2 92.3/1k (cd-160 limited) @ 0.007.
 *   Lab utilisation 17% -> ~46%. The residual gap is the INTEGER-LAB TAX: fast
 *   low-tier reactions need a fraction of a lab but must take a whole one, so ~2
 *   labs of capacity idle that can't join the top without switching (a withdraw
 *   react-away forbids). Closing it needs swing-labs — a future refinement.
 *   XGH2O/XGHO2: reactors + feeders > 10 -> reports "does not fit"; use the
 *   terminal-buffered sim-labs.ts (~0.29 CPU/unit) for the Ghodium line.
 * Run:  npx ts-node -P tsconfig.test.json scripts/sim-labs-flow.ts --target XLH2O
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

  // --- allocation: base feeders + reactor labs (∝ cooldown) -----------------
  const bases = [...new Set(tree.flatMap((c) => REACTIONS[c].filter(isBase)))];
  const reactorBudget = LAB_COUNT - bases.length;
  const fits = reactorBudget >= tree.length;
  const labsFor: Record<string, number> = {};
  const feederOf: Record<string, number> = {};
  const reactorsOf: Record<string, number[]> = {};
  if (fits) {
    for (const c of tree) labsFor[c] = 1;
    let used = tree.length;
    while (used < reactorBudget) {
      let worst = tree[0];
      for (const c of tree) if (REACTION_TIME[c] / labsFor[c] > REACTION_TIME[worst] / labsFor[worst]) worst = c;
      labsFor[worst]++;
      used++;
    }
    let idx = 0;
    for (const b of bases) { feederOf[b] = idx; labs[idx].mineral = b; idx++; }
    for (const c of tree) {
      reactorsOf[c] = [];
      for (let k = 0; k < labsFor[c]; k++) { labs[idx].mineral = c; reactorsOf[c].push(idx); idx++; }
    }
  }

  const sourceLab = (r: string, exclude?: Lab): Lab | undefined => {
    if (isBase(r)) { const l = labs[feederOf[r]]; return l.amount >= LAB_REACTION_AMOUNT ? l : undefined; }
    for (const id of reactorsOf[r]) { const l = labs[id]; if (l !== exclude && l.amount >= LAB_REACTION_AMOUNT) return l; }
    return undefined;
  };

  // --- reactions: every reactor fires the moment it cools & its inputs exist -
  const react = (): void => {
    for (const c of tree) {                 // bottom-up: upstream made before it is read
      if (c !== target && stockOf(c) >= BUFFER) continue; // capped -> idle to conserve
      const [a, b] = REACTIONS[c];
      for (const id of reactorsOf[c]) {
        const P = labs[id];
        if (P.cooldown > 0 || P.amount + LAB_REACTION_AMOUNT > CAP) continue;
        const la = sourceLab(a);
        const lb = sourceLab(b, la);
        if (!la || !lb) continue;
        if (la.cooldown > 0 || lb.cooldown > 0) readsAcrossCooldown++;
        la.amount -= LAB_REACTION_AMOUNT;
        lb.amount -= LAB_REACTION_AMOUNT;
        P.amount += LAB_REACTION_AMOUNT;
        P.cooldown = REACTION_TIME[c];
        reactionsRun++;
      }
    }
  };

  // --- tender: top feeders, drain target (react-away, 2-stroke) --------------
  const DRAIN_AT = 100;
  const TOPUP = CAP - 500; // refill a feeder once it drops below this
  const advanceTender = (): void => {
    let acted = false;
    if (tender.carrying) {
      const { res, amt } = tender.carrying;
      const dest = labs[feederOf[res]];
      const put = Math.min(amt, CAP - dest.amount);
      dest.amount += put;
      if (amt - put > 0) terminal[res] = (terminal[res] ?? 0) + (amt - put);
      tender.carrying = null;
      acted = true;
    } else {
      const tl = reactorsOf[target].map((i) => labs[i]).find((l) => l.amount >= DRAIN_AT);
      if (tl) {
        const amt = Math.min(args.carry, tl.amount);
        tl.amount -= amt;
        banked[target] = (banked[target] ?? 0) + amt;
        producedTarget += amt;
        acted = true;
      } else {
        const fb = bases.map((b) => labs[feederOf[b]]).filter((l) => l.amount < TOPUP).sort((x, y) => x.amount - y.amount)[0];
        if (fb) {
          const res = fb.mineral!;
          const avail = terminal[res] ?? 0;
          const amt = Math.min(args.carry, CAP - fb.amount, avail);
          if (amt > 0) { terminal[res] = avail - amt; tender.carrying = { res, amt }; acted = true; }
        }
      }
    }
    if (acted) { tenderBusyTicks++; tenderIntents++; }
  };

  if (!fits) {
    console.log("");
    console.log(`Lab reaction-network sim  —  STATIC ∝-cooldown react-away FLOW`);
    console.log(`  target ${target}: ${tree.length} reactor labs + ${bases.length} base feeders = ${tree.length + bases.length} > ${LAB_COUNT}.`);
    console.log(`  Does NOT fit in-lab (bases: ${bases.join(" ")}). Use the terminal-buffered scheduler (sim-labs.ts) for this tree.`);
    console.log("");
    return;
  }
  const stockOf = (c: string): number => labs.reduce((s, l) => s + (l.mineral === c ? l.amount : 0), 0);
  void stockOf;

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

  for (let tick = 0; tick < args.ticks; tick++) {
    for (const base of BASES) if (terminal[base] < BASE_SUPPLY) terminal[base] = BASE_SUPPLY;
    for (const l of labs) if (l.cooldown > 0) l.cooldown--;

    react();
    advanceTender();
    for (const l of labs) if (l.cooldown > 0) busyLabTicks++;
    for (const c of tree) for (const id of reactorsOf[c]) if (labs[id].cooldown > 0) busyBy[c] = (busyBy[c] ?? 0) + 1;

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
  console.log(`  scheduler       : STATIC ∝-COOLDOWN ALLOCATION, REACT-AWAY FLOW (every reactor lab always reacting)`);
  console.log(`  target compound : ${target}   (tree depth ${depthOf(target)})`);
  console.log(`  allocation      : ${bases.length} feeders [${bases.join(" ")}] + reactors {${tree.map((c) => `${c}:${labsFor[c]}`).join(" ")}}`);
  console.log(`  ticks           : ${args.ticks}  (steady window: last ${steadyTicks}), carry ${args.carry}`);
  console.log(`  input assumption: base minerals ${[...BASES].join(" ")} supplied to terminal (the INPUT)`);
  console.log("");
  console.log(`  OUTPUT`);
  console.log(`    ${target} produced      : ${steadyProduced} over window  (${ratePerK.toFixed(1)} / 1000 ticks)`);
  console.log(`    reactions run        : ${reactionsRun}`);
  console.log(`    lab utilisation      : ${((busyLabTicks / (LAB_COUNT * args.ticks)) * 100).toFixed(1)}%  (lab-ticks reacting; idle labs = wasted throughput)`);
  console.log(`    per-step activity (cd, labs, % of their ticks actually reacting):`);
  console.log(`      ${bases.length} feeders [${bases.join(" ")}]  @ 0%  — hold a base to be READ; cannot react (react-away overhead)`);
  for (const c of tree) {
    const pct = ((busyBy[c] ?? 0) / (labsFor[c] * args.ticks)) * 100;
    console.log(`      ${c.padEnd(6)} cd${String(REACTION_TIME[c]).padStart(3)}  ${labsFor[c]} lab   @ ${pct.toFixed(0)}%${pct < 60 ? "  <-- idle slack (fast tier over-served)" : ""}`);
  }
  console.log(`    reads across cooldown: ${readsAcrossCooldown}  (source lab itself cooling — the spec-31 exploit)`);
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
