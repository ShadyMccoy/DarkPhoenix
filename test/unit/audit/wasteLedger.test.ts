import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  ACCOUNT_CLASS_OF_ROLE,
  F1_CLASS_OF_KIND,
  F1_PLAN_PREFIX,
  METHODOLOGY,
  computeChurn,
  computeLedger,
  formatAccounts,
  formatLedger,
  formatSourcePnL,
  planSpawnLoad
} from "../../../scripts/waste-ledger";
import { ALL_CORP_KINDS, ALL_SPAWN_ROLES } from "../../../src/execution/CommissionHost";
import {
  ATTACK_MOVE_PER_PART,
  CARRY_MOVE_PER_PART,
  CLAIM_MOVE_PER_PART,
  feederSpawnLoad,
  haulerOverhead,
  reserverSpawnLoad,
  roomGuardSpawnLoad,
  roomReserverSpawnLoad,
  tenderSpawnLoad
} from "../../../src/economy/primitives";
import { BASE_RESERVE, bankFedControllerRate } from "../../../src/economy/bank";
import { categoryOfKind, classifiedKinds } from "../../../src/economy/accountCategory";

const fixture = (name: string): any =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "fixtures", "telemetry", name), "utf8"));
const cap72411542 = fixture("shard1-t72411542.json");
const cap72404213 = fixture("shard1-t72404213.json");

/**
 * Spec 15 phase 1 acceptance: the ledger reproduces the 2026-07-18 known
 * numbers from the committed fixtures. These pins are the audit auditing
 * itself - the owner findings of that day (plan spawn-infeasibility, reserver
 * duty drift) must be caught by the LEDGER from a capture, never again only
 * by an owner question.
 */
describe("waste ledger (spec 15 phase 1)", () => {
  const cap: any = cap72411542;
  const base: any = cap72404213;
  const rows = computeLedger(cap, base);
  const row = (id: string) => rows.find(r => r.id === id)!;

  it("P4 catches the spawn-infeasible plan (the 2026-07-18 owner finding)", () => {
    const p4 = row("P4");
    expect(p4.verdict).to.equal("FAIL");
    expect(p4.value).to.be.greaterThan(1.2); // measured 1.32x ceiling at t72411542
    expect(p4.detail).to.contain("unbudgeted"); // the transient-route line the mining budget never prices
  });

  it("P4 does NOT fail a budget-dry plan on recompute noise (the fill stops AT the ceiling by design)", () => {
    // t72420007: the P4 fill ran to budget-dry (its components sum to the
    // capacity exactly); the script's independent recompute drifted +0.0002
    // and tripped strict >1.0 - a false red that would persist at every
    // equilibrium. Within 0.5% of the ceiling is arithmetic, not a leak
    // (the smallest real fleet class is ~3% of ceiling).
    //
    // The capture ALSO fielded one 10-part raidGuard the audit was blind to
    // until phase 1 priced the class; counting it, the plan genuinely stood
    // ~2% OVER ceiling - a real reading, not noise. The pin's subject is the
    // NOISE BAND, so the clone strips the guard to keep the original
    // budget-dry boundary shape; the phase-1 pricing has its own coverage.
    const capBoundary = fixture("shard1-t72420007.json");
    capBoundary.data.corps.corps = capBoundary.data.corps.corps.filter((c: any) => c.kind !== "raidGuard");
    const rows2 = computeLedger(capBoundary, fixture("shard1-t72419708.json"));
    const p4 = rows2.find(r => r.id === "P4")!;
    // 2026-08-04: the recompute prices the feeder at the sip-floor law
    // (STORAGE_UPGRADE_TARGET dropped), ~1.3% of ceiling below the era's own
    // 15-based plan - the boundary fixture read 0.987.
    //
    // METHODOLOGY #17 moves it again, to 0.936, and the direction is the
    // demonstration: the tender line used to be `sizing.target x MEASURED
    // body`, which on this era's fixture was 3 x 24 = 72p where the plan
    // charges TENDER_FLEET_PARTS = 48p. An actuals-fed budget reads high
    // exactly when the fleet is fat, and low when it is thin - on the LIVE
    // capture the same fix moves this line the other way (43p -> 48p). That
    // is what "the budget moved with the fleet it exists to judge" costs.
    //
    // The pin's subject is unchanged: AT the budget-dry boundary the ledger
    // must not print a false RED on recompute drift.
    expect(p4.value).to.be.greaterThan(0.93); // the boundary shape, not a slack plan
    expect(p4.verdict).to.not.equal("FAIL"); // hot, worth watching - never a false red
  });

  it("P4's load table includes every fleet class, producers AND consumers", () => {
    const { lines } = planSpawnLoad(cap);
    const names = lines.map(([n]) => n).join("|");
    for (const cls of ["miners", "source-route haulers", "transient-route", "upgraders", "feeder", "tenders", "reservers"]) {
      expect(names).to.contain(cls);
    }
  });

  /**
   * PER-ROOM CORPS MUST BE SUMMED, NOT SAMPLED (measured t72683137). The
   * reserver line read `corps.find(kind === "reservation")?.sizing?.targets` -
   * the FIRST corp only. Reservation is a PER-ROOM corp: the live colony ran
   * SEVEN of them (W42N22/W42N23/W43N22/W43N24/W44N22/W44N23/W41N23), each
   * `targets: 1`, each a 4-part body. P4 therefore priced 4 parts where 28
   * stood - 0.0074 vs 0.0519 parts/t, a 7x under-count on a class that was
   * 21.7% of MEASURED spawn spend (26,000e of 119,969e over 2,452t). It
   * accounts for ~26% of the session-long "unbudgeted" gap (measured 0.649
   * p/t vs plan-implied 0.478) that the 90% headroom failed to explain.
   *
   * P4's charter is "ALL fleet classes, budgeted or not" - a sampling read of
   * a per-room class silently breaks exactly that contract.
   */
  it("P4 SUMS per-room reservation corps instead of sampling the first (t72683137)", () => {
    const room = (n: string) => ({
      id: `reservation-${n}-reservation`,
      kind: "reservation",
      creepCount: 1,
      bodyParts: 4,
      sizing: { targets: 1 }
    });
    const seven = ["W42N22", "W42N23", "W43N22", "W43N24", "W44N22", "W44N23", "W41N23"].map(room);
    const mk = (corps: any[]): any => ({
      tick: 0,
      data: { flow: { sources: [], haulers: [], sinks: [] }, corps: { corps }, core: { rooms: [{ storageEnergy: 0 }] } }
    });
    const resLoad = (c: any): number =>
      planSpawnLoad(c).lines.find(([n]) => String(n).startsWith("reservers"))![2];

    const one = resLoad(mk([room("W42N22")]));
    const all = resLoad(mk(seven));
    expect(all, "seven rooms cost seven reservers, not one").to.be.closeTo(7 * one, 1e-9);
    // 28 parts, amortized by the ONE home (duty-bearing since methodology #8 -
    // the continuous-duty recompute this line used to pin was the +8.02 F lie).
    expect(all, "28 parts at the shipped duty over the claim life, not 4").to.be.closeTo(
      reserverSpawnLoad(28),
      1e-9
    );
  });

  it("P4's reserver line stays zero when no room is reserved", () => {
    const mk = (corps: any[]): any => ({
      tick: 0,
      data: { flow: { sources: [], haulers: [], sinks: [] }, corps: { corps }, core: { rooms: [{ storageEnergy: 0 }] } }
    });
    const line = planSpawnLoad(mk([])).lines.find(([n]) => String(n).startsWith("reservers"))!;
    expect(line[2]).to.equal(0);
  });

  it("P4 READS the planner's own hauler spawnParts - no re-derivation, so no drift", () => {
    // ROOT-CAUSE of the ledger/planner drift (owner 2026-07-22): the ledger
    // RECOMPUTED hauler load as 2*carryParts/effectiveLife - a second
    // implementation of the planner's ((paved?1.5:2)*carryPartsFor)/life. On a
    // paved-remote colony the 2x-all over-count read P4 1.01x FAIL where the
    // planner's paved-aware number was 0.90x (t72508069). The fix shares the
    // ONE number: the planner exports its per-route spawnParts, the ledger
    // echoes it. This pins the "echo, don't recompute" contract with a sentinel
    // value the recompute could never produce.
    const mk = (haulers: any[]): any => ({
      tick: 0,
      data: { flow: { sources: [], haulers, sinks: [] }, corps: { corps: [] }, core: { rooms: [{ storageEnergy: 0 }] } }
    });
    const sentinel = 0.01234; // arbitrary; only an echo (not a recompute) yields it
    const load = (r: { lines: Array<[string, number, number]> }): number =>
      r.lines.find(([n]) => n === "source-route haulers")![2];
    const echoed = planSpawnLoad(
      mk([{ sourceId: "source-aaa", carryParts: 10, distance: 50, flowRate: 5, spawnParts: sentinel }])
    );
    expect(load(echoed), "the planner's spawnParts, verbatim").to.equal(sentinel);
    // Legacy capture (pre-export, no spawnParts): fall back to the recompute so
    // old fixtures still produce a number - no crash, no NaN.
    const legacy = planSpawnLoad(mk([{ sourceId: "source-bbb", carryParts: 10, distance: 50, flowRate: 5 }]));
    expect(load(legacy), "legacy fallback still computes").to.be.greaterThan(0);
  });

  it("P6 measures per-room reservation PUMP from the bank stamps (reservers not reserving)", () => {
    // t72420978 -> t72421124 (owner marathon directive): stamp-window dt=156,
    // pump_r = bank2 - (bank1 - dt). Two of four needy rooms saw ZERO pump
    // with claim parts fielded - the one-way-violation churn, measurable.
    const rows2 = computeLedger(fixture("shard1-t72421124.json"), fixture("shard1-t72420978.json"));
    const p6 = rows2.find(r => r.id === "P6")!;
    expect(p6.verdict).to.equal("WARN"); // >= half the rooms pumped nothing while staffed
    expect(p6.detail).to.contain("W43N24:0");
    expect(p6.detail).to.contain("W42N23:66");
  });

  it("P6 zero-floor: banks pinned at 0 with no reservers pump NOTHING (t72481477 phantom +dt)", () => {
    // pump_r = bank2 - (bank1 - dt) assumes an above-zero bank decays 1/tick;
    // at the ZERO FLOOR nothing decays, so the +dt credit fabricated a
    // phantom "209 ticks banked per room, no reservers fielded" (live
    // t72481477 vs t72481270 - all four banks 0 at both ends). Expected
    // decay must be bounded by the starting bank.
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    for (const cap of [capA, capB]) {
      const res = cap.data.corps.corps.find((c: any) => c.kind === "reservation");
      res.sizing.banks = { W42N22: 0, W42N23: 0, W43N24: 0, W44N23: 0 };
      res.bodyParts = 0;
    }
    const p6 = computeLedger(capA, capB).find(r => r.id === "P6")!;
    expect(p6.value, "no decay credit at the zero floor").to.equal(0);
    expect(p6.verdict).to.equal("ok");
  });

  it("X1 skips gracefully on pre-meter captures (no workUtil in the upgrader stamp)", () => {
    const rows2 = computeLedger(fixture("shard1-t72421124.json"), fixture("shard1-t72420978.json"));
    expect(rows2.find(r => r.id === "X1")).to.equal(undefined);
  });

  it("X1 names standing-but-idle WORK from the meter stamp (owner: parts standing around are waste)", () => {
    // The t72482220 shape: 100 WORK standing at both endpoints, stock full,
    // burn 48.7 of ~100 e/t. With the meter stamped, the invisible half
    // becomes a number: idle-equivalent WORK and its supply-starved share.
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    const upg = capA.data.corps.corps.find((c: any) => c.kind === "upgrade");
    upg.body = { work: 100, carry: 5, move: 25 };
    upg.sizing = { ...(upg.sizing ?? {}), workUtil: 0.49, dryShare: 0.45, meterTicks: 743 };
    const x1 = computeLedger(capA, fixture("shard1-t72420978.json")).find(r => r.id === "X1")!;
    expect(x1.verdict).to.equal("FAIL");
    expect(x1.value, "idle-equivalent WORK = 100 x (1 - 0.49)").to.be.closeTo(51, 0.11);
    expect(x1.detail).to.contain("dry (supply-starved) 0.45");
    expect(x1.detail).to.contain("package");
  });

  it("X1 reads ok when standing WORK actually fires (workUtil ~1)", () => {
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    const upg = capA.data.corps.corps.find((c: any) => c.kind === "upgrade");
    upg.body = { work: 100, carry: 5, move: 25 };
    upg.sizing = { ...(upg.sizing ?? {}), workUtil: 0.97, dryShare: 0.01, meterTicks: 1500 };
    const x1 = computeLedger(capA, fixture("shard1-t72420978.json")).find(r => r.id === "X1")!;
    expect(x1.verdict).to.equal("ok");
  });

  it("P7 does not fail a window whose plan legitimately dropped (construction preempt)", () => {
    // Same pair: allocation fell 86.3 -> 2.0 by doctrine; actual 14.35 e/t is
    // the old upgraders burning residual stock - MORE than the surviving
    // plan asks. Compare against the LOWER endpoint plan: ok, not a failure.
    const rows2 = computeLedger(fixture("shard1-t72421124.json"), fixture("shard1-t72420978.json"));
    const p7 = rows2.find(r => r.id === "P7")!;
    expect(p7.verdict).to.equal("ok");
    expect(p7.value).to.be.greaterThan(1); // actual over the (floored) plan
  });

  it("P7 FAILS when a STABLE plan goes undelivered with stock standing (upgraders not upgrading)", () => {
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    // stable plan 86.3 both ends, stock present both ends, actual ~2 e/t
    capA.data.flow.sinks.find((s: any) => s.type === "controller").allocated = 86.3;
    capA.data.core.rooms[0].rclProgress = capB.data.core.rooms[0].rclProgress + 300; // 300/146t ~ 2 e/t
    const rows2 = computeLedger(capA, capB);
    const p7 = rows2.find(r => r.id === "P7")!;
    expect(p7.verdict).to.equal("FAIL");
    expect(p7.detail).to.contain("stock"); // the discriminator: energy WAS there
  });

  it("P7 does NOT fail a WARTIME window: the controller is DELIBERATELY relegated (spec 33)", () => {
    // Real capture t72599790 vs t72599499 (upgrader-fleet relegation live). The
    // upgrader sizing.wartime=true, allocated 2 (relegated to the anti-downgrade
    // sip); the controller flow sink still reads 15 (the save-regime
    // STORAGE_UPGRADE_TARGET floor - the plan-side relegation caps to
    // max(15,2)=15, a no-op). Actual ~7 e/t is the incumbent 12-WORK upgraders
    // draining toward the sip. Measured against the PEACETIME plan (15) this
    // false-FAILs (0.47x) every cycle of a build campaign, masking any REAL P7
    // regression. Wartime target IS the relegated floor - actual over it is the
    // expected drain, not a leak.
    const p7 = computeLedger(fixture("shard1-t72599790.json"), fixture("shard1-t72599499.json")).find(
      r => r.id === "P7"
    )!;
    expect(p7.verdict, "wartime relegation is not a delivery failure").to.not.equal("FAIL");
    expect(p7.detail, "the verdict names the wartime relegation").to.contain("wartime");
  });

  it("P7 STILL FAILS in wartime if the controller is starved BELOW its floor (downgrade risk)", () => {
    // Relegated != off: the anti-downgrade floor is inviolable. If the controller
    // is delivering well under its relegated sip WITH stock standing (the link
    // broke / a real starvation), that is a genuine FAIL even in wartime.
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72599499.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72599790.json")));
    // Force near-zero delivery while the relegated floor is 2 and stock stands.
    capA.data.core.rooms[0].rclProgress = capB.data.core.rooms[0].rclProgress + 1; // ~0 e/t
    capA.data.core.rooms[0].controllerStock = 800;
    capB.data.core.rooms[0].controllerStock = 800;
    const p7 = computeLedger(capA, capB).find(r => r.id === "P7")!;
    expect(p7.verdict, "starved below the relegated floor with stock is a real FAIL").to.equal("FAIL");
  });

  it("P8 skips gracefully when captures predate the site fields (no row)", () => {
    const rows2 = computeLedger(fixture("shard1-t72421124.json"), fixture("shard1-t72420978.json"));
    expect(rows2.find(r => r.id === "P8")).to.equal(undefined);
  });

  it("P8 FAILS a flat-progress window with sites standing and construction funded (builders not building)", () => {
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    Object.assign(capB.data.core.rooms[0], { siteCount: 1, siteProgress: 500, siteTotal: 5000 });
    Object.assign(capA.data.core.rooms[0], { siteCount: 1, siteProgress: 500, siteTotal: 5000 });
    // fund construction at BOTH endpoints (t72421124 already carries 90.1)
    capB.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 90 });
    const p8 = computeLedger(capA, capB).find(r => r.id === "P8")!;
    expect(p8.verdict).to.equal("FAIL");
    expect(p8.detail).to.contain("CREW IDLE");
  });

  /**
   * P8 MEASURES BUILD PROGRESS DIRECTLY (methodology #15, audit t72842655).
   *
   * P8's value was the sum of three acknowledged FLOORS - the home rooms'
   * `siteProgress` delta, the road-receipts ratchet, and the poolWork
   * remaining-decrease - each documented in place as undercounting. None is a
   * measurement, and none can see a REMOTE site that completed and left the
   * ledger, because every one of them reads state that vanishes with the site.
   *
   * Measured t72842655: `building-W43N21-construction` took its `produced`
   * counter 6,270 -> 12,310 in 1,314 ticks - 6,040 units, 4.60 e/t - clearing
   * 17 of 18 road sites. P8 reported the window at a small fraction of that and
   * the ENERGY ACCOUNT, which reads P8 verbatim, booked construction ACTUAL at
   * 0.42 e/t against a 30.00 budget. The -29.58 variance was the meter, not the
   * colony; and the previous cycle's entry repeated "0 e/t built" as fact.
   *
   * The direct measurement was already published: a ConstructionCorp's
   * `unitsProduced` IS build progress (segment 4 v14), so P8 now sums the
   * construction corps' `produced` deltas and keeps the floors only as a
   * fallback for captures that predate the counter.
   *
   * Per-corp deltas clamp at zero. A corp destroyed and rebuilt restarts its
   * counter (measured -885 on `building-W43N24-construction` when the invader
   * core took the room), and a negative delta is lost history, not negative
   * building - so it undercounts, in the same direction as the floors it
   * replaces.
   */
  it("P8 reads the construction corps' produced counters, not the vanishing site fields", () => {
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    // Sites standing at both ends and construction funded - the shape that used
    // to read "CREW IDLE" - but the corp counter says 6,040 units were built.
    Object.assign(capB.data.core.rooms[0], { siteCount: 1, siteProgress: 500, siteTotal: 5000 });
    Object.assign(capA.data.core.rooms[0], { siteCount: 1, siteProgress: 500, siteTotal: 5000 });
    capB.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 90 });
    capB.data.corps.corps.push({ id: "building-W1N1-construction", kind: "construction", produced: 6270 });
    capA.data.corps.corps.push({ id: "building-W1N1-construction", kind: "construction", produced: 12310 });
    const dt = capA.tick - capB.tick;
    const p8 = computeLedger(capA, capB).find(r => r.id === "P8")!;
    expect(p8.value, "the corp counter is the measurement").to.be.closeTo(6040 / dt, 0.01);
    expect(p8.verdict, "a crew that built 6,040 units is not idle").to.not.equal("FAIL");
    expect(p8.detail).to.not.contain("CREW IDLE");
  });

  it("P8 clamps a rebuilt corp's counter reset to zero rather than booking negative building", () => {
    // building-W43N24-construction went -885 when the invader core took the
    // room and the corp was rebuilt. Lost history, not negative progress.
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    Object.assign(capB.data.core.rooms[0], { siteCount: 1, siteProgress: 500, siteTotal: 5000 });
    Object.assign(capA.data.core.rooms[0], { siteCount: 1, siteProgress: 500, siteTotal: 5000 });
    capB.data.corps.corps.push({ id: "building-A-construction", kind: "construction", produced: 885 });
    capA.data.corps.corps.push({ id: "building-A-construction", kind: "construction", produced: 0 });
    capB.data.corps.corps.push({ id: "building-B-construction", kind: "construction", produced: 1000 });
    capA.data.corps.corps.push({ id: "building-B-construction", kind: "construction", produced: 3000 });
    const dt = capA.tick - capB.tick;
    const p8 = computeLedger(capA, capB).find(r => r.id === "P8")!;
    expect(p8.value, "the reset contributes 0, not -885").to.be.closeTo(2000 / dt, 0.01);
  });

  it("P8 renders the siteLedger by room with window delta and ETA (core v34, owner 2026-08-05: stay informed of construction progress)", () => {
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    Object.assign(capB.data.core.rooms[0], { siteCount: 1, siteProgress: 500, siteTotal: 5000 });
    Object.assign(capA.data.core.rooms[0], { siteCount: 1, siteProgress: 1500, siteTotal: 5000 });
    // vision-free roster both ends: the big road room built 840, the lone tile idle
    capB.data.core.siteLedger = { W1N1: { n: 19, rem: 6000, done: 100 }, W2N2: { n: 1, rem: 300, done: 0 } };
    capA.data.core.siteLedger = { W1N1: { n: 19, rem: 5160, done: 940 }, W2N2: { n: 1, rem: 300, done: 0 } };
    const p8 = computeLedger(capA, capB).find(r => r.id === "P8")!;
    expect(p8.detail).to.contain("by room:");
    expect(p8.detail, "rooms sorted by remaining, delta rendered").to.contain("W1N1 19 sites rem 5160 (-840)");
    expect(p8.detail, "singular form, zero-delta omitted").to.contain("W2N2 1 site rem 300");
    expect(p8.detail).to.contain("total rem 5460");
    expect(p8.detail, "ETA at the row's own composite rate").to.contain("ETA ~");
    // pre-v34 captures keep the old rendering (no by-room tail) - the
    // "skips gracefully" pin above covers the no-fields case entirely.
  });

  it("P8 treats a completion window as ambiguous, never a failure", () => {
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    Object.assign(capB.data.core.rooms[0], { siteCount: 2, siteProgress: 2900, siteTotal: 8000 });
    Object.assign(capA.data.core.rooms[0], { siteCount: 1, siteProgress: 100, siteTotal: 5000 });
    capB.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 90 });
    const p8 = computeLedger(capA, capB).find(r => r.id === "P8")!;
    expect(p8.verdict).to.equal("ok");
    expect(p8.detail).to.contain("completion window");
  });

  it("P8 FAILS a remote-only stall: remote sites standing, receipts flat, crew funded (gap measured t72503018)", () => {
    // The live 2026-07-22 window: home siteCount 0 at both ends, but W43N24
    // held 3 standing remote sites (2 trunk tiles + a container) across 2171
    // ticks with roadReceipts frozen at 36/38 and a funded 5-creep build
    // corp - P8 read "ok / no sites standing" while the trunk pipeline was
    // stalled. Remote sites are sites: the standing/flat predicate must see
    // the segment-0 remoteSites census, not just the home rooms[] meter.
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    Object.assign(capB.data.core.rooms[0], { siteCount: 0, siteProgress: 0, siteTotal: 0 });
    Object.assign(capA.data.core.rooms[0], { siteCount: 0, siteProgress: 0, siteTotal: 0 });
    capB.data.core.remoteSites = { W43N24: 3 };
    capA.data.core.remoteSites = { W43N24: 3 };
    capB.data.core.roadReceipts = { r1: { built: 36, total: 38, paved: true } };
    capA.data.core.roadReceipts = { r1: { built: 36, total: 38, paved: true } };
    capB.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 20 });
    capA.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 20 });
    const p8 = computeLedger(capA, capB).find(r => r.id === "P8")!;
    expect(p8.verdict).to.equal("FAIL");
    expect(p8.detail).to.contain("CREW IDLE");
    expect(p8.detail, "the remote census is named, not lumped into the home count").to.contain("remote");
  });

  it("P8 treats a remote-site count drop as a completion window (ambiguous, skipped)", () => {
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    Object.assign(capB.data.core.rooms[0], { siteCount: 0, siteProgress: 0, siteTotal: 0 });
    Object.assign(capA.data.core.rooms[0], { siteCount: 0, siteProgress: 0, siteTotal: 0 });
    capB.data.core.remoteSites = { W43N24: 3 };
    capA.data.core.remoteSites = { W43N24: 1 }; // container finished mid-window
    capB.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 20 });
    const p8 = computeLedger(capA, capB).find(r => r.id === "P8")!;
    expect(p8.verdict).to.equal("ok");
    expect(p8.detail).to.contain("completion window");
  });

  /**
   * WITHIN-SITE remote progress (false-FAIL measured t72679468): remote site
   * COUNT held 9->9 and receipts were flat, but the construction corp's
   * poolWork stamp fell 3826->2252 - 1,574 energy actually built into
   * partially-complete sites (crew "BBR", two builders latched). P8 read
   * "0 e/t - CREW IDLE" on a window where the crew built ~2.8 e/t. The
   * poolWork DELTA is a conservative floor on energy built: placements RAISE
   * poolWork, so a falling delta only ever undercounts, same direction as
   * the receipts floor.
   */
  it("P8 credits a falling construction poolWork stamp (within-site remote progress, t72679468)", () => {
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    Object.assign(capB.data.core.rooms[0], { siteCount: 0, siteProgress: 0, siteTotal: 0 });
    Object.assign(capA.data.core.rooms[0], { siteCount: 0, siteProgress: 0, siteTotal: 0 });
    capB.data.core.remoteSites = { W41N23: 9 };
    capA.data.core.remoteSites = { W41N23: 9 };
    capB.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 20 });
    capA.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 20 });
    capB.data.corps = { corps: [{ id: "building-X-construction", kind: "construction", sizing: { poolWork: "W41N23:3826" } }] };
    capA.data.corps = { corps: [{ id: "building-X-construction", kind: "construction", sizing: { poolWork: "W41N23:2252" } }] };
    const p8 = computeLedger(capA, capB).find(r => r.id === "P8")!;
    expect(p8.verdict, "building 1574e is not CREW IDLE").to.equal("ok");
    expect(p8.value, "the poolWork floor is credited as e/t").to.be.greaterThan(0);
    expect(p8.detail).to.contain("poolWork");
  });

  it("P8 still FAILS when poolWork is flat too (the stall is real)", () => {
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    Object.assign(capB.data.core.rooms[0], { siteCount: 0, siteProgress: 0, siteTotal: 0 });
    Object.assign(capA.data.core.rooms[0], { siteCount: 0, siteProgress: 0, siteTotal: 0 });
    capB.data.core.remoteSites = { W41N23: 9 };
    capA.data.core.remoteSites = { W41N23: 9 };
    capB.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 20 });
    capA.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 20 });
    capB.data.corps = { corps: [{ id: "building-X-construction", kind: "construction", sizing: { poolWork: "W41N23:2252" } }] };
    capA.data.corps = { corps: [{ id: "building-X-construction", kind: "construction", sizing: { poolWork: "W41N23:2252" } }] };
    const p8 = computeLedger(capA, capB).find(r => r.id === "P8")!;
    expect(p8.verdict).to.equal("FAIL");
    expect(p8.detail).to.contain("CREW IDLE");
  });

  it("P8 never counts a RISING poolWork as negative build (placements are not un-building)", () => {
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    Object.assign(capB.data.core.rooms[0], { siteCount: 1, siteProgress: 500, siteTotal: 5000 });
    Object.assign(capA.data.core.rooms[0], { siteCount: 1, siteProgress: 900, siteTotal: 5000 });
    capB.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 20 });
    capB.data.corps = { corps: [{ id: "building-X-construction", kind: "construction", sizing: { poolWork: "W41N23:1000" } }] };
    capA.data.corps = { corps: [{ id: "building-X-construction", kind: "construction", sizing: { poolWork: "W41N23:4000" } }] };
    const p8 = computeLedger(capA, capB).find(r => r.id === "P8")!;
    // home progress 400 delivered; the risen pool must not subtract from it
    expect(p8.value).to.be.greaterThan(0);
    expect(p8.verdict).to.equal("ok");
  });

  it("P9 catches mined production that is funded but never routed (#19, owner-caught 2026-07-19)", () => {
    // Live t72425058/t72424537: 7 funded mined sources = 70 e/t produced, ZERO
    // mined-source haulers, 0 routed. The leak that had NO ledger line - it
    // scattered across E2/E4/P7 until the owner asked. P9 names it directly.
    const rows2 = computeLedger(fixture("shard1-t72425058.json"), fixture("shard1-t72424537.json"));
    const p9 = rows2.find(r => r.id === "P9")!;
    expect(p9.verdict).to.equal("FAIL");
    expect(p9.value).to.be.lessThan(0.5);
    expect(p9.detail).to.contain("ROTTING");
    // and it leads the ledger: the rot is the cycle's work item, not X3 noise
    expect(rows2[0].id).to.equal("P9");
  });

  it("P9 stays ok when a colony has no meaningful remote mining (no false alarm)", () => {
    const cap2: any = JSON.parse(JSON.stringify(fixture("shard1-t72425058.json")));
    cap2.data.flow.sources = []; // no funded mining => nothing to route => not a leak
    const p9 = computeLedger(cap2, fixture("shard1-t72424537.json")).find(r => r.id === "P9")!;
    expect(p9.verdict).to.equal("ok");
  });

  it("P5 flags the reserver duty price/behavior drift until the corp reads the reservation bank", () => {
    const p5 = row("P5");
    expect(p5.verdict).to.equal("FAIL");
    expect(p5.detail).to.contain("ticksToEnd");
  });

  it("E4 flags idle capital while the bank is not draining", () => {
    const e4 = row("E4");
    expect(e4.verdict).to.equal("FAIL"); // 601k above target, slope +2.21/t
    expect(e4.value).to.be.greaterThan(500_000);
  });

  it("E4 measures against the DYNAMIC warchest when the capture carries it (no false idle AT target)", () => {
    // A bank sitting AT its income-scaled reserve is NOT idle, even far above the
    // static base floor (measured t72555188: bank 54.8k == dynamic reserve, but
    // the base-floor read called it 32k idle - a false WARN). Clone a real
    // fixture (full shape) and override only the bank + the dynamic reserve.
    const clone = (o: any): any => JSON.parse(JSON.stringify(o));
    const baseCap = clone(cap72404213);
    baseCap.data.core.rooms[0].storageEnergy = 54900;
    const roomName = baseCap.data.core.rooms[0].name;

    const withDyn = clone(cap72411542);
    withDyn.data.core.rooms[0].name = roomName;
    withDyn.data.core.rooms[0].storageEnergy = 54800;
    withDyn.data.core.warchestTarget = 54000; // bank sits ~AT the dynamic reserve
    const e4dyn = computeLedger(withDyn, baseCap).find(r => r.id === "E4")!;
    expect(e4dyn.verdict, "at the dynamic reserve -> not idle").to.equal("ok");
    expect(e4dyn.detail).to.contain("(dynamic)");

    // Same bank, NO dynamic reserve exported (old capture) -> base floor -> flagged.
    const withBase = clone(cap72411542);
    withBase.data.core.rooms[0].name = roomName;
    withBase.data.core.rooms[0].storageEnergy = 54800;
    delete withBase.data.core.warchestTarget;
    const e4base = computeLedger(withBase, baseCap).find(r => r.id === "E4")!;
    expect(e4base.verdict, "base floor still flags the excess").to.not.equal("ok");
    expect(e4base.detail).to.contain("(base floor)");
  });

  it("E2 catches stranded haulers serving routes absent from the plan", () => {
    const e2 = row("E2");
    expect(e2.value).to.be.greaterThan(20); // measured 48 parts across 3 scavenge corps at t72411542
    expect(e2.verdict).to.not.equal("ok");
  });

  it("S3 discriminates a funding hold from a stall (idle spawn, UNaffordable head)", () => {
    const s3 = row("S3");
    expect(s3.verdict).to.equal("ok"); // head reserver@1300 vs bank 1250: holding, not stalled
    expect(s3.detail).to.contain("not a stall");
  });

  it("ranks FAIL lines first and names the top line as the cycle's work item", () => {
    expect(rows[0].verdict).to.equal("FAIL");
    const firstOk = rows.findIndex(r => r.verdict === "ok");
    const lastFail = rows.map(r => r.verdict).lastIndexOf("FAIL");
    expect(lastFail).to.be.lessThan(firstOk === -1 ? rows.length : firstOk);
  });

  // ---- X5 rebuild churn (owner 2026-07-23: "continue investigating these
  // types of churns ... the bot is so constrained in screeps that they all add
  // up"). Discovered live t72509177: remote haulers spawned small then replaced
  // big (cbd5 1550->2200 @189t, cd8d 900->2300 @120t) and a reserver respawn
  // 25t apart - below one creep's spawn time, so a double-order, not a death.
  const mkChurnCap = (rows: any[], corps: any[]): any => ({
    tick: 1000,
    data: { blackbox: { v: 1, tick: 1000, rows }, corps: { corps } }
  });

  it("X5 counts an early-death remote respawn but EXCLUDES fleet growth (census cross-check)", () => {
    // The load-bearing correctness point: a corp whose spawn-count in the window
    // is <= its current staffing GREW - none of those spawns died. The upgrader
    // ramp (2->3) must NOT read as churn (my first hand-count wrongly did, 28%
    // vs the true 18% once growth is excluded).
    const churn = computeChurn(
      mkChurnCap(
        [
          // remote hauler cbd5: spawned 900, replaced by 2200 120t later, now 1 alive => 1 died
          { t: 100, k: "spawn", d: { corp: "hauling-W44N23-hauling-cbd5", role: "hauler", cost: 900 } },
          { t: 220, k: "spawn", d: { corp: "hauling-W44N23-hauling-cbd5", role: "hauler", cost: 2200 } },
          // home upgrader: two spawns but 2 alive => the fleet GREW, zero churn
          { t: 150, k: "spawn", d: { corp: "upgrading-W43N23-upgrading", role: "upgrader", cost: 2300 } },
          { t: 540, k: "spawn", d: { corp: "upgrading-W43N23-upgrading", role: "upgrader", cost: 2300 } }
        ],
        [
          { id: "hauling-W44N23-hauling-cbd5", creepCount: 1 },
          { id: "upgrading-W43N23-upgrading", creepCount: 2 }
        ]
      )
    )!;
    // cbd5: gap 120, unlived 1-120/1500 = 0.92, waste 900*0.92 = 828, REMOTE role
    expect(churn.remoteChurn).to.be.closeTo(828, 1);
    // the upgrader grew (staffing 2 >= 2 spawns) - excluded, so home churn is 0
    expect(churn.homeChurn).to.equal(0);
    expect(churn.totalSpawnEnergy).to.equal(900 + 2200 + 2300 + 2300);
  });

  it("X5 weights by UNLIVED fraction: a near-EOL replacement is ~0, an early one is ~full cost", () => {
    const nearEol = computeChurn(
      mkChurnCap(
        [
          { t: 0, k: "spawn", d: { corp: "hauling-W44N23-hauling-x", role: "hauler", cost: 1000 } },
          { t: 1450, k: "spawn", d: { corp: "hauling-W44N23-hauling-x", role: "hauler", cost: 1000 } }
        ],
        [{ id: "hauling-W44N23-hauling-x", creepCount: 1 }]
      )
    )!;
    expect(nearEol.churnEnergy).to.be.lessThan(50); // gap 1450 ~ life 1500 => barely churn
  });

  it("X5 returns null (row absent) when the capture predates the blackbox segment", () => {
    expect(computeChurn({ tick: 1, data: { corps: { corps: [] } } })).to.equal(null);
    const x5 = computeLedger(cap72411542, cap72404213).find(r => r.id === "X5");
    expect(x5, "pre-blackbox fixtures produce no X5 row").to.equal(undefined);
  });

  it("E5 does NOT flag a hauler bought small for a planned MICRO route (scavenge/short-haul)", () => {
    // t72523980: both E5-flagged runts were hauling-W43N24-hauling-0-20, the
    // scavenge route scavenge-W43N24-30-20 the planner sizes at carryParts 1.41.
    // A 200e (2 CARRY) hauler for a <3-carry route is RIGHT-sized, not a
    // drained-spawn purchase. Flagging it trained us to ignore E5.
    const capA: any = JSON.parse(JSON.stringify(cap72411542));
    const spawnId = Object.keys(capA.data.core.agenda)[0];
    capA.data.core.agenda[spawnId].executed = [
      { tick: 0, role: "hauler", corp: "hauling-W43N24-hauling-0-20", cost: 200 },
      { tick: 0, role: "hauler", corp: "hauling-W43N24-hauling-0-20", cost: 200 }
    ];
    capA.data.flow.haulers = [
      {
        edgeId: "scavenge-W43N24-30-20|storage-x",
        sourceId: "scavenge-W43N24-30-20",
        sinkId: "storage-x",
        carryParts: 1.41,
        flowRate: 0.6,
        distance: 55,
        spawnId
      }
    ];
    const e5 = computeLedger(capA, cap72404213).find(r => r.id === "E5")!;
    expect(e5.value, "a plan-micro hauler is not a runt").to.equal(0);
    expect(e5.verdict).to.equal("ok");
  });

  it("E5 STILL flags a hauler bought small for a planned NON-micro route (a real drained-spawn runt)", () => {
    // The genuine leak the detector must keep: the plan wanted a 14.8-carry
    // trunk hauler (distance-36 source route) but the drained spawn bought a
    // 200e runt. Plan >> actual = a real drained-spawn purchase.
    const capA: any = JSON.parse(JSON.stringify(cap72411542));
    const spawnId = Object.keys(capA.data.core.agenda)[0];
    capA.data.core.agenda[spawnId].executed = [
      { tick: 0, role: "hauler", corp: "hauling-W43N23-hauling-cd8e", cost: 200 },
      { tick: 0, role: "hauler", corp: "hauling-W43N23-hauling-cd8e", cost: 200 }
    ];
    capA.data.flow.haulers = [
      {
        edgeId: "source-5982fc1db097071b4adbcd8e|storage-x",
        sourceId: "source-5982fc1db097071b4adbcd8e",
        sinkId: "storage-x",
        carryParts: 14.8,
        flowRate: 10,
        distance: 36,
        spawnId
      }
    ];
    const e5 = computeLedger(capA, cap72404213).find(r => r.id === "E5")!;
    expect(e5.value, "plan-big but bought-small = runt").to.equal(2);
    expect(e5.verdict).to.equal("WARN");
  });

  it("E5 flags an UNMAPPABLE small hauler (no matching plan route = off-plan/stranded)", () => {
    // Conservative default: a small hauler with no plan route to vouch for its
    // size stays a runt - never hide a possible drained/stranded purchase.
    const capA: any = JSON.parse(JSON.stringify(cap72411542));
    const spawnId = Object.keys(capA.data.core.agenda)[0];
    capA.data.core.agenda[spawnId].executed = [
      { tick: 0, role: "hauler", corp: "hauling-W99N99-hauling-9999", cost: 200 },
      { tick: 0, role: "hauler", corp: "hauling-W99N99-hauling-9999", cost: 200 }
    ];
    capA.data.flow.haulers = [];
    const e5 = computeLedger(capA, cap72404213).find(r => r.id === "E5")!;
    expect(e5.value).to.equal(2);
    expect(e5.verdict).to.equal("WARN");
  });

  const scavCap = (dry: boolean, scavRate: number, scavParts: number): any => {
    const capA: any = JSON.parse(JSON.stringify(cap72411542));
    capA.data.flow.partsLedger = { capacity: 0.333, minerLoad: 0.05, infra: 0.1, budget: 0.18, spent: 0.18, dry };
    capA.data.flow.haulers = [
      // a strong real source route (the funded margin the scavenger is judged against)
      { sourceId: "source-aaaa", carryParts: 1, distance: 1, flowRate: 10, spawnParts: 0.001 },
      // the scavenger under test
      { sourceId: "scavenge-W1N1-10-20", carryParts: 1, distance: 1, flowRate: scavRate, spawnParts: scavParts }
    ];
    return capA;
  };

  it("SCAV WARNs only when spawn parts BIND and a scavenger is below the funded margin", () => {
    // dry=true (spawn is the binding constraint) + a scavenger whose net-e/part
    // (~0.73/0.002 = 366) sits far below the real route's (~9930): displacement.
    const scav = computeLedger(scavCap(true, 0.8, 0.002), cap72404213).find(r => r.id === "SCAV")!;
    expect(scav.verdict).to.equal("WARN");
    expect(scav.value, "one scavenger below margin").to.equal(1);
    expect(scav.detail).to.contain("DRY (binding)");
  });

  it("SCAV stays ok when spawn parts have SLACK (a low ratio spends parts nothing else wants)", () => {
    // Same low-ratio scavenger, but dry=false: parts are free at the margin, so
    // scavenging costs nothing it would otherwise use. No gate signal.
    const scav = computeLedger(scavCap(false, 0.8, 0.002), cap72404213).find(r => r.id === "SCAV")!;
    expect(scav.verdict).to.equal("ok");
    expect(scav.detail).to.contain("slack");
  });

  it("SCAV stays ok when the scavenger clears the funded margin even under bind", () => {
    // dry=true but a high-yield scavenger (~7.9/0.0005 = 15860) beats the real
    // route's margin - worth its parts even when the spawn binds.
    const scav = computeLedger(scavCap(true, 8, 0.0005), cap72404213).find(r => r.id === "SCAV")!;
    expect(scav.verdict).to.equal("ok");
    expect(scav.value).to.equal(0);
  });

  it("LINK surfaces the throughput ledger and flags 0%-direct controller flow as a missed win", () => {
    const capA: any = JSON.parse(JSON.stringify(cap72411542));
    capA.data.core.links = [
      { room: "W43N23", windowTicks: 200, toHubRate: 12, toControllerRate: 30, directShare: 0, taxRate: 1.26 }
    ];
    const link = computeLedger(capA, cap72404213).find(r => r.id === "LINK")!;
    expect(link.verdict).to.equal("ok"); // instrument-first: never gates
    expect(link.detail).to.contain("hub 12.0");
    expect(link.detail).to.contain("ctrl 30.0 (direct 0%)");
    expect(link.detail, "0% direct + real controller flow = the easy win").to.contain("double-hopping");
  });

  it("LINK does not flag a healthy direct share, and skips a dead network", () => {
    const capA: any = JSON.parse(JSON.stringify(cap72411542));
    capA.data.core.links = [
      { room: "W43N23", windowTicks: 200, toHubRate: 5, toControllerRate: 20, directShare: 0.8, taxRate: 0.75 },
      { room: "W44N24", windowTicks: 200, toHubRate: 0, toControllerRate: 0, directShare: 0, taxRate: 0 }
    ];
    const link = computeLedger(capA, cap72404213).find(r => r.id === "LINK")!;
    expect(link.detail).to.contain("direct 80%");
    expect(link.detail).to.not.contain("double-hopping");
    expect(link.value, "only the room with live fires counts as active").to.equal(1);
  });

  it("DEP surfaces the deposit-side link opportunity (remote haul shortened), sorted by saving", () => {
    const capA: any = JSON.parse(JSON.stringify(cap72411542));
    capA.data.flow.depositSavings = {
      candidates: [
        { sourceId: "source-aaaa", haulDist: 54, linkId: "link-gw01", linkDist: 39, saving: 15, flowRate: 10 },
        { sourceId: "source-bbbb", haulDist: 46, linkId: "link-ctrl9", linkDist: 20, saving: 26, flowRate: 8 }
      ],
      perLink: [
        { linkId: "link-gw01", depositFlow: 10, sources: 1 },
        { linkId: "link-ctrl9", depositFlow: 8, sources: 1 }
      ],
      controllerLinkId: "link-ctrl9",
      controllerCapacity: 15
    };
    const dep = computeLedger(capA, cap72404213).find(r => r.id === "DEP")!;
    expect(dep.verdict).to.equal("ok"); // instrument-first: never gates
    expect(dep.value).to.equal(2);
    // sorted by saving desc: bbbb (26) before aaaa (15)
    expect(dep.detail.indexOf("bbbb")).to.be.lessThan(dep.detail.indexOf("aaaa"));
    expect(dep.detail).to.contain("saves 26");
    // the controller link deposit is annotated bank-neutral up to its feed rate
    expect(dep.detail).to.contain("trl9 8.0e/t"); // "link-ctrl9".slice(-4)
    expect(dep.detail).to.contain("controller: bank-neutral <=15e/t");
  });

  it("X5 WARNs on a fast respawn (<60t = below one creep's spawn time, a double-order/loop)", () => {
    // The reserver 25t-gap shape live at t72509177 - a claim body takes ~78t to
    // SPAWN, so two 25t apart cannot be sequential deaths; it is a re-order
    // (the stranded-reserver trap's signature, or a post-reset double-order).
    const cap = JSON.parse(JSON.stringify(cap72411542));
    cap.data.blackbox = {
      v: 1,
      tick: cap.tick,
      rows: [
        { t: 100, k: "spawn", d: { corp: "reservation-W43N23-reservation", role: "reserver", cost: 1300 } },
        { t: 125, k: "spawn", d: { corp: "reservation-W43N23-reservation", role: "reserver", cost: 1300 } }
      ]
    };
    cap.data.corps.corps.push({ id: "reservation-W43N23-reservation", kind: "reservation", creepCount: 1 });
    const x5 = computeLedger(cap, cap72404213).find(r => r.id === "X5")!;
    expect(x5, "X5 present once a blackbox is captured").to.not.equal(undefined);
    expect(x5.verdict).to.equal("WARN");
    expect(x5.detail).to.contain("FAST RESPAWN");
  });

  it("X5 does NOT flag a healthy MULTI-SLOT corp whose interleaved slots each live a full life (t72587664 reservation)", () => {
    // Live t72587664: one reservation corp staffs 4 remote rooms (creepCount 4).
    // Its combined spawn log interleaves 4 independent 600t replacement cycles,
    // so CONSECUTIVE spawns are DIFFERENT slots ~life/4 apart (and a cohort
    // rebuild wave serialises 4 spawns ~12t apart through one spawn). The old
    // per-consecutive-gap method read those sub-60t gaps as one creep
    // double-ordering and WARNed - phantom churn on the very mechanism the trap
    // list says never to bandaid. The right lifetime is the SAME-slot gap
    // (i -> i+staffing): four slots, each replaced at full 600t life = 0 churn.
    const healthy: any[] = [];
    for (const base of [0, 600, 1200]) {
      for (let slot = 0; slot < 4; slot++) {
        healthy.push({
          t: base + slot * 50, // initial fill + two full-life replacement waves, staggered per slot
          k: "spawn",
          d: { corp: "reservation-W43N23-reservation", role: "reserver", cost: 1300 }
        });
      }
    }
    const churn = computeChurn(
      mkChurnCap(healthy, [{ id: "reservation-W43N23-reservation", kind: "reservation", creepCount: 4 }])
    )!;
    // every slot's same-slot gap is exactly the 600t claim lifetime => nothing died early
    expect(churn.remoteChurn, "healthy staggered 4-slot corp has no early-death churn").to.be.lessThan(1);
    expect(churn.worstGap, "worst same-slot gap is a full life, not a sub-60t interleave").to.be.greaterThan(60);

    const cap = JSON.parse(JSON.stringify(cap72411542));
    cap.data.blackbox = { v: 1, tick: cap.tick, rows: healthy };
    cap.data.corps.corps = cap.data.corps.corps.filter(
      (c: any) => c.id !== "reservation-W43N23-reservation"
    );
    cap.data.corps.corps.push({ id: "reservation-W43N23-reservation", kind: "reservation", creepCount: 4 });
    const x5 = computeLedger(cap, cap72404213).find(r => r.id === "X5")!;
    expect(x5.verdict, "a healthy interleaved multi-slot corp is not a churn WARN").to.equal("ok");
    expect(x5.detail).to.not.contain("FAST RESPAWN");
  });
});

describe("P4 construction charge (spec 34 P4: read THROUGH the all-in price)", () => {
  const fixtureCopy = (): any =>
    JSON.parse(
      require("fs").readFileSync(
        require("path").join(__dirname, "..", "..", "fixtures", "telemetry", "shard1-t72411542.json"),
        "utf8"
      )
    );

  it("a build sink carrying the plan's spawnLoad gains the construction (all-in) line", () => {
    const cap = fixtureCopy();
    cap.data.flow.sinks = cap.data.flow.sinks ?? [];
    cap.data.flow.sinks.push({ id: "site-x", type: "construction", demand: 20, allocated: 20, unmet: 0, priority: 70, spawnLoad: 0.05, spawnDist: 8 });
    const { lines, total } = planSpawnLoad(cap);
    const cons = lines.find(([n]) => n.includes("construction (all-in)"));
    expect(cons, "the class is no longer invisible to P4").to.not.equal(undefined);
    expect(cons![2]).to.be.closeTo(0.05, 1e-9); // the ECHO, never a re-derivation
    expect(total).to.be.greaterThan(planSpawnLoad(fixtureCopy()).total + 0.049);
  });

  it("legacy captures without the echo stay exactly as before (no fabricated line)", () => {
    const { lines } = planSpawnLoad(fixtureCopy());
    expect(lines.some(([n]) => n.includes("construction (all-in)"))).to.equal(false);
  });
});

describe("E6 miner pile gate (haul-deficit visibility, owner 2026-07-29)", () => {
  // The gate DEFERS miner bodies at a full source mouth; this line keeps the
  // deferral from MASKING the underlying haul deficit: chronic gating WARNs
  // on the haul side, a source dark behind a full pile (staffing 0) FAILs.
  const clone = (o: any): any => JSON.parse(JSON.stringify(o));
  const gatedCorp = (id: string, staffing: number): any => ({
    id,
    kind: "harvest",
    type: "mining",
    nodeId: id,
    roomName: "W9N9",
    creepCount: staffing,
    bodyParts: staffing * 8,
    body: {},
    // Stamped INSIDE the window (>= base tick): the stale-stamp filter (cycle
    // t72793209) discards frozen pre-defund stamps, so staged evidence must
    // carry a live tick like the real gate now always does.
    sizing: { tick: 72411542, gate: "buffer-full", buffered: 2400, threshold: 2000, staffing, target: 1 },
    createdAt: 0,
    lastActivityTick: 1
  });

  it("skips the row entirely on pre-gate captures (no stamped harvest corps)", () => {
    const rows = computeLedger(cap72411542, cap72404213);
    expect(rows.find(r => r.id === "E6")).to.equal(undefined);
  });

  it("FAILs when a source goes DARK behind a full pile (gated, staffing 0)", () => {
    const cap = clone(cap72411542);
    cap.data.corps.corps.push(gatedCorp("mining-W9N9-harvest-dead", 0));
    const e6 = computeLedger(cap, cap72404213).find(r => r.id === "E6")!;
    expect(e6.verdict).to.equal("FAIL");
    expect(e6.detail).to.contain("HAULING"); // the attribution the gate must never bury
    expect(e6.detail).to.contain("DARK");
  });

  it("WARNs on CHRONIC gating (deferred in both captures) - the haul side is behind", () => {
    const cap = clone(cap72411542);
    const base = clone(cap72404213);
    cap.data.corps.corps.push(gatedCorp("mining-W9N9-harvest-slow", 1));
    base.data.corps.corps.push(gatedCorp("mining-W9N9-harvest-slow", 1));
    const e6 = computeLedger(cap, base).find(r => r.id === "E6")!;
    expect(e6.verdict).to.equal("WARN");
    expect(e6.detail).to.contain("CHRONIC");
  });

  it("stays ok on a transient deferral with the post still staffed (the gate doing its job)", () => {
    const cap = clone(cap72411542);
    cap.data.corps.corps.push(gatedCorp("mining-W9N9-harvest-blip", 1));
    const e6 = computeLedger(cap, cap72404213).find(r => r.id === "E6")!;
    expect(e6.verdict).to.equal("ok");
    expect(e6.value).to.equal(1);
  });

  it("reports quiet-gate visibility (stamps present, zero deferrals) as ok/0", () => {
    const cap = clone(cap72411542);
    const clear = gatedCorp("mining-W9N9-harvest-fine", 1);
    clear.sizing = { tick: 72411542, gate: "clear", buffered: 150, staffing: 1, target: 1 };
    cap.data.corps.corps.push(clear);
    const e6 = computeLedger(cap, cap72404213).find(r => r.id === "E6")!;
    expect(e6.verdict).to.equal("ok");
    expect(e6.value).to.equal(0);
  });

  // Delay meter verdicts (owner 2026-07-29: instrument the spawning delay
  // time of a pile). heldFor is MEASURED consecutive hold: one source regen
  // cycle (300t) of continuous deferral WARNs without waiting for a second
  // capture; a full miner lifetime (1500t) FAILs - a whole generation of
  // spawning suppressed behind one pile.
  it("WARNs on a measured hold >= one regen cycle (300t) from a SINGLE capture", () => {
    const cap = clone(cap72411542);
    const c = gatedCorp("mining-W9N9-harvest-lag", 1);
    c.sizing.heldFor = 300;
    c.sizing.heldFrac = 0.3;
    cap.data.corps.corps.push(c);
    const e6 = computeLedger(cap, cap72404213).find(r => r.id === "E6")!;
    expect(e6.verdict).to.equal("WARN");
    expect(e6.detail).to.contain("300t");
  });

  it("FAILs on a measured hold >= a miner lifetime (1500t) even fully staffed", () => {
    const cap = clone(cap72411542);
    const c = gatedCorp("mining-W9N9-harvest-stuck", 1);
    c.sizing.heldFor = 1500;
    c.sizing.heldFrac = 1;
    cap.data.corps.corps.push(c);
    const e6 = computeLedger(cap, cap72404213).find(r => r.id === "E6")!;
    expect(e6.verdict).to.equal("FAIL");
  });

  it("stays ok on a short measured hold (below a regen cycle, staffed, not chronic)", () => {
    const cap = clone(cap72411542);
    const c = gatedCorp("mining-W9N9-harvest-blip2", 1);
    c.sizing.heldFor = 40;
    c.sizing.heldFrac = 0.04;
    cap.data.corps.corps.push(c);
    const e6 = computeLedger(cap, cap72404213).find(r => r.id === "E6")!;
    expect(e6.verdict).to.equal("ok");
  });
});

describe("E6 frac trigger sample floor (first-contact calibration, t72645498)", () => {
  // A reset wipes the meter window: 7 samples all-held read heldFrac 1.0 and
  // cried WARN on 7 ticks of evidence. The frac trigger now requires the
  // current hold to be >= 50t (the two-captures->=50t doctrine); heldFor's
  // own 300t duration trigger and the dark-source FAIL are unchanged.
  const clone = (o: any): any => JSON.parse(JSON.stringify(o));
  const fx = (name: string): any =>
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "fixtures", "telemetry", name), "utf8"));
  const capBase = fx("shard1-t72411542.json");
  const baseBase = fx("shard1-t72404213.json");
  const mk = (heldFor: number, heldFrac: number): any => {
    const cap = clone(capBase);
    cap.data.corps.corps.push({
      id: "mining-W9N9-harvest-tiny", kind: "harvest", type: "mining", nodeId: "n", roomName: "W9N9",
      creepCount: 1, bodyParts: 8, body: {},
      sizing: { tick: 72411542, gate: "buffer-full", buffered: 4000, staffing: 1, target: 1, heldFor, heldFrac },
      createdAt: 0, lastActivityTick: 1
    });
    return cap;
  };

  it("suppresses the frac WARN on a tiny post-reset window (7t held, frac 1.0)", () => {
    const e6 = computeLedger(mk(7, 1), baseBase).find(r => r.id === "E6")!;
    expect(e6.verdict).to.equal("ok");
  });

  it("keeps the frac WARN once the hold is >= 50t of evidence (60t, frac 0.6)", () => {
    const e6 = computeLedger(mk(60, 0.6), baseBase).find(r => r.id === "E6")!;
    expect(e6.verdict).to.equal("WARN");
  });
});

describe("X5 phantom churn on a mid-window fleet shrink (t72651837, owner 2026-07-29)", () => {
  // The governor swing bought two 4350e upgraders 153t apart (a cohort wave -
  // the spawn takes ~132t to BUILD one), relegation later shrank staffing to
  // 1, and X5 read the pair at stride 1 as one slot dying at 153t: 4350e of
  // phantom churn on bodies that both lived full lives (successors at
  // +1646t/+1493t ~ natural EOL). A slot with a natural-lifetime successor
  // anywhere in the log did not churn.
  it("does not book the 4350e cohort pair as churn (both bodies EOL'd naturally)", () => {
    const cap = fixture("shard1-t72651837.json");
    const churn = computeChurn(cap)!;
    expect(churn.worst).to.not.contain("4350e@153");
    expect(churn.homeChurn, "upgrading cohort wave is not churn").to.be.lessThan(1000);
  });

  it("still catches a REAL early death (no EOL-window successor exists)", () => {
    const mk = (ts: number[]): any => ({
      data: {
        blackbox: { rows: ts.map(t => ({ t, k: "spawn", d: { spawn: "s1", role: "hauler", corp: "hauling-W1N1-x", cost: 1000 } })) },
        corps: { corps: [{ id: "hauling-W1N1-x", creepCount: 1 }] }
      }
    });
    // death at 300t, replaced: successor at 0.2x life - churn stands
    const real = computeChurn(mk([100000, 100300]))!;
    expect(real.churnEnergy).to.be.greaterThan(700); // 1000 * (1 - 300/1500) = 800
    // natural EOL cadence: successor at ~1x life - no churn
    const eol = computeChurn(mk([100000, 101500]))!;
    expect(eol.churnEnergy).to.equal(0);
  });
});

describe("E4 damped-equilibrium frame (owner 2026-07-29: a rising surplus is convergence, not a leak)", () => {
  // Under SURPLUS_DRAIN_TICKS = CREEP_LIFETIME the bank's equilibrium is NOT
  // the reserve: spending is surplus/1500, so it settles where that equals
  // net inflow => S* = reserve + 1500 x netInflow. A bank CLIMBING toward a
  // finite S* with the spend path live is healthy convergence; the leak
  // signature is a bank whose projected S* runs past the draw-saturation
  // knee (MAX_SURPLUS_DRAW x 1500) or that climbs with the spend path DOWN.
  const clone = (o: any): any => JSON.parse(JSON.stringify(o));
  const fx = (n: string): any =>
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "fixtures", "telemetry", n), "utf8"));

  /** A capture pair with a chosen storage slope, feeder state, and reserve. */
  const pair = (storage: number, prevStorage: number, feederActive = true) => {
    const cap = clone(fx("shard1-t72652682.json"));
    const base = clone(fx("shard1-t72651837.json"));
    cap.data.core.warchestTarget = 56000;
    base.data.core.warchestTarget = 56000;
    cap.data.core.rooms[0].storageEnergy = storage;
    cap.data.core.rooms[0].feederActive = feederActive;
    base.data.core.rooms[0].storageEnergy = prevStorage;
    base.data.core.rooms[0].name = cap.data.core.rooms[0].name;
    return [cap, base] as const;
  };
  const e4 = (a: any, b: any): any => computeLedger(a, b).find((r: any) => r.id === "E4")!;

  it("does NOT flag a bank climbing toward a modest equilibrium (the damped signature)", () => {
    // +2/t from 90k (surplus 34k - genuinely ABOVE the idle threshold, so
    // the old rule's "excess big AND slope >= 0" would have FAILED it):
    // S* ~ 90k + 3000, ~37k surplus, well inside the 150k knee.
    const [cap, base] = pair(90_000, 88_310);
    const row = e4(cap, base);
    expect(row.verdict).to.equal("ok");
    expect(row.detail).to.contain("equilibrium");
  });

  it("still FAILS a runaway bank whose projected equilibrium blows past the draw knee", () => {
    // +40/t sustained: S* ~ 200k+, far beyond MAX_SURPLUS_DRAW x 1500 - the
    // spend path cannot absorb what income banks. That is a real leak.
    const [cap, base] = pair(190_000, 156_200);
    expect(e4(cap, base).verdict).to.equal("FAIL");
  });

  it("still FAILS a big idle bank while the spend path is DOWN (feederActive false)", () => {
    const [cap, base] = pair(120_000, 120_000, false);
    expect(e4(cap, base).verdict).to.equal("FAIL");
  });

  it("keeps a watch-level WARN (never a FAIL) on a bank FLAT at a big surplus", () => {
    // Flat is not convergence evidence - it is equally the stalled-spend-path
    // shape. Worth watching, never a deploy-blocking red.
    const [cap, base] = pair(90_000, 90_000);
    expect(e4(cap, base).verdict).to.equal("WARN");
  });

  it("stays ok at/below the reserve target (nothing idle)", () => {
    const [cap, base] = pair(50_000, 49_000);
    expect(e4(cap, base).verdict).to.equal("ok");
  });
});

describe("E4 spend-path: a feeder BETWEEN GENERATIONS is not a broken path (t72665987)", () => {
  // Live FAIL "SPEND PATH DOWN" on a healthy colony: feederActive false while
  // the feeder's own stamp read gate "demand", wantedFeeders 1, feeders 0 -
  // i.e. it had DEMANDED a body and was waiting for the spawn. Meanwhile P7
  // delivered 0.91x plan (33.3 e/t), the link network put 34.1 e/t into the
  // controller and upgraders ran workUtil 0.999. A path in transition is not a
  // path down; a path GATED OFF ("no-storage"/"no-miner"/"no-spawn") is.
  // Trust the stamp over the derived boolean - the spec-14 rule.
  const fx = (name: string): any =>
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "fixtures", "telemetry", name), "utf8"));
  const cap = fx("shard1-t72665987.json");
  const base = fx("shard1-t72664142.json");

  it("does NOT FAIL while the feeder is awaiting a body it has demanded", () => {
    const e4 = computeLedger(cap, base).find(r => r.id === "E4")!;
    expect(e4.verdict).to.not.equal("FAIL");
  });

  it("STILL FAILS when the feeder is structurally gated off (no-storage)", () => {
    const gated = JSON.parse(JSON.stringify(cap));
    const feeder = gated.data.corps.corps.find((c: any) => c.kind === "controllerFeeder");
    feeder.sizing = { tick: feeder.sizing.tick, gate: "no-storage" };
    const e4 = computeLedger(gated, base).find(r => r.id === "E4")!;
    expect(e4.verdict, "a gated-off relay IS a down spend path").to.equal("FAIL");
  });

  it("STILL FAILS when there is no feeder corp at all and the bank is idle", () => {
    const none = JSON.parse(JSON.stringify(cap));
    none.data.corps.corps = none.data.corps.corps.filter((c: any) => c.kind !== "controllerFeeder");
    const e4 = computeLedger(none, base).find(r => r.id === "E4")!;
    expect(e4.verdict).to.equal("FAIL");
  });
});

/**
 * F1 — PLAN FIDELITY (owner doctrine 2026-07-30): *"More than points what
 * we're chasing is a controllable economy. So that we can plan it all on the
 * abstract level and then it gets implemented faithfully... We end up having
 * to chase down why is this or that thing happening. That's something to
 * optimize for as well."*
 *
 * Fidelity was already first-class in SIMS (`fid-*` grid cells; CLAUDE.md:
 * "on synthetic worlds the plan should be achievable - a fidelity gap there
 * is a bug signal by construction") but had NO production number. The waste
 * ledger measured leaks; nothing measured DIVERGENCE, so every live fidelity
 * failure this session was found by hand: the 100-tile fuel price on a 4-tile
 * pile (spec 37), three bank-drain rates (spec 38), P4's 7x reserver
 * under-count, and the six-capture 0.649-vs-0.478 parts gap.
 *
 * F1 is the aggregate: what the plan says the colony's spawn maintenance
 * costs, against what the spawn MEASURABLY builds. 1.0 is a faithful plan.
 * It is deliberately a RATIO in both directions - a plan that over-states is
 * as unfaithful as one that under-states, and only one of those looks like
 * "waste".
 */
describe("F1 plan fidelity (waste ledger)", () => {
  const mk = (planLines: any[], partsPerTick: number[], corpsList: any[] = []): any => ({
    tick: 1000,
    data: {
      flow: { sources: [], haulers: [], sinks: [] },
      corps: { corps: corpsList },
      core: {
        rooms: [{ storageEnergy: 0 }],
        creeps: { total: 0, tracked: 0, untracked: 0 },
        spawns: partsPerTick.map(p => ({ partsPerTick: p, utilization: p * 3, queueDepth: 0 }))
      },
      ...(planLines.length ? {} : {})
    }
  });

  /** The plan total carries fallback lines (tender 3x24, feeder, ...), so the
   *  fixtures DERIVE it via planSpawnLoad rather than hard-coding a constant -
   *  the assertions are about the RELATIONSHIP, which is what F1 measures. */
  const planTotal = (cap: any): number => planSpawnLoad(cap).total;

  it("reads 1.0 when the spawn builds exactly what the plan prices", () => {
    const corps = [{ id: "reservation-A-reservation", kind: "reservation", creepCount: 1, bodyParts: 4, sizing: { targets: 1 } }];
    const probe = mk([], [0], corps);
    const cap = mk([], [planTotal(probe)], corps);
    const f1 = computeLedger(cap, cap).find(r => r.id === "F1")!;
    expect(f1.value).to.be.closeTo(1.0, 0.02);
    expect(f1.verdict).to.equal("ok");
    expect(f1.detail).to.contain("faithful");
  });

  it("FAILS when the spawn builds far more than the plan prices (the session's shape)", () => {
    const corps = [{ id: "reservation-A-reservation", kind: "reservation", creepCount: 1, bodyParts: 4, sizing: { targets: 1 } }];
    const probe = mk([], [0], corps);
    const cap = mk([], [planTotal(probe) * 2], corps);
    const f1 = computeLedger(cap, cap).find(r => r.id === "F1")!;
    expect(f1.value).to.be.closeTo(2.0, 0.05);
    expect(f1.verdict).to.equal("FAIL");
    expect(f1.detail).to.contain("UNBUDGETED");
  });

  it("also FLAGS an OVER-stating plan (fidelity is two-sided, not a waste line)", () => {
    // A fleet priced but never built is exactly as uncontrollable as an
    // unbudgeted one - and it is the shape that reads as "efficient" if you
    // only ever look for waste.
    const corps = [{ id: "reservation-A-reservation", kind: "reservation", creepCount: 1, bodyParts: 4, sizing: { targets: 1 } }];
    const probe = mk([], [0], corps);
    const cap = mk([], [planTotal(probe) * 0.5], corps);
    const f1 = computeLedger(cap, cap).find(r => r.id === "F1")!;
    expect(f1.value).to.be.closeTo(0.5, 0.05);
    expect(f1.verdict).to.equal("FAIL");
    expect(f1.detail).to.contain("OVER-states");
  });

  it("skips (no row) when the spawn meter is absent - never a fabricated verdict", () => {
    const cap: any = {
      tick: 1000,
      data: {
        flow: {},
        corps: { corps: [] },
        core: { rooms: [{ storageEnergy: 0 }], creeps: { total: 0, tracked: 0, untracked: 0 } }
      }
    };
    expect(computeLedger(cap, cap).find(r => r.id === "F1")).to.equal(undefined);
  });

  /**
   * DECOMPOSITION (t72689264). F1 said "0.286 p/t UNBUDGETED (44%)" for five
   * consecutive cycles and named only *the largest PLANNED class* - which is
   * not the same question. Finding WHICH class was in breach took a manual
   * blackbox bucket-by-role every cycle; the answer (haulers, 0.256 of the
   * 0.286 = 89%) was stable the whole time and no line printed it.
   *
   * This is spec 40's Part A thesis reduced to the one line that already
   * exists: *"one number nobody can decompose is worse than a table."* The
   * blackbox spawn ring is the actual side, `planSpawnLoad` is the plan side,
   * and the join is the corp's own kind - so the leak arrives with a name.
   */
  const mkRing = (rows: Array<{ role: string; corp: string; cost: number; parts?: number }>, tick = 1000): any =>
    rows.map((d, i) => ({ t: tick - rows.length + i, k: "spawn", d }));

  it("names the class in breach, not just the largest planned class", () => {
    const corps = [
      { id: "reservation-A-reservation", kind: "reservation", creepCount: 1, bodyParts: 4, sizing: { targets: 1 } },
      { id: "mining-A-harvest-s1", kind: "harvest", creepCount: 1, bodyParts: 8 }
    ];
    const probe = mk([], [0], corps);
    const cap = mk([], [planTotal(probe) * 2], corps);
    // 300 hauler parts over the 1000-tick ring = 0.3 p/t of a class the plan
    // prices at zero (no flow.haulers) - the whole overshoot, one class.
    cap.data.blackbox = { rows: mkRing([{ role: "hauler", corp: "mining-A-harvest-s1", cost: 15000, parts: 300 }]) };
    const f1 = computeLedger(cap, cap).find(r => r.id === "F1")!;
    expect(f1.detail).to.contain("haulers");
    expect(f1.detail).to.match(/breach|worst/i);
  });

  it("settles guard purchases against the PRICED defense line (the raidGuard hole is closed)", () => {
    // Phase 1 of the income-statement program: raidGuard stood 10 parts and
    // bought 0.020 p/t live while planSpawnLoad had no line for it - F1
    // flagged it UNPRICED on every cycle. The standing fleet now prices at
    // its replacement cadence, so guard spend settles against a plan line
    // like every other class.
    const corps = [
      { id: "reservation-A-reservation", kind: "reservation", creepCount: 1, bodyParts: 4, sizing: { targets: 1 } },
      { id: "raidGuard-A-raidGuard", kind: "raidGuard", creepCount: 1, bodyParts: 10, body: { attack: 5, move: 5 } }
    ];
    const probe = mk([], [0], corps);
    const cap = mk([], [planTotal(probe) * 2], corps);
    cap.data.blackbox = { rows: mkRing([{ role: "guard", corp: "raidGuard-A-raidGuard", cost: 3000, parts: 30 }]) };
    const f1 = computeLedger(cap, cap).find(r => r.id === "F1")!;
    expect(f1.detail).to.not.contain("UNPRICED");
    expect(f1.detail, "guards settle against their own plan line").to.contain("defense (guards)");
    const { lines } = planSpawnLoad(cap);
    const guard = lines.find(([n]) => String(n).startsWith("defense"))!;
    expect(guard, "the standing fleet is priced").to.not.equal(undefined);
    expect(guard[2]).to.be.closeTo(10 / 1500, 1e-9);
  });

  it("methodology #17: the depot-mover BUDGETS are the primitives, not a ledger recompute", () => {
    // THE SECOND-BOOK CLASS, third instance. Methodology #8 caught the reserver
    // line recomputing continuous duty while the primitive priced 0.5 (an +8.02 F
    // "favorable" variance that was pure arithmetic); #7 caught P4's hauler line
    // re-deriving spawnParts. This is the feeder and the tender.
    //
    // Measured t72849380: the ledger printed `feeder @ relay 100 (link-fed d1)
    // 16p=0.011` while the feeder COMMISSION declared 0.02135 - exactly 2x,
    // because the recompute `2 * carryPartsFor(relay, 1)` predates spec 45's
    // volley-service floor and `feederSpawnLoad` clamps to it. The ledger was
    // showing the plan charging half what it charges, on the account's single
    // worst unfavourable line (infra -1.97 budget vs -12.61 actual).
    //
    // The tender line had the OTHER shape of the same defect: `sizing.target x
    // measured body` is ACTUALS-FED, so its budget moved with the fleet it was
    // supposed to judge.
    const corps = [
      {
        id: "moving-W1N1-controllerFeeder",
        kind: "controllerFeeder",
        creepCount: 1,
        bodyParts: 100,
        body: { carry: 50, move: 50 },
        sizing: { linkFed: true, relayRate: 100 }
      },
      { id: "moving-W1N1-tender", kind: "tender", creepCount: 2, bodyParts: 86, sizing: { target: 2 } }
    ];
    const cap = mk([], [0], corps);
    const lines = planSpawnLoad(cap).lines;
    const relay = bankFedControllerRate(0, BASE_RESERVE);

    const feeder = lines.find(([n]) => String(n).startsWith("feeder"))!;
    expect(feeder[2], "the feeder budget IS feederSpawnLoad - volley floor and all").to.be.closeTo(
      feederSpawnLoad(relay, true),
      1e-12
    );

    const tender = lines.find(([n]) => String(n).startsWith("tender"))!;
    expect(tender[2], "the tender budget IS tenderSpawnLoad - one depot detail, not the measured fleet").to.be.closeTo(
      tenderSpawnLoad(),
      1e-12
    );
    // And it must NOT move when the fielded tender fleet does - that is what
    // "actuals-fed budget" means, and it is the thing spec 14 forbids.
    const fatter = mk([], [0], [corps[0], { ...corps[1], creepCount: 4, bodyParts: 300, sizing: { target: 4 } }]);
    const tender2 = planSpawnLoad(fatter).lines.find(([n]) => String(n).startsWith("tender"))!;
    expect(tender2[2], "a fatter fielded fleet does not raise its own budget").to.be.closeTo(tender[2], 1e-12);
  });

  it("methodology #16: the defense BUDGET is the PLAN's armed-room price, not the standing bodies", () => {
    // #14 priced this line from the guards standing at capture time, which made
    // the variance circular - measured bodies on both sides can never disagree.
    // Since spec 51 phase 2 the plan itself charges one guard per ARMED room, so
    // the budget reads that count and a gap becomes a real F1 signal.
    const corps = [
      { id: "raidGuard-A-raidGuard", kind: "raidGuard", creepCount: 1, bodyParts: 10, body: { attack: 5, move: 5 } }
    ];
    const cap = mk([], [0], corps);
    // The solve was armed for THREE rooms; only one guard is standing right now.
    cap.data.flow.fleetCharge = { infraInputs: { guardedRooms: 3 } };
    const guard = planSpawnLoad(cap).lines.find(([n]) => String(n).startsWith("defense"))!;
    expect(guard[2], "three armed rooms, not one standing body").to.be.closeTo(3 * (10 / 1500), 1e-12);
    expect(guard[1], "and the parts column follows the same count").to.equal(30);

    // A quiet solve prices nothing even with a guard still walking home.
    const quiet = mk([], [0], corps);
    quiet.data.flow.fleetCharge = { infraInputs: { guardedRooms: 0 } };
    expect(planSpawnLoad(quiet).lines.find(([n]) => String(n).startsWith("defense"))).to.equal(undefined);

    // Pre-spec-51 capture (no count published): the #14 measured reconstruction
    // still runs, so old captures keep producing a defense line.
    const legacy = planSpawnLoad(mk([], [0], corps)).lines.find(([n]) => String(n).startsWith("defense"))!;
    expect(legacy[2]).to.be.closeTo(10 / 1500, 1e-12);
  });

  /**
   * THE SECOND-BOOK CLASS, fifth instance - and the first on the ENERGY side.
   *
   * #16 (above) converged the defense line's PARTS onto the plan's armed-room
   * count. Its ENERGY RATE was left behind: the account priced those parts from
   * whatever guard bodies happened to be standing, defaulting to a hand-written
   * 80 e/part when none were, while `infraSpawnEnergy` - the charge the colony's
   * own solve deducts - prices the identical parts at ATTACK_MOVE_PER_PART = 65.
   *
   * The 23% gap landed in exactly the window #16 exists to make readable: the
   * plan budgets a guard for an armed room and no body is standing yet. That is
   * the F1 signal, and it was arriving pre-corrupted by an accounting constant.
   *
   * The classes below are the ones BOTH books price, so the invariant is simply
   * that they agree. Guards are the case that was broken; feeder/tender/reserver
   * are pinned beside them so the next divergence fails here rather than
   * printing.
   */
  it("methodology #18: the infra ENERGY budget IS infraSpawnEnergy's own per-class rates", () => {
    // The F1-signal case: three armed rooms priced by the plan, NO guard body
    // standing to reconstruct a rate from.
    const cap = mk([], [0], []);
    cap.data.flow.fleetCharge = { infraInputs: { guardedRooms: 3 } };
    const { energy } = planSpawnLoad(cap);
    expect(
      energy["defense (guards)"],
      "guards are ATTACK+MOVE pairs - 65 e/part, the same rate the colony's charge uses"
    ).to.be.closeTo(3 * roomGuardSpawnLoad() * ATTACK_MOVE_PER_PART, 1e-12);

    // And it must not move when a body IS standing: the budget is the plan's,
    // never the fielded fleet's (spec 14 - no actuals-fed budgets).
    const standing = mk([], [0], [
      { id: "raidGuard-A-raidGuard", kind: "raidGuard", creepCount: 1, bodyParts: 10, body: { attack: 5, move: 5 } }
    ]);
    standing.data.flow.fleetCharge = { infraInputs: { guardedRooms: 3 } };
    expect(planSpawnLoad(standing).energy["defense (guards)"]).to.be.closeTo(energy["defense (guards)"], 1e-12);

    // The other two classes both books price, pinned against the same constants.
    const depot = mk([], [0], [
      {
        id: "moving-W1N1-controllerFeeder",
        kind: "controllerFeeder",
        creepCount: 1,
        bodyParts: 100,
        body: { carry: 50, move: 50 },
        sizing: { linkFed: true, relayRate: 100 }
      },
      { id: "moving-W1N1-tender", kind: "tender", creepCount: 2, bodyParts: 86, sizing: { target: 2 } },
      { id: "reservation-A-reservation", kind: "reservation", creepCount: 1, bodyParts: 4, sizing: { targets: 2 } }
    ]);
    const de = planSpawnLoad(depot).energy;
    const relay = bankFedControllerRate(0, BASE_RESERVE);
    const feederKey = Object.keys(de).find(k => k.startsWith("feeder"))!;
    expect(de[feederKey]).to.be.closeTo(feederSpawnLoad(relay, true) * CARRY_MOVE_PER_PART, 1e-12);
    expect(de.tenders).to.be.closeTo(tenderSpawnLoad() * CARRY_MOVE_PER_PART, 1e-12);
    expect(de["reservers (claim life)"]).to.be.closeTo(2 * roomReserverSpawnLoad() * CLAIM_MOVE_PER_PART, 1e-12);
  });

  /**
   * THE COST COLUMN ADDS UP (methodology #18).
   *
   * `TOTAL SPAWN (plan fleet, priced)` is the whole plan's fleet in energy, and
   * the six cost lines above it are supposed to BE that fleet, split by
   * account. So their budgets must sum to it - not approximately, exactly.
   *
   * They did agree before this was pinned, but only algebraically: four lines
   * projected `planSpawnLoad`'s energy map while extraction and evacuation were
   * reduced independently from `flow.sources` / `flow.haulers`. Two derivations
   * that happen to be equal are one edit away from not being, and nothing would
   * have caught it - the column has no self-check, and TOTAL SPAWN is the line
   * the CONTROLLER VARIANCE BRIDGE charges its "fleet costs more than the plan
   * prices" term against. A silent split there would have moved the bridge's
   * closure into "rounding" and stayed there.
   *
   * Now every line reads the one book, so this is structural. Verified equal to
   * 1e-15 across all 25 committed fixtures before the unification.
   */
  it("methodology #18: the six cost-line budgets SUM to the TOTAL SPAWN budget", () => {
    const text = formatAccounts(cap72411542, cap72404213, computeLedger(cap72411542, cap72404213));
    const budgetOf = (label: string): number => {
      const line = text.split("\n").find(l => l.includes(label));
      if (!line) throw new Error(`no line matching "${label}" in:\n${text}`);
      const nums = (line.slice(line.indexOf(label) + label.length).match(/-?\d+\.\d\d/g) ?? []).map(Number);
      // BUDGET ACTUAL VARIANCE - the budget is the FIRST of the three.
      expect(nums.length, `"${label}" is a budgeted line`).to.be.greaterThanOrEqual(3);
      return nums[0];
    };
    const parts = [
      "extraction  (miner)",
      "evacuation  (hauler)",
      "reservation (reserver)",
      "infra      (tanker, feeder, scout)",
      "defense    (guard)",
      "consumers  (upgrader, builder)"
    ].map(budgetOf);
    const total = budgetOf("= TOTAL SPAWN (plan fleet, priced)");
    const sum = parts.reduce((s, v) => s + v, 0);
    // 0.01 is the printed precision, not a tolerance on the arithmetic.
    expect(sum, `lines ${parts.map(p => p.toFixed(2)).join(" + ")} vs total ${total.toFixed(2)}`).to.be.closeTo(
      total,
      0.011
    );
  });

  it("still surfaces a kind with NO plan line as UNPRICED (the detector outlives the hole)", () => {
    // An unpriced CLASS is a different defect from a mispriced one: no amount
    // of tuning an existing line can find it. The detector must survive the
    // raidGuard fix - pinned with a kind planSpawnLoad genuinely never prices.
    const corps = [
      { id: "reservation-A-reservation", kind: "reservation", creepCount: 1, bodyParts: 4, sizing: { targets: 1 } },
      { id: "mystery-A-mystery", kind: "mystery", creepCount: 1, bodyParts: 10 }
    ];
    const probe = mk([], [0], corps);
    const cap = mk([], [planTotal(probe) * 2], corps);
    cap.data.blackbox = { rows: mkRing([{ role: "enigma", corp: "mystery-A-mystery", cost: 3000, parts: 30 }]) };
    const f1 = computeLedger(cap, cap).find(r => r.id === "F1")!;
    expect(f1.detail).to.contain("UNPRICED");
    expect(f1.detail).to.contain("mystery");
  });

  it("prefers the recorded parts count over the cost estimate, and says which it used", () => {
    const corps = [{ id: "reservation-A-reservation", kind: "reservation", creepCount: 1, bodyParts: 4, sizing: { targets: 1 } }];
    const probe = mk([], [0], corps);
    const measured = mk([], [planTotal(probe) * 2], corps);
    measured.data.blackbox = { rows: mkRing([{ role: "hauler", corp: "mining-A-harvest-s1", cost: 15000, parts: 300 }]) };
    const estimated = mk([], [planTotal(probe) * 2], corps);
    // same purchase, no `parts` field (a pre-v2 ring): cost/50 = 300 parts too,
    // but the line must SAY it inferred them rather than claim a measurement.
    estimated.data.blackbox = { rows: mkRing([{ role: "hauler", corp: "mining-A-harvest-s1", cost: 15000 }]) };
    const a = computeLedger(measured, measured).find(r => r.id === "F1")!;
    const b = computeLedger(estimated, estimated).find(r => r.id === "F1")!;
    expect(a.detail).to.not.contain("est.");
    expect(b.detail).to.contain("est.");
  });

  it("omits the decomposition entirely when no spawn ring was captured", () => {
    const corps = [{ id: "reservation-A-reservation", kind: "reservation", creepCount: 1, bodyParts: 4, sizing: { targets: 1 } }];
    const probe = mk([], [0], corps);
    const cap = mk([], [planTotal(probe) * 2], corps);
    const f1 = computeLedger(cap, cap).find(r => r.id === "F1")!;
    expect(f1.verdict).to.equal("FAIL"); // the aggregate still works
    expect(f1.detail).to.not.match(/breach|UNPRICED/);
  });
});

/**
 * The F1 class map is keyed on REGISTERED KIND NAMES, and a typo there is
 * silent-and-wrong in the worst way: the class does not vanish, it is
 * re-reported as UNPRICED, which reads as a plan HOLE rather than a ledger
 * bug. Caught on the first live run - the map said "upgrading" where the kind
 * is "upgrade", and F1 duly announced upgraders as an unpriced class.
 *
 * So the map is pinned against the kind registry itself, not a literal list:
 * every registered kind is either classified or an ACKNOWLEDGED unpriced kind.
 * A new kind (spec 17: registration-only) fails this until someone decides
 * which of the two it is - which is the decision F1 exists to force.
 */
describe("F1 class map covers every registered corp kind", () => {
  /** Kinds the PLAN genuinely does not price. Each is a real finding, not a
   *  waiver: F1 reports them as UNPRICED so the hole stays visible. */
  const ACKNOWLEDGED_UNPRICED = new Set([
    "raidGuard", // defense: bought on threat, never budgeted (live 0.014-0.020 p/t)
    "coreBuster", // invader-core response, same shape as raidGuard
    "scout", // 50e bodies, below the noise floor but still unpriced
    "claim", // expansion capex, one-shot and outside the maintenance plan
    "carry" // routes ARE priced (flow.haulers); the kind only ever buys role `hauler`
  ]);

  it("classifies or acknowledges every kind in the registry", () => {
    const unclassified = ALL_CORP_KINDS.filter(k => !F1_CLASS_OF_KIND[k] && !ACKNOWLEDGED_UNPRICED.has(k));
    expect(unclassified, `unclassified kinds: ${unclassified.join(", ")}`).to.deep.equal([]);
  });

  it("maps no kind that does not exist (the 'upgrading' typo)", () => {
    const ghosts = Object.keys(F1_CLASS_OF_KIND).filter(k => !ALL_CORP_KINDS.includes(k));
    expect(ghosts, `mapped kinds that are not registered: ${ghosts.join(", ")}`).to.deep.equal([]);
  });

  it("points every class at a plan line that planSpawnLoad actually emits", () => {
    const classes = new Set(Object.values(F1_CLASS_OF_KIND).concat("haulers"));
    const missing = [...classes].filter(c => !F1_PLAN_PREFIX[c]);
    expect(missing, `classes with no plan prefix: ${missing.join(", ")}`).to.deep.equal([]);
  });
});

/**
 * The ENERGY ACCOUNT's role map, ratcheted the same way F1's kind map is.
 * Owner-caught 2026-08-01 ("what about claim corp"): four roles - claimer,
 * scout, buster, striker - were landing in an unnamed "other" bucket, and one
 * of them (claimer) is CAPEX that must never be charged to operating margin.
 * A chart of accounts with an anonymous bucket is not a chart of accounts.
 */
describe("energy account: every spawnable role has an account", () => {
  /**
   * Roles the bot really buys from OUTSIDE the kind registry, so `ALL_SPAWN_ROLES`
   * (derived from the kinds' own `roles` declarations) cannot see them. Each
   * needs a named reason - the set exists so a typo still fails the ghost check
   * rather than being waved through as "probably one of those".
   */
  const BOUGHT_OUTSIDE_THE_REGISTRY = new Set([
    // BootstrapCorp spawns jacks directly, bypassing the SpawningCorp executor
    // (it accrues to the ledger itself). There is no bootstrapKind to declare
    // the role, but the spend is real and lands in the account.
    "jack"
  ]);

  it("classifies every role any registered kind can buy", () => {
    const unclassified = ALL_SPAWN_ROLES.filter(r => !ACCOUNT_CLASS_OF_ROLE[r]);
    expect(unclassified, `roles with no account: ${unclassified.join(", ")}`).to.deep.equal([]);
  });

  it("maps no role that no kind declares (the ghost-key check)", () => {
    const ghosts = Object.keys(ACCOUNT_CLASS_OF_ROLE).filter(
      r => !ALL_SPAWN_ROLES.includes(r) && !BOUGHT_OUTSIDE_THE_REGISTRY.has(r)
    );
    expect(ghosts, `mapped roles no kind buys: ${ghosts.join(", ")}`).to.deep.equal([]);
  });

  /**
   * `jack` was the last role with no account, printing as a dangling
   * `UNCLASSIFIED [jack]` line - one of the three role-keying defects spec 51
   * names. The plan's vocabulary already had its home: `CATEGORY_OF_KIND`
   * classifies kind `bootstrap`, and `AccountCategory`'s own comment reads
   * "cold-start bodies, before the economy exists to classify them".
   *
   * BootstrapCorp used to argue the opposite - "no account class on purpose ...
   * which is honest for a pre-economy body" - but the honesty there is the
   * ABSENT BUDGET, not the absent name, and a named line keeps the first while
   * dropping the second. Pinned both ways: it is classified, and it stays inside
   * overhead where the unclassified bucket already carried it, so naming it
   * moved no total.
   */
  it("gives the cold-start body a NAME, not an UNCLASSIFIED bucket", () => {
    expect(ACCOUNT_CLASS_OF_ROLE.jack).to.equal("bootstrap");
    expect(categoryOfKind("bootstrap"), "the two tables agree on the line").to.equal(ACCOUNT_CLASS_OF_ROLE.jack);
  });

  it("shares ONE vocabulary with the plan side - every role class is a real AccountCategory", () => {
    // The two tables key differently (role here, kind there) but must name the
    // same lines. TypeScript pins this at compile time; this pins it against the
    // plan side's actual roster so a category retired there fails here.
    const planCategories = new Set(classifiedKinds().map(k => categoryOfKind(k) as string));
    const strays = [...new Set(Object.values(ACCOUNT_CLASS_OF_ROLE))].filter(c => !planCategories.has(c));
    expect(strays, `role classes no kind reports on: ${strays.join(", ")}`).to.deep.equal([]);
  });

  it("keeps expansion OUT of operating cost (capex, funded from the reserve)", () => {
    expect(ACCOUNT_CLASS_OF_ROLE.claimer).to.equal("expansion");
    expect(ACCOUNT_CLASS_OF_ROLE.buster).to.equal("incursion");
    expect(ACCOUNT_CLASS_OF_ROLE.striker).to.equal("incursion");
  });
});

/**
 * SPLITTING THE RESIDUAL (owner 2026-08-01: "I'd like to see pile decay,
 * tombstone and decay (structures) and repair show up in the report").
 *
 * The account balances by construction, so every line added to the loss side
 * comes straight OUT of the residual. That makes double-counting silent and
 * expensive: book structure decay as cash alongside the repair that services
 * it, and the residual shrinks by wear the colony never actually paid twice.
 * These pin the arithmetic, not the prose.
 */
describe("energy account: the residual's line items (core v20 loss meter)", () => {
  const withMeter = (losses: any): any => {
    const c = JSON.parse(JSON.stringify(cap72411542));
    c.data.core.losses = {
      windowTicks: 500,
      pileDecay: 0,
      structureDecay: 0,
      repairSpend: 0,
      tombstoneLost: 0,
      tombstoneRecovered: 0,
      tombstoneStock: 0,
      ...losses
    };
    return c;
  };
  const accountOf = (cap: any): string => {
    const rows = computeLedger(cap, cap72404213);
    return formatAccounts(cap, cap72404213, rows);
  };
  const lineValue = (text: string, label: string): number => {
    const line = text.split("\n").find(l => l.includes(label));
    if (!line) throw new Error(`no line matching "${label}" in:\n${text}`);
    const nums = (line.slice(line.indexOf(label) + label.length).match(/-?\d+\.\d\d/g) ?? []).map(Number);
    // Since methodology #9 a budgeted line reads BUDGET ACTUAL VARIANCE; the
    // ACTUAL is the middle column. Unbudgeted lines still carry one number.
    return nums.length >= 3 ? nums[1] : nums[0];
  };

  it("prints the three CASH loss lines and their total", () => {
    const text = accountOf(withMeter({ pileDecay: 3, tombstoneLost: 2, repairSpend: 1 }));
    expect(lineValue(text, "ground pile decay")).to.equal(-3);
    expect(lineValue(text, "tombstone losses")).to.equal(-2);
    expect(lineValue(text, "repair (energy spent")).to.equal(-1);
    expect(lineValue(text, "= measured losses")).to.equal(-6);
  });

  it("takes every metered loss OUT of the residual, one for one", () => {
    const bare = accountOf(withMeter({ pileDecay: 3 }));
    const more = accountOf(withMeter({ pileDecay: 3, tombstoneLost: 2, repairSpend: 1 }));
    const shrink = lineValue(bare, "RESIDUAL") - lineValue(more, "RESIDUAL");
    expect(shrink, "3 e/t of newly-attributed loss leaves the residual").to.be.closeTo(3, 0.011);
  });

  it("does NOT book structure decay as cash - that would double-count repair", () => {
    const none = accountOf(withMeter({ repairSpend: 1 }));
    const heavy = accountOf(withMeter({ repairSpend: 1, structureDecay: 9 }));
    expect(lineValue(heavy, "RESIDUAL")).to.be.closeTo(lineValue(none, "RESIDUAL"), 1e-9);
  });

  it("reports decay vs repair as a DEPRECIATION MEMO, and names a shortfall", () => {
    const short = accountOf(withMeter({ repairSpend: 1, structureDecay: 9 }));
    expect(short).to.include("DEPRECIATION MEMO");
    expect(short).to.include("SHORTFALL 8.00");
    const holding = accountOf(withMeter({ repairSpend: 9, structureDecay: 1 }));
    expect(holding).to.include("KEEPING UP");
  });

  it("books tombstone energy as LOST, witnessed recovery being only a memo", () => {
    // Owner 2026-08-01: with no reliable recovery, lost is the default. The
    // meter has already netted any witnessed withdrawal out of tombstoneLost,
    // so the account books that figure and reports recovery as context only.
    const t = accountOf(withMeter({ tombstoneLost: 2, tombstoneRecovered: 50 }));
    expect(lineValue(t, "tombstone losses")).to.equal(-2);
    expect(lineValue(t, "= measured losses")).to.equal(-2);
    expect(t).to.include("LOST BY DEFAULT");
  });

  it("degrades cleanly on a capture older than the meter", () => {
    // The 2026-07-18 fixture predates even v19's sourceDropped, so it must
    // print the fully-unsplit residual - never blank lines or NaN, and never
    // meter sections built on absent fields.
    const text = accountOf(JSON.parse(JSON.stringify(cap72411542)));
    expect(text).to.include("RESIDUAL (decay, rot, raids, error)");
    expect(text).to.not.include("DEPRECIATION MEMO");
    expect(text).to.not.include("= measured losses");
    expect(text).to.not.match(/NaN/);
  });
});

/**
 * METHODOLOGY #3 (audit cycle t72721419). Two defects the loss meter exposed
 * the moment it gave the account real costs to subtract: the residual came out
 * at -25.10 e/t, i.e. 25% of gross mining OVER-attributed, which is impossible
 * if every input is sound.
 */
describe("energy account: revenue is MINED, and windows must cohere (#3)", () => {
  const rig = (over: any = {}): any => {
    const c = JSON.parse(JSON.stringify(cap72411542));
    c.data.core.losses = {
      windowTicks: 5000,
      pileDecay: 0,
      structureDecay: 0,
      repairSpend: 0,
      tombstoneLost: 0,
      tombstoneRecovered: 0,
      tombstoneStock: 0,
      ...(over.losses ?? {})
    };
    if (over.heldFracs) {
      const harvest = c.data.corps.corps.filter((x: any) => x.kind === "harvest");
      harvest.forEach((h: any, i: number) => {
        h.sizing = { ...(h.sizing ?? {}), heldFrac: over.heldFracs[i] ?? 0 };
      });
    }
    return c;
  };
  const textOf = (cap: any): string => formatAccounts(cap, cap72404213, computeLedger(cap, cap72404213));

  /**
   * A miner whose buffer is full STOPS HARVESTING - `heldFrac` is stamped at
   * that decision site. Booking the unmined capacity as revenue inflates every
   * line below it. Live: 3.03 source-equivalents held, 30.28 e/t of a nominal
   * 100 never mined.
   */
  it("subtracts capacity the miners' own stamps say was never harvested", () => {
    const idle = textOf(rig({ heldFracs: [] }));
    expect(idle).to.include("mining capacity");

    const held = textOf(rig({ heldFracs: [1, 1] })); // two sources fully held
    expect(held).to.include("- forgone (miners held, buffer full)");
    // Gross mining must fall BELOW capacity by the forgone amount.
    // Columns are BUDGET then ACTUAL - take the second, or both lines read
    // back the same capacity figure and the assertion proves nothing.
    const actual = (label: string): number => {
      const line = held.split("\n").find(l => l.includes(label))!;
      return Number(line.match(/-?\d+\.\d\d/g)![1]);
    };
    expect(actual("= gross mining")).to.be.lessThan(actual("mining capacity"));
    expect(actual("mining capacity") - actual("= gross mining")).to.be.closeTo(20, 0.01);
  });

  it("omits the forgone line entirely when no stamp carries heldFrac", () => {
    // An older capture must not have a fabricated zero passed off as a reading.
    const old = JSON.parse(JSON.stringify(cap72411542));
    old.data.corps.corps.forEach((c: any) => {
      if (c.sizing) delete c.sizing.heldFrac;
    });
    expect(textOf(old)).to.not.include("forgone");
  });

  /**
   * The residual is a DIFFERENCE of rates. Revenue/bank/controller come from the
   * capture pair; measured costs from the blackbox ring; losses from the meter's
   * own window. A deploy restarts the last two but not the first, so an hour of
   * deploys makes their difference an artifact.
   */
  it("flags the residual as untrustworthy when the windows diverge", () => {
    const skewed = rig({ losses: { windowTicks: 100 } }); // vs a multi-thousand-tick capture window
    expect(textOf(skewed)).to.include("WINDOW INCOHERENCE");
  });

  it("stays quiet when the windows agree", () => {
    const coherent = rig({ losses: { windowTicks: 1e9 } }); // never the shortest
    expect(textOf(coherent)).to.not.include("WINDOW INCOHERENCE");
  });
});

/**
 * THE LINK TAX HAS A BUDGET (methodology #4, owner 2026-08-01: "we still have
 * the 'free' hauling from links in the plan as well?").
 *
 * Spec 42's first invariant: a line with an actual but no budget is a line the
 * plan cannot control. The planner now charges each link-served source one hop,
 * so the line can be compared instead of merely reported - and the comparison
 * is the point, because the network loses TWO hops (source->hub->controller)
 * while the plan bills one.
 */
describe("energy account: the link transfer tax is budgeted, not just measured", () => {
  const withLinks = (opts: { linkServed?: boolean; taxRate?: number }): any => {
    const c = JSON.parse(JSON.stringify(cap72411542));
    c.data.core.links = [{ room: "W1N1", windowTicks: 500, taxRate: opts.taxRate ?? 2.59 }];
    c.data.core.losses = {
      windowTicks: 1e9, // never the shortest - keeps the coherence guard quiet
      pileDecay: 0,
      structureDecay: 0,
      repairSpend: 0,
      tombstoneLost: 0,
      tombstoneRecovered: 0,
      tombstoneStock: 0
    };
    if (opts.linkServed !== undefined) {
      c.data.flow.sources.forEach((s: any, i: number) => {
        s.linkServed = opts.linkServed && i < 2; // two link-served sources
      });
    }
    return c;
  };
  const textOf = (cap: any): string => formatAccounts(cap, cap72404213, computeLedger(cap, cap72404213));

  it("budgets one hop per LINK-SERVED source, read from the flag not inferred", () => {
    const t = textOf(withLinks({ linkServed: true }));
    const line = t.split("\n").find(l => l.includes("link transfer"))!;
    const nums = line.match(/-?\d+\.\d\d/g)!;
    // two sources x 10 e/t x 3% = 0.60 budgeted, against 2.59 measured
    expect(Number(nums[0])).to.be.closeTo(-0.6, 0.01);
    expect(Number(nums[1])).to.be.closeTo(-2.59, 0.01);
  });

  /**
   * Owner 2026-08-02: "link tax is similar to haul body." Both are per-source
   * transport costs scaling with the flow they move - only the currency differs
   * (hauler body = spawn parts, link hop = delivered energy). So the tax sits in
   * DIRECT COST OF MINING beside evacuation, not in LOSSES: a link-served
   * source must never be able to show zero transport, which is exactly how
   * "free" link haulage went unnoticed.
   */
  it("books the tax as TRANSPORT (direct cost), not as a loss", () => {
    const t = textOf(withLinks({ linkServed: true }));
    const lines = t.split("\n");
    const idx = (needle: string): number => lines.findIndex(l => l.includes(needle));
    const linkIdx = idx("link transfer");
    expect(linkIdx).to.be.greaterThan(idx("DIRECT COST OF MINING"));
    expect(linkIdx).to.be.lessThan(idx("= NET MINING MARGIN"));
    // and it must be OUT of the loss block
    const lossIdx = idx("MEASURED LOSSES");
    if (lossIdx >= 0) expect(linkIdx).to.be.lessThan(lossIdx);
  });

  it("nets link transport out of NET MINING MARGIN", () => {
    const free = textOf(withLinks({ linkServed: true, taxRate: 0 }));
    const taxed = textOf(withLinks({ linkServed: true, taxRate: 4 }));
    const margin = (t: string): number =>
      Number(t.split("\n").find(l => l.includes("= NET MINING MARGIN"))!.match(/-?\d+\.\d\d/g)!.slice(-1)[0]);
    expect(margin(free) - margin(taxed)).to.be.closeTo(4, 0.01);
  });

  it("charges each LINK-SERVED source in the SOURCE P&L - never zero transport", () => {
    // Needs a capture with a spawn ring (the P&L's costs are measured); the
    // 2026-07-18 fixture predates the blackbox, so use the live one.
    const live = fixture("shard1-t72722670.json");
    const pnl = formatSourcePnL(live);
    expect(pnl, "the P&L renders for a capture with a ring").to.not.equal("");
    expect(pnl).to.include("link"); // the transport column exists
    // Every link-served source carries a non-zero transport charge.
    const linkIds = (live.data.flow.sources as any[]).filter(s => s.linkServed).map(s => String(s.id).slice(-4));
    for (const id of linkIds) {
      const row = pnl.split("\n").find(l => l.trimStart().startsWith(id))!;
      expect(row, `row for ${id}`).to.not.equal(undefined);
      expect(row, `${id} must not show free transport`).to.not.match(/\s-\s+\d+\.\d\d\s+10\.00/);
    }
  });

  it("leaves the budget BLANK on a capture predating the linkServed flag", () => {
    // Omit rather than fabricate a zero - a zero would read as "the plan says
    // link transport is free", which is the very claim being corrected.
    const t = textOf(withLinks({}));
    const line = t.split("\n").find(l => l.includes("link transfer"))!;
    expect(line.match(/-?\d+\.\d\d/g)!).to.have.length(1); // actual only
  });

  /**
   * Owner 2026-08-03: "there's more sources that deliver to the link, not
   * just the ones it was built for - account for that and the tax will be
   * more in line with actual." The old budget priced ONLY the link-served
   * sources' hop (0.60 at M05) while the meter read 3.08 - the missing legs
   * were the spec-26 DEPOSIT-PORT flows (~60 e/t of remote flow turning
   * around at link ports) and the hub->controller link leg in link-fed rooms
   * (~42 e/t relayed through the controller link). Every link-borne leg the
   * plan routes now budgets its hop, read off the plan's own publications.
   */
  it("budgets the DEPOSIT-PORT flows - remote legs that cross a link port (owner 2026-08-03)", () => {
    const c = withLinks({ linkServed: true });
    // Append port routes to the fixture's real haulers (replacing them would
    // starve planSpawnLoad's route scan of its expected fields).
    c.data.flow.haulers.push(
      { sourceId: "src-pa", sinkId: "sink-hub", carryParts: 4, flowRate: 40, distance: 10, spawnId: "s", port: { x: 10, y: 10, roomName: "W1N1" } },
      { sourceId: "src-pb", sinkId: "sink-hub", carryParts: 2, flowRate: 20, distance: 10, spawnId: "s", port: { x: 12, y: 10, roomName: "W1N1" } }
    );
    const line = textOf(c).split("\n").find(l => l.includes("link transfer"))!;
    const nums = line.match(/-?\d+\.\d\d/g)!;
    // 2 link-served x 10 x 3% + (40+20) port flow x 3% = 0.60 + 1.80 = 2.40
    expect(Number(nums[0])).to.be.closeTo(-2.4, 0.01);
  });

  it("budgets the hub->controller link leg in a link-fed room (the second hop)", () => {
    const c = withLinks({ linkServed: true });
    c.data.corps = { corps: [{ kind: "controllerFeeder", sizing: { linkFed: true, planFlow: 42 } }] };
    const line = textOf(c).split("\n").find(l => l.includes("link transfer"))!;
    const nums = line.match(/-?\d+\.\d\d/g)!;
    // 0.60 + 42 x 3% = 0.60 + 1.26 = 1.86
    expect(Number(nums[0])).to.be.closeTo(-1.86, 0.01);
  });

  it("a WALKING feeder room budgets no controller-link hop (linkFed absent)", () => {
    const c = withLinks({ linkServed: true });
    c.data.corps = { corps: [{ kind: "controllerFeeder", sizing: { planFlow: 42 } }] };
    const line = textOf(c).split("\n").find(l => l.includes("link transfer"))!;
    expect(Number(line.match(/-?\d+\.\d\d/g)![0])).to.be.closeTo(-0.6, 0.01);
  });
});

/**
 * A FISCAL MONTH MUST BE MEASURABLE (methodology #5, owner 2026-08-01: "can it
 * show the last 1500+ ticks of actual?").
 *
 * It could not: the loss meter's rates were since-reset, so the measured window
 * was bounded by VM lifetime - 480t against a 1251-tick capture window - and a
 * 1500-tick fiscal month never fit. Differencing CUMULATIVE totals makes the
 * measured window equal the capture window at any length.
 */
describe("energy account: loss lines span the FULL capture window (#5)", () => {
  const withCumulative = (capTotals: any, baseTotals: any): { cap: any; base: any } => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    const shell = { windowTicks: 5, pileDecay: 999, structureDecay: 0, repairSpend: 999, tombstoneLost: 999, tombstoneRecovered: 0, tombstoneStock: 0 };
    cap.data.core.losses = { ...shell, cumulative: capTotals };
    base.data.core.losses = { ...shell, cumulative: baseTotals };
    return { cap, base };
  };
  const zero = { pileDecay: 0, structureDecay: 0, repairSpend: 0, tombstoneGross: 0, tombstoneRecovered: 0 };

  it("differences the totals over the capture window, ignoring the since-reset rates", () => {
    const dt = cap72411542.data.core.tick - cap72404213.data.core.tick;
    const { cap, base } = withCumulative({ ...zero, pileDecay: 3 * dt, repairSpend: dt }, zero);
    const text = formatAccounts(cap, base, computeLedger(cap, base));
    // Budgeted lines (methodology #9) read BUDGET ACTUAL VARIANCE - the
    // ACTUAL is the middle of the three columns.
    const line = (label: string): number => {
      const nums = (text.split("\n").find(l => l.includes(label))!.match(/-?\d+\.\d\d/g) ?? []).map(Number);
      return nums.length >= 3 ? nums[1] : nums[0];
    };
    // 3 e/t and 1 e/t - NOT the 999 the since-reset shell carries.
    expect(line("ground pile decay")).to.be.closeTo(-3, 0.01);
    expect(line("repair (energy spent")).to.be.closeTo(-1, 0.01);
    expect(text).to.include("cumulative, full window");
  });

  it("nets tombstone recovery out of the cumulative loss", () => {
    const dt = cap72411542.data.core.tick - cap72404213.data.core.tick;
    const { cap, base } = withCumulative(
      { ...zero, tombstoneGross: 5 * dt, tombstoneRecovered: 2 * dt },
      zero
    );
    const text = formatAccounts(cap, base, computeLedger(cap, base));
    const nums = (text.split("\n").find(l => l.includes("tombstone losses"))!.match(/-?\d+\.\d\d/g) ?? []).map(Number);
    expect(nums.length >= 3 ? nums[1] : nums[0], "the ACTUAL column (methodology #9 added budget+variance)").to.be.closeTo(-3, 0.01);
  });

  it("stops blaming the LOSS lines for window incoherence once they span the window", () => {
    const { cap, base } = withCumulative(zero, zero);
    const text = formatAccounts(cap, base, computeLedger(cap, base));
    // The 5-tick since-reset shell would have tripped the guard at ~1400x.
    expect(text).to.not.include("WINDOW INCOHERENCE");
  });
});

/**
 * SPEC 42 STAGE A: every loss has a budget (methodology #9).
 *
 * The MEASURED LOSSES block gains a BUDGET column priced by primitives:
 * pile decay budgets ZERO (the gate's design point holds every mouth at the
 * container cap - pileDecayBudget(SOURCE_BUFFER_DEFER_THRESHOLD) == 0, so
 * every measured e/t is priced unfavorable variance pointing at the haul
 * deficit); tombstones budget the invader tax on the same capacity basis R1
 * prices (tombstoneLossBudget - one constant home, the two rows move
 * together at the >=10-window swap); repair budgets the structure-decay
 * ACCRUAL (service what decays - the depreciation memo's own shortfall
 * becomes priced variance). L1 summarizes adherence: FAIL when any line
 * breaches 25% of its budget (with a 0.25 e/t noise floor so a zero budget
 * doesn't FAIL on dust); absent without cumulative meters - never fabricated.
 */
describe("spec 42 stage A: every loss line has a BUDGET (methodology #9)", () => {
  const shell = { windowTicks: 5, pileDecay: 999, structureDecay: 999, repairSpend: 999, tombstoneLost: 999, tombstoneRecovered: 0, tombstoneStock: 0 };
  const rig = (capTotals: any, baseTotals: any): { cap: any; base: any } => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    cap.data.core.losses = { ...shell, cumulative: capTotals };
    base.data.core.losses = { ...shell, cumulative: baseTotals };
    return { cap, base };
  };
  const zero = { pileDecay: 0, structureDecay: 0, repairSpend: 0, tombstoneGross: 0, tombstoneRecovered: 0 };
  const dt = cap72411542.data.core.tick - cap72404213.data.core.tick;
  const grossCap = (cap72411542.data.flow?.sources ?? []).reduce((n: number, s: any) => n + (+s.harvestRate || 0), 0);

  it("the loss lines print BUDGETS, never '-' (pile 0 by design; tombstone the tax; repair the accrual)", async () => {
    const { tombstoneLossBudget } = (await import("../../../src/economy/primitives")) as any;
    const { cap, base } = rig(
      { ...zero, pileDecay: 3 * dt, structureDecay: 4 * dt, repairSpend: 3.5 * dt, tombstoneGross: 2 * dt },
      zero
    );
    const text = formatAccounts(cap, base, computeLedger(cap, base));
    const cols = (label: string): number[] =>
      (text.split("\n").find(l => l.includes(label))!.match(/-?\d+\.\d\d/g) ?? []).map(Number);
    // Three numeric columns each: BUDGET ACTUAL VARIANCE (no '-' budget).
    const pile = cols("ground pile decay");
    expect(pile.length, "pile line carries budget+actual+variance").to.be.at.least(3);
    expect(pile[0], "pile budget is ZERO - the gate's design point").to.be.closeTo(0, 0.005);
    const tomb = cols("tombstone losses");
    expect(tomb[0], "tombstone budget = the invader tax on R1's capacity basis").to.be.closeTo(
      -tombstoneLossBudget(grossCap),
      0.01
    );
    const rep = cols("repair (energy spent");
    expect(rep[0], "repair budget = the decay accrual").to.be.closeTo(-4, 0.01);
  });

  it("L1 FAILS when a loss line breaches 25% of its budget (pile decay above the zero budget)", () => {
    const { cap, base } = rig({ ...zero, pileDecay: 3 * dt }, zero);
    const l1 = computeLedger(cap, base).find(r => r.id === "L1")!;
    expect(l1, "the adherence row fields").to.not.equal(undefined);
    expect(l1.verdict).to.equal("FAIL");
    expect(l1.detail).to.include("pile");
  });

  it("L1 is ok when every line holds inside 25% (and dust under the noise floor never FAILs a zero budget)", async () => {
    const { tombstoneLossBudget } = (await import("../../../src/economy/primitives")) as any;
    const tombBudget = tombstoneLossBudget(grossCap);
    const { cap, base } = rig(
      { ...zero, pileDecay: 0.1 * dt, structureDecay: 4 * dt, repairSpend: 3.5 * dt, tombstoneGross: tombBudget * dt },
      zero
    );
    const l1 = computeLedger(cap, base).find(r => r.id === "L1")!;
    expect(l1).to.not.equal(undefined);
    expect(l1.verdict).to.equal("ok");
  });

  it("no cumulative meters -> no L1 row (absence, never a fake zero)", () => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    delete cap.data.core.losses;
    delete base.data.core.losses;
    expect(computeLedger(cap, base).find(r => r.id === "L1")).to.equal(undefined);
  });
});

/**
 * F3 output fidelity (spec 40 part A's contract OUTPUT term, at spec 39's
 * commission grain). F1/F2 audit the PRICE term (spawn parts); F3 audits what
 * each mining commission PRODUCED against the plan's own per-source rate -
 * the v14 cumulative `produced` counter differenced across the capture pair,
 * joined to flow sources by the P&L's corp-id construction
 * (mining-{room}-harvest-{last4 of source id}). Two-sided: an operation
 * out-producing its declaration distorts the plan exactly as much as one
 * under-delivering. A negative delta is a corp REBUILT mid-window (the
 * counter rides the store serialize) - skipped and counted, never booked as
 * output. No joinable rows -> no row.
 */
describe("F3 output fidelity (contract OUTPUT term per mining commission)", () => {
  const dtF3 = cap72411542.data.core.tick - cap72404213.data.core.tick;
  const rig = (rows: { suffix: string; rate: number; capProduced: number; baseProduced: number }[]): { cap: any; base: any } => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    cap.data.flow = cap.data.flow ?? {};
    cap.data.flow.sources = rows.map(r => ({ id: `source-aaaa${r.suffix}`, nodeId: "W9N9-25-25", harvestRate: r.rate }));
    const corpRow = (r: any, produced: number): any => ({
      id: `mining-W9N9-harvest-${r.suffix}`,
      kind: "harvest",
      creepCount: 1,
      bodyParts: 8,
      produced
    });
    cap.data.corps.corps = (cap.data.corps.corps ?? []).concat(rows.map(r => corpRow(r, r.capProduced)));
    base.data.corps.corps = (base.data.corps.corps ?? []).concat(rows.map(r => corpRow(r, r.baseProduced)));
    return { cap, base };
  };

  it("differences the produced counter per commission against the plan's own rate; names the offender", () => {
    const { cap, base } = rig([
      { suffix: "good", rate: 10, capProduced: 100 + 10 * dtF3, baseProduced: 100 },
      { suffix: "slow", rate: 10, capProduced: 5 * dtF3, baseProduced: 0 }
    ]);
    const f3 = computeLedger(cap, base).find(r => r.id === "F3")!;
    expect(f3, "joinable produced counters field the row").to.not.equal(undefined);
    // |10-10| + |5-10| = 5 over a declared basis of 20
    expect(f3.value).to.be.closeTo(0.25, 1e-3);
    expect(f3.verdict).to.equal("WARN");
    expect(f3.detail).to.include("harvest-slow");
    expect(f3.detail).to.include("-5.0");
  });

  it("a corp REBUILT mid-window (negative delta) is skipped and counted, never booked as output", () => {
    const { cap, base } = rig([
      { suffix: "good", rate: 10, capProduced: 100 + 10 * dtF3, baseProduced: 100 },
      { suffix: "rebt", rate: 10, capProduced: 50, baseProduced: 900 }
    ]);
    const f3 = computeLedger(cap, base).find(r => r.id === "F3")!;
    expect(f3.value, "only the faithful row is in the basis").to.be.closeTo(0, 1e-3);
    expect(f3.verdict).to.equal("ok");
    expect(f3.detail).to.include("1 reset");
  });

  it("no joinable rows -> no F3 (absence, never a fake zero)", () => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    for (const c of cap.data.corps.corps ?? []) delete c.produced;
    for (const c of base.data.corps.corps ?? []) delete c.produced;
    expect(computeLedger(cap, base).find(r => r.id === "F3")).to.equal(undefined);
  });
});

/**
 * BALANCE SHEET (spec 42 section 2b - the owner's target layout): the
 * account's STOCK side at close. Measured lines only; a line the captures
 * cannot measure prints as a NAMED gap ("not measured"), never a fabricated
 * number and never silently absent - the "--" rows of the target layout made
 * visible debt. NET WORTH is therefore labeled a measured FLOOR.
 */
describe("BALANCE SHEET (spec 42: energy stocks at close, measured floor)", () => {
  it("prints free/reserved/committed/standing from capture stocks, names the unmeasured lines", async () => {
    const { BODY_COSTS } = (await import("../../../src/economy/primitives")) as any;
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    // Known stocks: one room with 90k banked; a 12-part colony body census;
    // tombstones holding 500e; 1200e staged on the ground.
    cap.data.core.rooms = [{ name: "W1N1", storageEnergy: 90000, controllerStock: 0 }];
    cap.data.core.bodyParts = { total: 12, byPart: { work: 4, carry: 4, move: 4 } };
    cap.data.core.losses = {
      windowTicks: 5, pileDecay: 0, structureDecay: 0, repairSpend: 0,
      tombstoneLost: 0, tombstoneRecovered: 0, tombstoneStock: 500,
      cumulative: { pileDecay: 0, structureDecay: 0, repairSpend: 0, tombstoneGross: 0, tombstoneRecovered: 0 }
    };
    cap.data.core.sourceDropped = { s1: 700, s2: 500 };

    const text = formatAccounts(cap, base, computeLedger(cap, base));
    expect(text).to.include("BALANCE SHEET");
    const line = (label: string): string => text.split("\n").find(l => l.includes(label)) ?? "";
    // free = storage above the reserve; reserved = the target itself. Labels
    // matched on the sheet's own distinctive substrings ("reserved" alone
    // collides with the revenue line's "(reserved rate)").
    const reserved = Number((line("warchest/reserve target").match(/-?\d[\d,]*/g) ?? ["0"]).slice(-1)[0].replace(/,/g, ""));
    expect(reserved).to.be.greaterThan(0);
    const free = Number((line("storage above the reserve").match(/-?\d[\d,]*/g) ?? ["0"]).slice(-1)[0].replace(/,/g, ""));
    expect(free).to.be.closeTo(90000 - reserved, 1);
    // committed in-flight: tombstone stock + ground piles, creep cargo NAMED.
    expect(line("committed")).to.include("1,700");
    expect(line("committed"), "creep cargo is a NAMED gap, not silence").to.include("cargo not measured");
    // standing fleet at replacement cost: 4w+4c+4m at BODY_COSTS (keys are
    // UPPERCASE; the census byPart keys are the engine's lowercase names).
    const expectStanding = 4 * BODY_COSTS.WORK + 4 * BODY_COSTS.CARRY + 4 * BODY_COSTS.MOVE;
    expect(line("standing").replace(/,/g, "")).to.include(String(expectStanding));
    // fixed assets: named unmeasured, never fabricated.
    expect(line("fixed")).to.include("not measured");
    expect(text).to.include("NET WORTH (measured floor)");
  });
});

/**
 * SPAWN COSTS SPAN THE FULL CAPTURE WINDOW (methodology #7).
 *
 * After #5 made the loss lines cumulative, the blackbox ring was the account's
 * LAST short side: every "measured at the spawn" line sampled at most ~400
 * heap-ring rows, so a 1500-tick fiscal month read spawn costs from a 480-tick
 * post-deploy window and the guard printed WINDOW INCOHERENCE 3.1x - "the
 * residual below is NOT trustworthy" - on every close that followed a deploy.
 * The fix is the SAME shape as #5: the spawn director accrues every purchase
 * into cumulative energy-by-role totals (Memory.spawnLedger -> core.spawnSpend),
 * and the account differences two captures. The ring stays for forensics and
 * the per-corp SOURCE P&L; the ACCOUNT's window equals the capture window by
 * construction.
 */
describe("energy account: spawn costs span the FULL capture window (#7)", () => {
  const dt = cap72411542.data.core.tick - cap72404213.data.core.tick;
  /** Both captures carry cumulative loss totals so losses never blur the test. */
  const spannedLosses = {
    windowTicks: 5,
    pileDecay: 0,
    structureDecay: 0,
    repairSpend: 0,
    tombstoneLost: 0,
    tombstoneRecovered: 0,
    tombstoneStock: 0,
    cumulative: { pileDecay: 0, structureDecay: 0, repairSpend: 0, tombstoneGross: 0, tombstoneRecovered: 0 }
  };
  const rig = (
    capSpend: any,
    baseSpend: any,
    opts: { ring?: any[] } = {}
  ): { cap: any; base: any } => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    cap.data.core.losses = JSON.parse(JSON.stringify(spannedLosses));
    base.data.core.losses = JSON.parse(JSON.stringify(spannedLosses));
    if (capSpend) cap.data.core.spawnSpend = capSpend;
    if (baseSpend) base.data.core.spawnSpend = baseSpend;
    if (opts.ring) cap.data.blackbox = { rows: opts.ring };
    return { cap, base };
  };
  const textOf = (cap: any, base: any): string => formatAccounts(cap, base, computeLedger(cap, base));
  const actualOf = (text: string, label: string): number => {
    const line = text.split("\n").find(l => l.includes(label));
    if (!line) throw new Error(`no line matching "${label}" in:\n${text}`);
    return Number(line.match(/-?\d+\.\d\d/g)!.slice(-2)[0]);
  };

  it("differences the cumulative totals over the capture window, not the ring", () => {
    // The ring says miners cost a fortune over its 5 ticks; the cumulative
    // totals say 4.5 e/t over the full window. The account must read 4.5.
    const shortRing = [
      { t: 100, k: "spawn", d: { role: "miner", corp: "c1", cost: 9999 } },
      { t: 105, k: "spawn", d: { role: "miner", corp: "c1", cost: 9999 } }
    ];
    const { cap, base } = rig(
      { energyByRole: { miner: 10000 + 4.5 * dt, hauler: 500 }, partsByRole: { miner: 100, hauler: 10 } },
      { energyByRole: { miner: 10000, hauler: 500 }, partsByRole: { miner: 50, hauler: 10 } },
      { ring: shortRing }
    );
    const text = textOf(cap, base);
    expect(actualOf(text, "extraction  (miner)")).to.be.closeTo(-4.5, 0.01);
    // The hauler role bought nothing inside the window - zero, not the ring's view.
    expect(actualOf(text, "evacuation  (hauler)")).to.be.closeTo(0, 0.01);
    expect(text).to.match(/spawn \d+t cumulative/);
  });

  it("stops flagging WINDOW INCOHERENCE once every side spans the capture window", () => {
    // A 5-tick ring against a multi-thousand-tick window: the guard fired at
    // >1000x before, and it was RIGHT to - the ring was the account's source.
    // With cumulative totals on both captures the ring is no longer load-
    // bearing, so the residual is trustworthy and the guard must say nothing.
    const shortRing = [
      { t: 100, k: "spawn", d: { role: "miner", corp: "c1", cost: 9999 } },
      { t: 105, k: "spawn", d: { role: "miner", corp: "c1", cost: 9999 } }
    ];
    const { cap, base } = rig(
      { energyByRole: { miner: 1000 }, partsByRole: { miner: 10 } },
      { energyByRole: {}, partsByRole: {} },
      { ring: shortRing }
    );
    expect(textOf(cap, base)).to.not.include("WINDOW INCOHERENCE");
  });

  it("still fires the guard - and reads the ring - when the BASELINE predates the ledger", () => {
    // A capture pair can only be differenced when BOTH sides carry the totals.
    // With an old baseline the account falls back to the ring, and the guard
    // must keep calling the mismatch out rather than trusting a hybrid.
    const shortRing = [
      { t: 100, k: "spawn", d: { role: "miner", corp: "c1", cost: 500 } },
      { t: 105, k: "spawn", d: { role: "miner", corp: "c1", cost: 500 } }
    ];
    const { cap, base } = rig({ energyByRole: { miner: 1000 }, partsByRole: { miner: 10 } }, null, {
      ring: shortRing
    });
    const text = textOf(cap, base);
    expect(text).to.include("WINDOW INCOHERENCE");
    expect(text).to.match(/spawn ring \d+t/);
    // Ring arithmetic: 1000e over 5t = 200 e/t - the short-window figure, stated as such.
    expect(actualOf(text, "extraction  (miner)")).to.be.closeTo(-200, 0.01);
  });

  it("prints a role with no account as UNCLASSIFIED, from the cumulative path too", () => {
    const { cap, base } = rig(
      { energyByRole: { weirdo: 2 * dt }, partsByRole: { weirdo: 10 } },
      { energyByRole: {}, partsByRole: {} }
    );
    const text = textOf(cap, base);
    expect(text).to.include("UNCLASSIFIED [weirdo]");
    expect(actualOf(text, "UNCLASSIFIED")).to.be.closeTo(-2, 0.01);
  });
});

/**
 * THE TOMBSTONE CAUSE SPLIT IS EVIDENCE, NOT A MISREAD FIELD (methodology #7).
 *
 * v23 derived killed-vs-expired from `tombstone.creep.ticksToLive` - a field
 * that is 0/undefined on every dead creep, so the split read "expired 100%"
 * forever and the v24 audit line printed SUSPECT (ttl mean 0 max 0) on every
 * close. The meter now derives cause from its own death watch (last-seen TTL
 * vs deathTime); a tombstone with no watch entry lands in an honest UNKNOWN
 * bucket instead of defaulting into "expired". The account prints all three
 * shares - and the SUSPECT heuristic goes away, because expired-only windows
 * with ttl 0 are now a legitimate reading (old age IS ttl 0), not a defect
 * signature.
 */
describe("energy account: tombstone cause is expired/killed/UNKNOWN (#7)", () => {
  const withMeter = (losses: any): any => {
    const c = JSON.parse(JSON.stringify(cap72411542));
    c.data.core.losses = {
      windowTicks: 1e9,
      pileDecay: 0,
      structureDecay: 0,
      repairSpend: 0,
      tombstoneLost: 0,
      tombstoneRecovered: 0,
      tombstoneStock: 0,
      ...losses
    };
    return c;
  };
  const textOf = (cap: any): string => formatAccounts(cap, cap72404213, computeLedger(cap, cap72404213));

  it("prints the unknown share beside expired and killed", () => {
    const text = textOf(
      withMeter({
        tombstoneLost: 5,
        tombstoneByRole: { haul: 500 },
        tombstoneExpired: 300,
        tombstoneKilled: 100,
        tombstoneCauseUnknown: 100
      })
    );
    const line = text.split("\n").find(l => l.includes("by cause:"))!;
    expect(line).to.include("expired 60%");
    expect(line).to.include("killed 20%");
    expect(line).to.include("unknown 20%");
  });

  it("does NOT cry SUSPECT on a legitimate expired-only window (ttl 0 IS old age)", () => {
    const text = textOf(
      withMeter({
        tombstoneLost: 5,
        tombstoneByRole: { haul: 400 },
        tombstoneExpired: 400,
        tombstoneKilled: 0,
        tombstoneCauseUnknown: 0,
        tombstoneTtlMean: 0,
        tombstoneTtlMax: 0
      })
    );
    expect(text).to.not.include("SUSPECT");
  });

  it("says so when the cause is entirely unknown, rather than fabricating a split", () => {
    const text = textOf(
      withMeter({
        tombstoneLost: 5,
        tombstoneByRole: { haul: 400 },
        tombstoneExpired: 0,
        tombstoneKilled: 0,
        tombstoneCauseUnknown: 400
      })
    );
    const line = text.split("\n").find(l => l.includes("by cause:"))!;
    expect(line).to.include("unknown 100%");
  });

  it("VOIDS the cause split of a pre-#7 capture instead of printing the misread field", () => {
    // Live archaeology: the v23 deploy booked 39,806e killed / 0 expired; the
    // v24 one read ttl mean 0 max 0 - the same field, opposite constants. A
    // capture without the v25 unknown bucket carries those voided readings,
    // and the account must present its cause as UNKNOWN rather than confident.
    const text = textOf(
      withMeter({
        tombstoneLost: 5,
        tombstoneByRole: { haul: 400 },
        tombstoneExpired: 0,
        tombstoneKilled: 400 // the misread-field constant
      })
    );
    const line = text.split("\n").find(l => l.includes("by cause:"))!;
    expect(line).to.include("unknown 100%");
    expect(line).to.not.include("killed 100%");
  });
});

/**
 * METHODOLOGY #8 - the account's budgets price what the colony actually runs.
 *
 * Two second-implementation drifts inflated the variance surface (evidence,
 * t72725767->t72734018 pair): the reserver budget priced continuous duty 1.0
 * where primitives and the shipped gate use RESERVER_DUTY 0.5 (the whole
 * +8.02 "favorable" variance was this lie - measured 8.83 = 0.524x budget),
 * and the evacuation budget priced every route at the 1:1 body (100e/CARRY)
 * while the planner's parts side prices paved routes at 1.5p/CARRY (-2.82 e/t
 * of slack that MASKED real breach). Every CARRY/MOVE part costs exactly 50e,
 * so the parts plan converts to energy exactly: bEvac = sum spawnParts x 50.
 */
describe("energy account: budgets price the shipped behavior (#8)", () => {
  const quietLosses = {
    windowTicks: 1e9, pileDecay: 0, structureDecay: 0, repairSpend: 0,
    tombstoneLost: 0, tombstoneRecovered: 0, tombstoneStock: 0
  };

  it("prices the account's reserver budget at the SHIPPED duty cycle", () => {
    const c = JSON.parse(JSON.stringify(cap72411542));
    c.data.corps.corps = c.data.corps.corps.filter((x: any) => x.kind !== "reservation");
    c.data.corps.corps.push({
      id: "reservation-W2N2-reservation",
      kind: "reservation",
      creepCount: 1,
      bodyParts: 4,
      body: { claim: 2, move: 2 },
      sizing: { targets: 1 }
    });
    const { lines } = planSpawnLoad(c);
    const res = lines.find(([n]) => n.startsWith("reservers"))!;
    expect(res, "the reserver line exists").to.not.equal(undefined);
    expect(res[2], "4 parts priced at duty 0.5 over the walk-adjusted claim life").to.be.closeTo(
      reserverSpawnLoad(4),
      1e-9
    );
  });

  it("budgets evacuation on the plan's OWN parts basis when routes carry spawnParts", () => {
    const c = JSON.parse(JSON.stringify(cap72411542));
    c.data.core.losses = { ...quietLosses };
    c.data.flow.haulers = [
      { sourceId: "s1", carryParts: 10, distance: 20, spawnParts: (1.5 * 10) / 1480 }, // paved 2:1
      { sourceId: "s2", carryParts: 10, distance: 20, spawnParts: (2 * 10) / 1480 } // unpaved 1:1
    ];
    const text = formatAccounts(c, cap72404213, computeLedger(c, cap72404213));
    const line = text.split("\n").find(l => l.includes("evacuation  (hauler)"))!;
    const budget = Number(line.match(/-?\d+\.\d\d/g)![0]);
    const expected = -(((1.5 * 10) / 1480 + (2 * 10) / 1480) * 50);
    expect(budget).to.be.closeTo(expected, 0.005);
  });

  it("keeps the 1:1 energy fallback for captures whose routes predate spawnParts", () => {
    const c = JSON.parse(JSON.stringify(cap72411542));
    c.data.core.losses = { ...quietLosses };
    c.data.flow.haulers = [{ sourceId: "s1", carryParts: 10, distance: 20 }];
    const text = formatAccounts(c, cap72404213, computeLedger(c, cap72404213));
    const line = text.split("\n").find(l => l.includes("evacuation  (hauler)"))!;
    const budget = Number(line.match(/-?\d+\.\d\d/g)![0]);
    expect(budget).to.be.closeTo(-haulerOverhead(10, 20), 0.005);
  });
});

/**
 * FORGONE MINING RE-BOOKED FROM MEASUREMENT (phase 2; the two missing spec-42
 * contras land free).
 *
 * The heldFrac forgone line was an INFERENCE from a spawn de-pricing stamp -
 * and HarvestCorp harvests unconditionally, so it both over-counted (harvest
 * continued while "held") and missed unstaffed/unreserved capacity entirely.
 * With corps segment v14 publishing each harvest corp's cumulative `produced`
 * (reset-surviving), the account differences two captures and books
 * capacity - measured mined: every forgone mechanism in one measured number,
 * heldFrac demoted to the diagnostic naming the pile-gate's share.
 */
describe("energy account: forgone mining is MEASURED once produced spans both captures", () => {
  const rig = (capProduced: number[] | null, baseProduced: number[] | null): { cap: any; base: any } => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    for (const [c, produced] of [
      [cap, capProduced],
      [base, baseProduced]
    ] as [any, number[] | null][]) {
      c.data.core.losses = {
        windowTicks: 1e9, pileDecay: 0, structureDecay: 0, repairSpend: 0,
        tombstoneLost: 0, tombstoneRecovered: 0, tombstoneStock: 0
      };
      const harvest = c.data.corps.corps.filter((x: any) => x.kind === "harvest");
      harvest.forEach((h: any, i: number) => {
        if (produced && produced[i] !== undefined) h.produced = produced[i];
        else delete h.produced;
      });
    }
    return { cap, base };
  };
  const textOf = (cap: any, base: any): string => formatAccounts(cap, base, computeLedger(cap, base));
  const actualOf = (text: string, label: string): number => {
    const line = text.split("\n").find(l => l.includes(label));
    if (!line) throw new Error(`no line matching "${label}" in:\n${text}`);
    return Number(line.match(/-?\d+\.\d\d/g)!.slice(-2)[0]);
  };

  it("books gross mining as the measured mined rate, not an inference", () => {
    const dt = cap72411542.data.core.tick - cap72404213.data.core.tick;
    // Two harvest corps mining 6 e/t and 8 e/t of their 10 e/t capacities.
    const { cap, base } = rig([100000 + 6 * dt, 50000 + 8 * dt], [100000, 50000]);
    const text = textOf(cap, base);
    expect(text).to.include("forgone (measured: capacity - mined)");
    expect(actualOf(text, "= gross mining (measured mined)")).to.be.closeTo(14, 0.05);
  });

  it("keeps the heldFrac stamp as a DIAGNOSTIC decoration, not the booking", () => {
    const dt = cap72411542.data.core.tick - cap72404213.data.core.tick;
    const { cap, base } = rig([100000 + 6 * dt, 50000 + 8 * dt], [100000, 50000]);
    cap.data.corps.corps
      .filter((x: any) => x.kind === "harvest")
      .forEach((h: any) => (h.sizing = { ...(h.sizing ?? {}), heldFrac: 0.5 }));
    const text = textOf(cap, base);
    expect(text).to.include("pile-gate stamps explain");
    // The BOOKED forgone is capacity - measured mined (corps without a
    // counter measured nothing - a fresh corp's omitted 0 is a real 0), never
    // heldFrac's inference.
    const capacity = (cap.data.flow.sources as any[]).reduce((n, s) => n + (+s.harvestRate || 0), 0);
    expect(actualOf(text, "forgone (measured")).to.be.closeTo(-(capacity - 14), 0.05);
  });

  it("falls back to the heldFrac inference when the BASELINE predates produced", () => {
    const dt = cap72411542.data.core.tick - cap72404213.data.core.tick;
    const { cap, base } = rig([100000 + 6 * dt, 50000 + 8 * dt], null);
    cap.data.corps.corps
      .filter((x: any) => x.kind === "harvest")
      .forEach((h: any) => (h.sizing = { ...(h.sizing ?? {}), heldFrac: 0.5 }));
    const text = textOf(cap, base);
    expect(text).to.include("miners held, buffer full");
    expect(text).to.not.include("measured: capacity - mined");
  });

  it("counts a corp commissioned mid-window from zero (its counter began at birth)", () => {
    const dt = cap72411542.data.core.tick - cap72404213.data.core.tick;
    // Corp 0 spans both captures; corp 1 exists only in cap (newly born).
    const { cap, base } = rig([100000 + 6 * dt, 4 * dt], [100000]);
    // base's second harvest corp vanishes entirely (not just its counter).
    const harvest = base.data.corps.corps.filter((x: any) => x.kind === "harvest");
    base.data.corps.corps = base.data.corps.corps.filter((x: any) => x !== harvest[1]);
    const text = textOf(cap, base);
    expect(actualOf(text, "= gross mining (measured mined)")).to.be.closeTo(10, 0.05);
  });
});

/**
 * S5 - the spawn-throughput headroom gauge (phase 3's systemic-risk row).
 *
 * The replacement treadmill ran the spawns at 90% of the physical build rate
 * while the PLAN needed 0.51x - the missing margin is what absorbs a raid
 * wave, and no row watched it: the cascade (buffers back up -> miners held ->
 * income falls while replacement demand peaks) would have been diagnosed
 * after the fact. S5 books the saturation with verdicts.
 */
describe("S5 spawn-throughput headroom", () => {
  const withSpawns = (partsPerTick: number[]): any => {
    const c = JSON.parse(JSON.stringify(cap72411542));
    // Extend the fixture's real spawn shape (S3 upstream reads utilization
    // etc.) rather than replacing it with a minimal object.
    const template = (c.data.core.spawns ?? [])[0] ?? { utilization: 0.5, windowTicks: 1000 };
    c.data.core.spawns = partsPerTick.map((p, i) => ({ ...template, id: `s${i}`, partsPerTick: p }));
    return c;
  };

  it("books measured saturation against the physical ceiling", () => {
    const rows = computeLedger(withSpawns([0.3, 0.3]), cap72404213);
    const s5 = rows.find(r => r.id === "S5")!;
    expect(s5, "the row exists once the meter reports").to.not.equal(undefined);
    expect(s5.value).to.be.closeTo(0.9, 0.005); // 0.6 of 0.667
    expect(s5.verdict).to.equal("WARN");
  });

  it("FAILS when the margin is effectively gone", () => {
    const rows = computeLedger(withSpawns([0.32, 0.32]), cap72404213);
    expect(rows.find(r => r.id === "S5")!.verdict).to.equal("FAIL");
  });

  it("stays ok with real headroom, and skips silently on pre-meter captures", () => {
    const rows = computeLedger(withSpawns([0.2, 0.2]), cap72404213);
    expect(rows.find(r => r.id === "S5")!.verdict).to.equal("ok");
    const old = JSON.parse(JSON.stringify(cap72411542));
    (old.data.core.spawns ?? []).forEach((s: any) => delete s.partsPerTick);
    expect(computeLedger(old, cap72404213).find(r => r.id === "S5")).to.equal(undefined);
  });
});

/**
 * R1 - the raid-tax calibration gauge (phase 3).
 *
 * EXPECTED_RAID_DEFENSE_COST prices one guard body (750e) per expected raid;
 * its own doc calls it a derived starting point awaiting measured replacement
 * at >= 10 fiscal windows. R1 accumulates that evidence at every close:
 * measured attrition (killed-cargo cumulative + remote churn bodies) against
 * the priced tax - so the constant swap, when it comes, is a calibration
 * backed by closes rather than an argument from structure.
 */
describe("R1 raid-tax calibration gauge", () => {
  const rig = (killedCap: number, killedBase: number): { cap: any; base: any } => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    const shell = {
      windowTicks: 5, pileDecay: 0, structureDecay: 0, repairSpend: 0,
      tombstoneLost: 0, tombstoneRecovered: 0, tombstoneStock: 0
    };
    cap.data.core.losses = { ...shell, cumulative: { pileDecay: 0, structureDecay: 0, repairSpend: 0, tombstoneGross: 0, tombstoneRecovered: 0, tombstoneKilled: killedCap } };
    base.data.core.losses = { ...shell, cumulative: { pileDecay: 0, structureDecay: 0, repairSpend: 0, tombstoneGross: 0, tombstoneRecovered: 0, tombstoneKilled: killedBase } };
    return { cap, base };
  };

  it("compares measured killed-cargo against the priced tax over the capture window", () => {
    const dt = cap72411542.data.core.tick - cap72404213.data.core.tick;
    const { cap, base } = rig(10 * dt, 0); // 10 e/t of killed cargo
    const r1 = computeLedger(cap, base).find(r => r.id === "R1")!;
    expect(r1, "the gauge exists once the death watch spans both captures").to.not.equal(undefined);
    expect(r1.detail).to.include("killed cargo 10.00");
    expect(r1.verdict, "an order-of-magnitude gap is a WARN, never a FAIL (known-provisional constant)").to.equal("WARN");
  });

  it("stays quiet on captures whose baseline predates the death watch", () => {
    const { cap, base } = rig(1000, 0);
    delete base.data.core.losses.cumulative.tombstoneKilled;
    expect(computeLedger(cap, base).find(r => r.id === "R1")).to.equal(undefined);
  });
});

/**
 * H1's duty basis includes the INNER haul engines (phase 3 of the
 * income-statement program). The corps segment publishes innerSizing
 * (v13, spec 34 D5) precisely because the biggest hauling spend rides
 * INSIDE harvest operations - but H1 kept reading only top-level carry
 * corps, so its duty basis was the 0-3 standalone survivors while 8+
 * operation engines went uncounted (measured t72743103: 8 corps with
 * inner hauling stamps, 0 top-level carry corps, H1 silently absent).
 */
describe("H1 hauler duty reads the inner haul engines (the spec-34 blindness fix)", () => {
  const rig = (): { cap: any; base: any } => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    // No top-level carry corps in the capture at all - the live t72743103 shape.
    cap.data.corps.corps = (cap.data.corps.corps ?? []).filter((c: any) => c.kind !== "carry");
    cap.data.corps.corps.push(
      {
        id: "mining-W1N1-harvest-aaaa", kind: "harvest", creepCount: 3, bodyParts: 20,
        innerSizing: [{ type: "hauling", nodeId: "W1N1-harvest-aaaa",
          sizing: { duty: 0.9, idleSourceFrac: 0, idleSinkFrac: 0.1, idleSinkAtSinkFrac: 0, idleSinkStorageRoomFrac: 0, creeps: 2, carryNeeded: 8, staged: 500 } }]
      },
      {
        id: "mining-W1N1-harvest-bbbb", kind: "harvest", creepCount: 3, bodyParts: 20,
        innerSizing: [{ type: "hauling", nodeId: "W1N1-harvest-bbbb",
          sizing: { duty: 0.5, idleSourceFrac: 0.4, idleSinkFrac: 0, idleSinkAtSinkFrac: 0, idleSinkStorageRoomFrac: 0, creeps: 2, carryNeeded: 8, staged: 500 } }]
      }
    );
    return { cap, base };
  };

  it("fields the row from inner stamps alone, creep-weighted (duty 0.9 x2 + 0.5 x2 -> 0.7)", () => {
    const { cap, base } = rig();
    const h1 = computeLedger(cap, base).find(r => r.id === "H1")!;
    expect(h1, "inner haul engines ARE the fleet - the row must exist without top-level carry corps").to.not.equal(
      undefined
    );
    expect(h1.value).to.be.closeTo(0.7, 1e-6);
    expect(h1.detail).to.include("4 creeps");
  });
});

/**
 * H3 chronic mouth - the t72654979 cd8e signature as a STANDING gauge.
 * cd8e's buffer grew 2649 -> 3874 across a whole window while its drain
 * route stamped creeps 0 - chronic for 512t, found only by hand in the E6
 * audit. The gauge reads the same haul stamps H1 reads (staged + creeps,
 * both captures, matched per corp): a mouth over the container cap at BOTH
 * ends with NO drain creep fielded at the capture end is the leak; growing
 * is the disease (FAIL), flat is a warning. Routes with a fielded drain,
 * or captures predating the stamps, stay silent.
 */
describe("H3 chronic mouth (buffer full, zero drain demand - t72654979)", () => {
  const inner = (staged: number, creeps: number): any => ({
    innerSizing: [{ type: "hauling", nodeId: "W1N1-harvest-cccc",
      sizing: { duty: 0, idleSourceFrac: 0, idleSinkFrac: 0, creeps, carryNeeded: creeps > 0 ? 4 : 1, staged } }]
  });
  const rig = (capStaged: number, baseStaged: number, capCreeps: number): { cap: any; base: any } => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    cap.data.corps.corps = (cap.data.corps.corps ?? []).filter((c: any) => c.kind !== "carry");
    base.data.corps.corps = (base.data.corps.corps ?? []).filter((c: any) => c.kind !== "carry");
    cap.data.corps.corps.push({ id: "mining-W1N1-harvest-cccc", kind: "harvest", creepCount: 1, ...inner(capStaged, capCreeps) });
    base.data.corps.corps.push({ id: "mining-W1N1-harvest-cccc", kind: "harvest", creepCount: 1, ...inner(baseStaged, 0) });
    return { cap, base };
  };

  it("a growing over-cap mouth with zero drain creeps is the cd8e FAIL", () => {
    const { cap, base } = rig(3874, 2649, 0);
    const h3 = computeLedger(cap, base).find(r => r.id === "H3")!;
    expect(h3).to.not.equal(undefined);
    expect(h3.verdict).to.equal("FAIL");
    expect(h3.detail).to.include("cccc");
    expect(h3.detail).to.include("3874");
  });

  it("a flat over-cap mouth with zero drain is a WARN, not a FAIL", () => {
    const { cap, base } = rig(2650, 2649, 0);
    const h3 = computeLedger(cap, base).find(r => r.id === "H3")!;
    expect(h3.verdict).to.equal("WARN");
  });

  it("a fielded drain creep silences the gauge (the route is working the pile)", () => {
    const { cap, base } = rig(3874, 2649, 1);
    expect(computeLedger(cap, base).find(r => r.id === "H3")).to.equal(undefined);
  });

  it("mouths under the cap stay silent - piles below container size are normal staging", () => {
    const { cap, base } = rig(1500, 1400, 0);
    expect(computeLedger(cap, base).find(r => r.id === "H3")).to.equal(undefined);
  });
});

/**
 * F2 per-commission fleet fidelity (spec 39 phase 1). F1 answers "does the
 * colony build what the plan prices" at CLASS grain; F2 joins the commission's
 * own declared fleet (segment 4 v15 `fleet`, the plan side) against the same
 * row's measured bodyParts (the actual side) - the leak lands with a
 * commission id attached instead of a class name. Two-sided like F1: a
 * commission fielding parts its declaration lacks is exactly as
 * uncontrollable as one declared but never staffed. Rows without a
 * declaration (aux kinds until spec 39 phase 4, pre-v15 captures) are
 * excluded from the basis; NO declaring rows at all -> no gauge, never a
 * fake zero.
 */
describe("F2 per-commission fleet fidelity (spec 39 phase 1: declared fleet vs fielded body)", () => {
  const fleetRow = (id: string, planned: Record<string, number>, bodyParts: number, creepCount = 1): any => {
    const fleet: Record<string, { parts: number; load: number }> = {};
    for (const role of Object.keys(planned)) fleet[role] = { parts: planned[role], load: planned[role] / 1500 };
    return { id, kind: "harvest", creepCount, bodyParts, fleet };
  };
  const rig = (rows: any[]): { cap: any; base: any } => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    cap.data.corps.corps = (cap.data.corps.corps ?? []).concat(rows);
    return { cap, base };
  };

  it("captures with NO declaring commissions carry no row (pre-v15: absent, never zero)", () => {
    const { cap, base } = rig([]);
    expect(computeLedger(cap, base).find(r => r.id === "F2")).to.equal(undefined);
  });

  it("names the offender BY COMMISSION ID with its two-sided gap", () => {
    const { cap, base } = rig([
      fleetRow("mining-W1N1-harvest-good", { miner: 8, hauler: 12 }, 20),
      fleetRow("mining-W1N1-harvest-fat", { hauler: 10 }, 25)
    ]);
    const f2 = computeLedger(cap, base).find(r => r.id === "F2")!;
    expect(f2, "declaring rows exist -> the gauge fields").to.not.equal(undefined);
    // |20-20| + |25-10| = 15 over a planned basis of 30
    expect(f2.value).to.be.closeTo(0.5, 1e-6);
    expect(f2.verdict).to.equal("WARN");
    expect(f2.detail).to.include("harvest-fat");
    expect(f2.detail).to.include("+15");
  });

  it("a faithful fleet is ok", () => {
    const { cap, base } = rig([fleetRow("mining-W1N1-harvest-good", { miner: 8, hauler: 12 }, 20)]);
    const f2 = computeLedger(cap, base).find(r => r.id === "F2")!;
    expect(f2.value).to.be.closeTo(0, 1e-6);
    expect(f2.verdict).to.equal("ok");
  });

  it("a declared-but-unstaffed fleet counts the whole miss (two-sided)", () => {
    const { cap, base } = rig([
      fleetRow("mining-W1N1-harvest-good", { miner: 8, hauler: 12 }, 20),
      fleetRow("mining-W9N9-harvest-dark", { miner: 8 }, 0, 0)
    ]);
    const f2 = computeLedger(cap, base).find(r => r.id === "F2")!;
    // |20-20| + |0-8| = 8 over 28 (the row value is display-rounded to 3dp)
    expect(f2.value).to.be.closeTo(8 / 28, 5e-4);
    expect(f2.detail).to.include("harvest-dark");
    expect(f2.detail).to.include("-8");
  });

  it("misallocation exceeding the whole planned basis is a FAIL", () => {
    const { cap, base } = rig([fleetRow("mining-W1N1-harvest-wild", { hauler: 10 }, 25)]);
    const f2 = computeLedger(cap, base).find(r => r.id === "F2")!;
    expect(f2.value).to.be.closeTo(1.5, 1e-6);
    expect(f2.verdict).to.equal("FAIL");
  });
});

/**
 * METHODOLOGY #10 - RECOVERY MADE VISIBLE (owner 2026-08-04: "you may have
 * added something for scavenging tombstones or piles but it's not showing as
 * a line item. What if the cure is worse than the illness").
 *
 * Before #10 the cure was invisible on BOTH sides of the books: recovered
 * tombstone energy existed only as a silent netting credit inside the
 * tombstone loss line (booked gross-when-seen, credited-when-witnessed), and
 * the recovery fleet's bodies hid inside "evacuation (hauler)". #10 publishes
 * both: the tombstone line grows a gross/recovered detail, evacuation grows
 * an "of which recovery fleet" sub-line (cumulative scavenge sub-counter),
 * and a RECOVERY P&L memo answers cure-vs-illness as a subtraction every
 * close. No new revenue line - recovered energy was already counted as mined
 * once; grossing the EXISTING credit is what avoids the double-count.
 */
describe("methodology #10: the recovery P&L (cure vs illness, published)", () => {
  const shell = { windowTicks: 5, pileDecay: 0, structureDecay: 0, repairSpend: 0, tombstoneLost: 0, tombstoneRecovered: 0, tombstoneStock: 0 };
  const zero = { pileDecay: 0, structureDecay: 0, repairSpend: 0, tombstoneGross: 0, tombstoneRecovered: 0 };
  const dtOf = (): number => cap72411542.data.core.tick - cap72404213.data.core.tick;
  const rig = (capTotals: any, opts: { scavengeEnergy?: number; haulerEnergy?: number } = {}): { cap: any; base: any } => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    cap.data.core.losses = { ...shell, cumulative: capTotals };
    base.data.core.losses = { ...shell, cumulative: zero };
    if (opts.scavengeEnergy !== undefined || opts.haulerEnergy !== undefined) {
      cap.data.core.spawnSpend = {
        energyByRole: { hauler: opts.haulerEnergy ?? 0 },
        partsByRole: {},
        scavengeEnergy: opts.scavengeEnergy ?? 0,
        scavengeParts: 0
      };
      base.data.core.spawnSpend = { energyByRole: {}, partsByRole: {}, scavengeEnergy: 0, scavengeParts: 0 };
    }
    return { cap, base };
  };

  it("the tombstone line publishes its GROSS and the witnessed-recovered credit as a detail", () => {
    const dt = dtOf();
    const { cap, base } = rig({ ...zero, tombstoneGross: 5 * dt, tombstoneRecovered: 2 * dt });
    const text = formatAccounts(cap, base, computeLedger(cap, base));
    const detail = text.split("\n").find(l => /gross entombed/.test(l));
    expect(detail, "the gross/recovered detail line exists").to.not.equal(undefined);
    expect(detail).to.include("5.00");
    expect(detail).to.include("2.00");
  });

  it("evacuation splits out the recovery fleet from the cumulative scavenge sub-counter", () => {
    const dt = dtOf();
    const { cap, base } = rig(zero, { haulerEnergy: 10 * dt, scavengeEnergy: 1.5 * dt });
    const text = formatAccounts(cap, base, computeLedger(cap, base));
    const sub = text.split("\n").find(l => /of which recovery fleet/.test(l));
    expect(sub, "the evacuation sub-line exists").to.not.equal(undefined);
    expect(sub).to.include("1.50");
  });

  it("the RECOVERY P&L memo answers cure-vs-illness as a subtraction", () => {
    const dt = dtOf();
    const { cap, base } = rig(
      { ...zero, tombstoneGross: 5 * dt, tombstoneRecovered: 2 * dt, pileDecay: 13 * dt },
      { haulerEnergy: 10 * dt, scavengeEnergy: 1.5 * dt }
    );
    const text = formatAccounts(cap, base, computeLedger(cap, base));
    expect(text).to.include("RECOVERY P&L");
    const net = text.split("\n").find(l => /= recovery net/.test(l));
    expect(net, "the net cure line exists").to.not.equal(undefined);
    expect(net).to.include("0.50"); // 2.00 recovered - 1.50 bodies
  });

  it("without the scavenge sub-counter the memo degrades honestly (no fabricated cost)", () => {
    const dt = dtOf();
    const { cap, base } = rig({ ...zero, tombstoneGross: 5 * dt, tombstoneRecovered: 2 * dt });
    const text = formatAccounts(cap, base, computeLedger(cap, base));
    expect(text).to.include("RECOVERY P&L");
    expect(text).to.include("not yet measured");
  });

  it("the pile-decay line publishes the ceil-floor share and the standing census (spec 44 leg 1)", () => {
    // Owner 2026-08-04: piles pay ceil(amount/1000) >= 1 e/t however small.
    // The account names the floor's share of the decay line and the average
    // standing pile count (small = sub-1000, floor-bound) - the census the
    // standing-scavenger sizing and focus-fire dispatch are designed on.
    const dt = dtOf();
    const { cap, base } = rig({
      ...zero,
      pileDecay: 13 * dt,
      pileDecayCeilPenalty: 6 * dt,
      pileTicks: 8 * dt,
      pileTicksSmall: 5 * dt
    });
    const text = formatAccounts(cap, base, computeLedger(cap, base));
    const detail = text.split("\n").find(l => /ceil FLOOR adds/.test(l));
    expect(detail, "the census detail line exists").to.not.equal(undefined);
    expect(detail).to.include("6.00");
    expect(detail).to.include("8.0");
    expect(detail).to.include("5.0");
  });

  it("the header stamps the CURRENT methodology, whatever it is", () => {
    // Reads METHODOLOGY rather than restating it: the contract is that a report
    // carries its own stamp (spec 41 - two reports compare only at the same
    // one), not that the number is any particular value. Hardcoding it here
    // made the constant a second book, so every bump broke a test that was
    // never about the bump.
    const { cap, base } = rig(zero);
    const text = formatAccounts(cap, base, computeLedger(cap, base));
    expect(text).to.include(`[methodology #${METHODOLOGY}]`);
  });
});

/**
 * THE CONTROLLER TARGET'S DENOMINATOR IS CAPACITY (methodology #14, owner
 * 2026-08-06: *"42/110 is less than 50"*).
 *
 * #13 shipped the owner's *"50%+ net energy hitting the controller"* target
 * with `net = mined - fleet`. Against the t72819265 account that read
 * 42.20/45.78 = **92% MET** while the owner, reading the same account, got
 * 42.20/110.00 = **38% MISS**. Four denominators were defensible:
 *
 *     capacity          110.00 ->  38.4%      gross mined   87.70 ->  48.1%
 *     mined - fleet      45.78 ->  92.2%      ...- losses   27.60 -> 152.9%
 *
 * #13 took the second-most-flattering. A target cleared at 92% - and one that
 * a WORSE colony clears more easily, because shrinking the fleet shrinks the
 * denominator - measures nothing. CAPACITY charges forgone mining, the fleet
 * and the losses to one ratio, so the number moves when any of the three does.
 *
 * These tests pin the ARITHMETIC, not the live reading: the denominator must
 * be the capacity figure the account already prints, and the deduction
 * waterfall must sum back to it.
 */
describe("methodology #14: the controller target is scored against CAPACITY", () => {
  const shell = { windowTicks: 5, pileDecay: 0, structureDecay: 0, repairSpend: 0, tombstoneLost: 0, tombstoneRecovered: 0, tombstoneStock: 0 };
  const zero = { pileDecay: 0, structureDecay: 0, repairSpend: 0, tombstoneGross: 0, tombstoneRecovered: 0 };
  const render = (): string => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    cap.data.core.losses = { ...shell, cumulative: zero };
    base.data.core.losses = { ...shell, cumulative: zero };
    return formatAccounts(cap, base, computeLedger(cap, base));
  };
  const lineWith = (re: RegExp): string => {
    const l = render()
      .split("\n")
      .find(x => re.test(x));
    expect(l, `a line matching ${re} exists`).to.not.equal(undefined);
    return l as string;
  };
  const nums = (line: string): number[] => (line.match(/-?\d+\.\d+/g) ?? []).map(Number);
  // "label V.VV (P%)" - the waterfall's term encoding, parsed once.
  const waterfall = (): Array<{ label: string; v: number; pct: number }> => {
    const re = /([a-z]+) (-?\d+\.\d\d) \((-?\d+)%\)/g;
    const line = lineWith(/of capacity:/);
    const out: Array<{ label: string; v: number; pct: number }> = [];
    for (let m = re.exec(line); m; m = re.exec(line)) out.push({ label: m[1], v: Number(m[2]), pct: Number(m[3]) });
    return out;
  };

  it("the target line names CAPACITY as its denominator, not a netted figure", () => {
    const line = lineWith(/controller \/ CAPACITY/);
    expect(line).to.include("target >=50%");
    expect(line).to.match(/MET|MISS/);
  });

  it("its denominator EQUALS the capacity the account already publishes - one number, not two", () => {
    // The revenue section prints mining capacity; the target must reuse it
    // rather than derive a second one that can drift.
    const capLine = lineWith(/mining capacity/);
    const tgtLine = lineWith(/controller \/ CAPACITY/);
    const shown = nums(tgtLine);
    const denom = shown[shown.length - 1];
    expect(denom, "the '(score of DENOM)' tail is the published capacity").to.be.closeTo(nums(capLine)[0], 0.01);
  });

  it("the verdict agrees with the ratio it prints - no MET on a sub-50% share", () => {
    const line = lineWith(/controller \/ CAPACITY/);
    const share = Number((line.match(/(\d+)%/) ?? [])[1]);
    expect(Number.isFinite(share), "the percent is parseable").to.equal(true);
    expect(line.includes("MET"), `verdict must match ${share}%`).to.equal(share >= 50);
  });

  it("publishes the deduction waterfall, so a MISS says WHERE capacity went", () => {
    // The whole point of the honest denominator: it refuses to hide the
    // deductions #13 netted out before reporting.
    const line = lineWith(/of capacity:/);
    for (const term of ["fleet", "build", "bank", "controller"]) expect(line, `names ${term}`).to.include(term);
  });

  it("the waterfall CLOSES to capacity - the shares cannot sum past 100%", () => {
    // A waterfall that overshoots its own denominator is two books again.
    // `piles` and `resid` are carried for exactly this reason.
    const capacity = nums(lineWith(/controller \/ CAPACITY/)).slice(-1)[0];
    const summed = waterfall().reduce((a, t) => a + t.v, 0);
    expect(summed, `terms must sum to capacity ${capacity}`).to.be.closeTo(capacity, 0.02);
  });

  it("...and closes on a LINK-SERVED capture too - the fixture above has no links", () => {
    // SIM BLIND SPOT, caught in the act: the pair above carries no link
    // network, so a waterfall missing the LINK TRANSFER TAX closed there and
    // ran 1.21 e/t short on the live t72819265 window. A closure invariant
    // proven only on a link-free capture proves the wrong thing.
    const capL = fixture("shard1-t72819265.json");
    const baseL = fixture("shard1-t72812126.json");
    const text = formatAccounts(capL, baseL, computeLedger(capL, baseL));
    const lines = text.split("\n");
    const tgt = lines.find(l => /controller \/ CAPACITY/.test(l))!;
    const wf = lines.find(l => /of capacity:/.test(l))!;
    expect(wf, "the live capture is link-served").to.include("linktax");
    const capacity = Number((tgt.match(/-?\d+\.\d+/g) ?? []).slice(-1)[0]);
    const re = /([a-z]+) (-?\d+\.\d\d) \((-?\d+)%\)/g;
    let summed = 0;
    for (let m = re.exec(wf); m; m = re.exec(wf)) summed += Number(m[2]);
    expect(summed, `terms must sum to capacity ${capacity}`).to.be.closeTo(capacity, 0.02);
  });

  it("every waterfall term is the account's OWN published figure - never a second derivation", () => {
    // Closure to capacity cannot be asserted here (this fixture carries no
    // spawn ring, and the account itself prints an `unattributed` line for
    // exactly that reason). What MUST hold is that each term restates a number
    // the statement already publishes, so the two can never quietly disagree.
    const terms = new Map(waterfall().map(t => [t.label, t]));
    const actualOf = (label: string): number => {
      const l = lineWith(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const n = nums(l);
      return n.length >= 3 ? n[1] : n[0]; // BUDGET ACTUAL VARIANCE since #9
    };
    expect(terms.get("controller")!.v).to.be.closeTo(actualOf("controller (score)"), 0.01);
    expect(terms.get("bank")!.v).to.be.closeTo(actualOf("to/(from) bank"), 0.01);
    expect(terms.get("build")!.v).to.be.closeTo(actualOf("construction (built, measured)"), 0.01);
  });

  it("each term's PERCENT is that term over capacity - the shares cannot drift from the values", () => {
    const capacity = nums(lineWith(/controller \/ CAPACITY/)).slice(-1)[0];
    const terms = waterfall();
    expect(terms.length, "the waterfall parsed at all").to.be.at.least(3);
    for (const t of terms) expect(t.pct, `${t.label}: ${t.v} of ${capacity}`).to.equal(Math.round((t.v / capacity) * 100));
  });

  it("an UNMEASURED loss term goes ABSENT, never a flattering zero", () => {
    const cap = JSON.parse(JSON.stringify(cap72411542));
    const base = JSON.parse(JSON.stringify(cap72404213));
    delete cap.data.core.losses;
    delete base.data.core.losses;
    delete cap.data.core.sourceDropped;
    const text = formatAccounts(cap, base, computeLedger(cap, base));
    const line = text.split("\n").find(l => /of capacity:/.test(l));
    expect(line, "the waterfall still renders without loss meters").to.not.equal(undefined);
    expect(line).to.not.include("losses");
  });

  it("an UNMEASURED forgone goes ABSENT too - the pre-existing 'no fabricated forgone' invariant holds", () => {
    const old = JSON.parse(JSON.stringify(cap72411542));
    old.data.corps.corps.forEach((c: any) => {
      if (c.sizing) delete c.sizing.heldFrac;
      if (c.kind === "harvest") delete c.produced;
    });
    const text = formatAccounts(old, JSON.parse(JSON.stringify(cap72404213)), computeLedger(old, cap72404213));
    expect(text).to.not.include("forgone");
    // ...but the target itself survives: capacity and the score are still known.
    expect(text).to.include("controller / CAPACITY");
  });
});

/**
 * METHODOLOGY #11 - THE BUDGET COLUMN BALANCES BY CONSTRUCTION (owner
 * 2026-08-04: "I think our budget would actually be unbalanced... it should
 * just be zero or something"). #10 printed the bank BUDGET as the solver's
 * routed net bank flow (storage alloc - bank-out) while every other budget
 * line was the PLAN'S PRICED statement - two bases in one column. Measured
 * t72773737: bank budget -55.16 (a draw whose destination was a 117 e/t
 * spawn-sink claim against ~36.5 physically convertible), a 79.85 e/t hole
 * in the column. #11 prints the bank budget as the plan's RESIDUAL - what a
 * balanced budget leaves the bank after every priced line - so the column
 * sums to zero identically; the solver's routed flows stay visible in the
 * over-routing note.
 */
describe("the budget column balances by construction (methodology #11, t72773737)", () => {
  const cap: any = fixture("shard1-t72773737.json");
  const base: any = fixture("shard1-t72766670.json");
  const text = formatAccounts(cap, base, computeLedger(cap, base));
  const budgetOf = (label: string): number => {
    const line = text.split("\n").find(l => l.includes(label));
    expect(line, `line "${label}" exists`).to.not.equal(undefined);
    const cols = (line as string).slice(38).trim().split(/\s+/);
    return Number(cols[0]);
  };

  it("delivered budget - priced costs - loss budgets - appropriations budgets = 0", () => {
    const identity =
      budgetOf("= delivered into the economy") +
      budgetOf("extraction  (miner)") +
      budgetOf("evacuation  (hauler)") +
      budgetOf("reservation (reserver)") +
      budgetOf("link transfer") +
      budgetOf("= total overhead") +
      budgetOf("= measured losses") -
      budgetOf("controller (score)") -
      budgetOf("construction (built, measured)") -
      budgetOf("to/(from) bank");
    // Tolerance is PRINT ROUNDING, not slack in the identity. This sums ten
    // figures parsed back out of the formatted account at 2dp, so the worst
    // case is 10 x 0.005 = 0.05. The old 0.01 was passing by luck: the
    // 2026-08-07 feeder resize moved the bank residual and the printed terms
    // landed at exactly 0.010000000000001 - a rounding artifact reading as a
    // broken identity. The identity itself is exact by construction.
    expect(Math.abs(identity), `budget column sums to zero (got ${identity.toFixed(2)})`).to.be.lessThan(0.05);
  });

  it("the bank budget is the plan residual, not the solver's routed net draw (-55.16 at t72773737)", () => {
    const bank = budgetOf("to/(from) bank");
    expect(bank, "the routed -55.16 fiction is gone").to.be.greaterThan(0);
    // 100 - fleet - 3.59 link - 5.17 losses - 39.64 ctrl. METHODOLOGY #17 raised
    // the depot-mover budgets to the primitives' price (+1.28 e/t on this
    // fixture), and because the column balances BY CONSTRUCTION the residual
    // that falls to the bank drops by exactly that: 21.1 -> 19.82. The identity
    // test above is what guarantees this pin only ever moves for that reason.
    expect(bank).to.be.closeTo(19.82, 1.0);
  });

  it("the solver's routed net bank flow stays visible in the over-routing note", () => {
    expect(text).to.match(/solver.*routed net bank|routed flows: net bank/i);
  });
});

/**
 * P12 RE-PINNED (post spec-38 phase D, 2026-08-04). The runtime constant the
 * gauge was born against (STORAGE_UPGRADE_TARGET + drain) was retired by
 * phase D + addendum: plan sink and feeder both resolve
 * bankFedControllerRate = sip + surplus/tau. What still diverges is the
 * SOLVER: an over-claiming spawn sink (fundingNeed / FUND_HORIZON, physical
 * ceiling since t72773737) parks the draw and the published allocation
 * lands BELOW the law's cap - measured 39.64 against 59.04. The gauge now
 * reads published-alloc / law-cap, never a ratio of two negative
 * decompositions (the old model printed "Infinity x" on exactly the seam it
 * existed to name).
 */
describe("P12 valve coherence (published allocation vs the phase-D law)", () => {
  it("t72773737: allocation 39.64 vs cap 57.04 reads 0.70x - a WARN, not Infinity", () => {
    // The law's floor term (the anti-downgrade sip) honestly reads 0 when the
    // capture carries no ticksToDowngrade, so the cap here is the pure
    // surplus/tau term: (155,554 - 70,000) / 1,500 = 57.04.
    const cap: any = fixture("shard1-t72773737.json");
    const base: any = fixture("shard1-t72766670.json");
    const p12 = computeLedger(cap, base).find(r => r.id === "P12")!;
    expect(p12, "P12 present").to.not.equal(undefined);
    expect(Number.isFinite(p12.value), "never Infinity").to.equal(true);
    expect(p12.value).to.be.closeTo(0.7, 0.03);
    expect(p12.verdict).to.equal("WARN");
    expect(p12.unit).to.contain("57.0"); // the law's cap is named
    expect(p12.detail).to.contain("spawn sink"); // and so is the parked-claim culprit
  });
});


/**
 * THE SOURCE P&L'S RECONCILIATION CLAIM WAS AN ASSERTION, NOT A CHECK
 * (audit cycle t72874433).
 *
 * The P&L closes with a printed sentence: *"RECONCILES to the colony account:
 * miner X = extraction line; reserve Y = reservation line."* At t72874433 it
 * printed `reserve 11.80 = reservation line` while the colony account's
 * reservation line read **18.90** - a 60% mis-statement, presented to the
 * reader as a reconciliation.
 *
 * Neither number is wrong. They are measured over DIFFERENT WINDOWS:
 *
 *  - the account's spawn lines moved to the cumulative spawn ledger at
 *    methodology #7 (`core.spawnSpend.energyByRole`, differenced between the
 *    two captures) precisely because the blackbox ring is heap state that a
 *    deploy resets - here, 619 ticks;
 *  - the P&L needs per-CORP attribution, which the by-role cumulative ledger
 *    cannot give, so it still reads the ring - here, 1,102 ticks.
 *
 * Reserver purchases are lumpy (one 1,300e body per room per ~600t), so the
 * same spend normalised over two windows differs by more than half. The claim
 * was true when both sides read the ring and has been false since #7, silently,
 * because nothing computed it.
 *
 * It is not cosmetic: the P&L's `net` column is what the planner's own
 * `candidates[].net` is compared against, and that comparison "ADMITS OR
 * REJECTS a source" by the row's own words. Charging reservation at 1.18 e/t
 * per source instead of the window's 1.89 flatters every remote's net by
 * ~0.7 e/t - cbd8 reads -1.66 against plan where the capture window says
 * ~-2.85.
 *
 * The fix keeps both numbers (neither basis is available to the other) and
 * replaces the assertion with the arithmetic: state each side's window, and
 * print the DELTA where they can be compared at all.
 */
describe("SOURCE P&L: the reconciliation is computed, not asserted (t72874433)", () => {
  const cap = fixture("shard1-t72874433.json");
  const base = fixture("shard1-t72873814.json");

  it("states the window its costs are measured over", () => {
    const pnl = formatSourcePnL(cap, base);
    expect(pnl, "the ring window must be on the page - a rate without its window is not a reading").to.match(
      /RING \(1102t\)/
    );
    expect(pnl, "and the account's window beside it").to.match(/CAPTURE WINDOW \(619t\)/);
  });

  it("never claims a reconciliation it has not computed", () => {
    const pnl = formatSourcePnL(cap, base);
    // The old text asserted equality between two numbers it never compared.
    expect(pnl, "no bare RECONCILES claim").to.not.match(/RECONCILES to the colony account/);
  });

  it("prints the measured gap when the two windows disagree", () => {
    const pnl = formatSourcePnL(cap, base);
    // reservation: ring 11.80 e/t vs capture-window 18.90 e/t.
    expect(pnl).to.include("11.80");
    expect(pnl, "the account's own window must appear beside it").to.include("18.90");
  });

  it("says they AGREE when the two windows coincide", () => {
    // Same capture on both sides of the difference: the account's window is 0
    // ticks and unusable, so the comparison must be withheld, not faked.
    const pnl = formatSourcePnL(cap, cap);
    expect(pnl, "a degenerate window is stated, never differenced").to.match(/not comparable|no account window/i);
  });

  it("still renders without a base capture (the report is callable on one)", () => {
    const pnl = formatSourcePnL(cap);
    expect(pnl).to.not.equal("");
    expect(pnl, "no fabricated comparison").to.not.match(/RECONCILES to the colony account/);
  });
});

/**
 * X3 FAILED ON A LEAK THE CAPTURE ALREADY DISPROVES (audit cycle t72875067).
 *
 * X3 has read exactly **4 untracked creeps** at t72871684, t72873814,
 * t72874433 and t72875067 - four captures, four different fleet sizes (53, 54,
 * 66, 59), the same 4 - and FAILED every time on the `> 2 ⇒ orphan leak`
 * threshold. It is not an orphan leak, and the core segment has carried the
 * proof the whole time in TWO fields the row never read:
 *
 *  - **`creeps.unattributed`** - every creep whose `memory.corpId` matches no
 *    census corp, named. **Absent in all four captures**, and absent means
 *    EMPTY (this codebase omits empty optionals so absent and zero stay
 *    different facts). Zero orphans, every capture.
 *  - **`creeps.countMismatch`** - corps whose id-attributed creep count differs
 *    from their own `getCreepCount`. Its excess is **exactly 4** in all four
 *    captures, and it names the corps.
 *
 * `untracked` is a difference of two lenses (`total` minus the sum of
 * `getCreepCount`); `unattributed` is an id-match lens. The code that emits
 * them says why they are separate, and names this exact case in its own
 * comment - *"untracked 3, unattributed EMPTY - so corps exist that don't COUNT
 * creeps they own, the newborn/recycling counting-lens class, not orphans"*.
 * The ledger row then re-derived the leak from the count alone.
 *
 * `moving-W43N23-controllerFeeder` claims 3 and counts 1 in ALL FOUR captures -
 * the LinkCorp absorbed two roles (walking feeder + parked port tender, spec
 * 54) and its count lens follows one of them. That is the standing +2. The
 * other +2 rotates across whichever corp has a newborn or a recycler in flight.
 *
 * So: FAIL only where the capture cannot ACQUIT it. Orphans (a non-empty
 * `unattributed`) still fail on the original threshold; a difference the
 * reconciliation accounts for warns and names the corps, because a corp
 * mis-counting its own creeps is a real defect - just not a leaking one, and it
 * must not outrank the energy lines (spec 58a's ranking argument).
 */
describe("X3: an untracked count the capture reconciles is not an orphan leak (t72875067)", () => {
  const base = fixture("shard1-t72874433.json");
  const x3 = (cap: any) => computeLedger(cap, base).find(r => r.id === "X3")!;

  /** A capture clone whose creep census is replaced wholesale. */
  const withCensus = (creeps: any): any => {
    const c = JSON.parse(JSON.stringify(fixture("shard1-t72875067.json")));
    c.data.core.creeps = creeps;
    return c;
  };

  it("does not FAIL the live capture: unattributed empty, countMismatch accounts for all 4", () => {
    const live = fixture("shard1-t72875067.json");
    expect(live.data.core.creeps.unattributed, "no orphans in the capture").to.equal(undefined);
    const excess = (live.data.core.creeps.countMismatch as any[]).reduce(
      (n, m) => n + Math.max(0, m.claimed - m.counted),
      0
    );
    expect(excess, "the mismatch accounts for the untracked count exactly").to.equal(
      live.data.core.creeps.untracked
    );
    expect(x3(live).verdict, "reconciled ⇒ not a leak").to.not.equal("FAIL");
    expect(x3(live).detail, "and it must name the corps that mis-count").to.include("controllerFeeder");
  });

  it("STILL FAILS on real orphans - a creep whose corpId matches no corp", () => {
    const cap = withCensus({
      total: 59,
      tracked: 55,
      untracked: 4,
      byKind: {},
      unattributed: [
        { name: "a", corpId: "mining-GONE-harvest-dead" },
        { name: "b", corpId: null },
        { name: "c", corpId: "mining-GONE-harvest-dead" },
        { name: "d", corpId: null }
      ]
    });
    expect(x3(cap).verdict, "named orphans are the leak X3 exists for").to.equal("FAIL");
  });

  it("FAILS when the reconciliation does NOT add up - the residual is unexplained", () => {
    // countMismatch explains 1 of 4. The other 3 have no account at all, which
    // is the state that should have alarmed all along.
    const cap = withCensus({
      total: 59,
      tracked: 55,
      untracked: 4,
      byKind: {},
      countMismatch: [{ corpId: "moving-W43N23-controllerFeeder", claimed: 2, counted: 1 }]
    });
    expect(x3(cap).verdict).to.equal("FAIL");
    expect(x3(cap).detail).to.include("unexplained");
  });

  it("stays ok at or below the original threshold regardless", () => {
    const cap = withCensus({ total: 59, tracked: 57, untracked: 2, byKind: {} });
    expect(x3(cap).verdict).to.equal("ok");
  });
});

describe("TOP LINE picker ranks FAILs by the e/t they NAME (spec 58a, methodology #19)", () => {
  // Measured mis-ranks: t72871684 printed S5 (a dimensionless margin) over L1
  // at 69.28x budget; t72884395 and t72898387 printed P1 (a flip COUNT naming
  // no energy) over L1 at 53.3x / 60.0x. The two numbers share no axis, so
  // "first FAIL wins" ranked counts against energy. The law: a FAIL that
  // names an energy rate outranks any FAIL that does not; among named rows,
  // largest rate first; rows naming none are listed, not promoted. The
  // binding-constraint half of 58a's counter-argument prints S5 alongside
  // when the spawn is actually tight - both facts, neither hidden.
  const row = (id: string, verdict: "FAIL" | "WARN" | "ok", energyRate?: number, value = 1): any => ({
    id,
    name: `${id} name`,
    value,
    unit: "u",
    verdict,
    detail: "detail",
    ...(energyRate !== undefined ? { energyRate } : {})
  });

  it("a FAIL naming e/t outranks an earlier FAIL naming none (the P1-over-L1 mis-rank)", () => {
    const out = formatLedger([row("P1", "FAIL"), row("L1", "FAIL", 15.54)], 2, 1);
    expect(out).to.include("TOP LINE: L1");
    expect(out).to.include("15.54 e/t named");
  });

  it("FAILs naming no e/t are still listed beside the top line, not hidden", () => {
    const out = formatLedger([row("P1", "FAIL"), row("H3", "FAIL"), row("L1", "FAIL", 15.54)], 2, 1);
    expect(out).to.include("also FAIL");
    expect(out).to.include("P1");
    expect(out).to.include("H3");
  });

  it("among named FAILs the largest rate wins", () => {
    const out = formatLedger([row("L2", "FAIL", 3.1), row("L1", "FAIL", 15.54)], 2, 1);
    expect(out).to.include("TOP LINE: L1");
  });

  it("all-unnamed FAILs keep the first-row pick (no named row to promote)", () => {
    const out = formatLedger([row("P1", "FAIL"), row("H3", "FAIL")], 2, 1);
    expect(out).to.include("TOP LINE: P1");
  });

  it("prints the BINDING line when S5 reads tight (>= 0.95 of the ceiling)", () => {
    const out = formatLedger([row("L1", "FAIL", 15.54), row("S5", "ok", undefined, 0.97)], 2, 1);
    expect(out).to.include("BINDING: S5");
  });

  it("no binding line when the spawn has headroom", () => {
    const out = formatLedger([row("L1", "FAIL", 15.54), row("S5", "ok", undefined, 0.72)], 2, 1);
    expect(out).to.not.include("BINDING");
  });
});
