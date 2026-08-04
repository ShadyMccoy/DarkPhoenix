import { expect } from "chai";
import {
  BASE_RESERVE,
  RESERVE_COVERAGE_TICKS,
  SURPLUS_DRAIN_TICKS,
  MAX_SURPLUS_DRAW,
  STORAGE_UPGRADE_TARGET,
  warchestTarget,
  resolveReserveTarget,
  spendableBankSurplus,
  bankSurplusRate,
  bankFedControllerRate,
  feederRelayRate,
  bankSourceId,
  bankToTransientSource,
  controllerFloorRate
} from "../../../src/economy/bank";
import { EXPANSION_CAPEX, EXPANSION_SAFETY_RESERVE } from "../../../src/economy/expansion";
import { ANTI_DOWNGRADE_RESERVE, CREEP_LIFETIME } from "../../../src/economy/primitives";

// Spec 03 (storage draw-down), the SURPLUS half: once the bank holds the
// liquidity reserve, everything above it is spendable on the controller. The
// reserve target is now the plan-measured warchestTarget (income x coverage),
// not a flat constant - these pin the pure primitives every consumer (planner
// adapter, feeder, upgrader sizing) must derive from, one home, no drift.
describe("economy/bank - the surplus spend primitives", () => {
  describe("warchestTarget (the liquidity reserve, sized from income)", () => {
    it("never drops below the expansion-safety floor - a leaner floor would strand expansion", () => {
      // A drain floor below EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE would
      // permanently disable expansion (the pre-#98 STORAGE_BANK=10k failure).
      expect(BASE_RESERVE).to.equal(EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE);
      expect(warchestTarget(0)).to.equal(BASE_RESERVE);
      expect(warchestTarget(5)).to.equal(BASE_RESERVE); // tiny income -> floor still binds
    });

    it("covers RESERVE_COVERAGE_TICKS ticks of income once that exceeds the floor", () => {
      const richIncome = 80; // ~8 sources
      expect(warchestTarget(richIncome)).to.equal(RESERVE_COVERAGE_TICKS * richIncome);
      expect(warchestTarget(richIncome)).to.be.greaterThan(BASE_RESERVE);
    });

    it("BREATHES with colony size - a richer colony keeps a bigger buffer", () => {
      // The whole point: the flat lump did not scale, this does. Lean floors,
      // rich holds more in proportion to what it has to lose.
      const lean = warchestTarget(20);
      const mid = warchestTarget(40);
      const rich = warchestTarget(80);
      expect(lean).to.equal(BASE_RESERVE); // lean colony floors, freeing capital
      expect(mid).to.be.greaterThan(lean);
      expect(rich).to.be.greaterThan(mid);
    });

    it("reproduces roughly the old flat warchest at a mid colony (near-no-op calibration)", () => {
      // Old flat target was EXPANSION_CAPEX + 2*SAFETY. A mid ~40 e/t colony
      // should land within ~25% of it so existing behavior barely moves.
      const oldFlat = EXPANSION_CAPEX + 2 * EXPANSION_SAFETY_RESERVE;
      const mid = warchestTarget(40);
      expect(mid).to.be.closeTo(oldFlat, oldFlat * 0.25);
    });
  });

  describe("resolveReserveTarget (the shared fallback)", () => {
    it("uses the plan-persisted value when present", () => {
      expect(resolveReserveTarget(50_000)).to.equal(50_000);
    });
    it("falls back to the hard floor before the first solve publishes one", () => {
      expect(resolveReserveTarget(undefined)).to.equal(BASE_RESERVE);
    });
  });

  describe("spendableBankSurplus", () => {
    it("is zero at or below the reserve target", () => {
      expect(spendableBankSurplus(0, BASE_RESERVE)).to.equal(0);
      expect(spendableBankSurplus(BASE_RESERVE, BASE_RESERVE)).to.equal(0);
      expect(spendableBankSurplus(BASE_RESERVE - 1, BASE_RESERVE)).to.equal(0);
    });
    it("is exactly the stock above the target", () => {
      expect(spendableBankSurplus(BASE_RESERVE + 4000, BASE_RESERVE)).to.equal(4000);
    });
    it("tracks the target it is given - a bigger reserve leaves less spendable", () => {
      const banked = 60_000;
      expect(spendableBankSurplus(banked, 30_000)).to.equal(30_000);
      expect(spendableBankSurplus(banked, 50_000)).to.equal(10_000);
    });
  });

  describe("bankSurplusRate", () => {
    it("draws nothing while the reserve is still filling", () => {
      expect(bankSurplusRate(BASE_RESERVE, BASE_RESERVE)).to.equal(0);
      expect(bankSurplusRate(10_000, BASE_RESERVE)).to.equal(0);
    });
    it("drains the surplus over the target horizon", () => {
      expect(bankSurplusRate(BASE_RESERVE + 1500, BASE_RESERVE)).to.be.closeTo(1500 / SURPLUS_DRAIN_TICKS, 1e-9);
    });
    it("caps the draw so a runaway bank doesn't ask for an absurd consumer fleet", () => {
      // The cap binds only past MAX_SURPLUS_DRAW x SURPLUS_DRAIN_TICKS of
      // surplus (150k at the lifetime horizon) - a degenerate-bank guard,
      // never a pacer on ordinary surpluses.
      const runaway = MAX_SURPLUS_DRAW * SURPLUS_DRAIN_TICKS + 50_000;
      expect(bankSurplusRate(BASE_RESERVE + runaway, BASE_RESERVE)).to.equal(MAX_SURPLUS_DRAW);
    });
    it("the cap is a runaway GUARD above the physical absorption ceiling, never a pacer (owner doctrine: FOCUS energy - surge the current objective)", () => {
      // Controller-side absorption tops out well under 100 e/t at mid-game
      // (parking tiles x per-body WORK). The guard bounds degenerate fleet
      // math (a 570k bank must not commission a 100-feeder relay), but must
      // never be the binding term against physics. Measured incident: at 20
      // it capped the relay at 35 e/t while the plan allocated 105 - pacing
      // the exact focus the bot exists to deliver.
      expect(MAX_SURPLUS_DRAW).to.be.at.least(100);
    });
    it("tapers to zero approaching the target (no flapping at the boundary)", () => {
      expect(bankSurplusRate(BASE_RESERVE + SURPLUS_DRAIN_TICKS, BASE_RESERVE)).to.be.closeTo(1, 1e-9);
    });
  });

  describe("bankFedControllerRate (owner 2026-08-04: 'The bank should be the income mop up not the upgrade')", () => {
    // THE INVERSION, one formula, no branches: in a storage-backed room the
    // controller's allocation is floor + surplus/SURPLUS_DRAIN_TICKS and
    // NOTHING else - upgrade is proportional to surplus (plus its guaranteed
    // floor), and the BANK is the residual claimant on income. This
    // composes the owner's two rulings: the allocation follows the BANK
    // LEVEL, which moves slowly, so it is continuous through the target
    // (2026-08-03 "approach the equilibrium asymptotically" - no 85 -> 15
    // regime cliff) while every income shock lands in the bank first
    // (2026-08-04). It retires phase C's refill claim same-day: a bounded
    // controller leaves the residual to storage by construction, so the
    // bank no longer needs to CLAIM anything.
    it("below the target: the floor alone (income residual banks)", () => {
      expect(bankFedControllerRate(BASE_RESERVE - 20_000, BASE_RESERVE)).to.equal(
        controllerFloorRate(BASE_RESERVE - 20_000)
      );
    });
    it("above the target: floor + the ONE drain law", () => {
      const banked = BASE_RESERVE + 30_000;
      expect(bankFedControllerRate(banked, BASE_RESERVE)).to.be.closeTo(
        controllerFloorRate(banked) + bankSurplusRate(banked, BASE_RESERVE),
        1e-9
      );
      expect(bankFedControllerRate(banked, BASE_RESERVE)).to.be.closeTo(
        STORAGE_UPGRADE_TARGET + 30_000 / SURPLUS_DRAIN_TICKS,
        1e-9
      );
    });
    it("CONTINUOUS through the target crossing (no regime cliff)", () => {
      const eps = 1;
      const below = bankFedControllerRate(BASE_RESERVE - eps, BASE_RESERVE);
      const at = bankFedControllerRate(BASE_RESERVE, BASE_RESERVE);
      const above = bankFedControllerRate(BASE_RESERVE + eps, BASE_RESERVE);
      expect(Math.abs(at - below)).to.be.lessThan(0.01);
      expect(Math.abs(above - at)).to.be.lessThan(0.01);
    });
    it("a drained bank still floors at the anti-downgrade trickle (never zero)", () => {
      expect(bankFedControllerRate(0, BASE_RESERVE)).to.equal(controllerFloorRate(0));
      expect(bankFedControllerRate(0, BASE_RESERVE)).to.be.greaterThan(0);
    });
    it("the runaway guard still bounds the drain half", () => {
      const runaway = MAX_SURPLUS_DRAW * SURPLUS_DRAIN_TICKS + 500_000;
      expect(bankFedControllerRate(BASE_RESERVE + runaway, BASE_RESERVE)).to.equal(
        controllerFloorRate(BASE_RESERVE + runaway) + MAX_SURPLUS_DRAW
      );
    });
  });

  describe("feederRelayRate", () => {
    it("relays exactly the save-regime upgrade target while the reserve fills", () => {
      expect(feederRelayRate(10_000, BASE_RESERVE)).to.equal(STORAGE_UPGRADE_TARGET);
    });
    it("adds the surplus draw on top once the reserve is full", () => {
      expect(feederRelayRate(BASE_RESERVE + 3000, BASE_RESERVE)).to.be.closeTo(
        STORAGE_UPGRADE_TARGET + bankSurplusRate(BASE_RESERVE + 3000, BASE_RESERVE),
        1e-9
      );
    });
  });

  describe("bankToTransientSource", () => {
    const pos = { x: 24, y: 24, roomName: "W1N1" };

    it("emits nothing while the reserve is still filling", () => {
      expect(bankToTransientSource("W1N1", pos, BASE_RESERVE, BASE_RESERVE)).to.equal(null);
      expect(bankToTransientSource("W1N1", pos, 5000, BASE_RESERVE)).to.equal(null);
    });

    it("emits a miner-less transient source at the storage, sized to the surplus draw", () => {
      const banked = BASE_RESERVE + 3000;
      const src = bankToTransientSource("W1N1", pos, banked, BASE_RESERVE)!;
      expect(src).to.not.equal(null);
      expect(src.id).to.equal(bankSourceId("W1N1"));
      expect(src.id).to.equal("bank-W1N1");
      expect(src.pos).to.deep.equal(pos);
      expect(src.rate).to.be.closeTo(bankSurplusRate(banked, BASE_RESERVE), 1e-9);
      expect(src.maxMiners).to.equal(0);
      expect(src.transient).to.equal(true);
    });

    it("holds a larger reserve back before releasing surplus (the risk-smoothing knob)", () => {
      // Same banked energy, a bigger reserve target -> emits nothing yet.
      const banked = 40_000;
      expect(bankToTransientSource("W1N1", pos, banked, 30_000)).to.not.equal(null);
      expect(bankToTransientSource("W1N1", pos, banked, 50_000)).to.equal(null);
    });
  });
});

describe("surplus drain horizon (owner 2026-07-29: size upgraders to the equilibrium)", () => {
  it("drains the surplus over >= one CREEP_LIFETIME - bodies never outlive their fuel", () => {
    // Measured swing t72645498->t72652682 at 150: a ~21k surplus sized two
    // 4350e upgraders to a 100 e/t draw that self-extinguished in ~200t;
    // the standing fleet then burned the bank BELOW reserve for its
    // remaining ~1200t (slope -1.66/t), EOL'd at the floor, and the refill
    // re-armed the swing. Consumer fleets are SIZED to this draw
    // (feederRelayRate -> upgrader inflow), so the horizon must cover the
    // lifetime of the bodies it sizes. Mirrors sustainableConsumptionRate's
    // stock/CREEP_LIFETIME: one drain law at every stock.
    expect(SURPLUS_DRAIN_TICKS).to.be.at.least(CREEP_LIFETIME);
  });
});

/**
 * THE t72455355 PIN (spec 38's regression test, landed ahead of the refactor).
 *
 * The incident: 340k banked against a ~70k reserve while the PLAN's controller
 * allocation read ~2 e/t - obeying the plan starved the relay to 7 e/t with a
 * full warchest standing. The consumer-side override (feederRelayRate reading
 * the BANK, not the plan) is what kept upgrading alive, and spec 38 warns that
 * a naive clamp to the plan re-opens exactly this hole.
 *
 * This pin encodes the OUTCOME, not the mechanism: however phase 4 moves the
 * floor into the solver and kills the +15 side-channel, a bank deep in surplus
 * must still drive a large drain. If this test breaks, the refactor re-created
 * the incident - stop and re-read spec 38 section "the override is
 * incident-backed".
 */
describe("t72455355 pin: a full bank NEVER starves the relay (spec 38 guard)", () => {
  it("drives a large drain at incident-shaped stocks, whatever the plan says", () => {
    // 340k banked, 70k reserve: surplus 270k -> drain capped at MAX_SURPLUS_DRAW.
    const rate = feederRelayRate(340_000, 70_000);
    expect(rate).to.be.at.least(100, "the relay the incident needed was ~115 e/t; 7 e/t starved it");
    expect(rate).to.equal(STORAGE_UPGRADE_TARGET + MAX_SURPLUS_DRAW);
  });

  it("still relays the save-regime floor when the bank sits AT reserve", () => {
    expect(feederRelayRate(70_000, 70_000)).to.equal(STORAGE_UPGRADE_TARGET);
  });
});

/**
 * SPEC 38 PHASE A - the controller floor moves INSIDE the plan.
 *
 * The runtime's feederRelayRate carries a +STORAGE_UPGRADE_TARGET constant
 * the solver never modeled (P12 read 3.30x divergence on the non-bank term
 * at FY4849-M03). Phase A gives the plan the floor as a SINK RESERVE, priced
 * by the one drain law: the bank funds a floor it can sustain for a creep
 * generation - never more than the save target, and a cold storage room
 * floors at the anti-downgrade trickle so a thin economy's spawn is never
 * out-reserved by its own controller.
 */
describe("controllerFloorRate (spec 38 phase A: the plan's own floor)", () => {
  it("caps at the save-regime target once the bank can sustain it", () => {
    expect(controllerFloorRate(340_000)).to.equal(STORAGE_UPGRADE_TARGET); // t72455355's bank
    expect(controllerFloorRate(STORAGE_UPGRADE_TARGET * CREEP_LIFETIME)).to.equal(STORAGE_UPGRADE_TARGET);
  });

  it("scales with what the bank can actually sustain below the target", () => {
    expect(controllerFloorRate(7500)).to.be.closeTo(5, 1e-9); // 7500/1500
  });

  it("floors at the anti-downgrade trickle on an empty bank", () => {
    expect(controllerFloorRate(0)).to.equal(ANTI_DOWNGRADE_RESERVE);
    expect(controllerFloorRate(1000)).to.equal(ANTI_DOWNGRADE_RESERVE); // 0.67 < trickle
  });
});

import { planColony, ColonyProblem, PlannerSink, PlannerSpawn } from "../../../src/economy/CorpPlanner";
import { plannableSpawnParts } from "../../../src/economy/primitives";
import { Position } from "../../../src/types/Position";
import { feederRelayTarget, FEEDER_STOCK_HEADROOM } from "../../../src/corps/ControllerFeederCorp";
import { upgraderSizing } from "../../../src/corps/UpgradingCorp";

/**
 * SPEC 38 ACCEPTANCE 1+2 - the staged t72455355 state (bank full, ledger dry).
 *
 * The incident state does not occur organically in either live regime (checked
 * 2026-08-02: partsLeft 0.133 surplus / 0.216 filling), so the conformance
 * test STAGES it: a full bank's transient source standing, the spawn-parts
 * budget squeezed to a sliver (infraPartsPerTick eats all but ~4x the floor's
 * own charge), and a HIGHER-VALUE competitor (a founding site at 85, above
 * controller's 80) that would drain that sliver first under pure value greed -
 * exactly how t72455355's fill exhausted before the controller sink and
 * published allocated ~2 with 340k banked.
 *
 * The invariant (owner decision, spec 38 item 3): the parts-ledger fill must
 * never starve a sink the plan's own bank source is routing to below the sip
 * floor while that source stands. Phase A provides it structurally - the
 * reserve pre-pass runs FIRST on a fresh ledger, so the floor's parts are won
 * before any value-ranked fill can spend them.
 *
 * The CHAIN then agrees end to end (phase B): the feeder relays the plan's
 * allocation + stock headroom and the upgraders burn the plan's allocation -
 * both small, both AGREED, instead of the incident's feeder 7 vs upgraders
 * 115 (stock 1520 -> 60). The old override is not needed because the state it
 * defended against is impossible by construction.
 */
describe("spec 38 acceptance: the staged t72455355 state (bank full, ledger dry)", () => {
  const ROOM = "W1N1";
  const BANKED = 340_000;
  const RESERVE = 70_000;
  const at = (x: number): Position => ({ x, y: 0, roomName: ROOM });
  const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const FLOOR = controllerFloorRate(BANKED); // 15 - the bank sustains the full save target

  const stagedProblem = (): ColonyProblem => {
    const spawn: PlannerSpawn = { id: "S", pos: at(0) };
    const bankSrc = bankToTransientSource(ROOM, at(1), BANKED, RESERVE)!;
    const ctrl: PlannerSink = {
      id: "ctrl",
      kind: "controller",
      pos: at(3),
      value: 80,
      capacity: 80,
      reserve: FLOOR
    };
    // The ledger-drainer: a founding site OUTRANKS the controller (85 > 80,
    // the sink-value ladder) and its long haul is parts-expensive, so under
    // pure value order it exhausts the sliver before the controller's turn.
    const founding: PlannerSink = { id: "founding", kind: "spawn", pos: at(120), value: 85, capacity: 100 };
    // Squeeze the budget: standing infra eats all but a sliver (~4x the
    // floor's own charge at these distances).
    const infraPartsPerTick = plannableSpawnParts(1) - 0.05;
    return { dist: manhattan, spawns: [spawn], sources: [bankSrc], sinks: [ctrl, founding], infraPartsPerTick };
  };

  it("stages the discriminator state for real: the ledger runs DRY", () => {
    expect(planColony(stagedProblem()).partsLedger.dry).to.equal(true);
  });

  it("the parts squeeze binds the competitor, not the energy pool", () => {
    const founding = planColony(stagedProblem()).sinks.find(s => s.sinkId === "founding")!;
    expect(founding.allocated).to.be.greaterThan(0, "the sliver funds SOME founding haul");
    expect(founding.allocated).to.be.lessThan(50, "nowhere near its 100 demand - parts bound it");
  });

  it("the fill never starves the bank-fed sip floor while the bank source stands (phase A invariant)", () => {
    const ctrl = planColony(stagedProblem()).sinks.find(s => s.sinkId === "ctrl")!;
    expect(ctrl.allocated).to.be.at.least(FLOOR - 1e-6, "the reserve pre-pass won the floor before value greed");
    // ...and the dry ledger kept it AT the floor: the state is the incident's,
    // only the allocation is now honest instead of ~2.
    expect(ctrl.allocated).to.be.at.most(FLOOR + 1);
  });

  it("the chain AGREES end to end: relay covers the burn, both read the plan (phase B)", () => {
    const alloc = planColony(stagedProblem()).sinks.find(s => s.sinkId === "ctrl")!.allocated;
    const relay = feederRelayTarget(feederRelayRate(BANKED, RESERVE), alloc);
    const upgraders = upgraderSizing(alloc);
    expect(relay).to.be.closeTo(alloc + FEEDER_STOCK_HEADROOM, 1e-9, "the feeder relays the plan + headroom");
    expect(upgraders.allocated).to.be.at.most(relay, "the supply line covers the burn - no 1520->60 drain");
    expect(upgraders.allocated).to.be.at.least(FLOOR, "and the burn holds the sip floor");
  });

  it("HEALTHY ledger, same bank: the full surplus drain flows THROUGH the plan (the pin's outcome, end to end)", () => {
    // The t72455355 outcome pin above guarantees the drain at the formula
    // level; this is the same guarantee through the whole chain now that the
    // feeder reads the plan. A full bank's transient source (100 e/t at these
    // stocks) routes to an unconstrained controller sink, and the relay the
    // feeder actually sizes to covers it - no override needed for a large
    // drain to materialize.
    const spawn: PlannerSpawn = { id: "S", pos: at(0) };
    const bankSrc = bankToTransientSource(ROOM, at(1), BANKED, RESERVE)!;
    const ctrl: PlannerSink = { id: "ctrl", kind: "controller", pos: at(3), value: 80, capacity: 120, reserve: FLOOR };
    const plan = planColony({ dist: manhattan, spawns: [spawn], sources: [bankSrc], sinks: [ctrl] });
    const alloc = plan.sinks.find(s => s.sinkId === "ctrl")!.allocated;
    expect(alloc).to.be.closeTo(bankSurplusRate(BANKED, RESERVE), 1e-6, "the solver routes the WHOLE surplus draw");
    const relay = feederRelayTarget(feederRelayRate(BANKED, RESERVE), alloc);
    expect(relay).to.be.at.least(100, "the incident needed ~115; the plan-read relay delivers it");
    expect(upgraderSizing(alloc).allocated).to.be.at.most(relay, "and the burn it feeds agrees");
  });
});
