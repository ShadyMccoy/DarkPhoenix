/**
 * sim-labs-phased.ts — PHASED IN-LAB scheduler EXPERIMENT for spec 31.
 *
 * This is the "leave intermediates in the labs, swap only the base holders"
 * alternative to the terminal-buffered scheduler in sim-labs.ts. Kept for a
 * reproducible comparison. RESULT: it conserves and it proves you do NOT need
 * all 7 bases held (it runs the whole XGH2O tree with just 3 base-holder labs,
 * swapped) — but it measured WORSE than the terminal-buffered sim-labs.ts:
 * ~62.5 XGH2O/1k @ ~0.73 CPU/unit vs ~128/1k @ ~0.29 CPU/unit. Two reasons:
 * one dedicated lab per compound leaves only 3 base holders that thrash on
 * swaps, and a single lab on the cd-80 top reaction caps throughput. The
 * terminal turns out to be a cheap, large shared buffer that beats tight in-lab
 * reservoir management here. Run:  npx ts-node -P tsconfig.test.json
 * scripts/sim-labs-phased.ts [--buffer 60] [--ticks 80000]
 *
 * NOT wired into the bot. Labs are unmodeled in src/ (no StructureLab, no
 * reaction economy) — this is an exploration tool that answers one question:
 *
 *   Does the "two feeder spots + 10 labs" layout (spec 31) SUSTAINABLY produce a
 *   top-tier compound, and at what CPU (tender-intent) cost?
 *
 * SCHEDULER — PHASED, IN-LAB (the low-CPU model):
 *   - One lab per tree compound is that compound's producer AND its in-lab buffer.
 *     Intermediates are read in place by the next tier — never round-tripped
 *     through the terminal.
 *   - A small pool of base-holder labs is REUSED: the tender swaps their contents
 *     as the active phase changes, so only the 2 bases the current reaction needs
 *     are held at once (not all seven). This is why the whole tree fits in 10 labs.
 *   - Only base minerals enter from the terminal; only the target leaves to it.
 *
 * Sustainable == CONSERVATION: over the steady window the labs and every
 * intermediate buffer must return to their starting fill, so the only net changes
 * are bases consumed (input) and the top compound produced (output). A drifting
 * intermediate means the rate is borrowed from a bleeding buffer, not earned.
 *
 * CPU: every tender withdraw/deposit is one intent = 0.2 CPU (GRAND_STRATEGY §1).
 * Holding intermediates in-lab and reusing a few base holders keeps intents low.
 *
 * EVERY game constant below is the standard Screeps value but is UNVERIFIED here
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
// Game constants (STANDARD SCREEPS VALUES — VERIFY vs @screeps/engine master)
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
  UH: 10, UO: 10, KH: 10, KO: 10, LH: 10, LO: 10, ZH: 10, ZO: 10, GH: 10, GO: 10,
  UH2O: 5, UHO2: 5, KH2O: 5, KHO2: 5, LH2O: 5, LHO2: 5, ZH2O: 5, ZHO2: 5, GH2O: 5, GHO2: 5,
  XUH2O: 60, XUHO2: 60, XKH2O: 60, XKHO2: 60, XLH2O: 65, XLHO2: 60,
  XZH2O: 40, XZHO2: 160, XGH2O: 80, XGHO2: 150,
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

  // one lab per tree compound (its producer AND in-lab buffer); the rest are the
  // reusable base-holder pool.
  const producerLab: Record<string, number> = {};
  tree.forEach((c, i) => { producerLab[c] = i; });
  const baseHolders: number[] = [];
  for (let i = tree.length; i < LAB_COUNT; i++) baseHolders.push(i);

  const terminal: Record<string, number> = {};
  const banked: Record<string, number> = {};
  for (const base of BASES) terminal[base] = 0;

  // dst tags where the carried load is headed: "holder" (loading a base into a
  // holder lab) or "terminal" (evicting an unneeded base to free a holder).
  const tender: { carrying: { res: string; amt: number; dst: "holder" | "terminal" } | null } = { carrying: null };

  // metrics
  let tenderBusyTicks = 0;
  let tenderIntents = 0; // one per withdraw/deposit = 0.2 CPU
  let reactionsRun = 0;
  let readsAcrossCooldown = 0;
  let producedTarget = 0;

  const BUFFER = args.buffer;
  const stockOf = (c: string): number =>
    labs.reduce((s, l) => s + (l.mineral === c ? l.amount : 0), 0);

  // a lab currently holding reactant r with enough to react
  const sourceFor = (r: string): Lab | undefined => {
    if (!isBase(r)) {
      const l = labs[producerLab[r]];
      return l.amount >= LAB_REACTION_AMOUNT ? l : undefined;
    }
    return baseHolders.map((i) => labs[i]).find((l) => l.mineral === r && l.amount >= LAB_REACTION_AMOUNT);
  };

  // descend from the target to the shallowest input still below its buffer —
  // that is what the phase should be making right now.
  const nextGoal = (): string => {
    const need = (c: string): string => {
      for (const r of REACTIONS[c]) {
        if (!isBase(r) && stockOf(r) < BUFFER) return need(r);
      }
      return c;
    };
    return need(target);
  };

  const missingBaseFor = (goal: string): string | null => {
    for (const r of REACTIONS[goal]) if (isBase(r) && !sourceFor(r)) return r;
    return null;
  };

  // choose a base-holder lab to load `res` into: one already holding res, else an
  // empty one, else one holding a base the current goal does NOT need (swap it).
  const pickHolderFor = (res: string, goal: string): Lab | undefined => {
    const needed = new Set(REACTIONS[goal].filter(isBase));
    const held = baseHolders.map((i) => labs[i]);
    return (
      held.find((l) => l.mineral === res) ??
      held.find((l) => l.amount === 0 || l.mineral === null) ??
      held.find((l) => l.mineral !== null && !needed.has(l.mineral))
    );
  };

  // ---- reactions: fire every producer whose inputs are present -------------
  const react = (): void => {
    for (const c of tree) {
      const P = labs[producerLab[c]];
      if (P.cooldown > 0) continue;
      if (c !== target && P.amount >= BUFFER) continue; // buffer full -> leave in lab
      if (P.amount + LAB_REACTION_AMOUNT > LAB_MINERAL_CAPACITY) continue;
      const [a, b] = REACTIONS[c];
      const la = sourceFor(a);
      const lb = sourceFor(b);
      if (!la || !lb || la.id === lb.id) continue;
      if (la.amount < LAB_REACTION_AMOUNT || lb.amount < LAB_REACTION_AMOUNT) continue;
      if (la.cooldown > 0 || lb.cooldown > 0) readsAcrossCooldown++;
      la.amount -= LAB_REACTION_AMOUNT;
      lb.amount -= LAB_REACTION_AMOUNT;
      P.amount += LAB_REACTION_AMOUNT;
      P.mineral = c;
      P.cooldown = REACTION_TIME[c];
      reactionsRun++;
    }
  };

  // ---- tender: one stroke (withdraw OR deposit) per tick -------------------
  const advanceTender = (): void => {
    const goal = nextGoal();
    let acted = false;

    if (tender.carrying) {
      // deposit stroke
      const { res, amt, dst } = tender.carrying;
      const dest = dst === "holder" ? pickHolderFor(res, goal) : undefined;
      if (dst === "holder" && dest && (dest.mineral === null || dest.mineral === res || dest.amount === 0)) {
        const space = LAB_MINERAL_CAPACITY - dest.amount;
        const put = Math.min(amt, space);
        dest.mineral = res;
        dest.amount += put;
        if (amt - put > 0) terminal[res] = (terminal[res] ?? 0) + (amt - put);
      } else {
        terminal[res] = (terminal[res] ?? 0) + amt; // evicted, or no holder — return to terminal
      }
      tender.carrying = null;
      acted = true;
    } else {
      // withdraw stroke: drain the finished target, else fetch a missing base
      const targetLab = labs[producerLab[target]];
      if (targetLab.amount >= BUFFER) {
        const amt = Math.min(args.carry, targetLab.amount);
        targetLab.amount -= amt;
        if (targetLab.amount === 0) targetLab.mineral = null;
        banked[target] = (banked[target] ?? 0) + amt;
        producedTarget += amt;
        acted = true;
      } else {
        const need = missingBaseFor(goal);
        if (need) {
          const dest = pickHolderFor(need, goal);
          if (dest && dest.mineral !== null && dest.mineral !== need && dest.amount > 0) {
            // holder occupied by an unneeded base — drain it first (swap)
            const amt = Math.min(args.carry, dest.amount);
            dest.amount -= amt;
            const old = dest.mineral;
            if (dest.amount === 0) dest.mineral = null;
            tender.carrying = { res: old, amt, dst: "terminal" };
            acted = true;
          } else {
            const avail = terminal[need] ?? 0;
            const amt = Math.min(args.carry, LAB_MINERAL_CAPACITY, avail);
            if (amt > 0) {
              terminal[need] = avail - amt;
              tender.carrying = { res: need, amt, dst: "holder" };
              acted = true;
            }
          }
        }
      }
    }
    if (acted) { tenderBusyTicks++; tenderIntents++; }
  };

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

  for (let tick = 0; tick < args.ticks; tick++) {
    for (const base of BASES) if (terminal[base] < BASE_SUPPLY) terminal[base] = BASE_SUPPLY;
    for (const l of labs) if (l.cooldown > 0) l.cooldown--;

    react();
    advanceTender();

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
  console.log(`  scheduler       : PHASED IN-LAB (intermediates held & read in place; base holders reused)`);
  console.log(`  target compound : ${target}   (tree depth ${depthOf(target)}, ${tree.length} producer labs, ${baseHolders.length} base-holder labs)`);
  console.log(`  ticks           : ${args.ticks}  (steady window: last ${steadyTicks}),  in-lab buffer ${BUFFER}, carry ${args.carry}`);
  console.log(`  input assumption: base minerals ${[...BASES].join(" ")} supplied to terminal (the INPUT)`);
  console.log("");
  console.log(`  OUTPUT`);
  console.log(`    ${target} produced      : ${steadyProduced} over window  (${ratePerK.toFixed(1)} / 1000 ticks)`);
  console.log(`    reactions run        : ${reactionsRun}`);
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
