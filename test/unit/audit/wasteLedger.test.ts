import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { computeChurn, computeLedger, planSpawnLoad } from "../../../scripts/waste-ledger";

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
    const capBoundary = fixture("shard1-t72420007.json");
    const rows2 = computeLedger(capBoundary, fixture("shard1-t72419708.json"));
    const p4 = rows2.find(r => r.id === "P4")!;
    expect(p4.value).to.be.greaterThan(0.99); // the boundary shape, not a slack plan
    expect(p4.verdict).to.equal("WARN"); // hot, worth watching - but not a FAIL
  });

  it("P4's load table includes every fleet class, producers AND consumers", () => {
    const { lines } = planSpawnLoad(cap);
    const names = lines.map(([n]) => n).join("|");
    for (const cls of ["miners", "source-route haulers", "transient-route", "upgraders", "feeder", "tenders", "reservers"]) {
      expect(names).to.contain(cls);
    }
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
        { sourceId: "source-bbbb", haulDist: 46, linkId: "link-gw01", linkDist: 20, saving: 26, flowRate: 8 }
      ],
      perLink: [{ linkId: "link-gw01", depositFlow: 18, sources: 2 }]
    };
    const dep = computeLedger(capA, cap72404213).find(r => r.id === "DEP")!;
    expect(dep.verdict).to.equal("ok"); // instrument-first: never gates
    expect(dep.value).to.equal(2);
    // sorted by saving desc: bbbb (26) before aaaa (15)
    expect(dep.detail.indexOf("bbbb")).to.be.lessThan(dep.detail.indexOf("aaaa"));
    expect(dep.detail).to.contain("saves 26");
    expect(dep.detail).to.contain("gw01 18.0e/t x2"); // per-link throughput
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
});
