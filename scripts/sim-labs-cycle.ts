/**
 * sim-labs-cycle.ts — FULL-UTIL CYCLE, owner's OH-engine design (spec 31).
 *
 * The owner's cycle, implemented literally:
 *   "Make OH continuously. The feeder labs also react higher compounds that come
 *    back off the OH. OH accumulates in all the labs — clean them out after a while."
 *
 * Mechanism it exploits: a lab that JUST produced OH is on cooldown but its OH is
 * still READABLE. So an OH-holding, cooling lab doubles as the OH *source* for the
 * next tier (LH2O = LH + OH), while a couple of free labs make the tier up. There
 * are no permanent idle feeders for the shared reactant OH — it comes from the pool
 * of cooling OH producers. Only the true bases (H O L X) sit in holder labs.
 *
 * The controller (feedback, not a fixed schedule):
 *   - Every free off-cooldown lab defaults to firing OH  (keep-all-busy engine).
 *   - OH stock rides a band [LO, HI]. Above HI -> stop making OH, spend the pool
 *     on the higher compounds (cleanout); below LO -> back to the OH engine.
 *   - The tier ladder (LH -> LH2O -> X{target}) is fired greedily whenever its two
 *     reactant labs exist, reading cooling producers as sources.
 *
 * Measures the SAME things as sim-labs-burst.ts so the two are comparable:
 *   LAB UTILISATION (fraction of lab-ticks on cooldown — the ceiling question),
 *   throughput /1k, tender CPU, and CONSERVATION drift.
 *
 * RESULT — MEASURED NEGATIVE RESULT (kept as evidence, not a recommendation).
 * The literal "continuous OH engine" LOSES badly to the single-camp burst:
 *   XLH2O  cycle  24.5/1k  @ 18% util  (and NOT sustainable: OH piles +92/1k)
 *   XLH2O  burst 421.0/1k  @ 84% util  (sustainable)
 *   XGH2O  cycle   0.0/1k  @  3% util  (deadlocks — G's sub-tree base holders eat
 *                                       the labs)   vs  burst 337.8/1k @ 88%.
 * WHY it loses: OH is only ONE of the target's four reactants (LH, OH, LH2O,
 * X-boost). Flooding the pool with a continuous OH engine spends lab-ticks on the
 * one reactant that is already cheapest to keep ahead, piling parked OH the tiers
 * can't drain fast enough, while LH / LH2O / the X-boost STARVE for free labs. And
 * react-away pins every lab to its compound, so without parking pinned labs every
 * tick it freezes outright (measured 3x: --multi, greedy tiers, buffered tiers).
 * The fix that makes it *run* (park pinned labs to the terminal) is exactly the
 * burst's unbounded tender — so a working "keep-all-busy" cycle CONVERGES to the
 * burst; there is no cheaper high-util regime hiding here.
 *
 * TAKEAWAY: the owner's cycle DONE RIGHT is the burst — pick the most-owed reaction
 * and burst THAT one across the free labs, rotating which reaction each tick, so the
 * whole tree time-multiplexes through the lab pool. "8 labs all make OH" is just the
 * camp=OH tick of that same burst; the higher compounds "coming back" is the camp
 * rotating up the tree. Keep sim-labs-burst.ts; this file documents the road not
 * taken.
 *
 * Run: npx ts-node -P tsconfig.test.json scripts/sim-labs-cycle.ts [--target XLH2O]
 *                                                                   [--hi 400] [--lo 120]
 *                                                                   [--ticks 80000] [--quiet]
 *
 * NOT wired into the bot (labs are unmodeled in src/). Constants are standard
 * Screeps values, UNVERIFIED here (@screeps/engine not vendored).
 */

/* eslint-disable no-console */

const LAB_MINERAL_CAPACITY = 3000;
const LAB_REACTION_AMOUNT = 5;

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

const LAB_COUNT = 10;

interface Lab {
  id: number;
  mineral: string | null;
  amount: number;
  cooldown: number;
}

function treeCompounds(target: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (c: string) => {
    if (isBase(c) || seen.has(c)) return;
    seen.add(c);
    const [a, b] = REACTIONS[c];
    visit(a);
    visit(b);
    order.push(c);
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

interface Args {
  target: string;
  ticks: number;
  hi: number;
  lo: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const target = get("--target", "XLH2O");
  if (!REACTIONS[target]) {
    console.error(`Unknown target "${target}". Try XLH2O, XUH2O, XGH2O, ...`);
    process.exit(1);
  }
  return {
    target,
    ticks: parseInt(get("--ticks", "80000"), 10),
    hi: parseInt(get("--hi", "400"), 10),
    lo: parseInt(get("--lo", "120"), 10),
    quiet: argv.includes("--quiet"),
  };
}

function run(args: Args): void {
  const { target } = args;
  const tree = treeCompounds(target); // reactants-before-product; target last
  if (tree.length > LAB_COUNT) {
    console.error(`${target} needs ${tree.length} producer labs > ${LAB_COUNT}; pick a shallower target.`);
    process.exit(1);
  }
  // The shared reactant that the whole tree pivots on. Every tier-2 compound reads
  // OH, so OH is the engine. (If the target's tree has no OH, fall back to the
  // deepest single reactant — but all Xz2O/Xz-boost trees use OH.)
  const ENGINE = tree.includes("OH") ? "OH" : tree[0];

  const labs: Lab[] = Array.from({ length: LAB_COUNT }, (_, id) => ({
    id, mineral: null, amount: 0, cooldown: 0,
  }));

  const bases = [...new Set(tree.flatMap((c) => REACTIONS[c].filter(isBase)))];
  const BIG = 1e9;
  const terminal: Record<string, number> = {};
  for (const base of BASES) terminal[base] = BIG; // bases: unlimited supply (the INPUT)
  const banked: Record<string, number> = {};

  let tenderIntents = 0;
  let reactionsRun = 0;
  let readsAcrossCooldown = 0;
  let producedTarget = 0;
  let busyLabTicks = 0;
  const CAP = LAB_MINERAL_CAPACITY;

  const stockLabs = (c: string): number =>
    labs.reduce((s, l) => (l.mineral === c ? s + l.amount : s), 0);

  // a source usable as a reactant right now: any lab holding >=5 of it (INCLUDING
  // labs on cooldown — the owner's whole point). Bases also come from the terminal
  // via a holder lab, so ensure a base holder exists on demand.
  const findSource = (res: string, exclude: Set<Lab>): Lab | null => {
    let best: Lab | null = null;
    for (const l of labs) {
      if (exclude.has(l)) continue;
      if (l.mineral === res && l.amount >= LAB_REACTION_AMOUNT) {
        // prefer a cooling holder (frees clean labs for producing)
        if (!best || l.cooldown > best.cooldown) best = l;
      }
    }
    if (best) return best;
    // no in-lab holder — dedicate an empty lab and fill it from the terminal. For a
    // base that's the permanent holder (CAP). For a compound it's a reload of parked
    // stock (the cleaned-out pool coming back as a source — the return leg).
    const empty = labs.find((l) => !exclude.has(l) && l.mineral === null);
    if (empty && (terminal[res] ?? 0) >= LAB_REACTION_AMOUNT) {
      const want = isBase(res) ? CAP : Math.min(CAP, terminal[res] ?? 0);
      empty.mineral = res;
      empty.amount = want;
      terminal[res] -= want;
      tenderIntents += 2; // withdraw + deposit
      return empty;
    }
    return null;
  };

  // fire reaction `c` in producer P, reading two source labs. Returns true on fire.
  const fire = (c: string, P: Lab): boolean => {
    if (P.cooldown > 0) return false;
    if (P.mineral !== null && P.mineral !== c) return false;
    if (P.mineral === c && P.amount + LAB_REACTION_AMOUNT > CAP) return false;
    const [a, b] = REACTIONS[c];
    const excl = new Set<Lab>([P]);
    const sA = findSource(a, excl);
    if (!sA) return false;
    excl.add(sA);
    const sB = findSource(b, excl);
    if (!sB) return false;
    if (sA.cooldown > 0 || sB.cooldown > 0) readsAcrossCooldown++;
    sA.amount -= LAB_REACTION_AMOUNT;
    sB.amount -= LAB_REACTION_AMOUNT;
    P.mineral = c;
    P.amount += LAB_REACTION_AMOUNT;
    P.cooldown = REACTION_TIME[c];
    reactionsRun++;
    return true;
  };

  // the higher tiers, deepest-first (target, then its reactant compound, ... , LH).
  // OH (the engine) is handled separately by the band controller.
  const tiers = tree.filter((c) => c !== ENGINE).reverse(); // target ... down to leaves

  const cycleTick = (): void => {
    // 1. bank finished target off its labs (react-away discipline: only the top
    //    product is ever withdrawn)
    for (const P of labs) {
      if (P.mineral === target && P.amount > 0) {
        banked[target] = (banked[target] ?? 0) + P.amount;
        producedTarget += P.amount;
        terminal[target] = (terminal[target] ?? 0) + P.amount;
        P.mineral = null; P.amount = 0;
        tenderIntents++;
      }
    }

    // free any lab whose holding has been read down to nothing (an ex-source that
    // did its job) so it can be repurposed — this is what lets a cooling OH lab,
    // once its OH is spent by the tiers, come back as a fresh producer. Base
    // holders (kept topped for reading) are exempt.
    for (const P of labs) {
      if (P.amount <= 0 && P.mineral !== null && !isBase(P.mineral)) {
        P.mineral = null; P.amount = 0;
      }
    }

    const ohStock = stockLabs(ENGINE);
    const cleanout = ohStock >= args.hi; // above the high-water mark: spend the pool

    // CLEAN-OUT (owner: "we clean them out after some time"): the OH pool has piled
    // above HI, so its cooling holders are clogging labs that could be producing.
    // Drain the most-stocked idle OH labs to the terminal, freeing them, until the
    // pool is back to LO. This is the only tender withdraw of a compound — the
    // periodic sweep, not per-reaction.
    if (cleanout) {
      let pool = ohStock;
      const holders = labs
        .filter((l) => l.mineral === ENGINE)
        .sort((x, y) => y.amount - x.amount);
      for (const P of holders) {
        if (pool <= args.lo) break;
        const drainable = Math.min(P.amount, pool - args.lo);
        terminal[ENGINE] = (terminal[ENGINE] ?? 0) + drainable;
        P.amount -= drainable; pool -= drainable;
        tenderIntents++;
        if (P.amount <= 0) { P.mineral = null; P.amount = 0; }
      }
    }

    // 2. Higher tiers, deepest-first. A tier fires ONLY while its own stock is below
    //    a small buffer — otherwise a cheap fast reaction (LH, cd10) would grab every
    //    free lab and re-fire itself forever, starving the OH engine (measured: the
    //    "all-LH" deadlock). The target has no cap (it's the drain). This buffer-gate
    //    is what leaves the bulk of the labs for OH.
    const TIER_BUFFER = 40; // ~8 reactions of head-room per intermediate
    for (const P of labs) {
      if (P.cooldown > 0) continue;
      if (!(P.mineral === null || tiers.includes(P.mineral!))) continue;
      for (const c of tiers) {
        if (c !== target && stockLabs(c) >= TIER_BUFFER) continue;
        if (fire(c, P)) break;
      }
    }

    // 3. The OH engine — keep every remaining free lab busy making OH, unless we're
    //    in cleanout (OH pool already above HI). Below LO we force the engine even
    //    if a tier could have run, to never starve the shared reactant.
    if (!cleanout) {
      for (const P of labs) {
        if (P.cooldown > 0) continue;
        if (!(P.mineral === null || P.mineral === ENGINE)) continue;
        if (P.mineral === ENGINE && P.amount + LAB_REACTION_AMOUNT > CAP) continue;
        fire(ENGINE, P);
      }
    }

    // 4. PARK the pinned. Any lab that is off-cooldown but still holds a non-target,
    //    non-engine compound it could not productively re-fire this tick is dead
    //    weight (react-away's trap). Drain it to the terminal so it is free next
    //    tick; the stock returns as a source via findSource when a tier needs it.
    //    This is the owner's "clean them out" made continuous — and it is the ONLY
    //    thing that keeps labs from freezing. Its cost is tender intents (the CPU
    //    the burst also pays).
    for (const P of labs) {
      if (P.cooldown > 0) continue;
      if (P.mineral === null || isBase(P.mineral) || P.mineral === ENGINE || P.mineral === target) continue;
      terminal[P.mineral] = (terminal[P.mineral] ?? 0) + P.amount;
      P.mineral = null; P.amount = 0;
      tenderIntents++;
    }
  };

  // conservation instrumentation (non-base material only)
  const heldTotal = (c: string): number => {
    let v = terminal[c] ?? 0;
    for (const l of labs) if (l.mineral === c) v += l.amount;
    return v;
  };
  const labMaterial = (): number =>
    labs.reduce((s, l) => s + (l.mineral && !isBase(l.mineral) ? l.amount : 0), 0);

  let warmupBanked = 0;
  const snapInter: Record<string, number> = {};
  let snapLabMat = 0;
  const WARMUP = Math.min(8000, Math.floor(args.ticks / 4));

  for (let tick = 0; tick < args.ticks; tick++) {
    for (const base of BASES) terminal[base] = BIG;
    for (const l of labs) if (l.cooldown > 0) l.cooldown--;

    cycleTick();
    for (const l of labs) if (l.cooldown > 0) busyLabTicks++;

    if (tick === WARMUP) {
      warmupBanked = producedTarget;
      snapLabMat = labMaterial();
      for (const c of tree) if (c !== target) snapInter[c] = heldTotal(c);
    }
  }

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
  console.log(`  scheduler       : FULL-UTIL CYCLE (continuous ${ENGINE} engine + banded cleanout; tiers read cooling producers)`);
  console.log(`  target compound : ${target}   (tree depth ${depthOf(target)}, bases ${bases.join(" ")})`);
  console.log(`  engine / band   : ${ENGINE}  clean-out above ${args.hi}, refill below ${args.lo}`);
  console.log(`  ticks           : ${args.ticks}  (steady window: last ${steadyTicks})`);
  console.log("");
  console.log(`  OUTPUT`);
  console.log(`    ${target} produced      : ${steadyProduced} over window  (${ratePerK.toFixed(1)} / 1000 ticks)`);
  console.log(`    reactions run        : ${reactionsRun}`);
  console.log(`    LAB UTILISATION      : ${((busyLabTicks / (LAB_COUNT * args.ticks)) * 100).toFixed(1)}%   (fraction of lab-ticks on cooldown; the ceiling question)`);
  console.log(`    reads across cooldown: ${readsAcrossCooldown}  (tier reactions reading a still-cooling producer — the owner's lever)`);
  console.log(`    tender CPU           : ${intentsPerK.toFixed(0)} intents/1k = ${(intentsPerK * 0.2).toFixed(1)} CPU/1k ticks, ${(producedTarget > 0 ? (tenderIntents * 0.2) / producedTarget : 0).toFixed(3)} CPU per ${target}`);
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
      `only bases in, ${target} out, at ${ratePerK.toFixed(1)}/1k for ${(intentsPerK * 0.2).toFixed(1)} CPU/1k.`
    : `NOT SUSTAINABLE — ${maxDriftC || "lab fill"} drifts ${(Math.abs(maxDrift) > Math.abs(labDriftPerK) ? maxDrift : labDriftPerK).toFixed(2)}/1k ` +
      `(> tol ${tol.toFixed(2)}); a buffer is bleeding, the rate above is borrowed not earned.`;
  console.log(`  verdict: ${verdict}`);
  console.log("");
}

run(parseArgs(process.argv.slice(2)));
