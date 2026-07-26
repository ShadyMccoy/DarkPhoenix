/**
 * sim-labs-batch.ts — phased batches: 1.0 utilisation for ANY compound, incl. XGH2O.
 *
 * The owner's idea that beats the one capacity wall left standing. sim-labs-unity-tree
 * hits 1.0 on shallow boosts but CANNOT run XGH2O: its tree has 7 compound producers +
 * 7 distinct base holders = 14 simultaneous holdings > 10 labs. That wall only exists
 * because the whole tree is held at once. Break the tree into TIERS and run one
 * reaction at a time in BULK:
 *
 *   make a batch of ZK (Z+K) -> bank it;  a batch of UL (U+L) -> bank it;
 *   then treat ZK, UL as "bases" and make a batch of G (ZK+UL) -> bank it;  ... up to
 *   XGH2O.  Each phase is a SINGLE reaction whose two inputs come from the terminal, so
 *   it is exactly the sim-labs-unity.ts system (base feeders rotate through cooldown)
 *   and hits ~1.0 on its own. A phase never holds more than ONE reaction's working set
 *   (<=4 source labs + producers), so the 14>10 wall never appears.
 *
 * RESULT — ~1.0 for EVERYTHING, and the cut-over is nearly free (owner: "less disruptive
 * than assumed"). Measured, XGH2O at batch 3000: 99.66% util, 383.8/1k = 99.8% of the
 * 385/1k ceiling. Shallow boosts (XLH2O/XUHO2/XZHO2) 99.8% too. Batch size barely matters
 * now (3000 already ~1.0), so the amortisation worry was misplaced — see below.
 *
 * Two things were needed to actually reach 1.0, and BOTH are about the compound+compound
 * tiers (G=ZK+UL, GH2O=GH+OH), NOT the cut-over (a per-phase diagnostic showed base+base
 * tiers already ran at 100% and the boundaries handed off cleanly — a tier's product IS
 * the next tier's input, so those labs become the next reaction's feeders for free):
 *   (a) BALANCED holder load — a finite compound input must not all pool into one lab, or
 *       the lone holder is pinned idle at cd0 (no second same-input source to read
 *       against). Split it so two holders coexist and rotate.  (~75% -> higher.)
 *   (b) FRAGMENT CONSOLIDATION — as a finite input drains it fragments into sub-AMT bits
 *       (last 5 ZK stranded as 2+3 across two labs) that can neither be read nor merged;
 *       bank them back so the terminal recombines them. Without this the phase deadlocks
 *       on its tail.  (removes the stall; together -> ~1.0.)
 *
 * Cost of generality (owner accepted "regardless of CPU"): every intermediate unit now
 * round-trips through the terminal (it is the next tier's input), so tender intents are
 * higher than the in-lab react-away schedulers (~132 CPU/1k for XGH2O) — still a fraction
 * of the burst's 476. The other costs are latency (target emerges one batch per
 * super-cycle) and WIP (a batch of each intermediate parked in the terminal); small batch
 * keeps both low and still hits ~1.0, so prefer modest batches.
 *
 * Run: npx ts-node -P tsconfig.test.json scripts/sim-labs-batch.ts [--target XGH2O]
 *                                                                   [--batch 3000]
 *                                                                   [--ticks 120000] [--quiet]
 *
 * NOT wired into the bot. Standard Screeps constants, UNVERIFIED here.
 */

/* eslint-disable no-console */

const LAB_MINERAL_CAPACITY = 3000;
const LAB_REACTION_AMOUNT = 5;

const REACTIONS: Record<string, [string, string]> = {
  OH: ["H", "O"], ZK: ["Z", "K"], UL: ["U", "L"], G: ["ZK", "UL"],
  UH: ["U", "H"], UO: ["U", "O"], KH: ["K", "H"], KO: ["K", "O"],
  LH: ["L", "H"], LO: ["L", "O"], ZH: ["Z", "H"], ZO: ["Z", "O"], GH: ["G", "H"], GO: ["G", "O"],
  UH2O: ["UH", "OH"], UHO2: ["UO", "OH"], KH2O: ["KH", "OH"], KHO2: ["KO", "OH"],
  LH2O: ["LH", "OH"], LHO2: ["LO", "OH"], ZH2O: ["ZH", "OH"], ZHO2: ["ZO", "OH"],
  GH2O: ["GH", "OH"], GHO2: ["GO", "OH"],
  XUH2O: ["X", "UH2O"], XUHO2: ["X", "UHO2"], XKH2O: ["X", "KH2O"], XKHO2: ["X", "KHO2"],
  XLH2O: ["X", "LH2O"], XLHO2: ["X", "LHO2"], XZH2O: ["X", "ZH2O"], XZHO2: ["X", "ZHO2"],
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

interface Lab { id: number; mineral: string | null; amount: number; cooldown: number; }

function treeCompounds(target: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (c: string) => {
    if (isBase(c) || seen.has(c)) return;
    seen.add(c);
    const [a, b] = REACTIONS[c];
    visit(a); visit(b); order.push(c);
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
    const v = 1 + Math.max(d(a), d(b)); memo.set(c, v); return v;
  };
  return d;
})();

interface Args { target: string; batch: number; ticks: number; quiet: boolean; pitstop: boolean; dedicate: boolean; }
function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const target = get("--target", "XGH2O");
  if (!REACTIONS[target]) { console.error(`Unknown target "${target}".`); process.exit(1); }
  return {
    target,
    batch: parseInt(get("--batch", "3000"), 10),
    ticks: parseInt(get("--ticks", "120000"), 10),
    quiet: argv.includes("--quiet"),
    pitstop: argv.includes("--pitstop"),
    dedicate: argv.includes("--dedicate"),
  };
}

function run(args: Args): void {
  const { target } = args;
  const phases = treeCompounds(target); // post-order: a reaction's inputs are made in earlier phases
  const AMT = LAB_REACTION_AMOUNT;
  const CAP = LAB_MINERAL_CAPACITY;
  const B = args.batch; // units of product per phase

  const labs: Lab[] = Array.from({ length: LAB_COUNT }, (_, id) => ({ id, mineral: null, amount: 0, cooldown: 0 }));
  const terminal: Record<string, number> = {};
  const BIG = 1e9;
  for (const b of BASES) terminal[b] = BIG; // bases are the supplied input
  for (const c of phases) terminal[c] = 0;

  let tenderIntents = 0, reactionsRun = 0, producedTarget = 0, busyLabTicks = 0;

  let phaseIdx = 0;
  let phaseFired = 0; // units of the current phase's product created so far this phase

  const holders = (res: string): Lab[] => labs.filter((l) => l.mineral === res && l.amount >= AMT);
  const inputsOf = (rx: string): string[] => {
    const [x, y] = REACTIONS[rx];
    return x === y ? [x] : [x, y];
  };

  // bank a lab's contents to the terminal (product goes to terminal to feed next tier;
  // a leftover input likewise returns). Frees the lab.
  const bankLab = (l: Lab): void => {
    if (l.mineral !== null && l.amount > 0) {
      terminal[l.mineral] = (terminal[l.mineral] ?? 0) + l.amount;
      if (l.mineral === target) producedTarget += l.amount;
      tenderIntents++;
    }
    l.mineral = null; l.amount = 0;
  };

  const tick = (): void => {
    for (const l of labs) if (l.cooldown > 0) l.cooldown--;

    const c = phases[phaseIdx];
    const [a, b] = REACTIONS[c];
    const inputs = a === b ? [a] : [a, b];

    // 0. CONSOLIDATE fragments. A finite compound input can fragment into sub-AMT bits
    //    (e.g. the last 5 ZK stranded as 2+3 across two labs) that can never be read
    //    (need >=AMT) and can never merge (one mineral per lab) — a hard stall. Bank
    //    any sub-AMT input holder back to the terminal so the pieces recombine there
    //    and reload as a whole >=AMT holder. This is what makes the balanced-holder
    //    scheme (below) actually complete instead of deadlocking on the tail.
    for (const l of labs) {
      if (l.mineral !== null && inputs.includes(l.mineral) && l.amount > 0 && l.amount < AMT) bankLab(l);
    }

    // 1. MAINTAIN INPUT SOURCES on cooling labs (the unity trick). Keep 2 cooling
    //    holders of each input, drawn from the terminal (bases infinite; compound
    //    inputs from the banks the earlier phases filled), BALANCED so a finite input
    //    never all pools into one lab (a lone holder gets pinned idle at cd0, no second
    //    source to read against). Never steal the other input's holders.
    const KEEP = 2;
    for (const res of inputs) {
      let have = holders(res).length;
      if (have >= KEEP) continue;
      const eligible = (l: Lab): boolean =>
        l.mineral !== res && !(l.mineral !== null && inputs.includes(l.mineral) && l.mineral !== res);
      const cooling = labs.filter((l) => l.cooldown > 0 && eligible(l)).sort((x, y) => y.cooldown - x.cooldown);
      const idle = labs.filter((l) => l.cooldown === 0 && eligible(l));
      for (const l of [...cooling, ...idle]) {
        if (have >= KEEP || (terminal[res] ?? 0) < AMT) break;
        bankLab(l);
        const want = isBase(res)
          ? Math.min(CAP, terminal[res])
          : Math.min(CAP, Math.max(AMT, Math.floor(terminal[res] / Math.max(1, KEEP - have))));
        l.mineral = res; l.amount = want; terminal[res] -= want; tenderIntents++;
        have++;
      }
    }

    // 2. FIRE. Every off-cooldown lab produces c (unity discipline: a lab that was an
    //    input holder and just came off cooldown empties its input back and produces
    //    c too — so the input holders are always COOLING labs, never idle reserved
    //    ones; that is what carries a phase to ~1.0). Stop starting new reactions once
    //    the batch quota B is met, letting the phase wind down for the cut-over.
    for (const P of labs) {
      if (P.cooldown > 0) continue;
      if (phaseFired >= B) continue;
      // --dedicate (experiment): NEVER let an input-holder fire — feeders are fixed,
      // permanently-idle labs (the classic 2-feeder layout, no rotation). Shows the cost.
      if (args.dedicate && P.mineral !== null && P.mineral !== c && inputs.includes(P.mineral)) continue;
      // if P holds one of the inputs, only let it fire (empty + produce) when a SPARE
      // holder of that input remains to be read — otherwise keep it as the source.
      if (P.mineral !== null && P.mineral !== c && inputs.includes(P.mineral) && holders(P.mineral).length <= 1) continue;
      if (P.mineral !== null && P.mineral !== c) { if (P.amount > 0) bankLab(P); else { P.mineral = null; P.amount = 0; } }
      if (P.mineral === c && P.amount + AMT > CAP) bankLab(P);
      const sA = labs.find((l) => l !== P && l.mineral === a && l.amount >= AMT);
      const sB = a === b
        ? labs.find((l) => l !== P && l !== sA && l.mineral === b && l.amount >= AMT)
        : labs.find((l) => l !== P && l.mineral === b && l.amount >= AMT);
      if (!sA || !sB) continue; // no source this tick (rare cut-over transient)
      sA.amount -= AMT; sB.amount -= AMT;
      P.mineral = c; P.amount += AMT; P.cooldown = REACTION_TIME[c];
      reactionsRun++; phaseFired += AMT;
    }

    // 3. skim finished product to the terminal so the next tier can read it, and so a
    //    producer lab can keep firing without hitting CAP.
    for (const P of labs) {
      if (P.mineral === c && P.amount >= CAP - AMT) bankLab(P);
    }

    // 4. advance the phase. Two changeover policies:
    //  - DEFAULT (gradual drain-advance): advance only once the product has drained to
    //    the terminal (or B is banked). The small delay buys a clean handoff and wins at
    //    batch >=300 (~99.7%); its cost is a per-boundary drain tail that only bites at
    //    tiny batch.
    //  - --pitstop (owner's "NASCAR" changeover): advance the INSTANT the quota is met
    //    and reconfigure in one tick — carry over exactly the 2 fattest holders of each
    //    next input as ready feeders, empty every other lab (bank to terminal). Emptying
    //    is a tender action so it works on a cooling lab; that lab fires the new reaction
    //    the moment its cooldown ends. Flat ~97-98% across batch sizes, so it WINS at
    //    small batch (b=100: 98% vs the gradual 93%). It gives up ~2% at large batch
    //    because the compound+compound tiers don't fully re-settle their balanced holders.
    if (phaseFired >= B) {
      if (args.pitstop) {
        const nin = inputsOf(phases[(phaseIdx + 1) % phases.length]);
        for (const res of nin) {
          const hs = holders(res).sort((x, y) => y.amount - x.amount);
          for (const l of hs.slice(2)) bankLab(l); // keep 2 fattest feeders, bank the rest
        }
        for (const l of labs) {
          if (l.mineral !== null && !(nin.includes(l.mineral) && l.amount >= AMT)) bankLab(l);
        }
        phaseIdx = (phaseIdx + 1) % phases.length;
        phaseFired = 0;
      } else {
        for (const P of labs) if (P.mineral === c && P.cooldown === 0) bankLab(P);
        const stillInLabs = labs.some((l) => l.mineral === c && l.amount > 0);
        if (!stillInLabs || (terminal[c] ?? 0) >= B) {
          phaseIdx = (phaseIdx + 1) % phases.length;
          phaseFired = 0;
        }
      }
    }

    for (const l of labs) if (l.cooldown > 0) busyLabTicks++;
  };

  const WARMUP = Math.min(30000, Math.floor(args.ticks / 3));
  let wProd = 0, wBusy = 0;
  for (let t = 0; t < args.ticks; t++) {
    tick();
    if (t === WARMUP) { wProd = producedTarget; wBusy = busyLabTicks; }
  }

  const steadyTicks = args.ticks - WARMUP;
  const steadyProduced = producedTarget - wProd;
  const ratePerK = (steadyProduced / steadyTicks) * 1000;
  const util = (busyLabTicks - wBusy) / (LAB_COUNT * steadyTicks);
  const intentsPerK = (tenderIntents / args.ticks) * 1000;
  const sumCd = phases.reduce((s, cc) => s + REACTION_TIME[cc], 0);
  const R1 = (AMT * LAB_COUNT) / sumCd; // the 1.0-util ceiling rate

  console.log("");
  console.log(`Lab reaction-network sim  —  spec 31 (10 labs, 1 tender)`);
  console.log(`  scheduler       : PHASED BATCH (one reaction at a time in bulk; intermediates banked as the next tier's 'bases')`);
  console.log(`  changeover      : ${args.pitstop ? "PITSTOP (immediate advance, keep 2 feeders + empty rest)" : "gradual drain-advance (default)"}`);
  console.log(`  target          : ${target}  (depth ${depthOf(target)}, ${phases.length} tiers: ${phases.join(" -> ")})`);
  console.log(`  batch / ticks   : ${B} units per phase   ${args.ticks} ticks (steady: last ${steadyTicks})`);
  console.log("");
  console.log(`  LAB UTILISATION  : ${(util * 100).toFixed(2)}%   (amortised over cut-overs)`);
  console.log(`    ${target} produced      : ${steadyProduced}  (${ratePerK.toFixed(1)} / 1000 ticks)`);
  console.log(`    reactions run      : ${reactionsRun}`);
  console.log(`    tender CPU         : ${intentsPerK.toFixed(0)} intents/1k = ${(intentsPerK * 0.2).toFixed(1)} CPU/1k ticks`);
  console.log("");
  console.log(`  1.0-util ceiling (R=${R1.toFixed(3)}/tick): ${(R1 * 1000).toFixed(0)}/1k`);
  console.log(`  achieved / ceiling  : ${((ratePerK / (R1 * 1000)) * 100).toFixed(1)}%`);
  console.log("");
}

run(parseArgs(process.argv.slice(2)));
