/**
 * sim-labs-unity.ts — breaking the 0.8 wall, going for 1.0 utilisation (spec 31).
 *
 * The claim I kept making and the owner kept rejecting: a base-consuming reaction
 * can never hit 1.0 because every reaction needs two source labs and a base source
 * is a permanently-idle feeder -> 8/10. WRONG, same shape of error as the 0.8 wall.
 *
 * The hole: a base-holder lab need not be OFF-COOLDOWN. Cooldown is a property of
 * the LAB, set when it produces, and it persists no matter what is in the lab. So
 * the tender can withdraw a cooling lab's product and deposit a raw base into it
 * WHILE IT IS STILL ON COOLDOWN, and reading a base source is legal on cooldown.
 * The base-feeder duty therefore rotates through the cooldown dead-time every lab
 * already has — no lab is ever idle-and-off-cooldown. Utilisation -> 1.0.
 *
 * Scheme (continuous single reaction, default OH = H + O, cd 20):
 *   - Every lab, the tick its cooldown hits 0, PRODUCES (into its own OH holding or
 *     empty), reading two OTHER labs that currently hold the two bases.
 *   - The two base sources are COOLING labs (on cooldown from their own earlier
 *     production) that the tender has loaded with H / O. We keep two of each so a
 *     source can itself fire (reading the other) without ever leaving zero sources.
 *   - Product OH is banked off the accumulators before they overflow.
 * At no tick is any lab off-cooldown-and-idle, so util pins at ~1.0.
 *
 * Run: npx ts-node -P tsconfig.test.json scripts/sim-labs-unity.ts [--rx OH]
 *                                                                   [--ticks 40000] [--quiet]
 *   --rx may be ANY single reaction (OH, LH, UH2O, XLH2O, ...). Base+base is the
 *   hard case (both sources are bases); it is the one that proves the wall is gone.
 *
 * NOT wired into the bot (labs are unmodeled in src/). Standard Screeps constants,
 * UNVERIFIED here (@screeps/engine not vendored) — in particular that one source
 * lab may be read by several producers in one tick, and that withdraw/deposit is
 * legal on a lab that is on cooldown. Both are the standard rules; verify at build.
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

interface Args { rx: string; ticks: number; quiet: boolean; }
function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const rx = get("--rx", "OH");
  if (!REACTIONS[rx]) { console.error(`Unknown reaction "${rx}".`); process.exit(1); }
  return { rx, ticks: parseInt(get("--ticks", "40000"), 10), quiet: argv.includes("--quiet") };
}

function run(args: Args): void {
  const RX = args.rx;
  const [A, B] = REACTIONS[RX]; // the two reactants of the single reaction we run
  const CD = REACTION_TIME[RX];
  const CAP = LAB_MINERAL_CAPACITY;
  const AMT = LAB_REACTION_AMOUNT;

  const labs: Lab[] = Array.from({ length: LAB_COUNT }, (_, id) => ({ id, mineral: null, amount: 0, cooldown: 0 }));
  const terminal: Record<string, number> = {};
  const BIG = 1e9;
  for (const b of BASES) terminal[b] = BIG; // bases supplied
  const banked: Record<string, number> = {};

  let tenderIntents = 0;
  let reactionsRun = 0;
  let producedRX = 0;
  let busyLabTicks = 0;
  let misses = 0; // ticks a lab hit cd==0 but could not fire (the util leak)

  // how many DISTINCT source labs each reactant needs held at once. For a reactant
  // that is itself the product (never here — single reaction) it would be 0; for a
  // reactant equal to the OTHER reactant (e.g. none of ours) it'd need care. We keep
  // 2 of each distinct reactant so a source can fire (reading its twin) without ever
  // dropping to zero sources.
  const reactants = A === B ? [A] : [A, B];
  const KEEP = 2;

  // top a lab up to a working amount of `res` from the terminal (tender deposit)
  const loadBase = (l: Lab, res: string, target: number): void => {
    if (l.mineral !== null && l.mineral !== res && l.amount > 0) {
      // bank whatever it held (product) then repurpose
      if (!isBase(l.mineral)) { banked[l.mineral] = (banked[l.mineral] ?? 0) + l.amount; if (l.mineral === RX) producedRX += l.amount; }
      else terminal[l.mineral] = (terminal[l.mineral] ?? 0) + l.amount;
      l.amount = 0; tenderIntents++;
    }
    l.mineral = res;
    if (l.amount < target) {
      const want = Math.min(target - l.amount, terminal[res] ?? 0);
      terminal[res] -= want; l.amount += want; tenderIntents++;
    }
  };

  const sourcesOf = (res: string): Lab[] =>
    labs.filter((l) => l.mineral === res && l.amount >= AMT);

  const tick = (): void => {
    for (const l of labs) if (l.cooldown > 0) l.cooldown--;

    // 1. MAINTAIN SOURCES. For each reactant that is a base, make sure KEEP distinct
    //    labs hold it — and crucially, prefer to place that base in labs that are
    //    ON COOLDOWN (busy already), so the source role costs no idle lab-tick. Only
    //    if no cooling lab is spare do we (last resort) use an off-cooldown lab.
    for (const res of reactants) {
      if (!isBase(res)) continue; // compound sources are produced, handled by firing
      let have = sourcesOf(res).length;
      if (have >= KEEP) continue;
      // candidate donor labs, best first: on-cooldown labs NOT already a needed
      // source, holding the product or empty (never steal the other reactant's
      // sources below KEEP). Prefer highest cooldown (longest-lived source).
      const otherReactants = reactants.filter((r) => r !== res);
      const isProtectedSource = (l: Lab): boolean =>
        otherReactants.some((r) => l.mineral === r) &&
        otherReactants.every((r) => l.mineral !== r || sourcesOf(r).length <= KEEP);
      const cand = labs
        .filter((l) => l.mineral !== res)
        .filter((l) => !isProtectedSource(l))
        .sort((x, y) => y.cooldown - x.cooldown); // cooling labs first
      for (const l of cand) {
        if (have >= KEEP) break;
        loadBase(l, res, CAP);
        have++;
      }
    }

    // 2. FIRE. Every lab whose cooldown hit 0 should produce this tick. It fires the
    //    single reaction, reading two OTHER labs that hold the reactants (sources may
    //    be on cooldown — that is the whole point). A lab that was a base source and
    //    just came off cooldown gets emptied and fires too (rotates into a producer).
    for (const P of labs) {
      if (P.cooldown > 0) continue;
      // producer must hold RX (accumulate) or be empty; if it holds a base (an
      // ex-source) bank/clear it first
      if (P.mineral !== null && P.mineral !== RX) {
        if (isBase(P.mineral)) terminal[P.mineral] += P.amount;
        else { banked[P.mineral] = (banked[P.mineral] ?? 0) + P.amount; if (P.mineral === RX) producedRX += P.amount; }
        P.mineral = null; P.amount = 0; tenderIntents++;
      }
      if (P.mineral === RX && P.amount + AMT > CAP) {
        // full — bank it to make room, then fire into the empty lab
        banked[RX] = (banked[RX] ?? 0) + P.amount; producedRX += P.amount;
        P.mineral = null; P.amount = 0; tenderIntents++;
      }
      const sA = labs.find((l) => l !== P && l.mineral === A && l.amount >= AMT);
      const sB = A === B
        ? labs.find((l) => l !== P && l !== sA && l.mineral === B && l.amount >= AMT)
        : labs.find((l) => l !== P && l.mineral === B && l.amount >= AMT);
      if (!sA || !sB) { misses++; continue; } // could not fire -> idle this tick
      sA.amount -= AMT; sB.amount -= AMT;
      P.mineral = RX; P.amount += AMT; P.cooldown = CD;
      reactionsRun++;
    }

    // 3. Skim accumulated product so labs don't all fill to CAP and stall (bank the
    //    fullest RX accumulators down to a working level; keep 2 as read-sources if
    //    RX is itself a reactant — not the case for a single reaction, but harmless).
    for (const P of labs) {
      if (P.mineral === RX && P.amount >= CAP - AMT) {
        banked[RX] = (banked[RX] ?? 0) + (P.amount - AMT); producedRX += P.amount - AMT;
        P.amount = AMT; tenderIntents++;
      }
    }

    for (const l of labs) if (l.cooldown > 0) busyLabTicks++;
  };

  const WARMUP = Math.min(4000, Math.floor(args.ticks / 4));
  let warmupProduced = 0, warmupBusy = 0, warmupMiss = 0;
  for (let t = 0; t < args.ticks; t++) {
    tick();
    if (t === WARMUP) { warmupProduced = producedRX; warmupBusy = busyLabTicks; warmupMiss = misses; }
  }

  const steadyTicks = args.ticks - WARMUP;
  const steadyProduced = producedRX - warmupProduced;
  const ratePerK = (steadyProduced / steadyTicks) * 1000;
  const steadyBusy = busyLabTicks - warmupBusy;
  const util = steadyBusy / (LAB_COUNT * steadyTicks);
  const steadyMiss = misses - warmupMiss;
  const intentsPerK = (tenderIntents / args.ticks) * 1000;

  console.log("");
  console.log(`Lab reaction-network sim  —  spec 31 layout (10 labs, 1 tender)`);
  console.log(`  scheduler       : UNITY — continuous ${RX}=${A}+${B} (cd ${CD}); base feeders rotate through COOLDOWN dead-time`);
  console.log(`  reactants        : ${reactants.join(" ")}${reactants.every(isBase) ? "  (both bases — the hard case that proves the wall is gone)" : ""}`);
  console.log(`  ticks           : ${args.ticks}  (steady window: last ${steadyTicks})`);
  console.log("");
  console.log(`  LAB UTILISATION  : ${(util * 100).toFixed(2)}%   <-- the target is 100%`);
  console.log(`    ${RX} produced      : ${steadyProduced}  (${ratePerK.toFixed(1)} / 1000 ticks)`);
  console.log(`    reactions run      : ${reactionsRun}`);
  console.log(`    idle misses (leak) : ${steadyMiss}  (ticks a lab came off cooldown but had no sources -> the only util loss)`);
  console.log(`    tender CPU         : ${intentsPerK.toFixed(0)} intents/1k = ${(intentsPerK * 0.2).toFixed(1)} CPU/1k ticks`);
  console.log("");
  const theoreticalMax = (AMT * LAB_COUNT) / CD; // every lab firing every cd ticks
  console.log(`  theoretical ceiling (all ${LAB_COUNT} labs firing every ${CD} ticks): ${(theoreticalMax * 1000).toFixed(0)}/1k at 100% util`);
  console.log(`  achieved / ceiling  : ${((ratePerK / (theoreticalMax * 1000)) * 100).toFixed(1)}%`);
  console.log("");
}

run(parseArgs(process.argv.slice(2)));
