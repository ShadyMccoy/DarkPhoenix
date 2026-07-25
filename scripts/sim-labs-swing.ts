/**
 * sim-labs-swing.ts — DEFICIT-DRIVEN SWING (time-multiplex). UNSTABLE EXPERIMENT.
 *
 * Tests the owner insight: a withdraw is fine if it keeps a lab THROUGHPUTTING
 * (idle is the enemy, not withdrawing). Time-multiplexing a lab across reactions
 * ("alternate feeds") gives fractional allocation ("any denomination over 1000")
 * and would bypass the integer-lab tax — pushing XLH2O from the static 230 toward
 * the fractional ceiling ~300/1k. Implementation: demand accrues at rate R per
 * reaction; each lab makes the most-OWED makeable reaction; the tender parks
 * over-served compounds to the terminal (the throughput-preserving withdraw) and
 * reloads them when their deficit returns.
 *
 * RESULT: the INSIGHT holds but this naive controller is UNSTABLE — it thrashes.
 * Deficit-greedy over-commits to the bottleneck (labs pile on XLH2O the moment its
 * input momentarily exists), the low tiers then starve, and parking evicts
 * feedstock that is still needed (measured: 0 net output, LH drift ~300/1k, tender
 * 245 intents/1k). Realising the fractional ceiling robustly is a real-time control
 * problem (needs per-reaction lab caps + hysteresis + park-only-when-truly-surplus)
 * that this quick version does not crack. The STATIC ∝-cooldown allocator
 * (sim-labs-flow.ts, 230/1k, stable, conserving) captures ~3/4 of the ceiling and
 * is the one to ship; closing the last ~30% is future control-theory work.
 * Kept as a reproducible record of the attempt and the failure mode.
 * ---------------------------------------------------------------------------
 * (was: sim-labs-emergent.ts — EMERGENT LOCAL-RULE, REACT-AWAY FLOW (spec 31).)
 *
 * The "boids, not a V-plan" version (owner idea): no central allocation. Static
 * base feeders + a fungible reactor pool where each reactor follows two LOCAL
 * rules per tick — (produce) keep making the compound I hold until its buffer is
 * full; (adopt) if I'm EMPTY, take the hungriest compound I can currently make
 * (hunger = how far below buffer; the tender-drained target stays hungriest). The
 * allocation and swing-to-bottleneck are meant to fall OUT of the rules. Switching
 * only when empty preserves react-away. Feeders are pre-filled to avoid a
 * cold-start clumping deadlock.
 *
 * RESULT — it WORKS and self-organises, but under-performs the hand-computed
 * static allocator (sim-labs-flow.ts):
 *   XLH2O 153.8/1k @ 0.006 CPU/unit, conserving, emerged {LH:1 OH:2 LH2O:1 XLH2O:2}
 *     — vs flow's 230.8/1k with {..XLH2O:3}. Util 31% vs 46%.
 *   The gap: plain stock-deficit hunger under-weights the high-cooldown bottleneck
 *   (equal stock deficit != equal lab need), and react-away STICKINESS leaves labs
 *   stuck on over-served fast tiers (OH grabbed 2). Weighting hunger by cooldown to
 *   fix it CLUMPS and deadlocks (every empty lab picks the same compound) — the
 *   classic emergent-tuning trap. So: elegant, robust, adaptive, near-zero CPU, and
 *   conserving — but a decent-not-optimal split; matching the static optimum needs
 *   finicky rule tuning. XGH2O/XGHO2 don't fit -> terminal-buffered sim-labs.ts.
 * Run:  npx ts-node -P tsconfig.test.json scripts/sim-labs-emergent.ts --target XLH2O
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

  // EMERGENT LOCAL-RULE FLOW (boids, not a V-plan). Static base feeders + a
  // fungible reactor pool. No central allocation: each reactor follows two local
  // rules per tick — (produce) keep making the compound I hold until its buffer
  // is full; (adopt) if I'm EMPTY, take the hungriest compound I can currently
  // make. The target is drained so it stays hungriest, so idle labs flow to the
  // bottleneck as they drain — the ∝-cooldown split and swing-to-bottleneck fall
  // OUT of the rules. Switching only when empty preserves react-away (no withdraw).
  const terminal: Record<string, number> = {};
  const banked: Record<string, number> = {};
  for (const base of BASES) terminal[base] = 0;
  // dst: where the carried load goes — a base feeder, an empty reactor (reloading
  // a parked intermediate), or the terminal (parking an over-served compound).
  const tender: { carrying: { res: string; amt: number; dst: "feeder" | "reactor" | "terminal" } | null } = { carrying: null };

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

  // --- feeders (static, forced) + a fungible reactor POOL --------------------
  // One lab per distinct base (tender-topped). The rest are reactors that follow
  // LOCAL RULES only — the ∝-cooldown split and swing-to-bottleneck EMERGE, they
  // are not assigned anywhere.
  const bases = [...new Set(tree.flatMap((c) => REACTIONS[c].filter(isBase)))];
  const reactorBudget = LAB_COUNT - bases.length;
  const fits = reactorBudget >= tree.length;
  const feederOf: Record<string, number> = {};
  const reactorIds: number[] = [];
  if (fits) {
    let idx = 0;
    for (const b of bases) { feederOf[b] = idx; labs[idx].mineral = b; labs[idx].amount = CAP; idx++; } // pre-filled: no cold-start feeder race
    for (; idx < LAB_COUNT; idx++) reactorIds.push(idx); // fungible reactors, start empty
  }

  const stockOf = (c: string): number => labs.reduce((s, l) => s + (l.mineral === c ? l.amount : 0), 0);
  const findSource = (r: string, ...excl: Lab[]): Lab | undefined => {
    if (isBase(r)) { const l = labs[feederOf[r]]; return l.amount >= LAB_REACTION_AMOUNT ? l : undefined; }
    for (const id of reactorIds) { const l = labs[id]; if (!excl.includes(l) && l.mineral === r && l.amount >= LAB_REACTION_AMOUNT) return l; }
    return undefined;
  };
  const fire = (P: Lab, c: string): boolean => {
    const [a, b] = REACTIONS[c];
    const la = findSource(a, P);
    if (!la) return false;
    const lb = findSource(b, P, la);
    if (!lb) return false;
    if (la.cooldown > 0 || lb.cooldown > 0) readsAcrossCooldown++;
    la.amount -= LAB_REACTION_AMOUNT; if (la.amount === 0 && !isBase(a)) la.mineral = null; // drained reactor frees to adopt
    lb.amount -= LAB_REACTION_AMOUNT; if (lb.amount === 0 && !isBase(b)) lb.mineral = null;
    P.amount += LAB_REACTION_AMOUNT;
    P.mineral = c;
    P.cooldown = REACTION_TIME[c];
    reactionsRun++;
    return true;
  };
  // hunger = how far a compound sits below its buffer. The target is drained by
  // the tender so it stays near-empty -> chronically hungry. An empty reactor
  // adopts the hungriest makeable compound, so idle labs flow to the bottleneck
  // as they drain. Switching only when EMPTY preserves react-away (no withdraw).
  // hunger = plain stock deficit (+ a nudge for the target). Cooldown-weighting was
  // tried and it CLUMPS (every empty lab picks the same highest-weight compound and
  // deadlocks) — the classic emergent-tuning trap. This plain rule self-organises a
  // decent (not optimal) split; see the header for the measured gap vs the static
  // allocator.
  // DEFICIT-DRIVEN SWING. Demand for every reaction accrues at the max sustainable
  // rate R (all reactor labs busy, split ∝ cooldown). A lab makes the reaction that
  // OWES the most (largest deficit) — the slow top compound accrues deficit fastest
  // so labs pile there, and the fast tiers get served in the fractional slices
  // between. A lab that finishes an over-served compound is PARKED to the terminal
  // (a withdraw that keeps the lab throughputting, not idle) and re-adopts; parked
  // intermediates are RELOADED when their deficit returns. Time-multiplexing this
  // way hits any fractional allocation and bypasses the integer-lab tax.
  const R = (LAB_REACTION_AMOUNT * reactorIds.length) / tree.reduce((s, c) => s + REACTION_TIME[c], 0);
  const deficit: Record<string, number> = {};
  for (const c of tree) deficit[c] = 0;

  const react = (): void => {
    for (const c of tree) deficit[c] += R; // demand accrues each tick
    // PRODUCE: held reactors that still owe deficit fire (low tiers first so fresh
    // output is readable by the next tier within the same tick).
    const held = reactorIds.map((i) => labs[i]).filter((l) => l.mineral !== null && l.cooldown === 0);
    held.sort((x, y) => depthOf(x.mineral!) - depthOf(y.mineral!));
    for (const P of held) {
      const c = P.mineral!;
      if (deficit[c] <= 0) continue; // over-served -> leave it for the tender to park
      if (c !== target && stockOf(c) >= BUFFER) continue;
      if (P.amount + LAB_REACTION_AMOUNT > CAP) continue;
      if (fire(P, c)) deficit[c] -= LAB_REACTION_AMOUNT;
    }
    // ADOPT: an empty reactor takes the MOST-OWED reaction it can currently make.
    for (const id of reactorIds) {
      const P = labs[id];
      if (P.mineral !== null || P.cooldown > 0) continue;
      let best: string | null = null;
      let bestD = 0;
      for (const c of tree) {
        if (deficit[c] <= 0) continue;
        if (c !== target && stockOf(c) >= BUFFER) continue;
        const la = findSource(REACTIONS[c][0], P);
        if (!la || !findSource(REACTIONS[c][1], P, la)) continue;
        if (deficit[c] > bestD) { bestD = deficit[c]; best = c; }
      }
      if (best && fire(P, best)) deficit[best] -= LAB_REACTION_AMOUNT;
    }
  };

  // --- tender: top feeders, drain target (react-away, 2-stroke) --------------
  const DRAIN_AT = 100;
  const TOPUP = CAP - 500; // refill a feeder once it drops below this
  const advanceTender = (): void => {
    let acted = false;
    if (tender.carrying) {
      const { res, amt, dst } = tender.carrying;
      if (dst === "feeder") {
        const d = labs[feederOf[res]];
        const put = Math.min(amt, CAP - d.amount);
        d.amount += put;
        if (amt - put > 0) terminal[res] = (terminal[res] ?? 0) + (amt - put);
      } else if (dst === "reactor") {
        const d = reactorIds.map((i) => labs[i]).find((l) => l.mineral === null);
        if (d) { d.mineral = res; d.amount += amt; } else terminal[res] = (terminal[res] ?? 0) + amt;
      } else {
        terminal[res] = (terminal[res] ?? 0) + amt; // park
      }
      tender.carrying = null;
      acted = true;
    } else {
      // 1. product out
      const tl = reactorIds.map((i) => labs[i]).find((l) => l.mineral === target && l.amount >= DRAIN_AT);
      if (tl) {
        const amt = Math.min(args.carry, tl.amount);
        tl.amount -= amt;
        if (tl.amount === 0) tl.mineral = null;
        banked[target] = (banked[target] ?? 0) + amt;
        producedTarget += amt;
        acted = true;
      }
      // 2. reload a parked intermediate an owed reaction needs
      if (!acted) {
        let reloadRes: string | null = null;
        for (const c of tree) {
          if (deficit[c] <= 0) continue;
          for (const r of REACTIONS[c]) {
            if (isBase(r) || findSource(r)) continue;
            if ((terminal[r] ?? 0) >= LAB_REACTION_AMOUNT) { reloadRes = r; break; }
          }
          if (reloadRes) break;
        }
        const emptyReactor = reactorIds.map((i) => labs[i]).some((l) => l.mineral === null);
        if (reloadRes && emptyReactor) {
          const avail = terminal[reloadRes] ?? 0;
          const amt = Math.min(args.carry, CAP, avail);
          if (amt > 0) { terminal[reloadRes] = avail - amt; tender.carrying = { res: reloadRes, amt, dst: "reactor" }; acted = true; }
        }
      }
      // 3. park an over-served held reactor (withdraw that keeps it throughputting)
      if (!acted) {
        const park = reactorIds
          .map((i) => labs[i])
          .find((l) => l.mineral !== null && l.mineral !== target && !isBase(l.mineral!) && l.cooldown === 0 && deficit[l.mineral!] <= 0 && l.amount > 0);
        if (park) {
          const amt = Math.min(args.carry, park.amount);
          park.amount -= amt;
          const res = park.mineral!;
          if (park.amount === 0) park.mineral = null;
          tender.carrying = { res, amt, dst: "terminal" };
          acted = true;
        }
      }
      // 4. top a base feeder
      if (!acted) {
        const fb = bases.map((b) => labs[feederOf[b]]).filter((l) => l.amount < TOPUP).sort((x, y) => x.amount - y.amount)[0];
        if (fb) {
          const res = fb.mineral!;
          const avail = terminal[res] ?? 0;
          const amt = Math.min(args.carry, CAP - fb.amount, avail);
          if (amt > 0) { terminal[res] = avail - amt; tender.carrying = { res, amt, dst: "feeder" }; acted = true; }
        }
      }
    }
    if (acted) { tenderBusyTicks++; tenderIntents++; }
  };

  if (!fits) {
    console.log("");
    console.log(`Lab reaction-network sim  —  EMERGENT local-rule react-away FLOW`);
    console.log(`  target ${target}: needs > ${reactorBudget} reactor labs alongside ${bases.length} base feeders. Does NOT fit in-lab (bases: ${bases.join(" ")}). Use sim-labs.ts.`);
    console.log("");
    return;
  }

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
  const emergentAlloc = tree.map((c) => `${c}:${reactorIds.filter((i) => labs[i].mineral === c).length}`).join(" ");
  console.log(`  scheduler       : DEFICIT-DRIVEN SWING (time-multiplex ∝ cooldown; park/reload withdraws keep labs busy)`);
  console.log(`  target compound : ${target}   (tree depth ${depthOf(target)})`);
  console.log(`  emerged (end)   : ${bases.length} feeders [${bases.join(" ")}] + reactors {${emergentAlloc}}  (snapshot — reactors reassign as they drain)`);
  console.log(`  ticks           : ${args.ticks}  (steady window: last ${steadyTicks}), carry ${args.carry}`);
  console.log(`  input assumption: base minerals ${[...BASES].join(" ")} supplied to terminal (the INPUT)`);
  console.log("");
  console.log(`  OUTPUT`);
  console.log(`    ${target} produced      : ${steadyProduced} over window  (${ratePerK.toFixed(1)} / 1000 ticks)`);
  console.log(`    reactions run        : ${reactionsRun}`);
  console.log(`    lab utilisation      : ${((busyLabTicks / (LAB_COUNT * args.ticks)) * 100).toFixed(1)}%  (lab-ticks reacting; idle labs = wasted throughput)`);
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
