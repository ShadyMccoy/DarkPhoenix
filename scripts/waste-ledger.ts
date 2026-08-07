/**
 * @fileoverview Waste ledger (spec 15 phase 1) - every leak as a number.
 *
 * Reads two telemetry captures (fixtures) and prints the ledger: each row
 * computed from data, ranked FAIL > WARN > ok. The audit loop runs this FIRST
 * each cycle; any FAIL outranks the symptomatic triage checklist.
 *
 * Decision symmetry (spec 14): every economic constant here is IMPORTED from
 * the module the bot runs - the ledger can only drift from the bot if the bot
 * drifts from itself. Fleet body ratios are MEASURED from the capture's actual
 * bodies where a fleet exists (fallback ratios only when a fleet is empty).
 *
 * Usage: npm run audit:ledger [-- --capture <path|latest> --baseline <path|prev>]
 *
 * @module scripts/waste-ledger
 */

import * as fs from "fs";
import * as path from "path";
import {
  BODY_COSTS,
  CARRY_MOVE_PAIR_COST,
  CLAIM_LIFETIME,
  CREEP_LIFETIME,
  INVADER_TAX_PER_ENERGY,
  LINK_TRANSFER_LOSS,
  MINER_COST,
  MINER_PARTS,
  RESERVER_DUTY,
  SOURCE_BUFFER_DEFER_THRESHOLD,
  SOURCE_RATE,
  SOURCE_REGEN_TIME,
  SPAWN_PARTS_PER_TICK,
  carryPartsFor,
  effectiveLife,
  haulerOverhead,
  minerOverhead,
  pileDecayBudget,
  reserverSpawnLoad,
  roomGuardSpawnLoad,
  GUARD_PARTS_PER_ROOM,
  tombstoneLossBudget
} from "../src/economy/primitives";
import { BASE_RESERVE, MAX_SURPLUS_DRAW, SURPLUS_DRAIN_TICKS, bankFedControllerRate } from "../src/economy/bank";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * METHODOLOGY STAMP (owner 2026-08-01). Every report prints it, and two
 * reports are only directly comparable at the SAME stamp.
 *
 * Bump it whenever HOW a figure is computed changes - a new account, a
 * reclassified line, a changed budget derivation, a corrected sign. Do NOT
 * bump for a new capture, a threshold tweak that changes only a verdict, or a
 * wording change. The point is that a historical fiscal close carries the
 * methodology it was produced under, so a year-over-year comparison can say
 * "these are not comparable" instead of silently mixing two definitions - the
 * failure mode that made P10 look like a real 28 e/t leak for four cycles.
 *
 * 1: energy account (revenue / direct / overhead / appropriations / residual),
 *    budget-vs-actual-vs-variance, source P&L, controller variance bridge,
 *    ground rot split, capital vs operating, reserving as COGS.
 * 11: THE BUDGET COLUMN BALANCES BY CONSTRUCTION (owner 2026-08-04: "I think
 *    our budget would actually be unbalanced... it should just be zero or
 *    something"). The bank BUDGET line becomes the PLAN'S RESIDUAL -
 *    delivered budget less every priced line (fleet, link tax, loss budgets,
 *    controller, construction) - so the budget column sums to ZERO
 *    identically. #4-#10 printed the solver's routed net bank flow there
 *    (storage alloc - bank-out), which mixes bases with the priced spawn
 *    lines: t72773737 printed a -55.16 draw whose destination was a 117 e/t
 *    spawn-sink claim against ~36.5 physically convertible - a 79.85 e/t
 *    hole in the column, and the bridge booked the fiction as "bank draw
 *    budgeted but not performed" (+71.73, mostly phantom). The routed net
 *    stays visible in the over-routing note; the BRIDGE re-derives from the
 *    balanced column (delivered gap / fleet execution / losses+residual /
 *    bank behavior). A #10 bank budget and a #11 bank budget are NOT
 *    comparable; #10 controller bridges are voided, not restated. P12 is
 *    re-pinned the same commit: published allocation vs the phase-D law's
 *    cap (bankFedControllerRate), replacing the retired runtime-constant
 *    model whose negative decomposition printed "Infinity x".
 * 10: THE CURE'S COST: the recovery fleet's spend (v30 scavenge sub-counter)
 *    splits out of the evacuation line and prices against witnessed
 *    recoveries in a RECOVERY P&L memo; tombstone gross/credit published.
 * 9: EVERY LOSS HAS A BUDGET (spec 42 stage A). The MEASURED LOSSES block
 *    gains a BUDGET column priced by primitives: pile decay budgets ZERO
 *    (pileDecayBudget at the gate's own design point - the plan intends every
 *    mouth AT the container cap, so all measured ground decay is priced
 *    UNFAVORABLE variance pointing at the haul deficit, no longer a neutral
 *    memo); tombstones budget the invader tax on R1's capacity basis
 *    (tombstoneLossBudget - one constant home, both rows move at the
 *    >=10-window swap); repair budgets the structure-decay ACCRUAL (the
 *    depreciation memo's shortfall becomes a priced variance). The L1 gauge
 *    FAILs any line breaching 25% of budget (0.25 e/t noise floor). A #8
 *    losses block has no budget side; #9 variances are new information, not
 *    a change in the measured actuals.
 * 8: BUDGETS PRICE THE SHIPPED BEHAVIOR, RECEIPTS BOOK THE DEBIT. Three
 *    second-implementation lies die at once, so #7-vs-#8 variances shift by
 *    their sum (~12 e/t of the #7 surface was these, not economics):
 *    (a) the reserver budget prices RESERVER_DUTY 0.5 via the new
 *    primitives.reserverSpawnLoad (the whole +8.02 F reservation variance was
 *    this script re-pricing continuous duty 1.0 - measured 8.83 = 0.524x
 *    budget, the duty ratio); (b) the evacuation budget converts the plan's
 *    OWN paved-aware parts (spawnParts x 50e exactly) instead of
 *    haulerOverhead's flat 1:1 100e/CARRY (which carried -2.82 e/t of slack
 *    that MASKED breach; the plan's energy side keeps the 1:1 price until the
 *    phase-1 repricing and the footer prints the internal gap); (c) the
 *    blackbox spawn receipt's `cost` becomes the energy actually DEBITED for
 *    the body - the demand now prices the body it elicits per route ratio
 *    (2:1 road = 75e/CARRY, 1:2 swamp = 150e/CARRY) and executeSpawn returns
 *    {parts, cost} - where #4-#7 receipts booked the GRANT (+3.99 e/t of
 *    phantom evacuation spend, 63-65 e/part observed against a physical 50).
 *    A #7 spawn line and an #8 spawn line differ by booking bias; do not
 *    read the drop as a behavior change.
 * 7: SPAWN COSTS are differenced from CUMULATIVE role totals (core v25,
 *    Memory.spawnLedger) instead of read off the blackbox ring, completing what
 *    #5 did for losses: every account side now spans the capture window and the
 *    WINDOW INCOHERENCE guard goes structurally quiet on modern capture pairs.
 *    Two changes of meaning: (a) a #6 spawn line is a post-deploy ring sample
 *    (480t live) while a #7 line is the full window - NOT comparable across the
 *    bump; (b) the cumulative side accrues the energy actually DEBITED for the
 *    body where the ring records the budget GRANTED, so #7 spawn lines read
 *    slightly lower on the same colony, and scout/bootstrap purchases (which
 *    bypass the director's receipt) are counted for the first time. Tombstone
 *    CAUSE also becomes evidence-based here: killed/expired come from the death
 *    watch (last-seen TTL vs deathTime), an unresolvable death lands in an
 *    honest UNKNOWN bucket, and the #4-#6 "expired 100%" readings (a misread
 *    constant field, flagged SUSPECT by their own audit line) are voided.
 * 6: the LINK TRANSFER TAX moves from LOSSES into DIRECT COST OF MINING, beside
 *    evacuation (owner 2026-08-02: "link tax is similar to haul body"). Both are
 *    per-source costs scaling with the flow they move; only the currency differs
 *    (hauler body = spawn parts, link hop = delivered energy). It nets against
 *    NET MINING MARGIN and against each link-served source in the P&L, so a
 *    link-served source can no longer show zero transport. Same energy, same
 *    residual - a #5 margin and a #6 margin differ by the tax.
 * 5: loss lines are differenced from CUMULATIVE totals (core v22) instead of
 *    read as since-reset rates, so the measured window equals the capture
 *    window at any length. Before this the loss window was capped by VM
 *    lifetime (480t against a 1251-tick capture at t72722670) and a 1500-tick
 *    fiscal month was structurally unmeasurable. #4 loss rates are a phase
 *    sample of an arbitrary post-reset window; #5 ones are not.
 * 4: the LINK TRANSFER TAX joins measured losses - the engine destroys 3% of
 *    every link hop (2.59 e/t measured at t72721419) and it had been inside the
 *    residual because LINK_LOSS_RATIO existed only in the telemetry meter. The
 *    planner now prices one hop per link-served source too, so plan and actual
 *    stop disagreeing about whether link haulage is free.
 * 3: revenue is MINED, not capacity - the miners' own heldFrac stamps price the
 *    capacity a buffer-full gate forgoes (30.28 e/t of 100 at t72721419), which
 *    #2 booked as income. Plus a WINDOW COHERENCE guard: the residual is a
 *    difference of rates drawn from three different windows (capture pair,
 *    blackbox ring, loss meter) and is flagged untrustworthy when they diverge
 *    more than 2x. A #2 residual sits on inflated revenue; a #3 one does not.
 * 2: the residual is SPLIT into line items (core v20 loss meter): ground pile
 *    decay by the engine's own ceil rule (superseding #1's summed-pile
 *    estimate, which missed the per-pile ceiling and saw only source-adjacent
 *    piles), tombstone energy destroyed, and measured repair spend. Structure
 *    decay enters as a DEPRECIATION MEMO, never as cash - its cash cost IS the
 *    repair line, and booking both would double-count the same wear. A #1
 *    residual and a #2 residual are NOT comparable: #2 is smaller by exactly
 *    the newly-attributed losses.
 */
// 12 (2026-08-05): the capacity line excludes DEFUNDED sources - the plan
//    now reads the same hostileRooms() lens the corps' defense gates read
//    (invader occupations + creep marks), so "mining capacity" is what the
//    runtime will actually staff, with the exclusion printed as a memo
//    line. A #11 capacity (phantom-inclusive) and a #12 capacity differ by
//    exactly the occupied rooms' rates; forgone shrinks by the same amount.
/**
 * #13 (owner 2026-08-06): ADDITIVE only - a TARGETS block under the residual
 * stating the owner's two standing objectives as measured ratios.
 *
 * #14 (owner 2026-08-06, same day): the controller ratio's DENOMINATOR is
 * corrected from `mined - fleet` to CAPACITY. *"42/110 is less than 50"* -
 * and the owner is right on both the arithmetic and the principle. #13 read
 * 42.20/45.78 = 92% MET while the owner read 42.20/110 = 38% MISS, off the
 * same account. Of the four defensible denominators
 *
 *     capacity 110.00 -> 38.4%   gross mined 87.70 -> 48.1%
 *     mined-fleet 45.78 -> 92.2%  mined-fleet-losses 27.60 -> 152.9%
 *
 * #13 took the second-most-flattering. A bar cleared at 92% cannot fail,
 * which is the definition of a useless target. CAPACITY is the honest one: it
 * charges forgone mining, the fleet AND the losses to the same ratio, so the
 * number moves when any of the three does. Prior windows' TARGET lines are
 * NOT comparable across this bump; every other account line is unchanged.
 */
/**
 * #15 (audit t72842655): P8 - and therefore the ENERGY ACCOUNT's construction
 * ACTUAL line, which reads P8 verbatim - now MEASURES build progress from the
 * construction corps' `produced` counters instead of summing three floors
 * (home-room siteProgress, the road-receipts ratchet, poolWork decrease). All
 * three read state that vanishes when a site completes, so a remote program
 * that finished was invisible to every one of them: W43N21 built 6,040 units
 * in 1,314 ticks clearing 17 of 18 road sites while the account booked
 * construction at 0.42 e/t against a 30.00 budget. A #14 construction line and
 * a #15 one differ by exactly the completed-and-departed sites, and the
 * CONTROLLER VARIANCE BRIDGE's "construction above budget" term moves with it -
 * never quote one against the other.
 */
/**
 * #16 (spec 51 phase 2): the `defense (guards)` BUDGET line now reads the
 * PLAN's own price - `infraInputs.guardedRooms * roomGuardSpawnLoad()` - on any
 * capture that carries the count, instead of reconstructing it from the
 * measured bodies standing at capture time.
 *
 * #14 introduced that reconstruction because the plan charged guards nothing;
 * it closed the "-" budget but left the comparison circular - measured bodies
 * on both sides of a variance can never disagree. With the plan pricing guards
 * (raidGuardKind, from the armed-room lens), a budget-vs-actual gap on this line
 * is now a real F1 signal. A #15 defense line and a #16 one differ whenever the
 * armed-room count at solve time differs from the guards standing at capture
 * time - which is precisely the information #14 could not show.
 */
export const METHODOLOGY = 16;

export interface LedgerRow {
  id: string;
  name: string;
  value: number;
  unit: string;
  verdict: "FAIL" | "WARN" | "ok";
  detail: string;
}

const FIXTURE_DIR = path.join(__dirname, "..", "test", "fixtures", "telemetry");

function listFixtures(): string[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter(f => /^shard1-t\d+\.json$/.test(f))
    .sort((a, b) => Number(b.match(/t(\d+)/)![1]) - Number(a.match(/t(\d+)/)![1]))
    .map(f => path.join(FIXTURE_DIR, f));
}

function loadCapture(spec: string, fallbackIndex: number): any {
  if (spec !== "latest" && spec !== "prev") return JSON.parse(fs.readFileSync(spec, "utf8"));
  const files = listFixtures();
  const file = files[spec === "latest" ? 0 : fallbackIndex];
  if (!file) throw new Error(`no fixture for --${spec === "latest" ? "capture" : "baseline"} in ${FIXTURE_DIR}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Measured parts-per-WORK from an actual upgrader body; 4/3 fallback (15W1C4M). */
function upgraderPartsPerWork(corps: any[]): number {
  for (const c of corps) {
    if (c.kind === "upgrade" && c.bodyParts > 0 && (c.body.work ?? 0) > 0) return c.bodyParts / c.body.work;
  }
  return 4 / 3;
}

function fleetParts(corps: any[], kind: string, fallback: number): number {
  for (const c of corps) if (c.kind === kind && c.creepCount > 0) return c.bodyParts / c.creepCount;
  return fallback;
}

/**
 * P4: the WHOLE plan's amortized spawn maintenance (parts/tick) vs the
 * physical ceiling - including every line the planner's own mining budget
 * never prices (transient-route haulers, consumers, infra). The plan is
 * infeasible when this exceeds spawnCount * SPAWN_PARTS_PER_TICK: actuals
 * then converge to the ceiling, never to the plan (measured 2026-07-18:
 * 0.561 p/t vs 0.333, 168%, while progress ran at ~3 of a 115 e/t plan).
 */
/**
 * ENERGY per BODY PART, by fleet class - the conversion that lets every planned
 * class carry an ENERGY budget, not just a parts budget (owner 2026-08-01: "we
 * can always convert body parts into energy ... per creep body get the energy
 * equivalent and sum it up").
 *
 * I previously refused this conversion as "biased across classes" and left four
 * budget lines blank. That over-generalised F1's lesson. F1's warning is against
 * using COST as a proxy for spawn TIME - a CLAIM part is 600e against 50e for
 * CARRY, so cost mis-ranks classes by build pressure. It is NOT an argument
 * against converting per BODY: each class's shape is known, so its energy per
 * part is exact. Only a FLAT rate across classes would be biased.
 */
const ENERGY_PER_PART: Record<string, number> = {
  // 5 WORK + 3 MOVE = 650e over 8 parts
  miners: MINER_COST / MINER_PARTS,
  // every hauler-shaped body is CARRY+MOVE pairs: 100e per 2 parts
  "source-route haulers": CARRY_MOVE_PAIR_COST / 2,
  "transient-route haulers (unbudgeted)": CARRY_MOVE_PAIR_COST / 2,
  tenders: CARRY_MOVE_PAIR_COST / 2,
  feeder: CARRY_MOVE_PAIR_COST / 2,
  // CLAIM+MOVE pairs: (600 + 50) / 2
  "reservers (claim life)": (BODY_COSTS.CLAIM + BODY_COSTS.MOVE) / 2
};

export function planSpawnLoad(cap: any): {
  total: number;
  lines: Array<[string, number, number]>;
  /** class -> ENERGY/tick the plan's own fleet for that class implies. */
  energy: Record<string, number>;
} {
  const flow = cap.data.flow;
  const corps: any[] = cap.data.corps?.corps ?? [];
  const rooms = cap.data.core?.rooms ?? [];
  const banked = rooms[0]?.storageEnergy ?? 0;
  const lines: Array<[string, number, number]> = []; // [name, parts, partsPerTick]

  let p = 0,
    l = 0;
  for (const s of flow.sources ?? []) {
    p += MINER_PARTS;
    l += MINER_PARTS / effectiveLife(s.spawnDistance);
  }
  lines.push(["miners", p, l]);

  let sp = 0,
    sl = 0,
    tp = 0,
    tl = 0;
  for (const h of flow.haulers ?? []) {
    // ECHO the planner's OWN per-route spawn-parts (CorpPlanner sets
    // `spawnParts = ((paved?1.5:2)*carryPartsFor(take,dEff))/effectiveLife(d)`)
    // rather than re-deriving it here (owner 2026-07-22: "eliminate the ledger
    // vs planner drift at the root by having them share the same code"). The
    // old recompute `2*carryParts` hardcoded the UNPAVED body for every route,
    // so a paved-remote colony over-counted its hauler load and P4 read
    // infeasible (t72508069: 1.01x FAIL where the planner's paved-aware number
    // is 0.90x). The parts figure (display) backs out of the load over the
    // same effectiveLife so the "Np" reads consistently. Legacy captures with
    // no spawnParts fall back to the conservative 2x recompute (no crash).
    const life = effectiveLife(h.distance);
    const load = h.spawnParts ?? (2 * h.carryParts) / life;
    const parts = h.spawnParts !== undefined ? h.spawnParts * life : 2 * h.carryParts;
    const transient = h.sourceId.startsWith("scavenge") || h.sourceId.startsWith("bank");
    if (transient) {
      tp += parts;
      tl += load;
    } else {
      sp += parts;
      sl += load;
    }
  }
  lines.push(["source-route haulers", sp, sl]);
  lines.push(["transient-route haulers (unbudgeted)", tp, tl]);

  // CONSTRUCTION, charged THROUGH the plan's all-in price (spec 34 P4): the
  // segment echoes the build commission's operationSpawnLoad (WORK bodies +
  // supply vector) as sinks[].spawnLoad - the class stops being invisible to
  // P4, and for the right reason: an ECHO of the planner's own number, never
  // a ledger-side re-derivation. Legacy captures without the echo emit no
  // line (exactly the pre-v11 behavior - no fabricated figures).
  let cp = 0,
    cl = 0;
  for (const k of (flow.sinks ?? []).filter((s: any) => s.type === "construction" && s.spawnLoad !== undefined)) {
    cl += k.spawnLoad;
    cp += k.spawnLoad * effectiveLife(k.spawnDist ?? 8);
  }
  if (cl > 0) lines.push(["construction (all-in)", cp, cl]);

  const ctrl = (flow.sinks ?? []).find((s: any) => s.type === "controller");
  if (ctrl?.workParts) {
    const parts = ctrl.workParts * upgraderPartsPerWork(corps);
    lines.push(["upgraders (plan WORK)", parts, parts / effectiveLife(10)]);
  }
  const relay = bankFedControllerRate(banked, BASE_RESERVE);
  // LINK-FED feeder charges at distance 1, not the nominal 6 (owner
  // 2026-07-22 "the feeder seems way too large": this line overcharged 64p
  // vs the true ~18-22p link-fed body all week, inflating P4 ~0.03
  // parts/t). Read the corp's own stamp - decision symmetry, not a guess.
  // NOTE: deliberately the PLAN-side trip model, NOT the corp's realized
  // neededCarry stamp - P4's budget-dry identity is constructed from the
  // plan's own formulas, and injecting actual bodies breaks it at every
  // equilibrium (the t72420007 boundary pin). The parked-post body shrink
  // (2026-07-22) shows up on the ACTUAL side of plan-vs-actual instead.
  const feederLinkFed = corps.find(c => (c.id ?? "").includes("controllerFeeder"))?.sizing?.linkFed === true;
  const feederDist = feederLinkFed ? 1 : 6;
  const feederParts = 2 * carryPartsFor(relay, feederDist);
  lines.push([
    `feeder @ relay ${Math.round(relay)}${feederLinkFed ? " (link-fed d1)" : ""}`,
    feederParts,
    feederParts / effectiveLife(feederDist)
  ]);

  const tenderTarget = corps.find(c => c.kind === "tender")?.sizing?.target ?? 3;
  const tenderBody = fleetParts(corps, "tender", 24);
  lines.push(["tenders", tenderTarget * tenderBody, (tenderTarget * tenderBody) / 1500]);

  // PER-ROOM corps are SUMMED, never sampled (measured t72683137): reservation
  // is one corp PER RESERVED ROOM, and `find()` priced only the first. The live
  // colony ran SEVEN, each targets:1 / 4 parts - P4 charged 4 parts where 28
  // stood (0.0074 vs 0.0519 parts/t, a 7x under-count) on a class that was
  // 21.7% of MEASURED spawn spend and ~26% of the session's unexplained
  // plan-vs-actual parts gap. P4's charter is ALL fleet classes; a sampling
  // read of a per-room class breaks it silently.
  const resFallback = fleetParts(corps, "reservation", 4);
  const resParts = corps
    .filter(c => c.kind === "reservation")
    .reduce((sum, c) => {
      const targets = c.sizing?.targets ?? 0;
      // Each corp's OWN measured body when it has one; the fleet body otherwise
      // (a corp between deaths still costs its replacement).
      const body = c.creepCount > 0 ? c.bodyParts / c.creepCount : resFallback;
      return sum + targets * body;
    }, 0);
  // Amortized by the ONE home (methodology #8): reserverSpawnLoad prices the
  // SHIPPED duty cycle (RESERVER_DUTY stints over the walk-adjusted claim
  // life). This script's own continuous-duty recompute was the entire +8.02 F
  // "favorable" reservation variance - measured spend 8.83 e/t was 0.524x a
  // 16.85 budget, i.e. exactly the duty ratio the audit refused to price.
  const resLoad = reserverSpawnLoad(resParts);
  lines.push(["reservers (claim life)", resParts, resLoad]);

  // DEFENSE. raidGuard was F1's one standing UNPRICED class (0.027 p/t live,
  // 1.73 e/t of spend with a "-" budget on the account's defense line), so
  // methodology #14 reconstructed the price here from MEASURED bodies. That
  // reconstruction was itself a second book - the plan still charged nothing.
  //
  // Since spec 51 phase 2 the PLAN prices it (`roomGuardSpawnLoad` per armed
  // room, from the same `guardTargetsFor` lens the corp holds its posts with),
  // and this line reads the plan's own count whenever the capture carries it.
  // The measured fallback stays for pre-spec-51 captures ONLY - on a modern
  // capture, a gap between this line and the account's measured defense spend is
  // now a real F1 signal (the plan disagreeing with the runtime) instead of a
  // tautology comparing measured bodies to themselves.
  //
  // The raid-driven SURGE (replacements bought mid-fight) is not here either
  // way: that is the invader tax, priced at ADMISSION.
  const guardedRooms: number | undefined = flow.fleetCharge?.infraInputs?.guardedRooms;
  const guardParts = corps
    .filter(c => c.kind === "raidGuard")
    .reduce((sum, c) => sum + (c.creepCount > 0 ? c.bodyParts : 0), 0);
  if (guardedRooms !== undefined) {
    const planned = guardedRooms * roomGuardSpawnLoad();
    if (planned > 0) lines.push(["defense (guards)", guardedRooms * GUARD_PARTS_PER_ROOM, planned]);
  } else if (guardParts > 0) {
    lines.push(["defense (guards)", guardParts, guardParts / 1500]);
  }

  const total = lines.reduce((s, [, , x]) => s + x, 0);

  // Per-class ENERGY/tick from the SAME parts figures above. Classes whose body
  // shape is mixed (upgraders, construction) take the measured fleet's own
  // energy-per-part - the same discipline `upgraderPartsPerWork` and
  // `fleetParts` already use on this function's parts side.
  const mixedRate = (kind: string, dflt: number): number => {
    const own = corps.filter(c => c.kind === kind && c.bodyParts > 0);
    if (own.length === 0) return dflt;
    let e = 0;
    let n = 0;
    for (const c of own) {
      for (const [part, count] of Object.entries((c.body ?? {}) as Record<string, number>)) {
        e += count * (BODY_COSTS[part.toUpperCase() as keyof typeof BODY_COSTS] ?? 50);
        n += count;
      }
    }
    return n > 0 ? e / n : dflt;
  };
  const energy: Record<string, number> = {};
  for (const [name, , load] of lines) {
    const flat = ENERGY_PER_PART[name] ?? (name.startsWith("feeder") ? CARRY_MOVE_PAIR_COST / 2 : undefined);
    const rate =
      flat ??
      (name.startsWith("upgraders")
        ? mixedRate("upgrade", 85)
        : name.startsWith("defense")
          ? mixedRate("raidGuard", 80)
          : mixedRate("construction", 65));
    energy[name] = load * rate;
  }
  return { total, lines, energy };
}

/** HOME-room roles run inside the owned room; an early death there is a bot
 * signal, not the invader/revocation noise the remote-exposed roles (haul,
 * mine, reserve, scout, fight) eat as the price of leaving the walls. */
const HOME_ROLES = new Set(["upgrader", "tanker", "tender", "controllerFeeder", "builder", "bootstrap"]);

/**
 * X5 churn analysis (spec 15): spawn energy lost to EARLY-DEATH rebuilds, read
 * from the blackbox spawn log (segment 5). Discovered live t72509177 - remote
 * haulers were spawned small then replaced full a few hundred ticks later
 * (afford-min-scaled body under a momentary extension dip), and a reserver
 * respawned 25t after itself (below a claim body's ~78t spawn time - a
 * re-order, not a death). Method, so the number can't lie:
 *
 *  - per corp, spawns BEYOND its current staffing are the ones that died and
 *    were replaced (census cross-check) - so fleet GROWTH, e.g. the upgrader
 *    2->3 ramp, never counts as churn (my first hand-count wrongly did);
 *  - each dead spawn is weighted by the fraction of life it did NOT live (gap
 *    to its successor / lifetime), so a natural end-of-life replacement scores
 *    ~0 and only genuinely-early deaths accrue;
 *  - HOME vs REMOTE-exposed split by role: home churn is the bot-controllable
 *    signal the verdict keys on; remote churn is reported but largely
 *    unavoidable (a global reset inflates BOTH for ~1 window - read against the
 *    deploy log).
 *
 * Returns null when the capture predates the blackbox segment (graceful skip).
 */
export function computeChurn(cap: any): {
  churnEnergy: number;
  homeChurn: number;
  remoteChurn: number;
  totalSpawnEnergy: number;
  windowTicks: number;
  worst: string;
  worstGap: number;
} | null {
  const spawns: Array<{ t: number; corp: string; role: string; cost: number }> = (cap.data?.blackbox?.rows ?? [])
    .filter((r: any) => r.k === "spawn" && r.d)
    .map((r: any) => ({ t: r.t, corp: String(r.d.corp), role: String(r.d.role), cost: +r.d.cost || 0 }));
  if (spawns.length < 2) return null;

  const corpsList: any[] = cap.data?.corps?.corps ?? [];
  const staffingOf = (corp: string): number => {
    const c = corpsList.find((x: any) => x.id === corp);
    return c?.creepCount ?? c?.staffing ?? 0;
  };

  const byCorp = new Map<string, Array<{ t: number; role: string; cost: number }>>();
  for (const s of spawns) {
    const arr = byCorp.get(s.corp) ?? [];
    arr.push({ t: s.t, role: s.role, cost: s.cost });
    byCorp.set(s.corp, arr);
  }

  let homeChurn = 0;
  let remoteChurn = 0;
  let worst = "none";
  let worstV = 0;
  let worstGap = Infinity;
  for (const [corp, ss] of byCorp) {
    // A corp of staffing N runs N INDEPENDENT slots. Filled round-robin, a
    // slot's own successor is the spawn N positions later - the CONSECUTIVE
    // spawn is a DIFFERENT slot ~life/N away (and a cohort rebuild wave
    // serialises all N through one spawn ~spawn-time apart). Reading the
    // consecutive gap as one creep's lifetime charged phantom churn to any
    // multi-room corp (measured t72587664: the 4-room reservation corp booked
    // 11828e of "churn" though its per-room cadence was ~656t ~ the 600t claim
    // life - a false WARN on the reserver mechanism the trap list says never to
    // bandaid). The correct lifetime is the SAME-slot gap ss[i+N] - ss[i]; for
    // N=1 that IS the consecutive gap, so single-slot behaviour is unchanged.
    const slots = Math.max(1, staffingOf(corp));
    if (ss.length <= slots) continue; // <= staffing => the fleet GREW, nothing died
    ss.sort((a, b) => a.t - b.t);
    // every spawn with a same-slot successor (i + slots in range) was replaced;
    // the last `slots` spawns are the current incumbents.
    const churned = ss.length - slots;
    for (let i = 0; i < churned; i++) {
      let gap = ss[i + slots].t - ss[i].t;
      const life = ss[i].role === "reserver" ? CLAIM_LIFETIME : 1500;
      // EOL-window exemption (t72651837 phantom, owner 2026-07-29): the
      // stride uses CURRENT staffing, so a fleet that SHRANK mid-window
      // (governor relegation) mispairs a cohort-wave spawn as a slot death
      // (two 4350e bodies bought 153t apart - the spawn's own build time -
      // read as one slot dying at 153t, though both lived full lives). A
      // slot with a natural-lifetime successor ANYWHERE in the log did not
      // churn: if any later spawn sits in [0.9, 1.15]x life from ss[i],
      // that is its real replacement - measure the gap there. Real early
      // deaths (0.2x-life replacements) and re-order loops (<60t) have no
      // such successor and stay caught. EXCUSE-ONLY (max): a window alt may
      // LENGTHEN the measured gap, never shorten it - on a healthy staggered
      // multi-slot corp a DIFFERENT slot's spawn can sit slightly earlier in
      // the window than the true successor, and taking it verbatim would
      // manufacture small churn on exactly the corps this line must not flag.
      for (let m = i + 1; m < ss.length; m++) {
        const alt = ss[m].t - ss[i].t;
        if (alt >= 0.9 * life && alt <= 1.15 * life) {
          gap = Math.max(gap, alt);
          break;
        }
        if (alt > 1.15 * life) break;
      }
      const waste = ss[i].cost * Math.max(0, 1 - gap / life);
      if (HOME_ROLES.has(ss[i].role)) homeChurn += waste;
      else remoteChurn += waste;
      if (waste > worstV) {
        worstV = waste;
        worst = `${corp.replace(/^(hauling|mining|reservation|upgrading|building|moving)-/, "")} ${ss[i].cost}e@${gap}t`;
        worstGap = gap;
      }
    }
  }
  const ts = spawns.map(s => s.t);
  return {
    churnEnergy: homeChurn + remoteChurn,
    homeChurn,
    remoteChurn,
    totalSpawnEnergy: spawns.reduce((a, s) => a + s.cost, 0),
    windowTicks: Math.max(1, Math.max(...ts) - Math.min(...ts)),
    worst,
    worstGap: worstV > 0 ? worstGap : Infinity
  };
}

/**
 * F1's ACTUAL side, bucketed into the same classes `planSpawnLoad` prices.
 *
 * F1 reported "0.286 p/t UNBUDGETED" for five straight cycles while naming
 * only the largest PLANNED class - a different question, and one whose answer
 * never changed. Locating the breach meant hand-bucketing the blackbox ring
 * by role every cycle (t72689264: haulers 0.444 p/t actual vs 0.188 priced =
 * 0.256 of the 0.286 gap, 89%, with the whole remainder in construction and
 * one entirely UNPRICED kind). That is spec 40 Part A's thesis applied to the
 * line that already exists: one number nobody can decompose is worse than a
 * table.
 *
 * The join is the buyer corp's own KIND (segment 4), never a guess from the
 * id string - decision symmetry, same as everywhere else in this file. A kind
 * with no plan line at all is reported separately as UNPRICED: an absent class
 * is a different defect from a mispriced one, and no tuning of an existing
 * line can ever surface it.
 */
export const F1_CLASS_OF_KIND: Record<string, string> = {
  harvest: "miners", // role `hauler` on a harvest corp re-routes below
  construction: "construction (all-in)",
  tender: "tenders",
  controllerFeeder: "feeder",
  reservation: "reservers",
  upgrade: "upgraders",
  // Priced since phase 1 (standing-fleet replacement cadence in
  // planSpawnLoad) - raidGuard was the one class F1 flagged UNPRICED on
  // every live cycle (0.027 p/t / 1.73 e/t of real defense spend).
  raidGuard: "defense (guards)"
};

/** Plan-line prefix that each actual class settles against. */
export const F1_PLAN_PREFIX: Record<string, string[]> = {
  miners: ["miners"],
  haulers: ["source-route haulers", "transient-route haulers"],
  "construction (all-in)": ["construction (all-in)"],
  tenders: ["tenders"],
  feeder: ["feeder"],
  reservers: ["reservers"],
  upgraders: ["upgraders"],
  "defense (guards)": ["defense (guards)"]
};

/**
 * Cost -> parts fallback for rings captured before the spawn row carried a
 * `parts` count. Derived from the archetype bodies the kinds actually build
 * (hauler CARRY+MOVE = 100e/2p; miner 5W+3M = 700e/8p; reserver 2C+2M =
 * 1300e/4p; upgrader 2W+1C+1M = 300e/4p). Estimated lines are LABELLED - the
 * ledger never presents an inference as a measurement.
 */
const F1_ENERGY_PER_PART: Record<string, number> = {
  hauler: 50,
  tanker: 50,
  feeder: 50,
  builder: 100,
  miner: 87.5,
  upgrader: 75,
  reserver: 325,
  guard: 100
};

export function f1Decompose(
  cap: any,
  planLines: Array<[string, number, number]>
): { rows: Array<{ cls: string; actual: number; planned: number; unpriced: boolean }>; estimated: boolean; windowTicks: number } | null {
  const ring: any[] = (cap.data?.blackbox?.rows ?? []).filter((r: any) => r.k === "spawn");
  if (ring.length === 0) return null;
  const corps: any[] = cap.data?.corps?.corps ?? [];
  const kindOf = new Map<string, string>(corps.map(c => [c.id, c.kind]));

  const ts = ring.map(r => r.t);
  const windowTicks = Math.max(1, Math.max(...ts) - Math.min(...ts));
  let estimated = false;
  const actual = new Map<string, number>();
  for (const r of ring) {
    const kind = kindOf.get(r.d.corp) ?? String(r.d.corp).split("-")[0];
    // A hauler is a hauler whoever buys it: the per-source haulers are owned by
    // the HARVEST corp, and the plan prices them on the hauler lines, not the
    // miner line. Route by role first, kind second.
    const cls = r.d.role === "hauler" ? "haulers" : F1_CLASS_OF_KIND[kind] ?? `UNPRICED:${kind}`;
    let parts = r.d.parts;
    if (parts === undefined) {
      estimated = true;
      parts = r.d.cost / (F1_ENERGY_PER_PART[r.d.role] ?? 100);
    }
    actual.set(cls, (actual.get(cls) ?? 0) + parts);
  }

  const rows = [...actual].map(([cls, parts]) => {
    const prefixes = F1_PLAN_PREFIX[cls] ?? [];
    const planned = planLines
      .filter(([name]) => prefixes.some(p => name.startsWith(p)))
      .reduce((a, [, , load]) => a + load, 0);
    return { cls, actual: parts / windowTicks, planned, unpriced: cls.startsWith("UNPRICED:") };
  });
  rows.sort((a, b) => Math.abs(b.actual - b.planned) - Math.abs(a.actual - a.planned));
  return { rows, estimated, windowTicks };
}

/** The reserve target a capture was measured against (plan-persisted, else the floor). */
function resolveReserve(cap: any): number {
  return cap.data.core?.warchestTarget ?? BASE_RESERVE;
}

export function computeLedger(cap: any, base: any): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const core = cap.data.core;
  const bcore = base.data.core;
  const dt = cap.tick - base.tick;
  const flow = cap.data.flow;
  const corps: any[] = cap.data.corps?.corps ?? [];

  // ---- P4 plan spawn-feasibility (the audit gap of 2026-07-18) ----
  const { total, lines } = planSpawnLoad(cap);
  const ceiling = (core.spawns?.length ?? 1) * SPAWN_PARTS_PER_TICK;
  const ratio = total / ceiling;

  // ---- F1 plan FIDELITY (owner doctrine 2026-07-30) ----
  // "More than points what we're chasing is a controllable economy ... plan it
  // all on the abstract level and then it gets implemented faithfully ... we
  // end up having to chase down why is this or that thing happening. That's
  // something to optimize for as well."
  //
  // Fidelity was first-class in SIMS (fid-* grid cells) but had NO production
  // number, so every live divergence this session was found BY HAND: the
  // 100-tile fuel price on a 4-tile pile (spec 37), three bank-drain rates
  // (spec 38), P4's 7x reserver under-count, and a six-capture parts gap
  // (measured 0.649 vs plan 0.478) that no line reported. P4 asks "is the plan
  // PHYSICALLY POSSIBLE"; F1 asks "is the plan what actually HAPPENS" - a plan
  // can be perfectly feasible and still describe a different colony.
  //
  // Two-sided ON PURPOSE: a plan that OVER-states is exactly as uncontrollable
  // as one that under-states, and only the under-stating direction looks like
  // "waste" - so a waste-only ledger is blind to half the failure mode.
  {
    const measured = (core.spawns ?? []).reduce((a: number, s: any) => a + (+s.partsPerTick || 0), 0);
    const hasMeter = (core.spawns ?? []).some((s: any) => s.partsPerTick !== undefined);
    if (hasMeter && total > 0) {
      const fidelity = measured / total;
      const gap = measured - total;
      const worst = [...lines].sort((a, b) => b[2] - a[2])[0];
      // WHICH class is in breach - the question five cycles of "largest
      // planned class" could not answer (see f1Decompose).
      const dec = f1Decompose(cap, lines);
      let breach = "";
      if (dec) {
        const top = dec.rows.filter(r => Math.abs(r.actual - r.planned) >= 0.005).slice(0, 3);
        const unpriced = dec.rows.filter(r => r.unpriced && r.actual > 0);
        if (top.length) {
          breach =
            `; in breach: ` +
            top
              .map(
                r =>
                  `${r.cls.replace("UNPRICED:", "")} ${r.actual.toFixed(3)} vs ${r.planned.toFixed(3)} ` +
                  `(${r.actual > r.planned ? "+" : ""}${(r.actual - r.planned).toFixed(3)})`
              )
              .join(", ");
        }
        if (unpriced.length) {
          breach += `; UNPRICED classes: ${unpriced.map(r => `${r.cls.replace("UNPRICED:", "")} ${r.actual.toFixed(3)} p/t`).join(", ")}`;
        }
        if (breach) breach += ` [over ${dec.windowTicks}t${dec.estimated ? ", parts est. from cost" : ""}]`;
      }
      rows.push({
        id: "F1",
        name: "plan fidelity (measured vs planned spawn load)",
        value: +fidelity.toFixed(2),
        unit: "x planned",
        // 1.25/0.8 = a quarter of the plan unaccounted for in either direction.
        verdict: fidelity > 1.25 || fidelity < 0.8 ? "FAIL" : fidelity > 1.1 || fidelity < 0.9 ? "WARN" : "ok",
        detail:
          `spawn builds ${measured.toFixed(3)} p/t, plan prices ${total.toFixed(3)} p/t` +
          (gap > 0
            ? ` - ${gap.toFixed(3)} p/t UNBUDGETED (${(100 * gap / Math.max(1e-9, measured)).toFixed(0)}% of what the spawn builds is not in the plan)`
            : gap < 0
            ? ` - the plan OVER-states by ${(-gap).toFixed(3)} p/t (a fleet priced but never built)`
            : " - faithful") +
          `; largest planned class: ${worst ? `${worst[0]} ${worst[2].toFixed(3)}` : "n/a"}` +
          breach
      });
    }
  }
  // ---- F2 per-commission fleet fidelity (spec 39 phase 1) ----
  // F1 answers "does the colony build what the plan prices" at CLASS grain;
  // F2 joins each commission's own declared fleet (segment 4 v15 `fleet` -
  // the envelope's role decomposition, Sigma(load) == its price by
  // construction) against the SAME row's measured bodyParts. The leak lands
  // with a commission id attached instead of a class name. Two-sided like F1.
  // Basis honesty: declared `parts` is the steady-state standing target;
  // measured bodyParts includes replacement overlap and walk-in time, so
  // per-row noise is expected - the gauge aggregates and names only the worst
  // offenders. Rows without a declaration (aux kinds until spec 39 phase 4,
  // pre-v15 captures) are excluded from the basis; none at all -> no row,
  // never a fake zero.
  {
    const corpsRows: any[] = cap.data?.corps?.corps ?? [];
    const declaring = corpsRows.filter(c => c.fleet && typeof c.fleet === "object");
    if (declaring.length > 0) {
      const perRow = declaring.map(c => {
        const planned = Object.keys(c.fleet).reduce((s, role) => s + (+c.fleet[role]?.parts || 0), 0);
        const actual = +c.bodyParts || 0;
        return { id: String(c.id), planned, actual, gap: actual - planned };
      });
      const plannedSum = perRow.reduce((s, r) => s + r.planned, 0);
      const absGapSum = perRow.reduce((s, r) => s + Math.abs(r.gap), 0);
      if (plannedSum > 0) {
        const frac = absGapSum / plannedSum;
        const worst = [...perRow].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 3)
          .filter(r => Math.abs(r.gap) > 0.5);
        rows.push({
          id: "F2",
          name: "per-commission fleet fidelity (fielded vs declared parts)",
          value: +frac.toFixed(3),
          unit: "frac of declared",
          // >1.0: the misallocation exceeds the entire declared basis -
          // structurally wrong, not lifecycle noise. 0.5 starts the warning
          // band wide (replacement overlap double-counts briefly); ratchet
          // as measured steady-state arrives.
          verdict: frac > 1.0 ? "FAIL" : frac >= 0.5 ? "WARN" : "ok",
          detail:
            `${declaring.length} commissions declare ${plannedSum.toFixed(0)}p standing; ` +
            `fielded ${perRow.reduce((s, r) => s + r.actual, 0)}p; |gap| ${absGapSum.toFixed(0)}p` +
            (worst.length
              ? `; worst: ` + worst.map(r => `${r.id} ${r.actual}p vs ${r.planned.toFixed(0)}p (${r.gap > 0 ? "+" : "-"}${Math.abs(r.gap).toFixed(0)})`).join(", ")
              : "")
        });
      }
    }
  }

  // ---- F3 output fidelity (spec 40-A's contract OUTPUT term, commission grain) ----
  // F1/F2 audit the PRICE term; F3 audits what each mining commission
  // PRODUCED against the plan's own per-source rate: the v14 cumulative
  // `produced` counter differenced across the capture pair, joined to flow
  // sources by the P&L's corp-id construction. Two-sided. A negative delta is
  // a corp REBUILT mid-window (the counter rides the store serialize) -
  // skipped and counted, never booked as output.
  {
    const capCorpsF3 = new Map(((cap.data?.corps?.corps ?? []) as any[]).map(c => [c.id, c]));
    const baseCorpsF3 = new Map(((base.data?.corps?.corps ?? []) as any[]).map(c => [c.id, c]));
    const roomOfF3 = (nodeId: string): string => String(nodeId).split("-")[0];
    const joined: { id: string; declared: number; actual: number }[] = [];
    let resets = 0;
    for (const src of (cap.data?.flow?.sources ?? []) as any[]) {
      const corpId = `mining-${roomOfF3(src.nodeId)}-harvest-${String(src.id).slice(-4)}`;
      const a = capCorpsF3.get(corpId);
      const b = baseCorpsF3.get(corpId);
      if (!a || !b || a.produced === undefined || b.produced === undefined || dt <= 0) continue;
      const delta = (+a.produced || 0) - (+b.produced || 0);
      if (delta < 0) {
        resets += 1;
        continue;
      }
      joined.push({ id: corpId, declared: +src.harvestRate || 0, actual: delta / dt });
    }
    const declaredSum = joined.reduce((s, r) => s + r.declared, 0);
    if (joined.length > 0 && declaredSum > 0) {
      const gapSum = joined.reduce((s, r) => s + Math.abs(r.actual - r.declared), 0);
      const frac = gapSum / declaredSum;
      const worst = [...joined].sort((a, b) => Math.abs(b.actual - b.declared) - Math.abs(a.actual - a.declared))
        .slice(0, 3)
        .filter(r => Math.abs(r.actual - r.declared) > 0.5);
      rows.push({
        id: "F3",
        name: "output fidelity (produced vs declared, per mining commission)",
        value: +frac.toFixed(3),
        unit: "frac of declared",
        verdict: frac > 0.5 ? "FAIL" : frac >= 0.25 ? "WARN" : "ok",
        detail:
          `${joined.length} commissions declare ${declaredSum.toFixed(0)} e/t; |gap| ${gapSum.toFixed(1)} e/t` +
          (resets > 0 ? `; ${resets} reset (rebuilt mid-window, excluded)` : "") +
          (worst.length
            ? `; worst: ` +
              worst
                .map(r => `${r.id} ${r.actual.toFixed(1)} vs ${r.declared.toFixed(1)} (${r.actual >= r.declared ? "+" : "-"}${Math.abs(r.actual - r.declared).toFixed(1)})`)
                .join(", ")
            : "")
      });
    }
  }

  rows.push({
    id: "P4",
    name: "plan spawn-infeasibility",
    value: ratio,
    unit: "x ceiling",
    // The fill runs budget-dry BY DESIGN, so an equilibrium plan sits AT the
    // ceiling; this script recomputes each class independently and drifts
    // ~0.1% from the planner's own ledger. 0.5% tolerance: smaller than any
    // real fleet class (min ~3% of ceiling), bigger than arithmetic noise.
    verdict: ratio > 1.005 ? "FAIL" : ratio > 0.85 ? "WARN" : "ok",
    detail:
      `plan-implied ${total.toFixed(3)} parts/t vs ${ceiling.toFixed(3)} physical; ` +
      lines
        .filter(([, , x]) => x > 0.005)
        .map(([n, p, x]) => `${n} ${Math.round(p)}p=${x.toFixed(3)}`)
        .join(", ")
  });

  // ---- P10 plan ENERGY accounting: WITHDRAWN 2026-08-01 (double-counting) ----
  //
  // This row asserted that `netEnergy = totalHarvest - totalOverhead` is "what
  // the solver hands to sinks", and priced the ~28 e/t of spawn spend it does
  // not subtract. The owner called it as double accounting and was right. Two
  // reads killed it:
  //
  //  1. `netEnergyTotal` (flowAdapter.ts:1189) is consumed ONLY by the reported
  //     `netEnergy` / `efficiency` / `isSustainable` fields (lines 1204-1207).
  //     It never gates the sink fill. It is a source-ranking and reporting
  //     statistic, not a budget - so nothing is "handed to sinks" against it.
  //  2. The plan ALREADY funds the spawn as a first-class SINK. Measured
  //     t72707443: spawn sinks allocated 100.0 + 10.0 = 110 e/t against ~48 e/t
  //     of measured spawn spend. Subtracting producer bodies from source yield
  //     AND routing energy to the spawn sink would be the double count - the
  //     solver correctly does only the latter.
  //
  // The row compared a per-source amortized efficiency statistic (producer
  // bodies only) against total measured spend across all classes and called the
  // difference a leak. Those quantities are not comparable and the difference
  // is not a leak.
  //
  // A VALID successor would ask "does the spawn sink allocation cover actual
  // spawn spend", but the sink's `demand` is a REFILL-CAPACITY figure (spawn +
  // extensions), not a rate, so that comparison needs a rate-shaped plan term
  // that does not exist yet. Left unbuilt rather than shipping a second
  // questionable formulation - a ledger line that cries wolf is worse than no
  // line, which X6 already taught this session.

  // ---- P5 price/behavior drift: reserver duty ----
  const res = corps.find(c => c.kind === "reservation");
  const dutyImplemented = res?.sizing && (res.sizing.banks !== undefined || res.sizing.gate === "reservation-banked");
  if (dutyImplemented) {
    const banks = res.sizing.banks ?? {};
    rows.push({
      id: "P5",
      name: "reserver duty vs priced",
      value: RESERVER_DUTY,
      unit: "duty (gate reads reservation bank)",
      verdict: "ok",
      detail:
        `gate ${res.sizing.gate}; banks ` +
        (Object.entries(banks as Record<string, number>)
          .map(([r, t]) => `${r}:${t}`)
          .join(" ") || "(none stamped)")
    });
  } else if (res?.sizing) {
    const bres = (base.data.corps?.corps ?? []).find((c: any) => c.kind === "reservation");
    const duty =
      (res.sizing.staffed / Math.max(1, res.sizing.targets) +
        (bres?.sizing ? bres.sizing.staffed / Math.max(1, bres.sizing.targets) : 0)) /
      (bres?.sizing ? 2 : 1);
    rows.push({
      id: "P5",
      name: "reserver duty vs priced",
      value: 1.0,
      unit: "gate duty (priced " + RESERVER_DUTY + ")",
      verdict: "FAIL",
      detail:
        `corp gate re-staffs whenever staffed < targets (duty 1.0 by construction; ` +
        `reservation bank to 5000 never read) while reserverTollPerRoom prices ${RESERVER_DUTY}; ` +
        `staffing proxy across captures ${duty.toFixed(2)} (raid-distorted); ` +
        `2x spawn+energy vs priced until the corp reads reservation.ticksToEnd`
    });
  }

  // ---- E4 idle capital ----
  const room = core.rooms?.[0];
  if (room) {
    const broom = (bcore.rooms ?? []).find((r: any) => r.name === room.name);
    const slope = broom ? (room.storageEnergy - broom.storageEnergy) / dt : 0;
    // Compare the bank against the reserve the DECISIONS use: the dynamic
    // income-scaled warchest (core.warchestTarget, exported v17) when the
    // capture carries it, else the static BASE_RESERVE floor (older captures /
    // cold start). Without the dynamic reserve E4 read a bank sitting AT its
    // target as "idle" - a false WARN (t72555188: bank 54.8k == dynamic reserve
    // but 32k "above" the 22.65k base). `idleThreshold` still requires a full
    // reserve's worth of TRUE excess before FAIL, so the signal stays honest.
    const reserve = typeof core.warchestTarget === "number" ? core.warchestTarget : BASE_RESERVE;
    const excess = room.storageEnergy - reserve;
    const idleThreshold = BASE_RESERVE; // a reserve's worth of genuine excess above the (dynamic) target
    // DAMPED-EQUILIBRIUM FRAME (owner 2026-07-29: "we would expect the
    // surplus to maybe rise, until it reaches an equilibrium ... don't
    // necessarily flag that as a red"). Spending is surplus/SURPLUS_DRAIN_TICKS,
    // so the bank does NOT settle at the reserve - it settles where the draw
    // equals net inflow: S* = reserve + SURPLUS_DRAIN_TICKS x netInflow.
    // Projected from the measured slope (slope = inflow - surplus/T =>
    // S*_excess = excess + T x slope), a bank climbing toward a FINITE,
    // absorbable equilibrium is convergence, not idle capital. The leak
    // signatures survive: an equilibrium past the draw-saturation knee
    // (MAX_SURPLUS_DRAW x T - income the spend path physically cannot
    // absorb), and any big idle bank with the spend path DOWN.
    const projectedExcess = excess + SURPLUS_DRAIN_TICKS * slope;
    const knee = MAX_SURPLUS_DRAW * SURPLUS_DRAIN_TICKS;
    // SPEND PATH DOWN vs BETWEEN GENERATIONS (live false FAIL t72665987). The
    // bank's route to the controller is the FEEDER relay (links carry SOURCE
    // energy, not banked energy, so a busy link network does NOT mean the bank
    // is being spent - that distinction is load-bearing here). But
    // `feederActive false` alone conflates a relay that is GATED OFF with one
    // whose creep is simply between generations: at t72665987 the feeder
    // stamped gate "demand" with wantedFeeders 1 / feeders 0 - it had ordered
    // a body and was waiting on the spawn - while P7 delivered 0.91x plan and
    // upgraders ran workUtil 0.999. Trust the stamp over the derived boolean
    // (spec 14): a relay that has DEMANDED a body is in transition; one gated
    // off ("no-storage"/"no-miner"/"no-spawn") or absent entirely is down.
    const feederCorp = corps.find((c: any) => c.kind === "controllerFeeder");
    const feederAwaitingBody =
      feederCorp?.sizing?.gate === "demand" && (feederCorp.sizing.wantedFeeders ?? 0) > 0;
    const spendPathDown = room.feederActive === false && !feederAwaitingBody;
    // RISING is the exemption the owner named: a bank climbing toward a
    // finite, absorbable S* is the damped law converging. A bank FLAT or
    // FALLING at a big surplus is not evidence of convergence (it is equally
    // the stalled-spend-path shape), so it keeps the old watch-level WARN.
    const converging = excess <= idleThreshold || (slope > 0 && projectedExcess < knee && !spendPathDown);
    const runaway = slope > 0 && projectedExcess >= knee;
    rows.push({
      id: "E4",
      name: "idle capital",
      value: excess,
      unit: "energy above the reserve target",
      verdict: converging
        ? "ok"
        : excess > idleThreshold && (runaway || spendPathDown)
        ? "FAIL"
        : excess > idleThreshold
        ? "WARN"
        : "ok",
      detail:
        `storage ${room.storageEnergy} vs reserve ${reserve}${
          typeof core.warchestTarget === "number" ? " (dynamic)" : " (base floor)"
        }, slope ${slope.toFixed(2)}/t over ${dt}t, feederActive ${room.feederActive}${
          feederAwaitingBody ? " (relay between generations - body demanded)" : ""
        }` +
        `; projected equilibrium ${(reserve + projectedExcess).toFixed(0)} (surplus ${projectedExcess.toFixed(0)}` +
        `, knee ${knee}) - ` +
        (converging
          ? excess <= idleThreshold
            ? "at/near target"
            : "CONVERGING toward it (damped draw, healthy - owner 2026-07-29)"
          : spendPathDown
          ? "SPEND PATH DOWN"
          : runaway
          ? "equilibrium past the absorbable knee - income the spend path cannot use"
          : "flat/falling at a big surplus - not convergence evidence; check the spend path")
    });
  }

  // ---- OSC bank/consumer limit cycle: WHICH PHASE is this capture in? ----
  //
  // Confirmed 2026-08-01 across four captures (t72696770→t72703512, 6,742t):
  // the bank and the upgrade fleet oscillate in ANTIPHASE, and the swing is a
  // LIMIT CYCLE, not a transient.
  //
  //   tick        bank    valve  upgAlloc  WORK   score
  //   72696770  149,803   68.20      2.00     2      -
  //   72700221  128,992   54.33     54.71    53   41.51
  //   72701842   55,201   15.00      2.00    68   68.29   <- fleet PEAKS as valve BOTTOMS
  //   72703512   84,511   24.67     25.16    18   13.96
  //
  // Positive feedback drives it: a wide valve builds a big fleet, the big
  // fleet drains the bank past the reserve, `bankSurplusRate` hits 0, the
  // valve slams to STORAGE_UPGRADE_TARGET, and the fleet - which cannot shed
  // faster than a 1,500-tick creep life - keeps burning the bank on the way
  // down. Cycle-average score 41.12 pts/t against an in-arc peak of 68.29:
  // PEAK IS 1.66x THE MEAN.
  //
  // Hence this row. Every score claim in this log is taken over a window
  // SHORTER than the ~9,000-tick period, so it samples a phase - the ledger
  // must say which one, or a trough read looks like a regression and a peak
  // read looks like a win. `standingWork / relayRate` is the single-capture
  // phase indicator: ~1 in phase, >2 the destructive quadrant (a fleet
  // stranded above a shut valve, eating reserve), <0.5 the wasteful quadrant
  // (valve open, fleet not built - the score the colony is not collecting).
  {
    const feeder = corps.find((c: any) => c.kind === "controllerFeeder");
    const relay = feeder?.sizing?.relayRate;
    const work = feeder?.sizing?.standingWork;
    if (typeof relay === "number" && typeof work === "number" && relay > 0) {
      const ratio = work / relay;
      const phase =
        ratio > 2
          ? "STRANDED FLEET above a shut valve (down-stroke: burning reserve, score peaking and about to fall)"
          : ratio < 0.5
          ? "VALVE OPEN, fleet not built (up-stroke: score suppressed, capacity idle)"
          : "in phase (fleet matched to valve)";
      rows.push({
        id: "OSC",
        name: "bank/consumer phase (limit-cycle position)",
        value: +ratio.toFixed(2),
        unit: "standing WORK per e/t of valve",
        // Neither extreme is a defect on its own - it is the SWING that costs.
        // FAIL the destructive quadrant only; WARN the idle one.
        verdict: ratio > 2 ? "FAIL" : ratio < 0.5 ? "WARN" : "ok",
        detail: `${work} WORK standing vs relay valve ${relay.toFixed(2)} e/t - ${phase}; ` +
          `read any score over a <9,000t window as a PHASE SAMPLE, not a rate (peak/mean measured 1.66x)`
      });
    }
  }

  // ---- P1/S2 plan flap: candidate verdict flips between captures ----
  const verdicts = new Map<string, string>((flow.candidates ?? []).map((c: any) => [c.sourceId, c.verdict]));
  const bverdicts = new Map<string, string>(
    (base.data.flow?.candidates ?? []).map((c: any) => [c.sourceId, c.verdict])
  );
  const flips: string[] = [];
  for (const [id, v] of verdicts) {
    const bv = bverdicts.get(id);
    if (bv && bv !== v && (v === "funded" || bv === "funded")) flips.push(`${id.slice(-8)} ${bv}->${v}`);
  }
  // A funded source VANISHING from the candidate list is the biggest flip of
  // all (raid embargo pulls remotes from the problem entirely - measured
  // t72415443: five funded remotes dropped, P1 read "0 flips").
  for (const [id, bv] of bverdicts) {
    if (bv === "funded" && !verdicts.has(id)) flips.push(`${id.slice(-8)} funded->DROPPED`);
  }
  rows.push({
    id: "P1",
    name: "plan flap (funded flips)",
    value: flips.length,
    unit: "sources",
    verdict: flips.length > 1 ? "FAIL" : flips.length === 1 ? "WARN" : "ok",
    detail: flips.join(", ") || "stable vs baseline"
  });

  // ---- P2 micro-routes ----
  const micro = (flow.haulers ?? []).filter((h: any) => h.carryParts < 3);
  rows.push({
    id: "P2",
    name: "micro-routes (<3 CARRY planned)",
    value: micro.length,
    unit: `of ${(flow.haulers ?? []).length} routes`,
    verdict: micro.length > (flow.haulers ?? []).length / 2 ? "WARN" : "ok",
    detail: micro.map((h: any) => `${h.sourceId.slice(-8)} ${h.carryParts.toFixed(1)}c`).join(", ") || "none"
  });

  // ---- E2 stranded fleet: actual carry corps serving routes absent from plan ----
  const planSuffixes = new Set(
    (flow.haulers ?? []).map((h: any) => h.sourceId.replace(/^source-|^scavenge-|^bank-/, "").slice(-4))
  );
  let strandedParts = 0;
  const strandedIds: string[] = [];
  for (const c of corps) {
    if (c.kind !== "carry" || c.creepCount === 0) continue;
    const suffix = c.id.slice(-4);
    if (!planSuffixes.has(suffix)) {
      strandedParts += c.bodyParts;
      strandedIds.push(c.id.replace(/^hauling-/, ""));
    }
  }
  rows.push({
    id: "E2",
    name: "stranded fleet",
    value: strandedParts,
    unit: "body parts off-plan",
    verdict: strandedParts > 60 ? "FAIL" : strandedParts > 20 ? "WARN" : "ok",
    detail: strandedIds.join(", ") || "every fielded hauler serves a planned route"
  });

  // ---- E5 runt purchases ----
  const agenda: any = Object.values(core.agenda ?? {})[0] ?? {};
  // Attribution-aware (t72523980): a hauler bought small for a route the PLANNER
  // sizes small (scavenge / distance-1 short-haul, carryParts < 3) is RIGHT-sized,
  // not a drained-spawn purchase. The plan-blind cost<300 test flagged every
  // scavenge hauler forever (2/2 flagged runts were scavenge-W43N24-30-20, plan
  // carryParts 1.41) - a standing false positive that trains us to ignore E5 and
  // would mask a REAL drained runt. Keep the runt verdict only when the plan
  // wanted a real body (carryParts >= 3) or no plan route vouches for the size.
  const routeCarry = new Map<string, number>();
  for (const h of (flow.haulers ?? []) as any[]) {
    const suf = String(h.sourceId).replace(/^source-|^scavenge-[EW]\d+[NS]\d+-|^bank-/, "").slice(-4);
    routeCarry.set(suf, Math.max(routeCarry.get(suf) ?? 0, h.carryParts));
  }
  const plannedMicroHauler = (corp: string): boolean => {
    const suf = String(corp).replace(/^hauling-[EW]\d+[NS]\d+-hauling-/, "").slice(-4);
    const carry = routeCarry.get(suf);
    return carry !== undefined && carry < 3; // plan owns this route AND sizes it small
  };
  const runts = (agenda.executed ?? []).filter(
    (e: any) =>
      e.cost < 300 &&
      !["reserver", "scout"].includes(e.role) &&
      !(e.role === "hauler" && plannedMicroHauler(e.corp))
  );
  rows.push({
    id: "E5",
    name: "runt purchases",
    value: runts.length,
    unit: "of last " + (agenda.executed ?? []).length + " receipts",
    verdict: runts.length > 1 ? "WARN" : "ok",
    detail: runts.map((e: any) => `${e.role}@${e.cost}`).join(", ") || "none"
  });

  // ---- SCAV scavenge economics (instrument-first for the economic gate) ----
  // Each scavenger's net-energy-per-spawn-part vs the MARGINAL funded source
  // route (the least efficient real route we already pay for = the opportunity
  // cost of a spawn part). The spawn shadow price only BITES when parts bind
  // (partsLedger.dry): with slack, a scavenger spends parts nothing else wants,
  // so a low ratio is free; when dry, a scavenger below the margin is displacing
  // a better use. This is the read that will calibrate the gate's threshold.
  const netPerPart = (h: any): number => {
    const carry = h.carryParts ?? carryPartsFor(h.flowRate, h.distance);
    const net = h.flowRate - haulerOverhead(carry, h.distance);
    return h.spawnParts > 0 ? net / h.spawnParts : 0;
  };
  const scavHaulers = (flow.haulers ?? []).filter((h: any) => String(h.sourceId).startsWith("scavenge-"));
  const realRoutes = (flow.haulers ?? []).filter(
    (h: any) => !String(h.sourceId).startsWith("scavenge-") && !String(h.sourceId).startsWith("bank-")
  );
  const dry = flow.partsLedger?.dry ?? false;
  if (scavHaulers.length > 0) {
    const margin = realRoutes.length > 0 ? Math.min(...realRoutes.map(netPerPart)) : Infinity;
    const scavRatios = scavHaulers.map((h: any) => ({ id: String(h.sourceId).replace(/^scavenge-/, ""), r: netPerPart(h) }));
    const belowMargin = scavRatios.filter((s: { r: number }) => s.r < margin);
    rows.push({
      id: "SCAV",
      name: "scavenge economics (net-e/part vs margin)",
      value: belowMargin.length,
      unit: `of ${scavHaulers.length} scavengers below the funded margin`,
      // Instrument-first: only WARN when spawn parts BIND and a scavenger sits
      // below the marginal funded route - the calibrated displacement signal.
      verdict: dry && belowMargin.length > 0 ? "WARN" : "ok",
      detail:
        `spawn parts ${dry ? "DRY (binding)" : `slack (spent ${(flow.partsLedger?.spent ?? 0).toFixed(3)}/${(flow.partsLedger?.budget ?? 0).toFixed(3)})`}` +
        `; margin ${margin === Infinity ? "n/a" : margin.toFixed(2)} net-e/part; ` +
        scavRatios.map((s: { id: string; r: number }) => `${s.id} ${s.r.toFixed(2)}`).join(", ")
    });
  }

  // ---- LINK link-throughput instrument (spec-26, read-only knowledge) ----
  // ACTUAL e/t the link network carries: hub inflow, controller DELIVERY receipt
  // (what the first spec-26 never measured), the cheap 1-hop direct share, and
  // the 3% tax. Informational until the planner models links; a controller flow
  // with 0% direct share is a visible missed easy-win (always double-hopping).
  const links = core.links ?? [];
  if (links.length > 0) {
    const active = links.filter((l: any) => l.toHubRate + l.toControllerRate > 0.01);
    const missedDirect = active.filter((l: any) => l.toControllerRate > 0.5 && l.directShare < 0.01);
    rows.push({
      id: "LINK",
      name: "link throughput (hub / controller receipt / direct / tax)",
      value: active.length,
      unit: "rooms with a live link network",
      verdict: "ok", // instrument-first: surface numbers, don't gate behavior yet
      detail:
        (active.length === 0
          ? "no link fires in the window"
          : active
              .map(
                (l: any) =>
                  `${l.room} hub ${l.toHubRate.toFixed(1)} ctrl ${l.toControllerRate.toFixed(1)} (direct ${(l.directShare * 100).toFixed(0)}%) tax ${l.taxRate.toFixed(2)} /${l.windowTicks}t`
              )
              .join("; ")) +
        (missedDirect.length > 0
          ? ` | double-hopping to controller in ${missedDirect.map((l: any) => l.room).join(",")} (0% direct - easy win)`
          : "")
    });
  }

  // ---- DEP deposit-side link instrument (spec-26 stage 4, read-only) ----
  // For each REMOTE source, the haul a hauler would save by depositing at a
  // home-room link it passes instead of walking to storage, plus the deposit
  // flow that would pile on each link (throughput headroom). Informational: it
  // sizes the potential lever before the depositPos routing is re-activated.
  const dep = flow.depositSavings;
  if (dep && (dep.candidates ?? []).length > 0) {
    const cands = [...dep.candidates].sort((a: any, b: any) => b.saving - a.saving);
    const totalFlow = cands.reduce((a: number, c: any) => a + c.flowRate, 0);
    const savedPartsProxy = cands.reduce((a: number, c: any) => a + c.saving * c.flowRate, 0);
    rows.push({
      id: "DEP",
      name: "deposit-side link opportunity (remote haul shortened)",
      value: cands.length,
      unit: "remote sources that could deposit at a home link",
      verdict: "ok", // instrument-first: surface the lever, don't route yet
      detail:
        cands
          .slice(0, 6)
          .map((c: any) => `${c.sourceId.slice(-4)} saves ${c.saving} (haul ${c.haulDist}->${c.linkDist}) @${c.flowRate.toFixed(1)}e/t`)
          .join("; ") +
        ` | per-link deposit flow: ${(dep.perLink ?? [])
          .map((l: any) => {
            const ctrl = l.linkId === dep.controllerLinkId;
            const cap = ctrl && dep.controllerCapacity !== undefined ? ` (controller: bank-neutral <=${dep.controllerCapacity.toFixed(0)}e/t)` : "";
            return `${l.linkId.slice(-4)} ${l.depositFlow.toFixed(1)}e/t x${l.sources}${cap}`;
          })
          .join(", ")}` +
        ` | ${totalFlow.toFixed(0)}e/t over ${cands.length} routes, ~${Math.round(savedPartsProxy)} tile*e/t saved`
    });
  }

  // ---- S3 scheduler stall: idle spawn with an AFFORDABLE head ----
  const spawn = core.spawns?.[0];
  if (spawn && room) {
    const head = (agenda.queue ?? [])[0];
    const affordable = head && room.energyAvailable >= head.minCost;
    // Staleness guard: the director republishes the agenda only on idle-spawn
    // evaluation ticks, so a snapshot older than ~20 ticks means the spawn has
    // been BUSY building since - the opposite of stalled (measured t72412472:
    // 37-tick-stale agenda while a 1127-cost tanker built, false S3 FAIL).
    const agendaFresh = agenda.tick !== undefined && cap.tick - agenda.tick <= 20;
    const stalled = agendaFresh && spawn.utilization < 0.5 && (agenda.queue ?? []).length > 0 && affordable;
    rows.push({
      id: "S3",
      name: "scheduler stall",
      value: stalled ? 1 : 0,
      unit: "boolean",
      verdict: stalled ? "FAIL" : "ok",
      detail: head
        ? `util ${spawn.utilization.toFixed(2)}, head ${head.role}@${head.minCost} vs bank ${room.energyAvailable}` +
          (!agendaFresh
            ? ` (agenda ${cap.tick - agenda.tick}t stale = spawn busy building - not a stall)`
            : affordable
            ? " AFFORDABLE+IDLE"
            : " (holding/funding - not a stall)")
        : "queue empty"
    });
  }

  // ---- S4 idle attribution: WHERE the spawn's idle ticks go ----
  // The S3 stall is a boolean snapshot; this is the windowed breakdown from
  // the v18 spawns[].idle tally (classifySpawnIdle). "spawn capacity but short
  // on haulers" is exactly this read: bank = energy-starved (feed the spawn
  // faster), empty = the plan isn't demanding a body (demand-side gap), hold =
  // a chosen wait, buy = exec latency. Recoverable idle (bank+hold) above the
  // threshold means spawn-time is being left on the table. Absent pre-v18.
  if (spawn && (spawn as any).idle) {
    const idle = (spawn as any).idle as { empty: number; bank: number; buy: number; hold: number };
    const total = idle.empty + idle.bank + idle.buy + idle.hold;
    const win = spawn.windowTicks || 1;
    const recoverable = (idle.bank + idle.hold) / win; // fraction of the window
    const parts = Object.entries(idle)
      .filter(([, v]) => v > 0)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .map(([k, v]) => `${k} ${(((v as number) / Math.max(1, total)) * 100).toFixed(0)}%`)
      .join(" ");
    rows.push({
      id: "S4",
      name: "spawn idle attribution",
      value: +recoverable.toFixed(3),
      unit: "recoverable idle frac",
      verdict: recoverable > 0.15 ? "WARN" : "ok",
      detail: `idle ${((total / win) * 100).toFixed(0)}% of window [${parts}] - bank=energy-starved, empty=no-demand, hold=chosen-wait, buy=latency`
    });
  }

  // ---- S5 spawn-throughput headroom: the replacement treadmill's ceiling ----
  // Measured saturation vs the physical build rate, with the PLAN's own need
  // beside it. The colony ran at 90% of ceiling on the t72734018 pair with a
  // plan needing only 0.51x - the difference is unplanned replacement (churn),
  // and it is the colony's surge margin: a second simultaneous raid wave
  // arrives ON TOP of a saturated pipe (buffers back up -> miners held ->
  // income falls exactly while replacement demand peaks). A booked ledger row
  // so the risk is visible BEFORE the cascade, not diagnosed after it.
  {
    const spawns = (core.spawns ?? []) as { partsPerTick?: number }[];
    const measured = spawns.reduce((s, x) => s + (+(x.partsPerTick ?? 0) || 0), 0);
    const physical = spawns.length * SPAWN_PARTS_PER_TICK;
    if (spawns.some(s => s.partsPerTick !== undefined) && physical > 0) {
      const saturation = measured / physical;
      rows.push({
        id: "S5",
        name: "spawn-throughput headroom (surge margin)",
        value: +saturation.toFixed(2),
        unit: "x physical ceiling",
        verdict: saturation > 0.92 ? "FAIL" : saturation > 0.85 ? "WARN" : "ok",
        detail:
          `building ${measured.toFixed(3)} p/t of ${physical.toFixed(3)} physical - ` +
          `${((1 - saturation) * 100).toFixed(0)}% surge margin for raids/recovery; ` +
          `plan-implied is the P4 row - the gap between them is unplanned replacement (churn)`
      });
    }
  }

  // ---- H1 hauler execution duty: are fielded haulers working or waiting? ----
  // The (a) vs (c) disambiguator (owner 2026-07-25). Reads the v?/segment-4
  // CarryCorp duty stamp (active vs idle-empty vs idle-loaded, realized). High
  // duty WITH source buffers over container cap => the plan under-asks (carry
  // is inflow-sized, no drain term) - a plan fix. Low duty / high idleSource
  // => execution loss (energy standing, haulers idle/blocked) - a behavior fix.
  // idleSink => sink backpressure (storage/port full). Absent pre-instrument.
  //
  // BASIS = top-level carry corps PLUS the operations' inner haul engines
  // (innerSizing type "hauling", corps v13/spec 34 D5 - published precisely
  // because the biggest hauling spend rides INSIDE harvest operations).
  // Until phase 3 of the income-statement program H1 read only the former,
  // so its duty basis was the 0-3 standalone survivors while 8+ operation
  // engines went uncounted (t72743103: 8 inner stamps, 0 carry corps, H1
  // silently absent). Inner stamps weight by their OWN fielded creeps (the
  // stamp's `creeps`), never the operation's creepCount (that counts miners).
  {
    const haulers: { sizing: any; weight: number }[] = [];
    for (const c of corps) {
      if (c.kind === "carry" && c.sizing && c.sizing.duty !== undefined)
        haulers.push({ sizing: c.sizing, weight: c.creepCount || 0 });
      for (const i of c.innerSizing ?? [])
        if (i.type === "hauling" && i.sizing && i.sizing.duty !== undefined)
          haulers.push({ sizing: i.sizing, weight: i.sizing.creeps || 0 });
    }
    const creeps = haulers.reduce((s, c) => s + c.weight, 0);
    if (haulers.length > 0 && creeps > 0) {
      const wavg = (f: string): number => haulers.reduce((s, c) => s + (c.sizing[f] || 0) * c.weight, 0) / creeps;
      const duty = wavg("duty");
      const idleSource = wavg("idleSourceFrac");
      const idleSink = wavg("idleSinkFrac");
      const idleSinkAtSink = wavg("idleSinkAtSinkFrac");
      const idleSinkEnRoute = Math.max(0, idleSink - idleSinkAtSink);
      // Of the atSink idle: how much had the hub storage with ROOM (=> spatial
      // contention at the deposit, NOT sink saturation). Absent pre-instrument.
      const atSinkStorageRoom = wavg("idleSinkStorageRoomFrac");
      const atSinkContended = idleSinkAtSink > 1e-9 && atSinkStorageRoom >= idleSinkAtSink * 0.5;
      // Buffers over container cap (2000) = energy on the ground.
      const buffers: Record<string, number> = core.sourceBuffers ?? {};
      const overCap = Object.values(buffers).reduce((s, v) => s + Math.max(0, (v as number) - 2000), 0);
      const piled = overCap > 3000;
      // Only a leak worth flagging when energy is actually piling up. Then a
      // LOW duty (or high idleSource) is the execution smoking gun.
      const executionLoss = piled && (duty < 0.75 || idleSource > 0.2);
      rows.push({
        id: "H1",
        name: "hauler execution duty",
        value: +duty.toFixed(3),
        unit: "active frac",
        verdict: executionLoss ? "WARN" : "ok",
        detail:
          `duty ${duty.toFixed(2)} (idleSource ${idleSource.toFixed(2)}, idleSink ${idleSink.toFixed(2)} ` +
          `[atSink ${idleSinkAtSink.toFixed(2)}, enRoute ${idleSinkEnRoute.toFixed(2)}]) over ` +
          `${haulers.length} corps/${creeps} creeps; ground-piled ${Math.round(overCap)}e ` +
          (piled
            ? duty >= 0.75 && idleSource <= 0.2 && idleSink <= 0.2
              ? "- haulers BUSY => plan under-asks (inflow-sized carry, no drain term)"
              : idleSinkEnRoute >= idleSinkAtSink
              ? "- idleSink EN-ROUTE => approach-lane congestion (traffic / standing blocker at the core)"
              : atSinkContended
              ? `- idleSink AT-SINK, storage HAD ROOM (${atSinkStorageRoom.toFixed(2)}) => SPATIAL contention at the deposit (queue / parked mover), not saturation => geometry/deposit-spread fix`
              : "- idleSink AT-SINK, storage FULL => sink saturation (spill the load / open the drain)"
            : "- buffers near cap, no leak")
      });
    }
  }

  // ---- H3 chronic mouth: buffer full at BOTH ends, zero drain fielded ----
  // The t72654979 cd8e signature as a STANDING gauge: a source buffer over
  // the container cap at BOTH captures whose haul stamp fields ZERO drain
  // creeps at the capture end - cd8e grew 2649 -> 3874 across a whole window
  // with creeps 0, chronic for 512t, found only by hand in the E6 audit.
  // Reads the same merged haul-stamp basis as H1 (top-level carry corps +
  // inner "hauling" engines), matched per corp/engine across the pair.
  // GROWING is the disease (FAIL); flat-but-full with no drain is a WARN
  // (could be a just-retired route scavenging down). A fielded drain creep,
  // an under-cap mouth, or captures predating the stamps stay silent.
  {
    const CONTAINER_CAP = 2000;
    const haulStampsOf = (arr: any[]): Map<string, any> => {
      const m = new Map<string, any>();
      for (const c of arr ?? []) {
        if (c.kind === "carry" && c.sizing && c.sizing.staged !== undefined) m.set(c.id, c.sizing);
        for (const i of c.innerSizing ?? [])
          if (i.type === "hauling" && i.sizing && i.sizing.staged !== undefined) m.set(`${c.id}/${i.nodeId}`, i.sizing);
      }
      return m;
    };
    const capStamps = haulStampsOf(cap.data.corps?.corps ?? []);
    const baseStamps = haulStampsOf(base.data.corps?.corps ?? []);
    const chronic: { id: string; from: number; to: number; growing: boolean }[] = [];
    for (const [id, s] of capStamps) {
      const b = baseStamps.get(id);
      if (!b) continue;
      const to = s.staged ?? 0;
      const from = b.staged ?? 0;
      if (to <= CONTAINER_CAP || from <= CONTAINER_CAP) continue; // full at BOTH ends or it's just staging
      if ((s.creeps ?? 0) > 0) continue; // a drain IS fielded - the route works the pile
      chronic.push({ id, from, to, growing: to > from + 1 });
    }
    if (chronic.length > 0) {
      const growing = chronic.filter(c => c.growing);
      rows.push({
        id: "H3",
        name: "chronic mouth (buffer full, no drain fielded)",
        value: chronic.length,
        unit: "mouths over cap with zero drain creeps at both captures",
        verdict: growing.length > 0 ? "FAIL" : "WARN",
        detail:
          chronic.map(c => `${c.id} ${Math.round(c.from)}->${Math.round(c.to)}${c.growing ? " GROWING" : ""}`).join("; ") +
          " - the cd8e class: order the drain (the plan's bufferDrainCarry term should have caught this - check the route's carryNeeded vs fielded)"
      });
    }
  }

  // ---- P6 reservation pump (owner marathon: "reservers not reserving") ----
  // pump_r = bank2 - (bank1 - stampDt): what the fielded reservers actually
  // ADDED per room, decay netted out. Zero pump on a needy room with claim
  // parts fielded = a reserver walking / blocked / dead - the delivery gap
  // no other line sees. Stamp ticks, not capture ticks: banks are read at
  // sizing time.
  {
    const res = (cap.data.corps?.corps ?? []).find((c: any) => c.kind === "reservation");
    const bres = (base.data.corps?.corps ?? []).find((c: any) => c.kind === "reservation");
    const banks1 = bres?.sizing?.banks;
    const banks2 = res?.sizing?.banks;
    const stampDt = res?.sizing?.tick && bres?.sizing?.tick ? res.sizing.tick - bres.sizing.tick : dt;
    if (banks1 && banks2 && stampDt > 0) {
      const rooms = Object.keys(banks2).filter(r => r in banks1);
      // Expected decay is bounded by the starting bank (a bank at 0 cannot
      // decay): pump = bank2 - (bank1 - min(bank1, dt)). The unbounded form
      // fabricated "+dt banked per room" from four zero banks with no
      // reservers fielded (live t72481477 vs t72481270).
      const pumps = rooms.map(
        r => [r, Math.round(banks2[r] - (banks1[r] - Math.min(banks1[r], stampDt)))] as [string, number]
      );
      const zero = pumps.filter(([, p]) => p <= 0);
      const fielded = (res?.bodyParts ?? 0) > 0 && (bres?.bodyParts ?? 0) > 0;
      const totalPump = pumps.reduce((a, [, p]) => a + Math.max(0, p), 0);
      rows.push({
        id: "P6",
        name: "reservation pump (delivered bank)",
        value: totalPump,
        unit: `ticks banked over ${stampDt}t`,
        verdict:
          fielded && rooms.length > 0 && zero.length === rooms.length
            ? "FAIL"
            : fielded && zero.length >= rooms.length / 2
            ? "WARN"
            : "ok",
        detail: pumps.map(([r, p]) => `${r}:${p}`).join(" ") + (fielded ? "" : " (no reservers fielded)")
      });
    }
  }

  // ---- P7 controller delivery (owner marathon: "upgraders not upgrading") ----
  // Actual rclProgress delta vs the LOWER of the two endpoint plans (a plan
  // that legitimately moved mid-window - construction preempt - must not
  // false-fail). FAIL only when a stable-ish plan went undelivered WITH
  // stock standing at the controller: energy was there, upgraders were not.
  {
    const allocOf = (f: any): number =>
      (f?.sinks ?? []).filter((s: any) => s.type === "controller").reduce((a: number, s: any) => a + (+s.allocated || 0), 0);
    const sinkAlloc = Math.min(allocOf(base.data.flow), allocOf(flow));
    const prog1 = (bcore.rooms ?? []).reduce((a: number, r: any) => a + (r.rclProgress ?? 0), 0);
    const prog2 = (core.rooms ?? []).reduce((a: number, r: any) => a + (r.rclProgress ?? 0), 0);
    const actual = dt > 0 ? (prog2 - prog1) / dt : 0;
    const stock1 = (bcore.rooms ?? []).reduce((a: number, r: any) => a + (r.controllerStock ?? 0), 0);
    const stock2 = (core.rooms ?? []).reduce((a: number, r: any) => a + (r.controllerStock ?? 0), 0);
    const stocked = stock1 > 500 && stock2 > 500;
    // WARTIME AWARENESS (spec 33, t72599790): while the upgrader fleet is
    // relegated (a build backlog stands and the surplus funds building, not the
    // controller), the controller's real target is the RELEGATED floor
    // (upgrader sizing.allocated ~= the anti-downgrade sip), NOT the controller
    // flow sink - which still reads the save-regime STORAGE_UPGRADE_TARGET (15)
    // because the plan-side cap is a no-op (max(15,2)=15). Measuring the
    // draining incumbents against 15 false-FAILs (0.47x) EVERY cycle of a build
    // campaign, masking any real P7 regression. In wartime the target is the
    // relegated floor: actual OVER it is the expected incumbent drain (ok); a
    // FAIL is only a controller starved BELOW its inviolable floor WITH stock
    // standing (the link broke - a genuine downgrade risk, relegated != off).
    const upg = corps.find((c: any) => c.kind === "upgrade" && c.sizing);
    const wartime = upg?.sizing?.wartime === true;
    const relegatedFloor = Math.max(1, +upg?.sizing?.allocated || 1);
    const alloc = wartime ? relegatedFloor : sinkAlloc;
    const ratio = alloc > 0 ? actual / alloc : 1;
    const verdict = wartime
      ? stocked && ratio < 0.5
        ? "FAIL"
        : "ok"
      : sinkAlloc > 0 && stocked && ratio < 0.5
        ? "FAIL"
        : sinkAlloc > 0 && ratio < 0.75
          ? "WARN"
          : "ok";
    rows.push({
      id: "P7",
      name: "controller delivery vs plan",
      value: +ratio.toFixed(2),
      unit: wartime ? "x RELEGATED floor (wartime)" : "x lower-endpoint plan",
      verdict,
      detail: wartime
        ? `wartime: relegated floor ${alloc.toFixed(1)}, delivering ${actual.toFixed(1)} e/t ` +
          `(incumbents draining to the sip); stock ${stock1}->${stock2} - surplus funds building, not the controller`
        : `actual ${actual.toFixed(1)} e/t vs plan ${sinkAlloc.toFixed(1)} (lower endpoint); ` +
          `stock ${stock1}->${stock2}${stocked ? " (stock stood - the energy was there)" : ""}`
    });
  }

  // ---- P8 build delivery (owner marathon: "builders not building") ----
  // Sites standing at BOTH endpoints, construction allocated, and summed site
  // progress FLAT = the build crew idled a whole window. A completion makes
  // progress vanish (site removed), so any drop in count/total reads
  // ambiguous and is skipped - no false alarms on finished builds.
  {
    const sum = (c: any, f: string): number => (c.rooms ?? []).reduce((a: number, r: any) => a + (r[f] ?? 0), 0);
    const hasFields = (core.rooms ?? []).some((r: any) => r.siteCount !== undefined) &&
      (bcore.rooms ?? []).some((r: any) => r.siteCount !== undefined);
    if (hasFields) {
      const consAlloc = Math.min(
        (base.data.flow?.sinks ?? []).filter((s: any) => s.type === "construction").reduce((a: number, s: any) => a + (+s.allocated || 0), 0),
        (flow?.sinks ?? []).filter((s: any) => s.type === "construction").reduce((a: number, s: any) => a + (+s.allocated || 0), 0)
      );
      const count1 = sum(bcore, "siteCount");
      const count2 = sum(core, "siteCount");
      const prog1 = sum(bcore, "siteProgress");
      const prog2 = sum(core, "siteProgress");
      const total1 = sum(bcore, "siteTotal");
      const total2 = sum(core, "siteTotal");
      // REMOTE SITES are sites (gap measured t72503018: home siteCount 0 at
      // both ends while W43N24 held 3 standing sites across 2171t with the
      // receipts frozen at 36/38 and a funded 5-creep crew - the stalled
      // trunk pipeline read "ok / no sites standing"). The segment-0
      // remoteSites census joins the standing/completion predicates; remote
      // progress itself is only measurable via the receipts floor below, so
      // a remote-only window with flat receipts is exactly the stall class.
      const remoteCount = (c: any): number =>
        Object.values(c.remoteSites ?? {}).reduce((a: number, n: any) => a + (+n || 0), 0);
      const remotes1 = remoteCount(bcore);
      const remotes2 = remoteCount(core);
      const completion = count2 < count1 || total2 < total1 || remotes2 < remotes1;
      const standing = count1 + remotes1 > 0 && count2 + remotes2 > 0;
      const delivered = prog2 - prog1;
      // REMOTE BUILD via receipts (gap measured 2026-07-22: P8 read "0 e/t
      // built" all day while cee0's trunk went 35 -> 45 - the rooms[] site
      // meter is home-only and remote build-out was INVISIBLE to the
      // ledger). roadReceipts.built RATCHETS (never counts down), so its
      // delta x ROAD_BUILD_COST is a floor on energy actually built into
      // remote roads - swamp tiles cost more, so this undercounts, never
      // overcounts.
      const ROAD_BUILD_COST = 300;
      const receiptsDelta = ((): number => {
        const r1 = bcore.roadReceipts ?? {};
        const r2 = core.roadReceipts ?? {};
        let tiles = 0;
        for (const k of Object.keys(r2)) {
          const b2 = r2[k]?.built;
          const b1 = r1[k]?.built;
          if (typeof b2 === "number" && typeof b1 === "number" && b2 > b1) tiles += b2 - b1;
        }
        return tiles * ROAD_BUILD_COST;
      })();
      // WITHIN-SITE remote progress via the construction corp's poolWork
      // stamp (false-FAIL measured t72679468: remote count 9->9, receipts
      // flat, poolWork 3826->2252 - 1,574e built into partially-complete
      // sites while P8 said "CREW IDLE"). The stamp sums the pool's REMAINING
      // work ("room:energy,room*:energy"); a FALL is a conservative floor on
      // energy built - placements RAISE poolWork, so the delta only ever
      // undercounts (same direction as the receipts floor). Requires the
      // stamp at BOTH endpoints (v10+); absent on either side -> 0.
      const poolWorkSum = (cap: any): number | null => {
        let sum = 0;
        let seen = false;
        for (const corp of cap?.corps ?? []) {
          const pw = corp?.sizing?.poolWork;
          if (typeof pw !== "string") continue;
          seen = true;
          for (const entry of pw.split(",")) {
            const n = Number(entry.slice(entry.lastIndexOf(":") + 1));
            if (Number.isFinite(n)) sum += n;
          }
        }
        return seen ? sum : null;
      };
      const pool1 = poolWorkSum(base.data.corps);
      const pool2 = poolWorkSum(cap.data.corps);
      const poolBuilt = pool1 !== null && pool2 !== null ? Math.max(0, pool1 - pool2) : 0;
      // THE DIRECT MEASUREMENT (methodology #15, audit t72842655). Everything
      // above is a FLOOR - home-room siteProgress, the receipts ratchet, the
      // poolWork decrease - and each is documented in place as undercounting.
      // They share one blind spot: all three read state that VANISHES when a
      // site completes, so a remote program that finished is invisible to the
      // lot of them.
      //
      // Measured: building-W43N21-construction took `produced` 6,270 -> 12,310
      // in 1,314 ticks (6,040 units, 4.60 e/t) clearing 17 of 18 road sites,
      // while P8 reported a fraction of it and the ENERGY ACCOUNT - which reads
      // this row verbatim - booked construction ACTUAL at 0.42 e/t against a
      // 30.00 budget. The -29.58 variance was the meter.
      //
      // A ConstructionCorp's `unitsProduced` IS build progress (segment 4 v14),
      // so read it. Per-corp deltas clamp at zero: a corp destroyed and rebuilt
      // restarts its counter (measured -885 on building-W43N24-construction
      // when the invader core took the room), and that is lost history rather
      // than negative building - so this still undercounts, the same direction
      // as the floors it supersedes.
      const corpBuilt = ((): number | null => {
        const producedById = (corpsCap: any): Map<string, number> => {
          const m = new Map<string, number>();
          for (const c of corpsCap?.corps ?? []) {
            if (c?.kind !== "construction") continue;
            if (typeof c.produced === "number") m.set(c.id, c.produced);
          }
          return m;
        };
        const m1 = producedById(base.data.corps);
        const m2 = producedById(cap.data.corps);
        let sum = 0;
        let seen = false;
        for (const [id, p2] of m2) {
          const p1 = m1.get(id);
          if (p1 === undefined) continue; // unknown history - never assume all of it landed here
          seen = true;
          if (p2 > p1) sum += p2 - p1;
        }
        return seen ? sum : null;
      })();
      // Prefer the measurement; keep the floors for captures predating the
      // counter. NOT summed together - they measure the same energy, so adding
      // them would double-count.
      const built = corpBuilt !== null ? corpBuilt : Math.max(0, delivered) + receiptsDelta + poolBuilt;
      const flat =
        standing && !completion && built <= 0 && delivered <= 0 && receiptsDelta <= 0 && poolBuilt <= 0;
      // SITE LEDGER (core v34; owner 2026-08-05: "I want to stay informed of
      // construction site progress"): the vision-free per-room roster from
      // Game.constructionSites, rendered per room with its window delta and
      // an ETA at the row's own composite build rate. RENDERING ONLY - the
      // verdict machinery above keeps its lenses (rem falls with build AND
      // completions, rises with placements, so the delta is context, not a
      // rate claim). Absent on pre-v34 captures - the line simply omits.
      const sl1 = (bcore as any).siteLedger ?? null;
      const sl2 = (core as any).siteLedger ?? null;
      let byRoom = "";
      if (sl2) {
        const roomNames = Object.keys(sl2).sort((a, b) => (sl2[b].rem ?? 0) - (sl2[a].rem ?? 0));
        const totalRem = roomNames.reduce((a, r) => a + (sl2[r].rem ?? 0), 0);
        const rate = dt > 0 ? built / dt : 0;
        byRoom =
          `; by room: ` +
          roomNames
            .map(r => {
              const cur = sl2[r];
              const prev = sl1?.[r];
              const dRem = prev ? cur.rem - prev.rem : null;
              return (
                `${r} ${cur.n} site${cur.n === 1 ? "" : "s"} rem ${cur.rem}` +
                (dRem !== null && dRem !== 0 ? ` (${dRem > 0 ? "+" : ""}${dRem})` : "")
              );
            })
            .join(", ") +
          ` | total rem ${totalRem}` +
          (rate > 0.05 && totalRem > 0 ? `, ETA ~${Math.round(totalRem / rate)}t at ${rate.toFixed(1)} e/t` : "");
      }
      rows.push({
        id: "P8",
        name: "build delivery (corp produced counters)",
        value: dt > 0 ? +(built / dt).toFixed(2) : 0,
        unit: "e/t built",
        verdict: flat && consAlloc > 5 ? "FAIL" : flat && consAlloc > 0 ? "WARN" : "ok",
        detail: completion
          ? `completion window (sites ${count1}->${count2}, remote ${remotes1}->${remotes2}) - progress delta ambiguous, skipped` +
            (receiptsDelta > 0 ? `; remote roads +${receiptsDelta}e via receipts` : "") +
            byRoom
          : standing || receiptsDelta > 0 || poolBuilt > 0
          ? `sites ${count1}->${count2}, remote ${remotes1}->${remotes2}, progress ${prog1}->${prog2}, plan alloc ${consAlloc.toFixed(1)} e/t` +
            (corpBuilt !== null ? `, corps built ${corpBuilt}e (produced counters)` : ", corps: no counter (pre-v14 capture)") +
            (receiptsDelta > 0 ? `, remote roads +${receiptsDelta}e (receipts)` : "") +
            (poolBuilt > 0 ? `, within-site +${poolBuilt}e (poolWork ${pool1}->${pool2})` : "") +
            (flat ? " - CREW IDLE (energy allocated, nothing built)" : "") +
            byRoom
          : "no sites standing across the window" + byRoom
      });
    }
  }

  // ---- P9 mined-production rot (owner-caught #19, 2026-07-19) ----
  // The plan self-consistency invariant that had NO ledger line: a funded miner
  // whose output the plan never routes. Live t72425058/t72424537: 7 funded mined
  // sources = 70 e/t produced, ZERO mined-source haulers, 0 e/t routed - the 555k
  // bank surplus out-competed real production at the nearest-first fill, so the
  // mined energy rotted at remote containers while the plan still paid to mine
  // it. The leak was invisible: it scattered across E2 (strands), E4 (idle
  // capital) and P7 (starved controller) with no single line naming it. Mined
  // sources carry the "source-" prefix; scavenge/bank ("scavenge-"/"bank-") are
  // free/transient and excluded. Production-first routing + the storage-as-hub
  // sink (this cycle) restore routed ~= produced.
  if (flow?.sources && flow?.haulers) {
    const isMined = (id: any): boolean => typeof id === "string" && id.startsWith("source-");
    // Spec 25 phase 3: no dedication carve-out - a source building locally
    // has ROUTES (source->construction) which count as routed below, so the
    // plain produced-vs-routed test is honest for every source again.
    const produced = (flow.sources as any[]).reduce((a, s) => a + (+s.harvestRate || 0), 0);
    const minedHaulers = (flow.haulers as any[]).filter(h => isMined(h.sourceId));
    const routed = minedHaulers.reduce((a, h) => a + (+h.flowRate || 0), 0);
    const ratio = produced > 0 ? routed / produced : 1;
    const meaningful = produced > 5; // no verdict on a colony with no remote mining
    rows.push({
      id: "P9",
      name: "mined production routed (rot detector)",
      value: +ratio.toFixed(2),
      unit: "x of funded mining",
      verdict: meaningful && ratio < 0.5 ? "FAIL" : meaningful && ratio < 0.8 ? "WARN" : "ok",
      detail:
        `funded mining ${(flow.sources as any[]).length} src / ${produced.toFixed(1)} e/t; ` +
        `routed ${routed.toFixed(1)} e/t via ${minedHaulers.length} mined-source haulers` +
        (meaningful && ratio < 0.5 ? " - MINED PRODUCTION ROTTING (funded but unrouted, #19)" : "")
    });
  }

  // ---- E6 miner pile gate: haul-deficit visibility (owner 2026-07-29) ----
  // The HarvestCorp buffer gate defers NEW miner bodies while a source mouth
  // holds >= SOURCE_BUFFER_DEFER_THRESHOLD unhauled (segment-4 stamp, v6).
  // The gate is a BACKSTOP against rot, not a fix: a holding gate means the
  // HAUL side is behind (missing drain term / route sizing / churn - the
  // CarryCorp pickup-buffer stamp names which). This line keeps the deferral
  // from MASKING that: chronic gating (both captures) WARNs on the haul
  // side, and a source gone DARK behind a full pile (gated with staffing 0 -
  // income actually stopped) FAILs. No stamped harvest corps => pre-gate
  // capture => no row.
  {
    // STALE-STAMP FILTER (cycle t72793209): a defunded corp's demand path
    // used to exit without stamping, so its lastSizing FROZE at the last
    // pre-defund value - E6 quoted "staffing 1/1 buffered 3825 held 100%"
    // for corps with ZERO creeps whose containers had already decayed away.
    // A stamp is evidence only if it was written inside this window.
    const stamped = corps.filter(
      (c: any) => c.kind === "harvest" && c.sizing && (c.sizing.tick ?? 0) >= base.tick
    );
    if (stamped.length > 0) {
      const gated = stamped.filter((c: any) => c.sizing.gate === "buffer-full");
      const bGated = new Set(
        (base.data.corps?.corps ?? [])
          .filter((c: any) => c.kind === "harvest" && c.sizing?.gate === "buffer-full")
          .map((c: any) => c.id)
      );
      const chronic = gated.filter((c: any) => bGated.has(c.id));
      const dark = gated.filter((c: any) => (c.sizing.staffing ?? 0) === 0);
      // Delay meter verdicts (v7 stamps, owner 2026-07-29): heldFor is the
      // MEASURED consecutive hold - one source regen cycle of continuous
      // deferral WARNs from a single capture (no second-capture wait), a
      // full miner lifetime FAILs (a whole generation of spawning
      // suppressed behind one pile). Pre-meter stamps (no heldFor) fall
      // back to the two-capture chronic read.
      const lifetimeHeld = gated.filter((c: any) => (c.sizing.heldFor ?? 0) >= CREEP_LIFETIME);
      // The frac trigger needs >=50t of current hold behind it (the
      // two-captures->=50t doctrine): a reset wipes the meter window and 7
      // all-held samples read frac 1.0 on 7 ticks of evidence (measured
      // first contact, t72645498 - real piles, premature verdict).
      const regenHeld = gated.filter(
        (c: any) =>
          (c.sizing.heldFor ?? 0) >= SOURCE_REGEN_TIME ||
          ((c.sizing.heldFrac ?? 0) >= 0.5 && (c.sizing.heldFor ?? 0) >= 50)
      );
      rows.push({
        id: "E6",
        name: "miner pile gate (haul deficit surfaced)",
        value: gated.length,
        unit: `of ${stamped.length} miner ops deferred`,
        verdict:
          dark.length > 0 || lifetimeHeld.length > 0
            ? "FAIL"
            : chronic.length > 0 || regenHeld.length > 0
            ? "WARN"
            : "ok",
        detail:
          gated.length === 0
            ? "no deferrals - source buffers under threshold"
            : gated
                .map(
                  (c: any) =>
                    `${String(c.id).slice(-14)} buffered ${c.sizing.buffered} staffing ${c.sizing.staffing}/${c.sizing.target}` +
                    (c.sizing.heldFor !== undefined
                      ? ` held ${c.sizing.heldFor}t (${((c.sizing.heldFrac ?? 0) * 100).toFixed(0)}% of window)`
                      : "") +
                    (bGated.has(c.id) ? " CHRONIC" : "")
                )
                .join("; ") +
              " => the leak is HAULING (drain term / route sizing / churn - read the carry pickup stamps), not the miner" +
              (dark.length > 0 ? `; ${dark.length} source(s) DARK behind a full pile - income stopped` : "")
      });
    }
  }

  // ---- X1 dry WORK ticks (owner doctrine 2026-07-21: "having body parts
  // standing around, unable to do their job is one form of waste ... hauling
  // and working grow in concert, spawned as a package") ----
  // The upgrade meter (Memory.upgradeMeter, tallied at the upgradeController
  // call site) stamps workUtil/dryShare into the upgrader sizing record.
  // Idle standing WORK = work parts x (1 - workUtil): capacity the colony
  // paid spawn time for that produced nothing. dryShare names the supply-
  // starved share of it - the half the package-spawn remedy targets.
  // Pre-meter captures (no workUtil in the stamp) skip the row.
  {
    const upg = (cap.data.corps?.corps ?? []).find((c: any) => c.kind === "upgrade" && c.sizing?.workUtil !== undefined);
    const work = upg?.body?.work ?? 0;
    if (upg && work > 0) {
      const workUtil = +upg.sizing.workUtil;
      const dryShare = +upg.sizing.dryShare || 0;
      const idleWork = work * (1 - workUtil);
      const meaningful = work > 10 && (upg.sizing.meterTicks ?? 0) > 100;
      rows.push({
        id: "X1",
        name: "dry WORK ticks (standing-but-idle)",
        value: +idleWork.toFixed(1),
        unit: "WORK parts idle-equivalent",
        verdict: meaningful && workUtil < 0.7 ? "FAIL" : meaningful && workUtil < 0.85 ? "WARN" : "ok",
        detail:
          `${work} WORK standing, workUtil ${workUtil.toFixed(2)} over ${upg.sizing.meterTicks}t; ` +
          `dry (supply-starved) ${dryShare.toFixed(2)}` +
          (meaningful && workUtil < 0.7 ? " - STANDING PARTS NOT WORKING (grow hauling+working as a package)" : "")
      });
    }
  }

  // ---- X3 census ----
  // ---- X4 lifetime quantization (owner 2026-07-22: "this rounding factor
  // is something we can track in telemetry as well for the future") ----
  // A hauler's effective life divides into floor(life/roundTrip) full
  // trips; the remainder ticks cannot fit another trip. With END-OF-LIFE
  // recycling (same commit) that tail converts to a spawn refund; without
  // it, the body walks its tail off and the amortization is lost. Priced
  // from the PLAN's routes: remainder/life x standing body cost per tick.
  {
    const srcRoutes = (flow?.haulers ?? []).filter((h: any) => (h.sourceId ?? "").startsWith("source-"));
    let waste = 0;
    let worst = "";
    let worstV = 0;
    for (const h of srcRoutes) {
      const d = +h.distance || 0;
      const rt = 2 * d + 2;
      const life = Math.max(1, 1500 - d);
      const rem = life % rt;
      const partsPerCarry = h.ratio === "2:1" ? 1.5 : 2;
      const bodyPerTick = ((+h.carryParts || 0) * partsPerCarry * 50) / life;
      const v = bodyPerTick * (rem / life);
      waste += v;
      if (v > worstV) {
        worstV = v;
        worst = `${String(h.sourceId ?? "").slice(-8)} rem ${rem}t of ${rt}t trips`;
      }
    }
    rows.push({
      id: "X4",
      name: "lifetime quantization (trip rounding)",
      value: +waste.toFixed(2),
      unit: "e/t amortization in trip tails",
      verdict: "ok",
      detail:
        srcRoutes.length > 0
          ? `${srcRoutes.length} routes; worst ${worst}; EOL recycle converts tails to refunds`
          : "no source routes"
    });
  }

  // ---- X6 over-built hauler bodies (needs the blackbox spawn log, segment 5) ----
  //
  // The regression pin for the 2026-07-31 route-sizing fix. A hauler body is
  // never worth more CARRY than its WHOLE route can load; past that the parts
  // are dead weight bought out of a saturated spawn's build time. Both sizers
  // used to measure a body against the ROOM's maxCarryPairs (25 at RCL7), so
  // a 7-CARRY route bought 25-CARRY bodies and retired the 8-CARRY incumbent
  // that covered it - measured 0.471 p/t of hauler spawn against a plan of
  // 0.225 with the STANDING fleet on plan (t72695674).
  //
  // Measured against the plan's per-route carryParts, with headroom for the
  // legitimate terms the plan number does not carry: the buffer-DRAIN term
  // (haulCarryNeeded adds staged/1500 on top of sustained inflow) and integer
  // body rounding. OVERBUILD_TOLERANCE is deliberately loose - this row must
  // catch a 3.5x over-buy without false-failing a drain-fed body, because a
  // ledger line that cries wolf gets ignored (the lesson E5's plan-blind
  // cost<300 test already taught).
  {
    const spawnRows = ((cap.data.blackbox?.rows ?? []) as any[]).filter(
      r => r.k === "spawn" && r.d?.role === "hauler" && typeof r.d?.parts === "number"
    );
    // suffix -> {carry, ratio} of the planned route, same id convention the
    // corp ids use (legacyNodeId keys off sourceId.slice(-4)).
    const planRoute = new Map<string, { carry: number; ratio: string }>();
    for (const h of (flow?.haulers ?? []) as any[]) {
      const suf = String(h.sourceId).replace(/^source-|^scavenge-[EW]\d+[NS]\d+-|^bank-/, "").slice(-4);
      const prev = planRoute.get(suf);
      if (!prev || h.carryParts > prev.carry) planRoute.set(suf, { carry: +h.carryParts || 0, ratio: h.ratio ?? "1:1" });
    }
    // The corp's OWN carryNeeded stamp beats the plan number wherever it
    // exists: haulCarryNeeded = sustained inflow PLUS the buffer-drain term, so
    // a route with a standing pile legitimately needs more carry than the plan
    // prices and a plan-only comparator false-fails it (measured while building
    // this row: W44N22-17-6 read 4.0x against a 2.0c plan route while its own
    // stamp said carryNeeded 11 behind a 4,114 pile - not an over-buy at all).
    // `hauling-*` corps stamp it directly; `mining-*` operations expose their
    // haul vector's stamp via innerSizing (segment 4 v12+, 2026-07-31).
    //
    // Read from BOTH ENDPOINTS and keep the MAX (2026-07-31, second cycle):
    // a body is judged against the largest need its route carried during the
    // window, because the plan can re-route a source mid-life. Measured on the
    // first live FAIL this row produced: `mining-W43N24-harvest-cd8d` bought a
    // 22-CARRY hauler at t72701035 against a stamped carryNeeded of 18 (1.2x -
    // correct), and the wartime regime then re-pointed the source at a
    // construction site ONE TILE away, collapsing carryNeeded to 5. Judged on
    // the closing stamp alone that correct body reads 4.4x over. A pin that
    // cries wolf is worse than no pin - it trains us to ignore the line.
    const stampedNeed = new Map<string, number>();
    const noteNeed = (id: string, n: unknown): void => {
      if (typeof n === "number") stampedNeed.set(id, Math.max(stampedNeed.get(id) ?? 0, n));
    };
    for (const capture of [cap, base]) {
      for (const c of (capture?.data?.corps?.corps ?? []) as any[]) {
        noteNeed(c.id, c.sizing?.carryNeeded);
        for (const inner of (c.innerSizing ?? []) as any[]) noteNeed(c.id, inner.sizing?.carryNeeded);
      }
    }
    const OVERBUILD_TOLERANCE = 2.0;
    let overParts = 0;
    let worst = "";
    let worstRatio = 0;
    let judged = 0;
    let stamped = 0;
    for (const r of spawnRows) {
      const suf = String(r.d.corp)
        .replace(/^mining-[EW]\d+[NS]\d+-harvest-|^hauling-[EW]\d+[NS]\d+-hauling-/, "")
        .slice(-4);
      const route = planRoute.get(suf);
      if (!route || route.carry <= 0) continue; // no plan route vouches for a size
      const need = stampedNeed.get(String(r.d.corp)) ?? route.carry;
      if (need <= 0) continue;
      judged += 1;
      stamped += stampedNeed.has(String(r.d.corp)) ? 1 : 0;
      // spawned CARRY back out of the body: 1:1 packs 2 parts per CARRY, the
      // road ratio 2:1 packs 1.5.
      const partsPerCarry = route.ratio === "2:1" ? 1.5 : 2;
      const spawnedCarry = r.d.parts / partsPerCarry;
      // At or below the sizer's own HAULER_MIN_CARRY floor the body size is set
      // by the FLOOR, not by the route, so it cannot be an over-buy however
      // small the route is. Without this the row fails on every micro-route's
      // 1-CARRY body (a 0.1c planned route reads 7.9x) - which is P2's finding,
      // not this row's, and is the false-positive class that trains us to
      // ignore a line.
      if (spawnedCarry <= 3) continue;
      const ceiling = need * OVERBUILD_TOLERANCE;
      if (spawnedCarry <= ceiling) continue;
      overParts += (spawnedCarry - need) * partsPerCarry;
      const ratio = spawnedCarry / need;
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worst = `${r.d.corp} ${spawnedCarry.toFixed(0)}c on a ${need.toFixed(1)}c route (${ratio.toFixed(1)}x)`;
      }
    }
    const allRows = (cap.data.blackbox?.rows ?? []) as any[];
    const window = allRows.length > 1 ? allRows[allRows.length - 1].t - allRows[0].t : 0;
    if (judged > 0 && window > 0) {
      const pt = overParts / window;
      rows.push({
        id: "X6",
        name: "over-built hauler bodies (route-sizing pin)",
        value: +pt.toFixed(3),
        unit:
          `p/t bought above the route (${judged} hauler spawns judged` +
          (stamped * 2 < judged ? `, DRAIN-BLIND on ${judged - stamped} - needs segment 4 v12 stamps)` : `)`),
        // FAIL only on a body more than DOUBLE its whole route - the shape the
        // fix removed. Any excess at all is worth a WARN once it is measurable.
        verdict: worstRatio >= 2.5 ? "FAIL" : pt > 0 ? "WARN" : "ok",
        detail:
          `${stamped}/${judged} judged against the corp's OWN carryNeeded stamp (rest against the plan route, drain-priced since #8) - ` +
          (worstRatio > 0
            ? `worst ${worst}; ${overParts.toFixed(0)} parts over ${window}t`
            : `every hauler body within ${OVERBUILD_TOLERANCE}x its route's need`)
      });
    }
  }

  // ---- R1 raid-tax calibration (measured attrition vs the priced tax) ----
  //
  // The invader tax's 750e constant prices ONE GUARD BODY per expected raid -
  // its own doc calls it "a DERIVED starting point" awaiting measured
  // replacement at >= 10 fiscal windows (the multi-draw rule). Until the
  // constant swaps, THIS row accumulates the evidence at every close: what
  // raids actually cost (killed-cargo from the death watch, capture-window
  // cumulative + early-death body churn from the ring, its own window
  // stated) against what the plan charges. FY4849-M03's first read: kills at
  // mean ttl 621 with the tax covering a small fraction - the plan admits
  // remotes at margins the raid reality does not deliver.
  {
    const cc = cap.data.core?.losses?.cumulative as Record<string, number> | undefined;
    const cb = base.data.core?.losses?.cumulative as Record<string, number> | undefined;
    const killedCargo =
      cc?.tombstoneKilled !== undefined && cb?.tombstoneKilled !== undefined
        ? Math.max(0, (cc.tombstoneKilled ?? 0) - (cb.tombstoneKilled ?? 0)) / dt
        : null;
    const churnR1 = computeChurn(cap);
    const bodyChurn =
      churnR1 && churnR1.windowTicks > 0 ? churnR1.remoteChurn / churnR1.windowTicks : null;
    const grossCap = ((cap.data.flow?.sources ?? []) as any[]).reduce(
      (n: number, s: any) => n + (+s.harvestRate || 0),
      0
    );
    const priced = INVADER_TAX_PER_ENERGY * grossCap;
    if (killedCargo !== null && priced > 0) {
      const measured = killedCargo + (bodyChurn ?? 0);
      const ratio = measured / priced;
      rows.push({
        id: "R1",
        name: "raid-tax calibration (measured attrition vs priced)",
        value: +ratio.toFixed(1),
        unit: "x the priced tax",
        // The constant is KNOWN provisional; the row is a gauge, so it never
        // FAILs - it accumulates toward the >=10-window calibration bar.
        verdict: ratio > 3 || ratio < 1 / 3 ? "WARN" : "ok",
        detail:
          `measured ${measured.toFixed(2)} e/t (killed cargo ${killedCargo.toFixed(2)} full-window` +
          (bodyChurn !== null ? ` + remote churn bodies ${bodyChurn.toFixed(2)} over ${churnR1!.windowTicks}t ring` : "") +
          `) vs priced ${priced.toFixed(2)} (${INVADER_TAX_PER_ENERGY.toFixed(4)}/e x ${grossCap.toFixed(0)} e/t capacity); ` +
          `swap EXPECTED_RAID_DEFENSE_COST only at >=10 accumulated fiscal windows`
      });
    }
  }

  // ---- L1 loss-budget adherence (spec 42 stage A: every loss has a budget) ----
  //
  // The MEASURED LOSSES block prices each line from a primitive (never "-"):
  // pile decay budgets ZERO (pileDecayBudget at the gate's own design point -
  // the plan intends every mouth held AT the container cap, so all measured
  // ground decay is priced unfavorable variance pointing at the haul deficit);
  // tombstones budget the invader tax on R1's capacity basis (one constant
  // home - the two rows move together at the >=10-window swap); repair budgets
  // the structure-decay ACCRUAL (service what decays - the depreciation memo's
  // shortfall becomes priced variance). FAIL when any line breaches 25% of its
  // budget, with a 0.25 e/t noise floor so a zero budget never FAILs on dust.
  {
    const cc = cap.data.core?.losses?.cumulative as Record<string, number> | undefined;
    const cb = base.data.core?.losses?.cumulative as Record<string, number> | undefined;
    if (cc && cb && dt > 0) {
      const d = (k: string): number => Math.max(0, (cc[k] ?? 0) - (cb[k] ?? 0)) / dt;
      const sources = (cap.data.flow?.sources ?? []) as any[];
      const grossCapL1 = sources.reduce((n: number, s: any) => n + (+s.harvestRate || 0), 0);
      const NOISE_FLOOR = 0.25; // e/t - dust under this never breaches a zero budget
      const lines = [
        // Every mouth at the gate's design point carries zero ground share.
        { name: "pile decay", actual: d("pileDecay"), budget: sources.length * pileDecayBudget(SOURCE_BUFFER_DEFER_THRESHOLD) },
        { name: "tombstones", actual: Math.max(0, d("tombstoneGross") - d("tombstoneRecovered")), budget: tombstoneLossBudget(grossCapL1) },
        { name: "repair", actual: d("repairSpend"), budget: d("structureDecay") }
      ].map(l => {
        const tolerance = Math.max(0.25 * l.budget, NOISE_FLOOR);
        const gap = l.actual - l.budget;
        return { ...l, gap, ratio: Math.abs(gap) / Math.max(l.budget, NOISE_FLOOR), breach: Math.abs(gap) > tolerance };
      });
      const breached = lines.filter(l => l.breach);
      const worst = [...lines].sort((a, b) => b.ratio - a.ratio)[0];
      rows.push({
        id: "L1",
        name: "loss-budget adherence (every loss priced, spec 42-A)",
        value: +worst.ratio.toFixed(2),
        unit: "x budget |gap| (worst line)",
        verdict: breached.length > 0 ? "FAIL" : "ok",
        detail:
          lines
            .map(l => `${l.breach ? "BREACH " : ""}${l.name} ${l.actual.toFixed(2)} vs budget ${l.budget.toFixed(2)} (${l.gap >= 0 ? "+" : ""}${l.gap.toFixed(2)})`)
            .join("; ") + `; tolerance 25% of budget, floor ${NOISE_FLOOR} e/t`
      });
    }
  }

  // ---- X5 rebuild churn (needs the blackbox spawn log, segment 5) ----
  {
    const churn = computeChurn(cap);
    if (churn && churn.totalSpawnEnergy > 0) {
      const homeShare = churn.homeChurn / churn.totalSpawnEnergy;
      // a gap below one creep's ~60t spawn floor cannot be a sequential death -
      // it is a re-order/loop (the stranded-reserver trap, or a post-reset
      // double-order). Flag it regardless of home/remote.
      const loop = churn.worstGap < 60;
      rows.push({
        id: "X5",
        name: "rebuild churn (early-death respawns)",
        value: +(churn.churnEnergy / churn.totalSpawnEnergy).toFixed(2),
        unit: "of spawn spend",
        verdict: homeShare > 0.12 || loop ? "WARN" : "ok",
        detail:
          `${churn.churnEnergy.toFixed(0)}e of ${churn.totalSpawnEnergy}e over ${churn.windowTicks}t ` +
          `(home ${((100 * churn.homeChurn) / churn.totalSpawnEnergy).toFixed(0)}% bot-signal, ` +
          `remote ${((100 * churn.remoteChurn) / churn.totalSpawnEnergy).toFixed(0)}% invader/revoke noise); ` +
          `worst ${churn.worst}` +
          (loop ? " - FAST RESPAWN (<60t = double-order/loop; check vs deploy log + P5/P6)" : "") +
          (homeShare > 0.12 && !loop ? " - HOME churn high (a reset inflates it ~1 window; read deploy log)" : "")
      });
    }
  }

  rows.push({
    id: "X3",
    name: "untracked creeps",
    value: core.creeps.untracked,
    unit: "creeps",
    verdict: core.creeps.untracked > 2 ? "FAIL" : "ok",
    detail: `${core.creeps.tracked}/${core.creeps.total} tracked`
  });

  // ---- P11 link/haul representation mismatch (owner 2026-08-01) ----
  //
  // The plan models bank->controller flow as HAULER edges carrying `carryParts`,
  // but in a link-served room the LINK network performs that work (hub link ->
  // controller link -> the feeder relays the last tile). No hauler is ever built
  // for those parts, so they inflate every plan-vs-actual hauler comparison.
  //
  // Found while reading plan-vs-actual bodies at t72714129: planned hauler CARRY
  // 198.1 vs 210 fielded read as a comfortable 1.06x, but 26.1 of those planned
  // parts are bank->controller edges the link serves. Against source routes only
  // (168.8 planned) the same fleet is 1.24x - still in tolerance, but a quarter
  // over rather than a rounding error.
  //
  // NOT a leak: nothing is wasted, the link is the cheaper carrier. It is a
  // REPRESENTATION mismatch that biases a reading, so it warns rather than
  // fails, and only when a controller link is actually live - without one those
  // haul edges are real work and the plan is right.
  {
    const linkRooms = new Set(
      ((core.links ?? []) as any[]).filter(l => (l.toControllerRate ?? 0) > 0).map(l => l.room)
    );
    const haulers = (flow?.haulers ?? []) as any[];
    const totalCarry = haulers.reduce((n, h) => n + (+h.carryParts || 0), 0);
    // bank-sourced edges into a controller, in a room the link already serves
    const linkServed = haulers.filter(h => {
      if (!String(h.sourceId ?? "").startsWith("bank-")) return false;
      if (!String(h.sinkId ?? "").startsWith("controller-")) return false;
      return linkRooms.has(String(h.sourceId).replace(/^bank-/, ""));
    });
    const notional = linkServed.reduce((n, h) => n + (+h.carryParts || 0), 0);
    if (linkRooms.size > 0 && totalCarry > 0) {
      const share = notional / totalCarry;
      rows.push({
        id: "P11",
        name: "link/haul representation (notional hauler parts)",
        value: +notional.toFixed(1),
        unit: `CARRY parts the plan bills to haulage that the LINK performs (${(share * 100).toFixed(0)}% of planned carry)`,
        // Not waste - a reading bias. Warn once it is big enough to matter to a
        // plan-vs-actual hauler comparison.
        verdict: share > 0.1 ? "WARN" : "ok",
        detail:
          (linkServed.length > 0
            ? `${linkServed.length} bank->controller edge(s) in link-served room(s) [${[...linkRooms].join(", ")}]; ` +
              `source-route carry alone is ${(totalCarry - notional).toFixed(1)} - compare fielded CARRY against THAT`
            : "no bank->controller edges in link-served rooms") +
          `; no energy is wasted (the link is the cheaper carrier) - this biases the plan-vs-actual READING only`
      });
    }
  }

  // ---- P12 valve coherence: published allocation vs the phase-D law ----
  //
  // RE-PINNED 2026-08-04 (methodology #11). The gauge was born (owner
  // 2026-08-01: "the plan and actual controller should use the same valve
  // formula logic") against a runtime CONSTANT - STORAGE_UPGRADE_TARGET +
  // drain - that spec-38 phase D retired the same day this re-pin landed:
  // the plan's controller sink and the feeder now both resolve ONE law,
  // bankFedControllerRate = sip + surplus/tau. The old two-sided
  // decomposition subtracted the drain from BOTH sides and printed
  // "Infinity x" on negative terms (t72773737: plan -17.40 vs runtime
  // -12.40) - a model artifact on exactly the seam it existed to name.
  //
  // What still diverges is the SOLVER: an over-claiming spawn sink
  // (fundingNeed / FUND_HORIZON - physically capped at spawnEnergyCeiling
  // since t72773737) parks the bank draw, and the PUBLISHED allocation
  // lands below the law's cap: measured 39.64 vs 59.04 (0.67x) with 116.97
  // e/t routed to spawn sink claims against ~36.5 physically convertible -
  // the binding seam of the 40-GCL program. The row reads published/cap;
  // the feeder relay rides in the detail (relay < published would be a
  // RUNTIME fault - none seen since phase B).
  {
    const banked = ((core.rooms ?? []) as any[]).reduce((n, r) => n + (r.storageEnergy ?? 0), 0);
    const feeder = corps.find((c: any) => c.kind === "controllerFeeder");
    const relay = feeder?.sizing?.relayRate;
    const ctrlSink = ((flow?.sinks ?? []) as any[]).find(x => x.type === "controller");
    if (ctrlSink && banked > 0) {
      const alloc = +ctrlSink.allocated || 0;
      const lawCap = bankFedControllerRate(banked, resolveReserve(cap));
      const spawnClaim = ((flow?.sinks ?? []) as any[])
        .filter(x => x.type === "spawn")
        .reduce((n, x) => n + (+x.allocated || 0), 0);
      const ratio = lawCap > 0 ? alloc / lawCap : 1;
      rows.push({
        id: "P12",
        name: "valve coherence (published allocation vs phase-D law)",
        value: +ratio.toFixed(2),
        unit: `x of the law's cap (published ${alloc.toFixed(2)} vs bankFedControllerRate ${lawCap.toFixed(2)})`,
        verdict: ratio < 0.5 || ratio > 2 ? "FAIL" : ratio < 0.8 || ratio > 1.25 ? "WARN" : "ok",
        detail:
          `ONE law both sides since spec-38 phase D; the remaining gap is the SOLVER's - it routes ` +
          `${spawnClaim.toFixed(2)} e/t to spawn sink claims (physical ceiling caps the claim since t72773737), ` +
          `and the published allocation gets the residual` +
          (typeof relay === "number"
            ? `; feeder relay ${relay.toFixed(2)} ${relay + 1e-9 >= alloc ? ">= published (ONE VALVE holds)" : "< published - RUNTIME FAULT"}`
            : "")
      });
    }
  }

  // ---- G1 sustained progress: score NET OF BANK DRAWDOWN (owner 2026-08-01) ----
  //
  // Pushed LAST on purpose. The sort below is stable, so within a verdict the
  // insertion order stands, and formatLedger names fails[0] as the cycle's
  // work item. G1 is an OUTCOME metric, not a leak class - the action on a G1
  // FAIL is always "find which leak caused it", one of the rows above. The
  // first draft pushed it first and it hijacked the work item from P9's
  // rotting production; the suite caught it (P9 must lead on that fixture).
  //
  // THE GOAL METRIC. Raw pts/t is not it, because the same colony scored 68.29
  // while burning the bank at -45.52 e/t and 47.59 while burning it at -5.74 -
  // and the first is a stockpile liquidation that ends, the second is income.
  //
  // What the sum MEANS (derived, not asserted - the P10 lesson):
  //   bankSlope = income - controller - spawn - construction
  //   => score + bankSlope = income - spawn - construction
  // i.e. the RESIDUAL the economy can sustainably route to the controller at
  // its current spawn and construction burn. Score above it is drawdown; score
  // below it is banking. Both sides are measured in the same unit (energy/tick;
  // one GCL point IS one energy delivered), so the addition is meaningful.
  //
  // Caveat carried in the detail line, not hidden: bankSlope also absorbs
  // construction spend and decay, so `funded` is "not drawn from storage",
  // NOT "converted to progress". It is a floor on sustainability, not an
  // energy audit. Shares an input with E4 but asks a different question - E4
  // asks whether capital is idle, this asks what is paying for the score.
  {
    const bankOf = (c: any): number =>
      (c.data.core.rooms ?? []).reduce((s: number, r: any) => s + (r.storageEnergy ?? 0), 0);
    const g = core.gcl?.progress;
    const bg = bcore.gcl?.progress;
    if (typeof g === "number" && typeof bg === "number" && dt > 0) {
      const score = (g - bg) / dt;
      const slope = (bankOf(cap) - bankOf(base)) / dt;
      const funded = score + slope;
      const share = score > 0 ? funded / score : 1;
      // A window shorter than the measured limit-cycle period samples a PHASE
      // (OSC carries the same warning); say so rather than pretending to a rate.
      const shortWindow = dt < 6000;
      // THREE regimes, not one axis. `funded` is the sustainable capacity;
      // `score` is what was actually delivered against it.
      //  - score >> funded  => LIQUIDATION (the saw-tooth down-stroke)
      //  - score ~= funded  => matched, the healthy state
      //  - score << funded  => UNDER-SPENDING: capacity banked instead of
      //    delivered. Caught in validation: the t72703512 trough scored 19.63
      //    while banking +25.88 and the share form read "232% income-funded,
      //    ok" - a compliment on the wasteful quadrant. A share above 1 is not
      //    more health, it is unconverted capacity, so it gets its own arm.
      const banking = share > 1.05;
      const shortfall = funded - score;
      rows.push({
        id: "G1",
        name: "sustained progress (score net of bank drawdown)",
        value: +funded.toFixed(2),
        unit: `pts/t sustainable (delivered ${score.toFixed(2)}, bank ${slope >= 0 ? "+" : ""}${slope.toFixed(2)})`,
        // FAIL only on LIQUIDATION - the down-stroke shape (measured t72701842:
        // delivered 68.29 against 22.77 sustainable, 33%). Healthy arcs measured
        // 76-88%, so 0.5 separates them with room. Under-spending WARNs: it is
        // real waste (OSC names the same quadrant from the fleet side) but it
        // burns no capital, so it never outranks a liquidation.
        verdict: banking ? "WARN" : score > 0 && share < 0.5 ? "FAIL" : share < 0.75 ? "WARN" : "ok",
        detail:
          (banking
            ? `UNDER-SPENDING: delivering ${score.toFixed(2)} of ${funded.toFixed(2)} sustainable - ` +
              `${shortfall.toFixed(2)} pts/t of capacity BANKED instead of delivered`
            : `${(share * 100).toFixed(0)}% of the score is income-funded`) +
          ` over ${dt}t` +
          (shortWindow ? " [SHORT WINDOW - phase sample, not a rate]" : "") +
          `; sustainable = income - spawn - construction (bank slope also absorbs construction + decay,` +
          ` so this is a sustainability floor, not an energy audit)`
      });
    }
  }

  const rank = { FAIL: 0, WARN: 1, ok: 2 };
  return rows.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
}


/**
 * THE ENERGY ACCOUNT - a standing chart of accounts for the colony, printed
 * above the leak ledger every cycle (owner 2026-08-01: "we at one point had a
 * sort of standardized chart of accounts like an income statement ... the exact
 * chart or report will evolve over time").
 *
 * Every term is energy/tick over the window, and the statement BALANCES BY
 * CONSTRUCTION: revenue - operating cost - appropriations = RESIDUAL. The
 * residual is the whole point. It is not a rounding bucket - it is the
 * unattributed energy (ground decay, rot above the container cap, raid losses,
 * tower burn, measurement error), and it inherits spec 20's discipline: a
 * named residual that cannot silently grow because both sides are published.
 *
 * Sources, and their honesty limits:
 *  - REVENUE is the PLAN's gross mining capacity, less the measured change in
 *    source piles (`core.sourceBuffers`). It is a capacity figure, not a
 *    measured delivery - we have no independent meter of energy actually
 *    landed in storage, so income is NOT derived as the balancing figure
 *    (that would make the residual circular and meaningless).
 *  - OPERATING COST is measured at the spawn (the blackbox ring, by role), so
 *    it is real spend, not a plan price.
 *  - APPROPRIATIONS are measured: controller = gcl delta (1 point IS 1
 *    energy), construction = the P8 lens, bank = storage delta.
 *
 * The ring and the capture window differ in length; each figure is normalised
 * over its OWN window, which is exact for rates and is stated in the header.
 */
/**
 * ACCOUNT each spawn ROLE is charged to in the energy account.
 *
 * The OPERATING/CAPITAL split is the accounting judgement here, and it matters
 * (owner asked "what about claim corp" 2026-08-01, when four roles - claimer,
 * scout, buster, striker - were silently landing in an unnamed "other"):
 *
 *  - `claimer` is EXPANSION CAPEX, not operating cost. `BASE_RESERVE =
 *    EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE` exists specifically to fund
 *    it, and a 600e/CLAIM-part body buys a permanent new room. Charging it to
 *    opex would make the operating margin look worst in exactly the cycle
 *    where expanding is the right call - the classic reason capex is a
 *    separate account.
 *  - `buster`/`striker` are the same shape: coreBusterKind's own comment says
 *    "off-budget: the mission restores a zeroed income stream". Capital repair
 *    of an income asset, not running cost.
 *  - `scout` IS operating cost - intel is continuous, and the bodies are ~50e.
 *
 * Ratcheted by test against ALL_SPAWN_ROLES (the kinds' own `roles`
 * declarations), so a new kind's role fails the audit until someone decides
 * its account, rather than vanishing into a bucket. Any role that still slips
 * through prints as UNCLASSIFIED with its name, never as anonymous "other".
 */
export const ACCOUNT_CLASS_OF_ROLE: Record<string, string> = {
  // DIRECT COST OF MINING - the three roles whose spend is attributable to the
  // gross-mining revenue line, so the statement can show a NET MINING MARGIN
  // (owner 2026-08-01: "reserving is an overhead applied to the gross mining").
  //
  // Reservation belongs here on a verifiable dependency, not a vibe: the plan
  // prices EVERY source at rate 10 = SOURCE_ENERGY_CAPACITY(3000)/
  // SOURCE_REGEN_TIME(300), which is the RESERVED yield. An unreserved remote
  // regenerates 1500 per 300t, i.e. 5 e/t. So on 8 remote sources the
  // reservation fleet is buying ~40 e/t of the 100 e/t revenue line - it is
  // cost of goods, not general overhead, and burying it in infra hid both the
  // cost AND the return.
  miner: "extraction",
  hauler: "evacuation",
  reserver: "reservation",
  // `tanker` is bought by TWO kinds - extensionTender (refills the spawn
  // network: infra) and construction (crew haulage: really a build cost). The
  // role alone cannot separate them, so both land in infra and the line
  // slightly OVER-states infra during a build campaign. Stated rather than
  // inferred from a corp-id prefix; a corp->kind join would fix it but cannot
  // resolve a corp that died inside the window.
  tanker: "infra",
  feeder: "infra",
  scout: "infra",
  guard: "defense",
  upgrader: "consumers",
  builder: "consumers",
  claimer: "expansion",
  buster: "incursion",
  striker: "incursion"
};

export function formatAccounts(cap: any, base: any, rows: LedgerRow[]): string {
  const core = cap.data.core;
  const bcore = base.data.core;
  const dt = cap.tick - base.tick;
  if (dt <= 0) return "";
  const rows0 = (cap.data.blackbox?.rows ?? []) as any[];
  const ring = rows0.length > 1 ? rows0[rows0.length - 1].t - rows0[0].t : 0;
  const spawnRows = rows0.filter(r => r.k === "spawn" && r.d?.cost);

  // SPAWN COSTS OVER THE CAPTURE WINDOW (methodology #7). The blackbox ring is
  // heap state: a deploy restarts it, so every "measured at the spawn" line
  // sampled a post-deploy window (480t live) against a 1500-tick fiscal month
  // and the coherence guard fired on essentially every close. The spawn ledger
  // (core v25) publishes CUMULATIVE energy-by-role totals; when BOTH captures
  // carry them the account differences those - the same shape as gcl.progress,
  // storage and the loss lines - and the ring remains only the forensic
  // fallback for older captures, stated as such in the header.
  const spendOf = (c: any): { energyByRole: Record<string, number> } | undefined => c.data.core?.spawnSpend;
  const spendCap = spendOf(cap);
  const spendBase = spendOf(base);
  const spawnSpanned = spendCap !== undefined && spendBase !== undefined;

  const cost: Record<string, number> = {
    extraction: 0, evacuation: 0, reservation: 0,
    infra: 0, defense: 0, consumers: 0, expansion: 0, incursion: 0, other: 0
  };
  const unknownRoles = new Set<string>();
  if (spawnSpanned) {
    const roles = new Set([...Object.keys(spendCap.energyByRole ?? {}), ...Object.keys(spendBase.energyByRole ?? {})]);
    for (const role of roles) {
      const spent = Math.max(0, (spendCap.energyByRole?.[role] ?? 0) - (spendBase.energyByRole?.[role] ?? 0));
      if (spent <= 0) continue;
      const cls = ACCOUNT_CLASS_OF_ROLE[role];
      if (!cls) unknownRoles.add(role);
      cost[cls ?? "other"] += spent;
    }
  } else {
    for (const r of spawnRows) {
      const cls = ACCOUNT_CLASS_OF_ROLE[r.d.role];
      if (!cls) unknownRoles.add(r.d.role);
      cost[cls ?? "other"] += r.d.cost;
    }
  }
  const perTick = (n: number) => (spawnSpanned ? n / dt : ring > 0 ? n / ring : 0);
  // THE CURE'S COST (methodology #10, owner 2026-08-04 "what if the cure is
  // worse than the illness"): the recovery fleet's spend, split OUT of the
  // evacuation line for display and priced against the witnessed-recovered
  // credit in the RECOVERY P&L memo. Known only when BOTH captures carry the
  // v30 sub-counter - a one-sided read would difference a lifetime total
  // against nothing and print fiction.
  const scavOf = (s: { energyByRole: Record<string, number> } | undefined): number | undefined =>
    (s as { scavengeEnergy?: number } | undefined)?.scavengeEnergy;
  const scavSpend =
    spawnSpanned && scavOf(spendCap) !== undefined && scavOf(spendBase) !== undefined
      ? Math.max(0, (scavOf(spendCap) ?? 0) - (scavOf(spendBase) ?? 0))
      : undefined;
  const direct = cost.extraction + cost.evacuation + cost.reservation;
  const overhead = cost.infra + cost.defense + cost.consumers + cost.other;
  const capital = cost.expansion + cost.incursion;
  const spawnTotal = direct + overhead + capital;

  const piles = (c: any): number =>
    Object.values((c.data.core.sourceBuffers ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
  const bank = (c: any): number =>
    (c.data.core.rooms ?? []).reduce((s: number, r: any) => s + (r.storageEnergy ?? 0), 0);

  const grossCapacity = ((cap.data.flow?.sources ?? []) as any[]).reduce((n, s) => n + (+s.harvestRate || 0), 0);
  // FORGONE MINING (methodology #3). Revenue was booked at the plan's RESERVED
  // CAPACITY - what the sources COULD yield - and that is falsified by the
  // miners' own decision stamps. A miner whose buffer is full stops harvesting:
  // `heldFrac` is the share of the window its E6 gate held it, stamped at the
  // decision site, so `rate * heldFrac` is capacity that was never mined at all.
  //
  // Measured t72721419: four ops CHRONICALLY buffer-full (heldFrac 0.97, 0.94,
  // 0.55, 0.28), summing to 3.03 source-equivalents = 30.28 e/t of the nominal
  // 100 never harvested. Booking that as revenue inflated every line below it
  // and was a large part of why the residual went NEGATIVE (over-attributed) as
  // soon as the loss meter gave the account real costs to subtract.
  const harvestCorps = ((cap.data.corps?.corps ?? []) as any[]).filter(c => c.kind === "harvest");
  const heldFracSum = harvestCorps.reduce((n, c) => n + Math.min(1, Math.max(0, +c.sizing?.heldFrac || 0)), 0);
  const sourceRate = harvestCorps.length > 0 ? grossCapacity / harvestCorps.length : 0;
  const forgone = heldFracSum * sourceRate;
  const forgoneKnown = harvestCorps.some(c => c.sizing?.heldFrac !== undefined);
  // MEASURED MINED (phase 2, corps segment v14): difference each harvest
  // corp's cumulative `produced` (harvested energy, reset-surviving via the
  // commission store) between the two captures. This RE-BOOKS the revenue
  // contra from measurement: the heldFrac forgone above is an INFERENCE from
  // a spawn de-pricing stamp - the harvester's own loop harvests
  // unconditionally, so the stamp can both over-count (harvest continued
  // while "held") and under-count (unstaffed mouths, unreserved downgrades -
  // the two contras spec 42 section 2b lists as missing). capacity - mined
  // measures ALL of them at once; heldFrac demotes to a diagnostic
  // decoration naming the share the pile gate explains. Requires `produced`
  // on BOTH sides - differencing a cumulative against a pre-v14 baseline
  // would book a corp's whole lifetime as one window.
  const producedOf = (c: any): Map<string, number> =>
    new Map(
      ((c.data.corps?.corps ?? []) as any[])
        .filter((x: any) => x.kind === "harvest" && x.produced !== undefined)
        .map((x: any) => [x.id, +x.produced])
    );
  const prodCap = producedOf(cap);
  const prodBase = producedOf(base);
  const minedKnown = prodCap.size > 0 && prodBase.size > 0;
  // A corp in cap but not base was commissioned mid-window: its counter began
  // at 0, so `?? 0` is exact. A corp in base but not cap retired mid-window:
  // its window production is lost - an honest UNDER-count, bounded by one
  // source-window.
  let minedRate = 0;
  if (minedKnown) for (const [id, p] of prodCap) minedRate += Math.max(0, p - (prodBase.get(id) ?? 0)) / dt;
  const grossPlan = minedKnown
    ? Math.min(grossCapacity, minedRate)
    : Math.max(0, grossCapacity - (forgoneKnown ? forgone : 0));
  // GROUND ROT (v19): dropped energy loses ceil(amount/1000) per tick; container
  // energy keeps. Averaged across the window's two endpoints - the piles move
  // slowly relative to the window, and the endpoints are all we sample.
  const droppedOf = (c: any): number =>
    Object.values((c.data.core.sourceDropped ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
  const droppedAvg = (droppedOf(cap) + droppedOf(base)) / 2;
  // METERED LOSSES (core v20, telemetry/LossMeter): supersedes the estimate
  // above wherever present. The estimate divided the SUMMED pile by 1000, which
  // misses the per-pile ceiling and only ever saw source-adjacent piles; the
  // meter applies the engine's own ceil rule to every pile in every visible
  // room, and adds the three quantities the estimate could not see at all.
  const meter = cap.data.core.losses as
    | {
        windowTicks: number;
        pileDecay: number;
        structureDecay: number;
        repairSpend: number;
        tombstoneLost: number;
        tombstoneRecovered: number;
        tombstoneByRole?: Record<string, number>;
        tombstoneExpired?: number;
        tombstoneKilled?: number;
        tombstoneCauseUnknown?: number;
        tombstoneTtlMean?: number;
        tombstoneTtlMax?: number;
        tombstoneStock: number;
      }
    | undefined;
  // CAPTURE-BOUNDED WINDOWS. The meter also publishes CUMULATIVE energy totals
  // (core v22), monotonic across global resets. Differencing them gives rates
  // over the FULL capture window - the same shape the account already uses for
  // gcl.progress and storage - instead of the meter's since-reset rates, which
  // are capped by VM lifetime (480t against a 1251-tick window at t72722670)
  // and could therefore never span a 1500-tick fiscal month.
  const cumCap = cap.data.core.losses?.cumulative as Record<string, number> | undefined;
  const cumBase = base.data.core.losses?.cumulative as Record<string, number> | undefined;
  const spanned = cumCap !== undefined && cumBase !== undefined;
  const cumRate = (key: string): number => Math.max(0, ((cumCap?.[key] ?? 0) - (cumBase?.[key] ?? 0)) / dt);
  const rot = spanned ? cumRate("pileDecay") : meter ? meter.pileDecay : droppedAvg / 1000;
  const rotKnown = meter !== undefined || cap.data.core.sourceDropped !== undefined;
  // Cash uses of delivered energy that are NOT spawn/controller/construction/
  // bank. Structure decay is deliberately absent: it is DEPRECIATION, an
  // accrued liability, and its cash cost IS the repair line - booking both
  // would double-count the same wear.
  const tombLoss = spanned
    ? Math.max(0, cumRate("tombstoneGross") - cumRate("tombstoneRecovered"))
    : meter?.tombstoneLost ?? 0;
  const repairSpend = spanned ? cumRate("repairSpend") : meter?.repairSpend ?? 0;
  // LOSS BUDGETS (spec 42 stage A, methodology #9): every loss line priced by
  // a primitive, never "-". Pile decay budgets ZERO by construction - the
  // gate's design point (SOURCE_BUFFER_DEFER_THRESHOLD == container cap)
  // holds every mouth with no ground share, so all measured ground decay is
  // priced UNFAVORABLE variance pointing at the haul deficit (E6's verdict).
  // Tombstones budget the invader tax on R1's capacity basis (one constant
  // home). Repair budgets the structure-decay ACCRUAL from the same meter -
  // the depreciation memo's shortfall, now a priced variance on the account.
  const lossBudgetSources = (cap.data.flow?.sources ?? []) as any[];
  const bPileDecay = lossBudgetSources.length * pileDecayBudget(SOURCE_BUFFER_DEFER_THRESHOLD);
  const bTombstone = tombstoneLossBudget(
    lossBudgetSources.reduce((n: number, s: any) => n + (+s.harvestRate || 0), 0)
  );
  const bRepair = spanned ? cumRate("structureDecay") : meter?.structureDecay ?? 0;
  // LINK TRANSFER TAX: the engine destroys 3% of every link hop, and the
  // LinkMeter already measures it per room. It is a genuine destruction of
  // delivered energy - exactly like pile rot - so it belongs in MEASURED
  // LOSSES rather than inside the residual. Energy that crosses the network
  // twice (source link -> hub -> controller link) pays twice, which is why the
  // measured figure runs above 3% of any single leg.
  const linkTax = ((core.links ?? []) as any[]).reduce((n, l) => n + (+l.taxRate || 0), 0);
  const linkTaxKnown = core.links !== undefined;
  // BUDGET for the line: EVERY link-borne leg the plan routes, one hop each
  // (owner 2026-08-03: "there's more sources that deliver to the link, not
  // just the ones it was built for - account for that and the tax will be
  // more in line with actual"). Three legs, all read off the plan's own
  // publications, never inferred from haul distance:
  //   1. LINK-SERVED sources (the sources the link was built for): their
  //      harvest enters at the source link - one hop.
  //   2. DEPOSIT-PORT flows (spec 26): remote routes whose haulers turn
  //      around at a link port - the flow segment stamps `port` on those
  //      routes; their flowRate crosses one hop the old budget never priced
  //      (measured M05: ~60 e/t of port flow, the bulk of the -2.48 U gap).
  //   3. The HUB -> CONTROLLER link leg in link-fed rooms: the controller
  //      allocation relayed through the controller link pays a second hop
  //      (the feeder's linkFed stamp is the room lens).
  const linkSources = ((cap.data.flow?.sources ?? []) as any[]).filter(s => s.linkServed);
  const bLinkSourceTax = linkSources.reduce((n, s) => n + (+s.harvestRate || 0) * LINK_TRANSFER_LOSS, 0);
  const bPortTax = ((cap.data.flow?.haulers ?? []) as any[])
    .filter(h => h.port)
    .reduce((n, h) => n + (+h.flowRate || 0) * LINK_TRANSFER_LOSS, 0);
  const feederStamp = ((cap.data.corps?.corps ?? []) as any[]).find((c: any) => c.kind === "controllerFeeder")?.sizing;
  const bCtrlLinkTax =
    feederStamp?.linkFed && typeof feederStamp.planFlow === "number"
      ? feederStamp.planFlow * LINK_TRANSFER_LOSS
      : 0;
  const bLinkTax = bLinkSourceTax + bPortTax + bCtrlLinkTax;
  const linkBudgetKnown = ((cap.data.flow?.sources ?? []) as any[]).some(s => s.linkServed !== undefined);
  // The link tax is TRANSPORT, not a loss (owner 2026-08-02: "link tax is
  // similar to haul body"). Both are per-source costs that scale with the flow
  // they move; they differ only in CURRENCY - a hauler body is paid in spawn
  // parts, a link hop in delivered energy. Booking it as a loss put the
  // transport bill for link-served sources in a different section from the
  // transport bill for walked ones, which is exactly what let link haulage
  // read as free: cd90/cd92 showed hauler 0.00 and net 10.00 in the P&L.
  const meteredLosses = rot + tombLoss + repairSpend;

  // ---- BUDGET (what the PLAN says each line should be) ----
  // Computed with the planner's own primitives, never a second formula:
  // minerOverhead/haulerOverhead are the same functions flowAdapter sums into
  // `totalOverhead`, so extraction+evacuation must reconcile to it - and the
  // footer prints that check rather than assuming it.
  const planSources = (cap.data.flow?.sources ?? []) as any[];
  const planHaulers = (cap.data.flow?.haulers ?? []) as any[];
  const bExtract = planSources.reduce((n, src) => n + minerOverhead(+src.spawnDistance || 0), 0);
  // EVACUATION BUDGET on the plan's OWN parts basis (methodology #8). Every
  // CARRY/MOVE part costs exactly 50e, so the planner's paved-aware
  // `spawnParts` (1.5p/CARRY on roads, 2p/CARRY off them) converts to energy
  // exactly. haulerOverhead prices every route at the 1:1 body - the plan's
  // internal parts-vs-energy disagreement, worth -2.82 e/t of slack that
  // MASKED real breach - and stays only as the fallback for older captures.
  const bEvacLegacy = planHaulers.reduce((n, h) => n + haulerOverhead(+h.carryParts || 0, +h.distance || 0), 0);
  const haulersHaveParts = planHaulers.some(h => h.spawnParts !== undefined);
  const bEvac = haulersHaveParts
    ? planHaulers.reduce(
        (n, h) =>
          n +
          (h.spawnParts !== undefined
            ? (+h.spawnParts || 0) * (CARRY_MOVE_PAIR_COST / 2)
            : haulerOverhead(+h.carryParts || 0, +h.distance || 0)),
        0
      )
    : bEvacLegacy;
  const planOverhead = cap.data.flow?.summary?.totalOverhead;
  const sinks = (cap.data.flow?.sinks ?? []) as any[];
  const sinkAlloc = (type: string): number =>
    sinks.filter(x => x.type === type).reduce((n, x) => n + (+x.allocated || 0), 0);
  const bController = sinkAlloc("controller");
  const bConstruction = sinkAlloc("construction");
  // The plan's own net position on the bank: what it routes INTO storage less
  // what it routes back OUT of it.
  const bankOut = planHaulers
    .filter(h => String(h.sourceId ?? "").startsWith("bank-"))
    .reduce((n, h) => n + (+h.flowRate || 0), 0);
  // The SOLVER'S routed net bank position - disposal accounting, kept for the
  // over-routing note. NOT the budget's bank line since methodology #11: it
  // mixes bases with the priced spawn lines (t72773737: -55.16 printed as a
  // "budget" while the priced column had +24.69 of residual headroom).
  const bBankRouted = sinkAlloc("storage") - bankOut;
  // THE PLAN'S SPAWN BUDGET. This is the like-for-like comparator P10 lacked
  // and was retracted for missing: energy the plan routes INTO the spawn
  // structures (a rate) against energy those structures convert OUT into
  // bodies (measured at the spawn). Same structure, same unit, same direction.
  // At steady state refill == spend, because the network's stock is bounded at
  // its capacity - so over a long window the two must agree, and where they do
  // not, the plan is under-provisioning the spawn.
  const bSpawn = sinkAlloc("spawn");
  // The plan's OWN fleet, priced in ENERGY (owner 2026-08-01). Every class the
  // plan sizes now carries an energy budget, so no line is blank for want of a
  // conversion. The gap between this and `bSpawn` is the plan's INTERNAL
  // inconsistency: it knows what its fleet costs and routes less than that to
  // the spawns, which is why the controller allocation is ~ total net mining.
  const planEnergy = planSpawnLoad(cap).energy;
  const pe = (...names: string[]): number =>
    names.reduce((n, key) => n + Object.keys(planEnergy).filter(k => k.startsWith(key)).reduce((m, k) => m + planEnergy[k], 0), 0);
  const bReserve = pe("reservers");
  const bInfra = pe("feeder", "tenders");
  const bDefense = pe("defense");
  const bConsumers = pe("upgraders", "construction (all-in)");
  const bFleetEnergy = Object.keys(planEnergy).reduce((n, k) => n + planEnergy[k], 0);
  // METHODOLOGY #11: the bank BUDGET is the plan's RESIDUAL - what a balanced
  // budget leaves the bank after every PRICED line - mirroring exactly the
  // budget cells the column prints (loss budgets only where the meter prints
  // them; link tax only where its budget is known), so the column sums to
  // zero BY CONSTRUCTION and a nonzero sum is arithmetically impossible
  // rather than merely unlikely.
  const lossesBudget = meter ? bPileDecay + bTombstone + bRepair : 0;
  const bBank =
    grossCapacity -
    (bExtract + bEvac + bReserve + (linkBudgetKnown ? bLinkTax : 0)) -
    (bInfra + bDefense + bConsumers) -
    lossesBudget -
    bController -
    bConstruction;
  const pileDelta = (piles(cap) - piles(base)) / dt;
  const delivered = grossPlan - pileDelta;
  // Link transport is a real use of delivered energy, so it sits on the cost
  // side of the identity even though it is not spawn spend.
  const opex = perTick(spawnTotal) + linkTax;
  // Remote sources only: home sources need no reservation, so the uplift the
  // reservation fleet buys is (reserved 10 - unreserved 5) per REMOTE source.
  const ownedRooms = new Set(((core.rooms ?? []) as any[]).map(r => r.name));
  const remoteSources = ((cap.data.flow?.sources ?? []) as any[]).filter(
    src => !ownedRooms.has(String(src.nodeId ?? "").split("-")[0])
  ).length;
  const reserveUplift = remoteSources * (SOURCE_RATE / 2);
  const score = ((core.gcl?.progress ?? 0) - (bcore.gcl?.progress ?? 0)) / dt;
  const bankDelta = (bank(cap) - bank(base)) / dt;
  // Reuse P8's lens rather than re-deriving build delivery (the codebase rule:
  // no second implementation of a measure that already has one).
  const build = rows.find(r => r.id === "P8")?.value ?? 0;
  const approp = score + build + bankDelta;
  const residual = delivered - opex - approp - (rotKnown ? meteredLosses : 0);

  // label | BUDGET | ACTUAL | VARIANCE.  `budget === null` means the plan does
  // not state this line in energy - printed as "-" rather than a fabricated
  // conversion (the P10 lesson: never build a number on an unexamined one).
  // `costLine` flips the variance sign convention: on a COST, spending more
  // than budget is Unfavourable; on revenue/output, delivering LESS is.
  // `nature`: "output" (more is better - revenue, margin, score), "cost"
  // (printed NEGATIVE, so spending more makes the variance more negative and
  // THAT is Unfavourable), or "neutral" (the bank line - retained energy is
  // neither earned nor spent, so an F/U verdict on it is meaningless; it is
  // read together with the controller line, not on its own).
  const L = (
    label: string,
    actual: number,
    indent = 2,
    budget: number | null = null,
    nature: "output" | "cost" | "neutral" = "output"
  ): string => {
    const b = budget === null ? "-" : budget.toFixed(2);
    let v = "-";
    if (budget !== null) {
      const raw = actual - budget;
      const flat = Math.abs(raw) < 0.005;
      const mark = nature === "neutral" || flat ? "" : raw < 0 ? " U" : " F";
      v = `${raw >= 0 ? "+" : ""}${raw.toFixed(2)}${mark}`;
    }
    return `${" ".repeat(indent)}${label.padEnd(38 - indent)}${b.padStart(9)}${actual.toFixed(2).padStart(10)}${v.padStart(11)}`;
  };
  return [
    `ENERGY ACCOUNT  e/tick  (window ${dt}t; spawn ${spawnSpanned ? `${dt}t cumulative` : `ring ${ring}t`}${
      meter ? `; losses ${spanned ? `${dt}t cumulative` : `${meter.windowTicks}t since-reset`}` : ""
    })  [methodology #${METHODOLOGY}]`,
    // WINDOW COHERENCE (methodology #3). The residual is a DIFFERENCE of rates,
    // so it is only meaningful when the rates describe the same stretch of time.
    // Revenue/bank/controller come from the capture window; every "measured at
    // the spawn" line comes from the blackbox ring; the loss lines come from the
    // meter's own window. A deploy restarts the ring and the meter but not the
    // capture pair, so an hour of deploys leaves the short windows sampling a
    // post-reset rebuild while the long one averages steady state - and their
    // difference is then an artifact, not a finding.
    //
    // Measured t72721419: window 2417t against a 565t ring and a 559t meter -
    // 4.3x - and the residual came out at -25.10, i.e. 25% of gross mining
    // OVER-attributed. That is what prompted this check.
    ...(() => {
      // Every side that reads CUMULATIVE totals spans the capture window by
      // construction; only a side still on its legacy short window (the ring
      // for old captures, the since-reset meter for pre-v22 ones) can drag
      // the residual into incoherence.
      const shortest = Math.min(spawnSpanned ? dt : ring || dt, spanned || !meter ? dt : meter.windowTicks);
      const spread = shortest > 0 ? dt / shortest : Infinity;
      if (spread <= 2) return [];
      return [
        `  !! WINDOW INCOHERENCE ${spread.toFixed(1)}x - the residual below is NOT trustworthy.`,
        `     Revenue/bank/controller span ${dt}t; measured costs and losses span as little as ${shortest}t.`,
        "     The residual is their DIFFERENCE, so it inherits the mismatch. Recapture once the",
        "     short windows have caught up (they restart on every deploy) before reading it as a leak."
      ];
    })(),
    `${" ".repeat(38)}${"BUDGET".padStart(9)}${"ACTUAL".padStart(10)}${"VARIANCE".padStart(11)}`,
    "  REVENUE",
    L("mining capacity (reserved rate)", grossCapacity, 4, grossCapacity),
    // Methodology #12: capacity the plan EXCLUDED because the execution side
    // is defunded there (invader occupation / hostile marks - same lens both
    // sides). Not a variance - the plan and runtime AGREE this is unworkable.
    ...(() => {
      const defunded = ((cap.data.flow?.candidates ?? []) as any[]).filter(c => c.verdict === "defunded");
      if (defunded.length === 0) return [];
      const rate = defunded.reduce((n, c) => n + (+c.rate || 0), 0);
      return [`    (excluded: ${rate.toFixed(2)} e/t in ${defunded.length} defunded source(s) - occupied/hostile rooms)`];
    })(),
    ...(minedKnown
      ? [
          // MEASURED (phase 2): capacity less what the harvest corps' own
          // cumulative counters say was mined - covers held mouths, unstaffed
          // sources and unreserved downgrades alike. The heldFrac stamp
          // becomes the diagnostic naming the share the pile gate explains.
          L("- forgone (measured: capacity - mined)", -(grossCapacity - grossPlan), 4, 0, "cost"),
          ...(forgoneKnown
            ? [`      of which the miners' pile-gate stamps explain ${forgone.toFixed(2)} e/t (heldFrac)`]
            : []),
          L("= gross mining (measured mined)", grossPlan, 4, grossCapacity)
        ]
      : forgoneKnown
        ? [
            L("- forgone (miners held, buffer full)", -forgone, 4, 0, "cost"),
            L("= gross mining", grossPlan, 4, grossCapacity)
          ]
        : []),
    L("+ pile drawdown / (build-up)", -pileDelta, 4),
    L("= delivered into the economy", delivered, 4, grossCapacity),
    "  DIRECT COST OF MINING (measured at the spawn)",
    L("extraction  (miner)", -perTick(cost.extraction), 4, -bExtract, "cost"),
    L("evacuation  (hauler)", -perTick(cost.evacuation), 4, -bEvac, "cost"),
    ...(scavSpend !== undefined
      ? [`      of which recovery fleet (scavenge corps) ${(-perTick(scavSpend)).toFixed(2)} - the cure's body bill, see RECOVERY P&L`]
      : []),
    L("reservation (reserver)", -perTick(cost.reservation), 4, -bReserve, "cost"),
    ...(linkTaxKnown
      ? [
          L(
            "link transfer  (3% per hop)",
            -linkTax,
            4,
            linkBudgetKnown ? -bLinkTax : undefined,
            "cost"
          )
        ]
      : []),
    L("= NET MINING MARGIN", delivered - perTick(direct) - linkTax, 4, grossPlan - bExtract - bEvac - bReserve - bLinkTax),
    "  OVERHEAD (measured at the spawn)",
    L("infra      (tanker, feeder, scout)", -perTick(cost.infra), 4, -bInfra, "cost"),
    // Budgeted since phase 1: the standing guard fleet's replacement cadence.
    // A zero budget with real spend is an HONEST unfavorable read (defense is
    // running above its standing plan - the raid-surge share the invader tax
    // prices at admission, not here).
    L("defense    (guard)", -perTick(cost.defense), 4, -bDefense, "cost"),
    L("consumers  (upgrader, builder)", -perTick(cost.consumers), 4, -bConsumers, "cost"),
    ...(cost.other > 0
      ? [L(`UNCLASSIFIED [${[...unknownRoles].join(", ")}]`, -perTick(cost.other), 4)]
      : []),
    L("= total overhead", -perTick(overhead), 4, -(bInfra + bDefense + bConsumers), "cost"),
    L("= TOTAL SPAWN (plan fleet, priced)", -perTick(spawnTotal), 2, -bFleetEnergy, "cost"),
    ...(bFleetEnergy >= bSpawn
      ? [
          `    ...and the plan ROUTES only ${bSpawn.toFixed(2)} e/t to the spawn sinks - UNDER-routing its own`,
          `    fleet by ${(bFleetEnergy - bSpawn).toFixed(2)} e/t, so that much is handed down the ladder to the controller.`
        ]
      : [
          `    ...and the plan ROUTES ${bSpawn.toFixed(2)} e/t to the spawn sinks - OVER-routing its own fleet`,
          `    by ${(bSpawn - bFleetEnergy).toFixed(2)} e/t of disposal flow the spawn cannot convert (physical ceiling`,
          `    caps the claim since t72773737).`
        ]),
    `    (solver routed flows: net bank ${bBankRouted >= 0 ? "+" : ""}${bBankRouted.toFixed(2)} e/t - disposal accounting, not the budget's`,
    `    bank line since methodology #11; the budget column above balances by construction.)`,
    ...(capital > 0
      ? [
          "  CAPITAL (funded from the expansion reserve, not operating margin)",
          ...(cost.expansion > 0 ? [L("expansion (claimer)", -perTick(cost.expansion), 4)] : []),
          ...(cost.incursion > 0 ? [L("incursion (buster, striker)", -perTick(cost.incursion), 4)] : []),
                L("= total capital", -perTick(capital), 4)
        ]
      : []),
    ...(rotKnown
      ? [
          `  MEASURED LOSSES${meter ? (spanned ? "  (cumulative, full window)" : `  (meter window ${meter.windowTicks}t)`) : ""}`,
          // Budgeted since #9 (spec 42 stage A): a zero pile budget is the
          // gate's own design point - the variance IS the haul-deficit price.
          L(
            meter ? "ground pile decay (engine ceil rule)" : "ground rot (dropped energy, 0.1%/t)",
            -rot,
            4,
            meter ? -bPileDecay : undefined,
            "cost"
          ),
          // THE CEIL-FLOOR CENSUS (spec 44 leg 1, owner 2026-08-04: "piles
          // lose a minimum of 1 e/t not always 1/1000"): the floor's share of
          // the decay line and the standing pile count. A high floor share =
          // many small piles each paying 1 e/t - the regime where focus-fire
          // (drain one to zero, retire its whole floor) beats skimming, and
          // the census the standing-scavenger fleet will be sized on.
          ...(spanned && cumRate("pileDecayCeilPenalty") > 0
            ? [
                `      of which the ceil FLOOR adds ${cumRate("pileDecayCeilPenalty").toFixed(2)} (avg ${cumRate(
                  "pileTicks"
                ).toFixed(1)} piles standing, ${cumRate("pileTicksSmall").toFixed(1)} small) - spec 44 focus-fire census`
              ]
            : []),
          ...(meter
            ? [
                L("tombstone losses (creeps died carrying)", -tombLoss, 4, -bTombstone, "cost"),
                // GROSS AND CREDIT, published (methodology #10): the line
                // above is NET of witnessed recoveries - before this detail
                // the recovery machinery's whole return was an invisible
                // netting credit, unanswerable against its cost.
                ...(spanned && cumRate("tombstoneGross") > 0
                  ? [
                      `      gross entombed ${cumRate("tombstoneGross").toFixed(2)}, recovered back ${cumRate(
                        "tombstoneRecovered"
                      ).toFixed(2)} (pad + loot-grab + scavenge witnessed returns)`
                    ]
                  : []),
                // WHOSE energy, and HOW they died. A tombstone line the account
                // cannot attribute is not actionable: haulers expiring mid-route
                // fold into the carry deficit, anything KILLED is a defense
                // question, and those are different work items.
                //
                // Cause is a VERDICT from the death watch (methodology #7):
                // expired/killed carry evidence, and a death the watch never
                // saw prints as UNKNOWN instead of being defaulted - the #4-#6
                // rule read a field that is 0 on every dead creep and called
                // 100% of deaths "expired", which its own audit line flagged
                // SUSPECT on every close. Attribution prefers the CUMULATIVE
                // keys (same capture-bounded window as the loss line itself);
                // the meter's since-reset view is the stated fallback.
                ...(() => {
                  const cc = cumCap as any;
                  const cb = cumBase as any;
                  const attSpanned = spanned && cc?.tombstoneExpired !== undefined && cb?.tombstoneExpired !== undefined;
                  const attDiff = (key: string): number => Math.max(0, (cc?.[key] ?? 0) - (cb?.[key] ?? 0));
                  const byRole: Record<string, number> = attSpanned
                    ? (() => {
                        const out: Record<string, number> = {};
                        const keys = new Set([
                          ...Object.keys(cc.tombstoneByRole ?? {}),
                          ...Object.keys(cb.tombstoneByRole ?? {})
                        ]);
                        for (const k of keys) {
                          const d = Math.max(0, (cc.tombstoneByRole?.[k] ?? 0) - (cb.tombstoneByRole?.[k] ?? 0));
                          if (d > 0) out[k] = d;
                        }
                        return out;
                      })()
                    : meter?.tombstoneByRole ?? {};
                  // A capture WITHOUT the v25 unknown bucket predates the death
                  // watch: its expired/killed figures came off the dead field
                  // and are VOIDED (#7) - live archaeology has the v23 deploy
                  // booking 100% killed and the v24 one 100% expired off the
                  // SAME field. Role attribution never depended on that field
                  // and stays; cause degrades to unknown, honestly.
                  const v25 = attSpanned || meter?.tombstoneCauseUnknown !== undefined;
                  const expired = attSpanned ? attDiff("tombstoneExpired") : v25 ? meter?.tombstoneExpired ?? 0 : 0;
                  const killed = attSpanned ? attDiff("tombstoneKilled") : v25 ? meter?.tombstoneKilled ?? 0 : 0;
                  // v28: deliberate spawn-side refunds, split OUT of killed so
                  // the raid story reads only combat (t72755898: 4,844e of
                  // recycle cargo booked "killed" at home).
                  const recycled = attSpanned ? attDiff("tombstoneRecycled") : (meter as any)?.tombstoneRecycled ?? 0;
                  const unknown = attSpanned
                    ? attDiff("tombstoneCauseUnknown")
                    : v25
                      ? meter?.tombstoneCauseUnknown ?? 0
                      : Object.values(byRole).reduce((a, b) => a + b, 0);
                  const causeTotal = expired + killed + recycled + unknown;
                  const out: string[] = [];
                  if (Object.keys(byRole).length > 0) {
                    const gross = Object.values(byRole).reduce((a, b) => a + b, 0) || 1;
                    out.push(
                      `      by role: ` +
                        Object.entries(byRole)
                          .sort((a, b) => b[1] - a[1])
                          .map(([r, e]) => `${r} ${((e / gross) * 100).toFixed(0)}%`)
                          .join("  ")
                    );
                  }
                  if (causeTotal > 0) {
                    const pct = (n: number): string => `${((n / causeTotal) * 100).toFixed(0)}%`;
                    // TTL context rides along where any death was resolved: for
                    // known deaths the ttl IS the verdict's evidence (expired =
                    // 0 by definition, killed = the life cut short).
                    const ttlKnown = attSpanned ? attDiff("tombstoneTtlKnown") : 0;
                    const ttlMean = attSpanned
                      ? ttlKnown > 0
                        ? attDiff("tombstoneTtlSum") / ttlKnown
                        : 0
                      : meter?.tombstoneTtlMean ?? 0;
                    const ttl =
                      expired + killed > 0 ? `   (ttl at death mean ${ttlMean.toFixed(0)} over known deaths)` : "";
                    out.push(
                      `      by cause: expired ${pct(expired)}  killed ${pct(killed)}${recycled > 0 ? `  recycled ${pct(recycled)}` : ""}  unknown ${pct(unknown)}${ttl}` +
                        (unknown === causeTotal ? "  <- no death-watch coverage this window" : "")
                    );
                  }
                  // The WHY of recycles (v29): the flag site's stamped
                  // trigger class - "are these legit" as a read, not a story.
                  if (attSpanned && recycled > 0 && (cc?.tombstoneRecycledByReason || cb?.tombstoneRecycledByReason)) {
                    const byReason: Record<string, number> = {};
                    const rk = new Set([
                      ...Object.keys(cc?.tombstoneRecycledByReason ?? {}),
                      ...Object.keys(cb?.tombstoneRecycledByReason ?? {})
                    ]);
                    for (const k of rk) {
                      const d = Math.max(0, (cc?.tombstoneRecycledByReason?.[k] ?? 0) - (cb?.tombstoneRecycledByReason?.[k] ?? 0));
                      if (d > 0) byReason[k] = d;
                    }
                    const total = Object.values(byReason).reduce((a, b) => a + b, 0);
                    if (total > 0) {
                      out.push(
                        `      recycled why: ` +
                          Object.entries(byReason)
                            .sort((a, b) => b[1] - a[1])
                            .map(([r, e]) => `${r} ${((e / total) * 100).toFixed(0)}%`)
                            .join("  ")
                      );
                    }
                  }
                  // The WHERE (v27, owner 2026-08-03): killed energy by room
                  // and the share intel can actually attribute to hostiles.
                  // Kills in quiet rooms are NOT raid evidence - this line is
                  // what the R1 constant swap must read before it fires.
                  if (attSpanned && cc?.tombstoneKilledByRoom !== undefined && cb?.tombstoneKilledByRoom !== undefined) {
                    const byRoom: Record<string, number> = {};
                    const roomKeys = new Set([
                      ...Object.keys(cc.tombstoneKilledByRoom ?? {}),
                      ...Object.keys(cb.tombstoneKilledByRoom ?? {})
                    ]);
                    for (const k of roomKeys) {
                      const d = Math.max(0, (cc.tombstoneKilledByRoom?.[k] ?? 0) - (cb.tombstoneKilledByRoom?.[k] ?? 0));
                      if (d > 0) byRoom[k] = d;
                    }
                    const killedTotal = Object.values(byRoom).reduce((a, b) => a + b, 0);
                    if (killedTotal > 0) {
                      const hostileShare = attDiff("tombstoneKilledHostileRoom");
                      out.push(
                        `      killed where: ` +
                          Object.entries(byRoom)
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 4)
                            .map(([r, e]) => `${r} ${((e / killedTotal) * 100).toFixed(0)}%`)
                            .join("  ") +
                          `   (${((hostileShare / killedTotal) * 100).toFixed(0)}% in intel-hostile rooms - the share the raid story can claim)`
                      );
                    }
                  }
                  return out;
                })(),
                L("repair (energy spent holding hits)", -repairSpend, 4, -bRepair, "cost"),
                L("= measured losses", -meteredLosses, 4, -(bPileDecay + bTombstone + bRepair), "cost"),
                // CURE VS ILLNESS (methodology #10, owner 2026-08-04): the
                // recovery machinery priced as a P&L of its own - the
                // witnessed tombstone returns against the fleet bought to
                // chase them. Scavenged PILES are deliberately NOT credited
                // here (they enter as pile drawdown in REVENUE); recovered
                // tombstone energy is deliberately NOT revenue (it was
                // counted as mined once already - grossing the existing
                // credit is what avoids the double-count).
                ...(spanned
                  ? [
                      "  RECOVERY P&L (the cure vs the illness)",
                      `    witnessed recovered (tombstones back into stores)   +${cumRate("tombstoneRecovered").toFixed(2)}`,
                      ...(scavSpend !== undefined
                        ? [
                            `    recovery-fleet bodies (scavenge corps)              -${perTick(scavSpend).toFixed(2)}`,
                            `    = recovery net ${
                              cumRate("tombstoneRecovered") - perTick(scavSpend) >= 0 ? "+" : ""
                            }${(cumRate("tombstoneRecovered") - perTick(scavSpend)).toFixed(2)} e/t   (the illness left standing: pile decay ${rot.toFixed(2)})`
                          ]
                        : [
                            "    recovery-fleet bodies: not yet measured (a capture side predates the v30 sub-counter)",
                            `    = recovery net: recovered ${cumRate("tombstoneRecovered").toFixed(2)} less an unmeasured body bill`
                          ])
                    ]
                  : [])
              ]
            : [])
        ]
      : []),
    "  APPROPRIATIONS",
    L("controller (score)", score, 4, bController),
    L("construction (built, measured)", build, 4, bConstruction),
    L("to/(from) bank", bankDelta, 4, bBank, "neutral"),
    L("= total", approp, 4, bController + bConstruction + bBank),
    "  " + "-".repeat(46),
    L(rotKnown ? "RESIDUAL (repair, tombstones, raids, error)" : "RESIDUAL (decay, rot, raids, error)", residual, 2),
    "",
    // THE OWNER'S TWO STANDING TARGETS (2026-08-06): *"I really want the income
    // statement to get back to where it was. Minimal foregone mining. 50%+ net
    // energy hitting the controller."* Stated here, under the statement they
    // are targets FOR, so every cycle reports them against a bar instead of
    // leaving "back to where it was" to memory.
    ...(() => {
      const forgone = grossCapacity - grossPlan;
      // THE DENOMINATOR IS CAPACITY (#14). Everything the colony could have
      // mined; the controller's share of it therefore charges forgone mining,
      // the fleet and the losses to ONE ratio, so the number moves when any of
      // the three does. Netting the fleet out first (as #13 did) hands back
      // the largest single deduction and reads 92% while the same account
      // reads 38% against capacity.
      const net = grossCapacity;
      const rawShare = net > 1e-9 ? score / net : 0;
      // Bank-funded delivery is not sustainable delivery. `bankDelta` is
      // positive when banking, negative when drawing down, so subtracting it
      // strips the drawdown out of the score (the same arithmetic G1 uses).
      const funded = score + bankDelta;
      const fundedShare = net > 1e-9 ? funded / net : 0;
      const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
      return [
        "  TARGETS (owner 2026-08-06)",
        // The forgone target is UNMEASURABLE without a mined or heldFrac
        // reading, and an unmeasurable line must go absent rather than print a
        // zero - the same invariant the revenue section is pinned to, and the
        // reason a "0.00 e/t MET" here would be a lie the account already
        // refuses to tell one line above.
        ...(minedKnown || forgoneKnown
          ? [
              `    forgone mining                     ${forgone.toFixed(2)} e/t   target ~0` +
                `   ${forgone <= 2 ? "MET" : forgone <= 5 ? "close" : "MISS"}`
            ]
          : []),
        `    controller / CAPACITY              ${pct(rawShare)}    target >=50%` +
          `   ${rawShare >= 0.5 ? "MET" : "MISS"}   (${score.toFixed(2)} of ${net.toFixed(2)})`,
        `    ...INCOME-FUNDED only              ${pct(fundedShare)}    target >=50%` +
          `   ${fundedShare >= 0.5 ? "MET" : "MISS"}   <- the one that lasts`,
        // WHERE THE REST OF CAPACITY WENT, so a MISS is actionable rather than
        // just a verdict. These are exactly the deductions #13 netted out of
        // its denominator before reporting - naming them is the whole reason
        // the honest denominator costs nothing in diagnosability.
        //
        // Each term prints only when it is MEASURED: forgone under the same
        // gate as the line above (an unmeasured heldFrac makes `forgone` a
        // fabricated zero), losses under `rotKnown`. An absent term is absent,
        // never a flattering zero.
        //
        // The terms CLOSE TO CAPACITY by construction, which is why `piles`
        // (a SOURCE, not a use, whenever the ground stock draws down) and the
        // residual ride along: a waterfall whose shares sum past 100% would
        // reintroduce the exact "which number do I trust" question the honest
        // denominator exists to end.
        "      of capacity: " +
          [
            ...(minedKnown || forgoneKnown ? [["forgone", forgone] as const] : []),
            ["piles", pileDelta] as const,
            ["fleet", perTick(spawnTotal)] as const,
            // TRANSPORT, not a loss (owner 2026-08-02) - but it is still
            // capacity that never reaches a sink, so the waterfall carries it
            // or it closes 1.21 short on any link-served room.
            ...(linkTaxKnown ? [["linktax", linkTax] as const] : []),
            ...(rotKnown ? [["losses", meteredLosses] as const] : []),
            ["build", build] as const,
            ["bank", bankDelta] as const,
            ["controller", score] as const,
            ["resid", residual] as const
          ]
            .map(([label, v]) => `${label} ${v.toFixed(2)} (${pct(v / net)})`)
            .join("  "),
        ""
      ];
    })(),
    `  CONTROLLER VARIANCE BRIDGE  (plan ${bController.toFixed(2)} -> actual ${score.toFixed(2)})`,
    ...(() => {
      // Single-column lines - the three-column renderer above would print two
      // empty budget/variance cells for each.
      //
      // METHODOLOGY #11: derived from the BALANCED budget column, so the
      // terms are exactly the other lines' actual-vs-budget gaps and the
      // bridge closes to rounding BY CONSTRUCTION - the #10 bridge carried
      // the routed-bank fiction as "bank draw budgeted but not performed"
      // (+71.73 at t72773737, mostly phantom) plus a standing "unexplained
      // (window mismatch)" term. The solver's disposal flows are P12's row,
      // not a bridge term.
      const B = (label: string, v: number): string => `    ${label.padEnd(42)}${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
      const bSpawnLines = bExtract + bEvac + bReserve + bInfra + bDefense + bConsumers;
      const deliveredGap = delivered - grossCapacity;
      const fleetExecGap = -(perTick(spawnTotal) - bSpawnLines);
      const linkGap = linkTaxKnown && linkBudgetKnown ? -(linkTax - bLinkTax) : linkTaxKnown ? -linkTax : 0;
      const lossGap = -((rotKnown ? meteredLosses : 0) - lossesBudget + residual);
      const buildGap = -(build - bConstruction);
      const bankGap = -(bankDelta - bBank);
      const explains = deliveredGap + fleetExecGap + linkGap + lossGap + buildGap + bankGap;
      const actualVar = score - bController;
      return [
        B("delivered below the capacity budget", deliveredGap),
        B("fleet costs more than the plan prices", fleetExecGap),
        B("link tax vs budget", linkGap),
        B("losses above budget (incl. residual)", lossGap),
        B("construction above budget", buildGap),
        B("bank kept above the residual budget", bankGap),
        B("= explains", explains),
        B("  actual controller variance", actualVar),
        `    ${"  closure check (rounding only)".padEnd(42)}${actualVar - explains >= 0 ? "+" : ""}${(actualVar - explains).toFixed(2)}`,
        "    ACCOUNTING vs BEHAVIOUR: fleet execution and the bank term are RUNTIME",
        "    (bodies bought vs priced; energy banked vs the residual the balanced budget",
        "    left it); delivered/losses are the physical world the plan does not model.",
        "    The solver parking flow in spawn sinks no longer distorts any term here -",
        "    it is P12's row and the over-routing note."
      ];
    })(),
    `  BUDGET CHECK: extraction+evacuation(1:1 energy basis) ${(bExtract + bEvacLegacy).toFixed(2)} vs the plan's own totalOverhead ` +
      `${typeof planOverhead === "number" ? planOverhead.toFixed(2) : "n/a"}` +
      `${typeof planOverhead === "number" && Math.abs(bExtract + bEvacLegacy - planOverhead) > 0.05 ? " <- DOES NOT RECONCILE" : " (reconciles)"}` +
      `. Lines with a "-" budget are ones the plan does not state in ENERGY.`,
    ...(Math.abs(bEvac - bEvacLegacy) > 0.05
      ? [
          `  NOTE: the evacuation BUDGET above is the plan's PARTS basis (spawnParts x 50e); its energy side` +
            ` (totalOverhead/netEnergy) still prices every route 1:1 - a ${(bEvacLegacy - bEvac).toFixed(2)} e/t` +
            ` internal gap the planner's admission pricing carries until the phase-1 ratio-aware repricing.`
        ]
      : []),
    `  reservation buys ~${reserveUplift.toFixed(0)} e/t of the revenue line (${remoteSources} remote sources x ` +
      `${(SOURCE_RATE / 2).toFixed(0)} e/t uplift, reserved ${SOURCE_RATE} vs unreserved ${(SOURCE_RATE / 2).toFixed(0)})` +
      ` for ${perTick(cost.reservation).toFixed(2)} e/t of bodies.`,
    `  ${residual >= 0 ? "unattributed" : "OVER-attributed"} = ${Math.abs(residual / Math.max(grossPlan, 1e-9) * 100).toFixed(0)}% of gross mining` +
      ` - revenue is PLAN CAPACITY less pile change, not a delivery meter, so this bounds`,
    meter
      ? "  raid losses, tower burn, energy dropped away from a source, and measurement error."
      : rotKnown
        ? "  still unattributed: REPAIR spend (tower + builder), TOMBSTONE losses (creeps that died carrying),"
        : "  ground decay + rot above the container cap + raid losses + tower burn + measurement error.",
    ...(rotKnown && !meter
      ? ["  and measurement error. Structure DECAY is not here: it is depreciation, and its cash cost IS repair."]
      : []),
    ...(meter
      ? [
          "",
          "  DEPRECIATION MEMO (not a cash line - the account must not book wear twice)",
          `    structure decay accruing        ${meter.structureDecay.toFixed(2)} e/t   (containers + ramparts + roads, base cadence)`,
          `    repair actually paid            ${repairSpend.toFixed(2)} e/t`,
          `    = ${
            repairSpend >= meter.structureDecay
              ? "KEEPING UP - hits are being held"
              : `SHORTFALL ${(meter.structureDecay - repairSpend).toFixed(2)} e/t - structures are being allowed to decay`
          }`,
          "    Decay is an accrued liability; its CASH cost is the repair line above, so only repair",
          "    nets against the residual. A shortfall is not free - it is deferred, and it is paid at",
          "    full rebuild price when a structure expires (a container is 5000 energy).",
          `    Road decay here EXCLUDES creep traffic, so it is a LOWER bound. Remote containers are`,
          `    priced at 5x owned (0.50 vs 0.10 e/t) - the engine decays them five times as fast.`,
          `    Tombstones now hold ${meter.tombstoneStock.toFixed(0)}e; ${meter.tombstoneRecovered.toFixed(2)} e/t was witnessed recovered`,
          "    Tombstone energy is LOST BY DEFAULT: booked when first seen, credited back only where a\n    withdrawal was actually witnessed. Every recovery path needs a creep already beside it."
        ]
      : []),
    // BALANCE SHEET (spec 42 section 2b - the owner's target layout): the
    // account's STOCK side at close. Measured lines only; a line the captures
    // cannot measure prints as a NAMED gap, never a fabricated number and
    // never silently absent - the target layout's "--" rows made visible
    // debt. NET WORTH is therefore a measured FLOOR: it can only understate.
    ...(() => {
      const storage = ((cap.data.core.rooms ?? []) as any[]).reduce(
        (n: number, r: any) => n + (+r.storageEnergy || 0),
        0
      );
      const reserve = resolveReserve(cap);
      const byPart = (cap.data.core.bodyParts?.byPart ?? {}) as Record<string, number>;
      const costs = BODY_COSTS as unknown as Record<string, number>;
      const standing = Object.keys(byPart).reduce((n, p) => n + byPart[p] * (costs[p.toUpperCase()] ?? 0), 0);
      const piles = Object.values((cap.data.core.sourceDropped ?? {}) as Record<string, number>).reduce(
        (a: number, b) => a + (+b || 0),
        0
      );
      const tombStock = meter?.tombstoneStock ?? 0;
      const committed = tombStock + piles;
      const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");
      const free = Math.max(0, storage - reserve);
      const floor = free + reserve + committed + standing;
      return [
        "",
        "  BALANCE SHEET (energy stocks at close - measured lines only, gaps NAMED)",
        `    free        storage above the reserve            ${fmt(free)}`,
        `    reserved    warchest/reserve target              ${fmt(reserve)}`,
        `    committed   in-flight: ${meter ? `tombstones ${fmt(tombStock)} + ` : ""}ground piles ${fmt(piles)} = ${fmt(committed)}   (${meter ? "" : "tombstones and "}creep cargo not measured)`,
        `    standing    fleet at replacement body cost       ${fmt(standing)}`,
        `    fixed       structures at rebuild cost           not measured (no structure inventory in captures)`,
        `    = NET WORTH (measured floor)                     ${fmt(floor)}`,
        "    The floor omits the NAMED gaps (creep cargo, fixed assets, accrued decay) - it can only",
        "    understate. A line joins when its meter lands; nothing here is ever inferred."
      ];
    })(),
    ""
  ].join("\n");
}

/**
 * SOURCE P&L - the chart of accounts one level down (owner 2026-08-01: keep
 * iterating on reporting and instrumentation).
 *
 * The colony account answers "did the economy pay for itself"; this answers
 * "WHICH sources paid". Attribution is exact rather than apportioned, because
 * spec 34 D5 made the miner operation own its evacuation haulers: every
 * `mining-{room}-harvest-{suffix}` corp's spawn spend IS that source's
 * extraction + evacuation cost, read straight off the blackbox ring. Only
 * reservation needs sharing - it is bought per ROOM, so it splits evenly
 * across the funded sources in that room.
 *
 * HONESTY LIMIT, printed with the table: `gross` is the plan's per-source
 * CAPACITY, because there is no per-source delivery meter - the same gap the
 * colony REVENUE line carries. Costs are MEASURED. So `net` is a hybrid:
 * plan-gross less measured cost. It is directly comparable to the planner's
 * own `candidates[].net`, which is built the same way, and that comparison is
 * the point - it shows where the planner's per-source pricing is optimistic.
 */
export function formatSourcePnL(cap: any): string {
  const rows0 = (cap.data.blackbox?.rows ?? []) as any[];
  const ring = rows0.length > 1 ? rows0[rows0.length - 1].t - rows0[0].t : 0;
  const sources = (cap.data.flow?.sources ?? []) as any[];
  if (ring <= 0 || sources.length === 0) return "";

  // corp -> measured spawn energy over the ring
  const spend = new Map<string, number>();
  for (const r of rows0) {
    if (r.k !== "spawn" || !r.d?.cost) continue;
    const key = `${r.d.corp}|${r.d.role}`;
    spend.set(key, (spend.get(key) ?? 0) + r.d.cost);
  }
  const per = (corp: string, role: string): number => (spend.get(`${corp}|${role}`) ?? 0) / ring;

  const roomOf = (nodeId: string): string => String(nodeId).split("-")[0];
  const byRoom = new Map<string, number>();
  for (const src of sources) byRoom.set(roomOf(src.nodeId), (byRoom.get(roomOf(src.nodeId)) ?? 0) + 1);

  const verdicts = new Map<string, any>(
    ((cap.data.flow?.candidates ?? []) as any[]).map(c => [String(c.sourceId).slice(-4), c])
  );

  const out: string[] = [
    "",
    "SOURCE P&L  e/tick  (gross = PLAN capacity, no per-source delivery meter; costs MEASURED)",
    `  ${"src".padEnd(6)}${"room".padEnd(9)}${"d".padStart(4)}${"gross".padStart(8)}${"miner".padStart(8)}${"hauler".padStart(8)}${"link".padStart(7)}${"reserve".padStart(9)}${"= net".padStart(8)}${"plan net".padStart(10)}${"var".padStart(9)}`
  ];
  let tG = 0;
  let tM = 0;
  let tH = 0;
  let tR = 0;
  let tL = 0;
  // LINK TRANSPORT is this source's haul bill, not a colony loss (owner
  // 2026-08-02: "link tax is similar to haul body"). A link-served source pays
  // it INSTEAD of a walking hauler - so it belongs in the same row, or the row
  // reads as free transport, which is precisely how it went unnoticed.
  for (const src of sources.slice().sort((a, b) => (a.spawnDistance ?? 0) - (b.spawnDistance ?? 0))) {
    const suffix = String(src.id).slice(-4);
    const room = roomOf(src.nodeId);
    const corp = `mining-${room}-harvest-${suffix}`;
    const gross = +src.harvestRate || 0;
    const miner = per(corp, "miner");
    const hauler = per(corp, "hauler");
    // reservation is bought per ROOM; split across that room's funded sources
    const resRoom = per(`reservation-${room}-reservation`, "reserver");
    const reserve = resRoom / Math.max(1, byRoom.get(room) ?? 1);
    const link = src.linkServed ? gross * LINK_TRANSFER_LOSS : 0;
    const net = gross - miner - hauler - link - reserve;
    const planNet = verdicts.get(suffix)?.net;
    tG += gross;
    tM += miner;
    tH += hauler;
    tL += link;
    tR += reserve;
    const varStr =
      typeof planNet === "number" ? `${net - planNet >= 0 ? "+" : ""}${(net - planNet).toFixed(2)}` : "-";
    out.push(
      `  ${suffix.padEnd(6)}${room.padEnd(9)}${String(src.spawnDistance ?? "").padStart(4)}` +
        `${gross.toFixed(2).padStart(8)}${(-miner).toFixed(2).padStart(8)}${(-hauler).toFixed(2).padStart(8)}` +
        `${(link > 0 ? (-link).toFixed(2) : "-").padStart(7)}` +
        `${(-reserve).toFixed(2).padStart(9)}${net.toFixed(2).padStart(8)}` +
        `${typeof planNet === "number" ? planNet.toFixed(2).padStart(10) : "-".padStart(10)}${varStr.padStart(9)}`
    );
  }
  out.push(
    `  ${"TOTAL".padEnd(19)}${tG.toFixed(2).padStart(8)}${(-tM).toFixed(2).padStart(8)}${(-tH).toFixed(2).padStart(8)}` +
      `${(-tL).toFixed(2).padStart(7)}${(-tR).toFixed(2).padStart(9)}${(tG - tM - tH - tL - tR).toFixed(2).padStart(8)}`
  );
  // Remote-only summary: the home sources need no reservation and pay no
  // invader tax, so mixing them in would flatter the remote picture.
  const remoteVars = sources
    .map(src => {
      const c = verdicts.get(String(src.id).slice(-4));
      return c && (+c.tax || 0) > 0 ? c : null;
    })
    .filter(Boolean) as any[];
  const meanTax = remoteVars.length
    ? remoteVars.reduce((n, c) => n + (+c.tax || 0), 0) / remoteVars.length
    : 0;
  out.push(
    "  a NEGATIVE var means the source costs MORE than the planner priced it - the planner's",
    "  per-source net is what ADMITS OR REJECTS a source, so a chronic negative is a funding bug.",
    `  RECONCILES to the colony account: miner ${tM.toFixed(2)} = extraction line; reserve ${tR.toFixed(2)} =` +
      " reservation line. Hauler is LOWER than the evacuation line by the standalone scavenge",
    "  corps, which serve no source and so appear in no row here.",
    `  The planner's INVADER TAX is ${meanTax.toFixed(3)} e/t per remote - against a mean remote variance of` +
      ` ${(remoteVars.length ? remoteVars.reduce((n, c) => {
        const suffix = String(c.sourceId).slice(-4);
        const src = sources.find(x => String(x.id).slice(-4) === suffix);
        if (!src) return n;
        const room = roomOf(src.nodeId);
        const corp = `mining-${room}-harvest-${suffix}`;
        const net = (+src.harvestRate || 0) - per(corp, "miner") - per(corp, "hauler") -
          per(`reservation-${room}-reservation`, "reserver") / Math.max(1, byRoom.get(room) ?? 1);
        return n + (net - (+c.net || 0));
      }, 0) / remoteVars.length : 0).toFixed(2)} e/t it covers only a small fraction of the`,
    "  remote cost the plan is missing."
  );
  return out.join("\n");
}

export function formatLedger(rows: LedgerRow[], capTick: number, baseTick: number): string {
  const out: string[] = [`waste ledger  capture t${capTick}  baseline t${baseTick}  (dt ${capTick - baseTick})`];
  for (const r of rows) {
    out.push(
      `  [${r.verdict.padEnd(4)}] ${r.id.padEnd(3)} ${r.name.padEnd(34)} ${
        Number.isInteger(r.value) ? r.value : r.value.toFixed(2)
      } ${r.unit}`
    );
    out.push(`         ${r.detail}`);
  }
  const fails = rows.filter(r => r.verdict === "FAIL");
  out.push(
    fails.length
      ? `TOP LINE: ${fails[0].id} ${fails[0].name} - this is the cycle's work item`
      : "no FAIL lines - attack the largest WARN or ship the backlog"
  );
  return out.join("\n");
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag: string, dflt: string): string => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const cap = loadCapture(get("--capture", "latest"), 0);
  const base = loadCapture(get("--baseline", "prev"), 1);
  const rows = computeLedger(cap, base);
  // The chart of accounts frames the leak ledger: what the colony earned and
  // where it went, before the list of what leaked.
  console.log(formatAccounts(cap, base, rows));
  console.log(formatSourcePnL(cap));
  console.log(formatLedger(rows, cap.tick, base.tick));
}
