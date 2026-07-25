/**
 * sim-labs-unity-tree.ts — pushing the WHOLE tree toward 1.0 (spec 31).
 *
 * sim-labs-unity.ts proved a SINGLE reaction hits 100% utilisation: the base
 * feeders rotate through cooldown dead-time, so no lab is ever idle-off-cooldown.
 * The campaign burst runs a full high-tier tree but only reaches 84-88%, because
 * ITS base feeders are off-cooldown idle labs. This applies the unity trick to the
 * full tree: keep the base feeders on labs that are ALREADY COOLING, so the only
 * thing that was idle in the burst becomes busy.
 *
 * Per tick:
 *   - Maintain base sources on COOLING labs (rotate through the cooldown window).
 *     Compound reactants come free from cooling producers of that compound.
 *   - Every off-cooldown lab fires the reaction it is most useful for: the one most
 *     behind its cooldown-proportional target rate whose two sources are available.
 *     A lab firing a compound-consuming reaction reads on-cooldown producers; a lab
 *     firing a base+base reaction reads the rotating base sources — both busy.
 *   - Bank the target; skim overfull intermediates.
 *
 * Reports util the same way as burst/unity so the three are directly comparable.
 *
 * RESULT — this BEATS the burst's 84-88% and reaches 1.0 on most high-tier boosts.
 * Measured, 60k ticks, absolute-deficit reaction selection:
 *   XUH2O XUHO2 XKH2O XKHO2 XLHO2 : 100.00% util   (exactly 1.0 — every lab always cooling)
 *   XLH2O 97.8%   XZH2O 98.9%   XZHO2 97.0%        (the cd-heavy top tier's integer-lab
 *                                                   tax leaves a couple of % of misses)
 *   XGH2O (depth 5) : cannot — its 7 compound labs + 7 base holders = 14 > 10 labs, so
 *                     it physically cannot hold all its bases at once (the same Ghodium
 *                     capacity wall the react-away scheduler hit). Burst still runs it
 *                     at 88% because bursting holds only 2 feeders at a time.
 * The single-reaction sibling sim-labs-unity.ts already proved the base case at a clean
 * 1.0 (OH/LH/ZK, both reactants bases — the exact "0.8 wall" case). This shows the same
 * trick scales to the full tree: keep every base feeder on a COOLING lab and there is no
 * idle lab left to drag utilisation below 1.0.
 *
 * Run: npx ts-node -P tsconfig.test.json scripts/sim-labs-unity-tree.ts [--target XLH2O]
 *                                                                        [--ticks 60000] [--quiet]
 *
 * NOT wired into the bot. Standard Screeps constants, UNVERIFIED here — in particular
 * that one lab may be read by several producers in one tick, and that withdraw/deposit
 * is legal on a lab that is on cooldown. Both are the standard rules; verify at build.
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

interface Args { target: string; ticks: number; quiet: boolean; }
function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const target = get("--target", "XLH2O");
  if (!REACTIONS[target]) { console.error(`Unknown target "${target}".`); process.exit(1); }
  return { target, ticks: parseInt(get("--ticks", "40000"), 10), quiet: argv.includes("--quiet") };
}

function run(args: Args): void {
  const { target } = args;
  const tree = treeCompounds(target); // reactants-before-product
  if (tree.length > LAB_COUNT) { console.error(`${target} tree ${tree.length} > ${LAB_COUNT} labs.`); process.exit(1); }
  const AMT = LAB_REACTION_AMOUNT;
  const CAP = LAB_MINERAL_CAPACITY;

  const labs: Lab[] = Array.from({ length: LAB_COUNT }, (_, id) => ({ id, mineral: null, amount: 0, cooldown: 0 }));
  const terminal: Record<string, number> = {};
  const BIG = 1e9;
  for (const b of BASES) terminal[b] = BIG;
  const banked: Record<string, number> = {};

  let tenderIntents = 0, reactionsRun = 0, producedTarget = 0, busyLabTicks = 0, misses = 0;

  // the base reactants the tree consumes, and the 1.0-rate lab-share of each reaction
  const baseReactants = [...new Set(tree.flatMap((c) => REACTIONS[c].filter(isBase)))];
  const sumCd = tree.reduce((s, c) => s + REACTION_TIME[c], 0);
  const R = (AMT * LAB_COUNT) / sumCd; // units/tick at util 1.0
  const share: Record<string, number> = {}; // target busy-labs for each reaction
  for (const c of tree) share[c] = (R * REACTION_TIME[c]) / AMT;

  const deficit: Record<string, number> = {};
  for (const c of tree) deficit[c] = 0;

  const holders = (res: string): Lab[] => labs.filter((l) => l.mineral === res && l.amount >= AMT);
  const busyBy = (c: string): number => labs.filter((l) => l.mineral === c && l.cooldown > 0).length;

  const bankOrReturn = (l: Lab): void => {
    if (l.mineral === null || l.amount <= 0) { l.mineral = null; l.amount = 0; return; }
    if (isBase(l.mineral)) terminal[l.mineral] = (terminal[l.mineral] ?? 0) + l.amount;
    else { banked[l.mineral] = (banked[l.mineral] ?? 0) + l.amount; if (l.mineral === target) producedTarget += l.amount; }
    l.mineral = null; l.amount = 0; tenderIntents++;
  };

  const tick = (): void => {
    for (const l of labs) if (l.cooldown > 0) l.cooldown--;
    for (const c of tree) deficit[c] += R;

    // 1. MAINTAIN BASE SOURCES on cooling labs. For each base reactant, ensure at
    //    least KEEP cooling labs hold it. Prefer the deepest-cooling labs (longest
    //    before they must fire) that aren't themselves a scarce source.
    const KEEP = 1;
    for (const res of baseReactants) {
      let have = holders(res).length;
      if (have >= KEEP) continue;
      const eligible = (l: Lab): boolean =>
        l.mineral !== res &&
        !(l.mineral !== null && baseReactants.includes(l.mineral) && l.mineral !== res) && // never steal another base's holder
        !(l.mineral && !isBase(l.mineral) && busyBy(l.mineral) <= 1 && l.mineral !== target); // keep last producer of a compound
      // PREFER cooling labs (unity trick: the source costs no idle lab-tick). Fall
      // back to off-cooldown labs only to BOOTSTRAP (warmup) when nothing is cooling
      // yet — otherwise the chicken-and-egg (no cooling lab -> no source -> nothing
      // fires -> no cooling lab) never breaks.
      const cooling = labs.filter((l) => l.cooldown > 0 && eligible(l)).sort((x, y) => y.cooldown - x.cooldown);
      const idle = labs.filter((l) => l.cooldown === 0 && (l.mineral === null || isBase(l.mineral)) && eligible(l));
      for (const l of [...cooling, ...idle]) {
        if (have >= KEEP) break;
        bankOrReturn(l);
        l.mineral = res; l.amount = CAP; terminal[res] -= CAP; tenderIntents++;
        have++;
      }
    }

    // 2. FIRE every off-cooldown lab. Pick the reaction it should run: among tree
    //    reactions whose two sources are available (a source != P, holding >=AMT),
    //    choose the one with the largest ABSOLUTE deficit (owed = R accrued minus
    //    fired). Absolute — not deficit/share — is what makes the slow high-cd top
    //    tier win labs proportionally and stops the fast low tiers hogging the pool;
    //    it is what lifted the Σcd-95 boost family from an 85% plateau to a clean
    //    1.0. A lab holding a base (ex-source come off cooldown) is emptied and
    //    rejoins as a producer.
    for (const P of labs) {
      if (P.cooldown > 0) continue;
      const canFire = (c: string): [Lab, Lab] | null => {
        const [a, b] = REACTIONS[c];
        const sA = labs.find((l) => l !== P && l.mineral === a && l.amount >= AMT);
        if (!sA) return null;
        const sB = labs.find((l) => l !== P && l !== sA && l.mineral === b && l.amount >= AMT);
        if (!sB) return null;
        // producer must be able to hold the product
        if (P.mineral !== null && P.mineral !== c && P.amount > 0 && !isBase(P.mineral)) {
          if (busyBy(P.mineral) <= 1 && P.mineral !== target) return null; // don't kill last producer
        }
        if (P.mineral === c && P.amount + AMT > CAP) return null;
        return [sA, sB];
      };
      let pick: string | null = null; let pickSrc: [Lab, Lab] | null = null; let bestScore = -Infinity;
      for (const c of tree) {
        const src = canFire(c);
        if (!src) continue;
        const score = deficit[c]; // most behind in ABSOLUTE terms (favours high-cd tiers)
        if (score > bestScore) { bestScore = score; pick = c; pickSrc = src; }
      }
      if (!pick || !pickSrc) { misses++; continue; }
      if (P.mineral !== null && P.mineral !== pick) bankOrReturn(P);
      const [sA, sB] = pickSrc;
      sA.amount -= AMT; sB.amount -= AMT;
      P.mineral = pick; P.amount += AMT; P.cooldown = REACTION_TIME[pick];
      reactionsRun++; deficit[pick] -= AMT;
    }

    // 3. bank target; skim overfull intermediates so a compound doesn't fill CAP and
    //    stall its consumers by leaving no lab free to produce it into.
    for (const P of labs) {
      if (P.mineral === target && P.amount > 0 && P.cooldown === 0) bankOrReturn(P);
      else if (P.mineral && !isBase(P.mineral) && P.mineral !== target && P.amount >= CAP - AMT) {
        banked[P.mineral] = (banked[P.mineral] ?? 0) + (P.amount - AMT); P.amount = AMT; tenderIntents++;
      }
    }

    for (const l of labs) if (l.cooldown > 0) busyLabTicks++;
  };

  const WARMUP = Math.min(8000, Math.floor(args.ticks / 4));
  let wProd = 0, wBusy = 0, wMiss = 0;
  for (let t = 0; t < args.ticks; t++) {
    tick();
    if (t === WARMUP) { wProd = producedTarget; wBusy = busyLabTicks; wMiss = misses; }
  }

  const steadyTicks = args.ticks - WARMUP;
  const steadyProduced = producedTarget - wProd;
  const ratePerK = (steadyProduced / steadyTicks) * 1000;
  const util = (busyLabTicks - wBusy) / (LAB_COUNT * steadyTicks);
  const steadyMiss = misses - wMiss;
  const intentsPerK = (tenderIntents / args.ticks) * 1000;
  const ceil1k = R * 1000;

  console.log("");
  console.log(`Lab reaction-network sim  —  spec 31 (10 labs, 1 tender)`);
  console.log(`  scheduler       : UNITY-TREE — base feeders rotate through cooldown; full tree toward 1.0`);
  console.log(`  target          : ${target}  (depth ${depthOf(target)}, Σcd ${sumCd}, bases ${baseReactants.join(" ")})`);
  console.log(`  ticks           : ${args.ticks}  (steady window: last ${steadyTicks})`);
  console.log("");
  console.log(`  LAB UTILISATION  : ${(util * 100).toFixed(2)}%   <-- the target is 100%`);
  console.log(`    ${target} produced      : ${steadyProduced}  (${ratePerK.toFixed(1)} / 1000 ticks)`);
  console.log(`    reactions run      : ${reactionsRun}`);
  console.log(`    idle misses (leak) : ${steadyMiss}`);
  console.log(`    tender CPU         : ${intentsPerK.toFixed(0)} intents/1k = ${(intentsPerK * 0.2).toFixed(1)} CPU/1k ticks`);
  console.log("");
  console.log(`  1.0-util ceiling (R=${R.toFixed(3)}/tick): ${ceil1k.toFixed(0)}/1k`);
  console.log(`  achieved / ceiling  : ${((ratePerK / ceil1k) * 100).toFixed(1)}%`);
  console.log("");
}

run(parseArgs(process.argv.slice(2)));
