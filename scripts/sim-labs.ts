/**
 * sim-labs.ts — standalone lab-reaction-network simulator for spec 31.
 *
 * NOT wired into the bot. Labs are unmodeled in src/ (no StructureLab, no
 * reaction economy) — this is an exploration tool that answers one question:
 *
 *   Does the "two feeder spots + 10 labs" layout (spec 31) SUSTAINABLY produce a
 *   top-tier compound, given a single tender that can only withdraw OR deposit
 *   one lab-load per tick?
 *
 * It models: the 10-lab layout with real range-2 geometry, the terminal as the
 * raw-reactant + compound warehouse, the reaction tree with per-compound
 * cooldowns, and the tender as a 2-stroke forklift (withdraw one tick, deposit
 * the next). Bases are assumed supplied to the terminal (miners/market) so the
 * binding constraint is the layout + tender, which is what we want to measure.
 *
 * The game constants below are VERIFIED against @screeps/common master (2026-07-26)
 * here — @screeps/engine is not vendored in this repo. Per CLAUDE.md epistemics,
 * none of this informs the bot until the constants are re-derived from the
 * engine. This sim is a design aid, not an acceptance test.
 *
 * Sustainable == CONSERVATION: over the steady window the labs and every
 * intermediate buffer must return to their starting fill, so the only net
 * changes are bases consumed (input) and the top compound produced (output).
 * A drifting intermediate means the reported rate is borrowed from a bleeding
 * buffer, not earned. Tight batches (small --batch/--keep) hold the buffers flat.
 *
 * CPU: every tender withdraw/deposit is one intent = 0.2 CPU. The dominant cost
 * is round-tripping intermediates through the terminal in small batches. Larger
 * --batch amortises tender trips (batch 10 -> ~118 CPU/1k; batch 30 -> ~36 CPU/1k,
 * both conserving; past ~60 this scheduler's allocation goes lumpy and drift
 * breaks conservation). batch 30 is the default: the CPU-cheapest point that
 * still conserves.
 *
 * PHASING (you do NOT need all 7 bases held at once): the tree has 7 producible
 * compounds, but you never run them all concurrently — you PHASE, making one at a
 * time, and the tender swaps a small pool of base-holder labs between phases. So
 * ~7 producer/buffer labs + a few swappable base holders fit in 10 labs; there is
 * no "14 roles" wall (an earlier version of this note claimed one — wrong).
 * This terminal-buffered scheduler phases via the terminal (a large shared
 * buffer). An in-lab alternative (hold intermediates, swap only base holders) is
 * in sim-labs-phased.ts — it conserves but measured WORSE (base-holder swap
 * thrash + single top lab); the terminal buffer is cheaper here.
 *
 * Run:  npx ts-node -P tsconfig.test.json scripts/sim-labs.ts [--target XGH2O]
 *                                                             [--ticks 80000]
 *                                                             [--carry 2000]
 *                                                             [--batch 10] [--keep 60]
 *                                                             [--combined]   (allow withdraw+deposit same tick)
 *                                                             [--quiet]
 */

/* eslint-disable no-console */

// ---------------------------------------------------------------------------
// Game constants — VERIFIED against @screeps/common master lib/constants.js (2026-07-26)
// ---------------------------------------------------------------------------
const LAB_MINERAL_CAPACITY = 3000;
const LAB_REACTION_AMOUNT = 5; // produced per reaction; consumed per reactant
const REACTION_RANGE = 2; // source labs must be within Chebyshev range 2

// output compound -> [reactantA, reactantB]
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

// per-compound reaction cooldown (ticks the producing lab is locked)
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
// ---------------------------------------------------------------------------
const LAB_COORDS: Array<[number, number]> = [
  [0, 0], [1, 0], [2, 0],
  [0, 1], [2, 1], [3, 1],
  [0, 2], [1, 2], [3, 2],
  [1, 3],
];
const FEEDER_SPOTS: Array<[number, number]> = [[1, 1], [2, 2]];

const cheb = (a: [number, number], b: [number, number]) =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

interface Lab {
  id: number;
  pos: [number, number];
  mineral: string | null;
  amount: number;
  cooldown: number;
  reserved: boolean; // claimed by an active station this cycle
}

// ---------------------------------------------------------------------------
// Reaction tree expansion
// ---------------------------------------------------------------------------
function treeCompounds(target: string): string[] {
  // all compounds (not bases) that must be produced to reach target, deepest last
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
// Simulation
// ---------------------------------------------------------------------------
interface Args {
  target: string;
  ticks: number;
  carry: number;
  combined: boolean; // true => tender may withdraw AND deposit in the same tick
  quiet: boolean;
  batch: number; // units of each reactant loaded per station cycle
  keep: number; // terminal re-order point for intermediate compounds
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const target = get("--target", "XGH2O");
  if (!REACTIONS[target]) {
    console.error(`Unknown target compound "${target}". Known top-tier: XGH2O, XGHO2, XLH2O, XUH2O, ...`);
    process.exit(1);
  }
  return {
    target,
    ticks: parseInt(get("--ticks", "20000"), 10),
    carry: parseInt(get("--carry", "2000"), 10),
    combined: argv.includes("--combined"),
    quiet: argv.includes("--quiet"),
    batch: parseInt(get("--batch", "30"), 10),
    keep: parseInt(get("--keep", "180"), 10),
  };
}

// A station = one reaction batch running on three labs (producer + 2 sources).
interface Station {
  compound: string;
  a: string;
  b: string;
  prod: number;
  srcA: number;
  srcB: number;
  made: number;
  batch: number;
  phase: "loadA" | "loadB" | "cook" | "drain";
}

function run(args: Args): void {
  const { target } = args;
  const tree = treeCompounds(target);
  const treeSet = new Set(tree);

  const labs: Lab[] = LAB_COORDS.map((pos, id) => ({
    id, pos, mineral: null, amount: 0, cooldown: 0, reserved: false,
  }));
  // precompute range-2 neighbourhood (labs a producer could read as sources)
  const neighbors2: number[][] = labs.map((p) =>
    labs.filter((q) => q.id !== p.id && cheb(p.pos, q.pos) <= REACTION_RANGE).map((q) => q.id),
  );

  const terminal: Record<string, number> = {};
  const banked: Record<string, number> = {}; // final target drained out of the labs
  for (const base of BASES) terminal[base] = 0;

  // tender: a 2-stroke forklift. carrying === null means "empty, may withdraw".
  const tender: { carrying: { res: string; amt: number } | null; job: TenderJob | null } = {
    carrying: null,
    job: null,
  };
  type TenderJob =
    | { kind: "load"; res: string; labId: number; want: number }
    | { kind: "drain"; labId: number };

  const stations: Station[] = [];
  const MAX_STATIONS = 3;

  // metrics
  let tenderBusyTicks = 0;
  let tenderIntents = 0; // each withdraw/deposit is one intent = 0.2 CPU
  let reactionsRun = 0;
  let readsAcrossCooldown = 0; // reactions where a source lab was itself on cooldown
  let producedTarget = 0;
  const baseConsumed: Record<string, number> = {};

  const freeLab = (want: (l: Lab) => boolean): Lab | undefined =>
    labs.find((l) => !l.reserved && want(l));

  // Pick the next compound to manufacture for an idle station slot.
  const availableInTerminal = (r: string) =>
    (isBase(r) ? terminal[r] : terminal[r] ?? 0) >= LAB_REACTION_AMOUNT;
  const pickCompound = (activeCompounds: Set<string>): string | null => {
    const [ta, tb] = REACTIONS[target];
    const targetMakeable = availableInTerminal(ta) && availableInTerminal(tb);
    const targetSlots = stations.filter((s) => s.compound === target).length;
    // keep at most half the slots on the top compound so intermediates refill
    if (targetMakeable && targetSlots < Math.ceil(MAX_STATIONS / 2)) return target;
    // else refill the shallowest tree compound below its terminal re-order point
    const candidates = tree
      .filter((c) => c !== target)
      .filter((c) => !activeCompounds.has(c))
      .filter((c) => (terminal[c] ?? 0) < args.keep)
      .filter((c) => {
        const [a, b] = REACTIONS[c];
        return availableInTerminal(a) && availableInTerminal(b);
      })
      .sort((x, y) => depthOf(x) - depthOf(y));
    if (candidates.length) return candidates[0];
    if (targetMakeable) return target; // nothing to refill -> just make more target
    return null;
  };

  const tryFormStation = (): void => {
    if (stations.length >= MAX_STATIONS) return;
    const active = new Set(stations.map((s) => s.compound));
    const compound = pickCompound(active);
    if (!compound) return;
    const [a, b] = REACTIONS[compound];
    // producer: free, off cooldown, empty or already holding the compound
    const prod = freeLab((l) => l.cooldown === 0 && (l.mineral === null || l.mineral === compound));
    if (!prod) return;
    prod.reserved = true;
    // two sources within range 2 of the producer, free, holding nothing useful yet
    const pool = neighbors2[prod.id]
      .map((id) => labs[id])
      .filter((l) => !l.reserved && (l.mineral === null || l.amount === 0));
    if (pool.length < 2) { prod.reserved = false; return; }
    const srcA = pool[0];
    const srcB = pool[1];
    srcA.reserved = true;
    srcB.reserved = true;
    srcA.mineral = a; srcA.amount = 0;
    srcB.mineral = b; srcB.amount = 0;
    prod.mineral = compound;
    stations.push({
      compound, a, b, prod: prod.id, srcA: srcA.id, srcB: srcB.id,
      made: 0, batch: args.batch, phase: "loadA",
    });
  };

  const releaseStation = (s: Station): void => {
    for (const id of [s.prod, s.srcA, s.srcB]) {
      labs[id].reserved = false;
    }
    // leftover reactant in a source is wasted back to terminal (tender-free
    // bookkeeping: models the tender eventually reclaiming it; kept simple)
    for (const id of [s.srcA, s.srcB]) {
      const l = labs[id];
      if (l.mineral && l.amount > 0) { terminal[l.mineral] = (terminal[l.mineral] ?? 0) + l.amount; }
      l.mineral = null; l.amount = 0;
    }
  };

  // ---- the tender: choose and advance ONE stroke of work --------------------
  const neededLoad = (): TenderJob | null => {
    // priority: drain a finished producer, else load the highest-tier station's
    // source that is short of its batch requirement.
    const drain = stations.find((s) => s.phase === "drain");
    if (drain) return { kind: "drain", labId: drain.prod };
    // stations waiting on reactant, deepest first (pull material upward)
    const loaders = stations
      .filter((s) => s.phase === "loadA" || s.phase === "loadB")
      .sort((x, y) => depthOf(y.compound) - depthOf(x.compound));
    for (const s of loaders) {
      const want = s.phase === "loadA" ? s.a : s.b;
      const lab = labs[s.phase === "loadA" ? s.srcA : s.srcB];
      const need = Math.min(s.batch, LAB_MINERAL_CAPACITY) - lab.amount;
      if (need > 0 && availableInTerminal(want)) {
        return { kind: "load", res: want, labId: lab.id, want: need };
      }
    }
    return null;
  };

  const advanceTender = (): void => {
    // combined mode: withdraw + deposit same tick (engine likely allows this).
    // default: one stroke per tick.
    const doWithdraw = (): boolean => {
      if (tender.carrying) return false;
      if (!tender.job) tender.job = neededLoad();
      const job = tender.job;
      if (!job) return false;
      if (job.kind === "load") {
        const avail = terminal[job.res] ?? 0;
        const amt = Math.min(args.carry, job.want, avail);
        if (amt <= 0) { tender.job = null; return false; }
        terminal[job.res] = avail - amt;
        tender.carrying = { res: job.res, amt };
        return true;
      } else {
        const lab = labs[job.labId];
        if (lab.amount <= 0) { tender.job = null; return false; }
        const amt = Math.min(args.carry, lab.amount);
        lab.amount -= amt;
        const res = lab.mineral!;
        if (lab.amount === 0) lab.mineral = null;
        tender.carrying = { res, amt };
        return true;
      }
    };
    const doDeposit = (): boolean => {
      if (!tender.carrying || !tender.job) return false;
      const job = tender.job;
      const carry = tender.carrying;
      if (job.kind === "load") {
        const lab = labs[job.labId];
        const space = LAB_MINERAL_CAPACITY - lab.amount;
        const put = Math.min(carry.amt, space);
        lab.mineral = carry.res;
        lab.amount += put;
        const back = carry.amt - put;
        if (back > 0) terminal[carry.res] = (terminal[carry.res] ?? 0) + back;
      } else {
        // draining a producer -> terminal, or bank the final target
        if (carry.res === target) { banked[target] = (banked[target] ?? 0) + carry.amt; producedTarget += carry.amt; }
        else terminal[carry.res] = (terminal[carry.res] ?? 0) + carry.amt;
      }
      tender.carrying = null;
      tender.job = null;
      return true;
    };

    let acted = false;
    if (args.combined) {
      const w = doWithdraw(); if (w) tenderIntents++;
      const d = doDeposit(); if (d) tenderIntents++;
      acted = w || d;
    } else {
      acted = tender.carrying ? doDeposit() : doWithdraw();
      if (acted) tenderIntents++;
    }
    if (acted) tenderBusyTicks++;
  };

  // ---- reactions ------------------------------------------------------------
  const react = (): void => {
    for (const s of stations) {
      if (s.phase !== "cook") continue;
      const P = labs[s.prod];
      if (P.cooldown > 0) continue;
      const A = labs[s.srcA];
      const B = labs[s.srcB];
      if (A.amount < LAB_REACTION_AMOUNT || B.amount < LAB_REACTION_AMOUNT) continue;
      if (P.amount + LAB_REACTION_AMOUNT > LAB_MINERAL_CAPACITY) continue;
      if (A.cooldown > 0 || B.cooldown > 0) readsAcrossCooldown++;
      A.amount -= LAB_REACTION_AMOUNT;
      B.amount -= LAB_REACTION_AMOUNT;
      P.amount += LAB_REACTION_AMOUNT;
      P.mineral = s.compound;
      P.cooldown = REACTION_TIME[s.compound];
      s.made += LAB_REACTION_AMOUNT;
      reactionsRun++;
      if (isBase(s.a)) baseConsumed[s.a] = (baseConsumed[s.a] ?? 0) + LAB_REACTION_AMOUNT;
      if (isBase(s.b)) baseConsumed[s.b] = (baseConsumed[s.b] ?? 0) + LAB_REACTION_AMOUNT;
    }
  };

  const advanceStations = (): void => {
    for (const s of stations) {
      const A = labs[s.srcA];
      const B = labs[s.srcB];
      const P = labs[s.prod];
      if (s.phase === "loadA" && A.amount >= Math.min(s.batch, LAB_MINERAL_CAPACITY)) s.phase = "loadB";
      if (s.phase === "loadB" && B.amount >= Math.min(s.batch, LAB_MINERAL_CAPACITY)) s.phase = "cook";
      if (s.phase === "cook") {
        const dry = A.amount < LAB_REACTION_AMOUNT || B.amount < LAB_REACTION_AMOUNT;
        if (s.made >= s.batch || (dry && P.amount > 0)) s.phase = "drain";
      }
    }
    // remove finished (drained) stations
    for (let i = stations.length - 1; i >= 0; i--) {
      const s = stations[i];
      if (s.phase === "drain" && labs[s.prod].amount === 0) {
        releaseStation(s);
        stations.splice(i, 1);
      }
    }
  };

  // ---- main loop ------------------------------------------------------------
  const BASE_SUPPLY = 100000; // terminal base minerals = the INPUT (assumed supplied)

  // Sustainability = conservation: labs + every intermediate buffer must return
  // to their starting fill over the window. Only bases (down) and the target
  // (up) may net-change. Anything else drifting means an intermediate is being
  // drained from a buffer faster than it is made -> not steady state.
  const heldTotal = (c: string): number => {
    let v = terminal[c] ?? 0;
    for (const l of labs) if (l.mineral === c) v += l.amount;
    if (tender.carrying && tender.carrying.res === c) v += tender.carrying.amt;
    return v;
  };
  const labMaterial = (): number => labs.reduce((s, l) => s + l.amount, 0);

  let warmupBanked = 0;
  const snapInter: Record<string, number> = {}; // intermediate stock at warmup
  let snapLabMat = 0;
  const WARMUP = Math.min(4000, Math.floor(args.ticks / 4));

  for (let tick = 0; tick < args.ticks; tick++) {
    // sustainable base supply (miners/market keep the terminal stocked)
    for (const base of BASES) if (terminal[base] < BASE_SUPPLY) terminal[base] = BASE_SUPPLY;

    for (const l of labs) if (l.cooldown > 0) l.cooldown--;

    react();
    advanceTender();
    advanceStations();
    while (stations.length < MAX_STATIONS) {
      const before = stations.length;
      tryFormStation();
      if (stations.length === before) break;
    }

    if (tick === WARMUP) {
      warmupBanked = producedTarget;
      snapLabMat = labMaterial();
      for (const c of tree) if (c !== target) snapInter[c] = heldTotal(c);
    }
  }

  // ---- report ---------------------------------------------------------------
  const steadyTicks = args.ticks - WARMUP;
  const steadyProduced = producedTarget - warmupBanked;
  const ratePerK = (steadyProduced / steadyTicks) * 1000;

  // conservation check: intermediate + lab drift over the steady window
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
  // "same fill at end as start": drift must be negligible vs the output rate
  const tol = Math.max(0.5, ratePerK * 0.02);
  const conserved = Math.abs(maxDrift) <= tol && Math.abs(labDriftPerK) <= tol;

  console.log("");
  console.log(`Lab reaction-network sim  —  spec 31 layout (10 labs, 2 feeder spots, 1 tender)`);
  console.log(`  target compound : ${target}   (tree depth ${depthOf(target)}, ${tree.length} intermediates)`);
  console.log(`  tender model    : ${args.combined ? "withdraw+deposit same tick" : "one stroke/tick (withdraw XOR deposit)"}, carry ${args.carry}`);
  console.log(`  ticks           : ${args.ticks}  (steady-state window: last ${steadyTicks})`);
  console.log(`  input assumption: base minerals ${BASES.size ? [...BASES].join(" ") : ""} supplied to terminal (the INPUT)`);
  console.log("");
  console.log(`  OUTPUT`);
  console.log(`    ${target} produced      : ${steadyProduced} over window  (${ratePerK.toFixed(1)} / 1000 ticks)`);
  console.log(`    reactions run        : ${reactionsRun}`);
  console.log(`    reads across cooldown: ${readsAcrossCooldown}  (source lab itself cooling — the spec-31 exploit)`);
  console.log(`    tender utilisation   : ${((tenderBusyTicks / args.ticks) * 100).toFixed(1)}%  (${tenderBusyTicks}/${args.ticks} strokes used, carry ${args.carry})`);
  const intentsPerK = (tenderIntents / args.ticks) * 1000;
  console.log(`    tender CPU           : ${intentsPerK.toFixed(0)} intents/1k = ${(intentsPerK * 0.2).toFixed(1)} CPU/1k ticks (0.2 CPU/intent), ${(producedTarget > 0 ? (tenderIntents * 0.2) / producedTarget : 0).toFixed(2)} CPU per ${target}`);
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
      `only bases in, ${target} out, at ${ratePerK.toFixed(1)}/1k ticks.`
    : `NOT SUSTAINABLE — ${maxDriftC || "lab fill"} drifts ${(Math.abs(maxDrift) > Math.abs(labDriftPerK) ? maxDrift : labDriftPerK).toFixed(2)}/1k ` +
      `(> tol ${tol.toFixed(2)}); a buffer is bleeding, the rate above is borrowed not earned.`;
  console.log(`  verdict: ${verdict}`);
  console.log("");
}

run(parseArgs(process.argv.slice(2)));
