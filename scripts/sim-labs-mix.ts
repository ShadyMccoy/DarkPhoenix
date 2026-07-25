/**
 * sim-labs-mix.ts — FUNGIBLE BOTTOM-UP scheduler EXPERIMENT for spec 31.
 *
 * Any lab may fire any GOAL-TREE reaction whose two reactants sit in other labs
 * (read in place, bottom-up); the tender keeps a stable mix of bases loaded and
 * drains the target. This is the "any mix of reactions, still toward the goal"
 * design. Kept for a reproducible comparison against the terminal-buffered
 * sim-labs.ts and the phased sim-labs-phased.ts.
 *
 * REACT-AWAY DISCIPLINE (owner): the tender only DEPOSITS bases and WITHDRAWS the
 * final product — it never withdraws a compound to empty/re-task a lab. Labs free
 * themselves by having their contents reacted forward. Base holders are not
 * evicted; a base load is capped (BASE_LOAD) so it depletes and the lab frees.
 *
 * RESULT — this WINS wherever the labs have slack:
 *   depth<=3 targets (most boosts: XLH2O build, XUHO2/XZHO2 combat, ...):
 *     ~0.012-0.015 CPU per unit, tender ~1-15 intents/1k (essentially idle),
 *     conserves. That is an ORDER OF MAGNITUDE cheaper than terminal-buffering
 *     (~0.16-0.29 CPU/unit in sim-labs.ts).
 *   depth-5 Ghodium line (XGH2O/XGHO2): DEADLOCKS. That tree needs 7 compound
 *     labs + 7 bases = the full 10 with zero slack, so no lab is ever free for
 *     the top compound to react INTO. Only there is the terminal (300k, any mix)
 *     required — it rents the buffer capacity the labs physically lack.
 * So: react-away in-lab flow is the right design for the common shallow boosts;
 * the terminal only earns its keep for the deepest (Ghodium) tree.
 * Run:  npx ts-node -P tsconfig.test.json scripts/sim-labs-mix.ts --target XLH2O [--buffer 40]
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

  // FUNGIBLE labs — no fixed producer/holder assignment. Any lab may fire any
  // reaction whose two reactants sit in other labs (read in place); the tender
  // keeps a stable MIX of bases loaded (bottom-up) and drains the target.
  const terminal: Record<string, number> = {};
  const banked: Record<string, number> = {};
  for (const base of BASES) terminal[base] = 0;

  const tender: { carrying: { res: string; amt: number; dst: "holder" | "terminal" } | null } = { carrying: null };

  // metrics
  let tenderBusyTicks = 0;
  let tenderIntents = 0; // one per withdraw/deposit = 0.2 CPU
  let reactionsRun = 0;
  let readsAcrossCooldown = 0;
  let producedTarget = 0;
  let busyLabTicks = 0; // lab-ticks spent locked on a reaction (throughput proxy)

  const CAP = LAB_MINERAL_CAPACITY;
  const BUFFER = args.buffer;
  // react-away discipline: cap a base load so the holder lab depletes (via
  // reactions) in bounded time and frees itself, instead of a fat charge that
  // ties a lab up for tens of thousands of ticks.
  const BASE_LOAD = Math.max(200, BUFFER * 3);
  const stockOf = (c: string): number =>
    labs.reduce((s, l) => s + (l.mineral === c ? l.amount : 0), 0);
  const holderOf = (r: string, not?: Lab): Lab | undefined =>
    labs.find((l) => l !== not && l.mineral === r && l.amount >= LAB_REACTION_AMOUNT);
  const wantMore = (c: string): boolean => c === target || stockOf(c) < BUFFER;
  // is base b still consumed by some under-buffer reaction? (don't evict if so)
  const baseNeeded = (b: string): boolean =>
    tree.some((c) => wantMore(c) && REACTIONS[c].includes(b));

  // ---- reactions: bottom-up, fire any ready reaction on any fungible lab ----
  const react = (): void => {
    for (const c of tree) {                 // reactants-before-product => bottom-up
      const [a, b] = REACTIONS[c];
      for (;;) {                            // fire as many as producers + feedstock allow
        if (!wantMore(c)) break;
        const la = holderOf(a);
        const lb = holderOf(b, la);
        if (!la || !lb) break;
        // accumulate in a lab already holding c; only claim a fresh empty lab if
        // NO lab holds c yet (else one compound smears across every lab -> clog).
        const P =
          labs.find((l) => l !== la && l !== lb && l.cooldown === 0 && l.mineral === c && l.amount + LAB_REACTION_AMOUNT <= CAP) ??
          (labs.some((l) => l.mineral === c)
            ? undefined
            : labs.find((l) => l !== la && l !== lb && l.cooldown === 0 && l.mineral === null));
        if (!P) break;
        if (la.cooldown > 0 || lb.cooldown > 0) readsAcrossCooldown++;
        la.amount -= LAB_REACTION_AMOUNT;
        lb.amount -= LAB_REACTION_AMOUNT;
        P.amount += LAB_REACTION_AMOUNT;
        P.mineral = c;
        P.cooldown = REACTION_TIME[c];
        reactionsRun++;
      }
    }
  };

  // ---- tender: drain target, else keep base feedstock (bottom-up) ----------
  const DRAIN_AT = 50;
  const advanceTender = (): void => {
    let acted = false;
    if (tender.carrying) {
      // deposit stroke
      const { res, amt, dst } = tender.carrying;
      const dest = dst === "holder"
        ? (labs.find((l) => l.mineral === res && l.amount + amt <= CAP) ?? labs.find((l) => l.mineral === null))
        : undefined;
      if (dest) {
        const put = Math.min(amt, CAP - dest.amount);
        dest.mineral = res;
        dest.amount += put;
        if (amt - put > 0) terminal[res] = (terminal[res] ?? 0) + (amt - put);
      } else {
        terminal[res] = (terminal[res] ?? 0) + amt; // evicted or nowhere to put — return
      }
      tender.carrying = null;
      acted = true;
    } else {
      // drain a full-enough target lab (one stroke straight to banked)
      const tl = labs.find((l) => l.mineral === target && l.amount >= DRAIN_AT);
      if (tl) {
        const amt = Math.min(args.carry, tl.amount);
        tl.amount -= amt;
        if (tl.amount === 0) tl.mineral = null;
        banked[target] = (banked[target] ?? 0) + amt;
        producedTarget += amt;
        acted = true;
      } else {
        // lowest-tier under-buffer reaction blocked by a missing base -> load it
        let need: string | null = null;
        for (const c of tree) {
          if (!wantMore(c)) continue;
          for (const r of REACTIONS[c]) if (isBase(r) && !holderOf(r)) { need = r; break; }
          if (need) break;
        }
        if (need) {
          // REACT-AWAY DISCIPLINE (owner): never withdraw a compound to free a
          // lab — only DEPOSIT bases and WITHDRAW the final product. A base-holder
          // is not evicted; we simply stop topping it and let reactions drain it
          // to zero, and only then is the empty lab reloaded. So we load a base
          // ONLY into an already-empty lab; if none is free we wait for one to
          // deplete. Base loads are capped (BASE_LOAD) so labs cycle in bounded
          // time instead of a fat 3000-charge tying a lab up for ages.
          const empty = labs.find((l) => l.mineral === null);
          if (empty) {
            const avail = terminal[need] ?? 0;
            const amt = Math.min(args.carry, BASE_LOAD, avail);
            if (amt > 0) { terminal[need] = avail - amt; tender.carrying = { res: need, amt, dst: "holder" }; acted = true; }
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
  console.log(`  scheduler       : FUNGIBLE BOTTOM-UP (any lab fires any goal-tree reaction; stable base mix; read in place)`);
  console.log(`  target compound : ${target}   (tree depth ${depthOf(target)}, ${tree.length} goal-tree compounds in ${LAB_COUNT} fungible labs)`);
  console.log(`  ticks           : ${args.ticks}  (steady window: last ${steadyTicks}),  in-lab buffer ${BUFFER}, carry ${args.carry}`);
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
