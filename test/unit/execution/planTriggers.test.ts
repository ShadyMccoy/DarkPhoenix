import { expect } from "chai";
import {
  FORCED_SOLVE_DEBOUNCE_TICKS,
  PlanTriggerSnapshot,
  planTriggerReason,
  shouldForceReplan
} from "../../../src/execution/planTriggers";

/**
 * EVENT-TRIGGERED REPLANNING - the detector (spec 36 item 1, P0).
 *
 * The stale-plan tax this removes: the planner priced a world up to a full
 * 50/150-tick cadence gone (the retired-remote and stranded-reserver
 * incidents both carried the flavor). Durable signals ONLY (trap list) -
 * hostile-room flips, expansion campaign transitions, RCL-up, spawn census
 * changes - debounced to one forced solve per FORCED_SOLVE_DEBOUNCE_TICKS,
 * with the CPU governor's bucket still gating behind the request.
 */
const base = (over: Partial<PlanTriggerSnapshot> = {}): PlanTriggerSnapshot => ({
  hostileRooms: [],
  expansionState: undefined,
  rclByRoom: { W1N1: 4 },
  spawnCount: 1,
  ...over
});

/**
 * SPEC 46 PHASE A - the budget-staleness trigger (owner 2026-08-05: "We can
 * still resolve along the way and identify LARGE VARIANCES as signals to
 * adapt"). With the scheduled solve at the fiscal month, the published
 * controller allocation is a month old while the bank level moves
 * continuously - and the ONE VALVE rule sizes the upgrader fleet from that
 * published number and nothing else. A month-stale valve is not merely
 * imprecise: at ~40 e/t of draw the bank moves ~60k in one term, so an
 * allocation priced at the month's opening stock can keep a standing fleet
 * drawing against a bank that has since fallen through its reserve (the
 * cash-poor failure the warchest exists to prevent).
 *
 * So the LAW's own movement SINCE THE BUDGET SOLVED is a durable signal -
 * bank stock, not creep positions - and re-budgets when it gets large.
 * Small drift rides to the boundary: that IS the anti-thrash point.
 *
 * LAW-vs-LAW, never law-vs-PUBLISHED: the published allocation diverges
 * from the law by PLAN POLICY (wartime relegation, the physical burn cap),
 * so a law-vs-published test would fire every debounce window forever in
 * exactly the state the colony is in today - pinned below.
 */
describe("spec 46: budget staleness is a durable trigger (the owner's large-variance signal)", () => {
  const withBank = (atBudget: number, law: number): PlanTriggerSnapshot =>
    base({ budgetLawRate: atBudget, bankFedControllerRate: law });

  it("a LARGE move in the law since the budget solved re-budgets", () => {
    // The bank drained through the month: the law prices 20 e/t where it
    // stood at 60 when the budget was set. A fleet sized to that budget is
    // eating the reserve.
    expect(planTriggerReason(withBank(60, 60), withBank(60, 20))).to.contain("budget-stale");
  });

  it("...in BOTH directions (an under-drawing budget wastes the surplus it should be spending)", () => {
    expect(planTriggerReason(withBank(20, 20), withBank(20, 60))).to.contain("budget-stale");
  });

  it("ORDINARY drift rides to the month boundary - that is the anti-thrash point", () => {
    // A month of normal banking moves the law some; re-budgeting on THAT
    // would restore the 50-tick thrash through the back door.
    expect(planTriggerReason(withBank(50, 50), withBank(50, 56))).to.equal(null);
  });

  it("a tiny absolute gap never fires, however large the ratio (a near-zero valve is not a variance)", () => {
    // 0.5 -> 2.0 is 4x, but it is 1.5 e/t - noise, not a signal.
    expect(planTriggerReason(withBank(0.5, 0.5), withBank(0.5, 2))).to.equal(null);
  });

  it("absent readings never fire (no bank, no vision, pre-first-solve)", () => {
    expect(planTriggerReason(base(), base())).to.equal(null);
    expect(planTriggerReason(withBank(60, 60), base())).to.equal(null);
  });

  it("PLAN POLICY is never staleness: wartime publishes ~0 against a live law of 41 and nothing fires", () => {
    // The live state at t72801354: the colony-wide backlog relegates every
    // controller to its floor (published ~0) while the law prices the full
    // surplus (~41). A law-vs-PUBLISHED test would re-force every debounce
    // window forever here - the 50-tick thrash restored through the back
    // door. Law-vs-law sees a quiet world, which it is.
    const wartime = base({ budgetLawRate: 41, bankFedControllerRate: 41 });
    expect(planTriggerReason(wartime, wartime)).to.equal(null);
  });
});

describe("plan triggers (spec 36 item 1: durable transitions force a replan)", () => {
  describe("planTriggerReason - the durable trigger set", () => {
    it("a room flipping HOSTILE fires (embargo on)", () => {
      expect(planTriggerReason(base(), base({ hostileRooms: ["W2N2"] }))).to.equal("hostile-on:W2N2");
    });

    it("a room flipping SAFE fires (embargo off - the recovered route reprices)", () => {
      expect(planTriggerReason(base({ hostileRooms: ["W2N2"] }), base())).to.equal("hostile-off:W2N2");
    });

    it("an expansion campaign transition fires", () => {
      expect(planTriggerReason(base(), base({ expansionState: "claiming" }))).to.equal("expansion:none->claiming");
      expect(planTriggerReason(base({ expansionState: "claiming" }), base({ expansionState: "founding" }))).to.equal(
        "expansion:claiming->founding"
      );
    });

    it("an RCL-UP in an owned room fires", () => {
      expect(planTriggerReason(base(), base({ rclByRoom: { W1N1: 5 } }))).to.equal("rcl-up:W1N1:4->5");
    });

    it("a NEW owned room appearing is not an rcl-up (no prior level to compare)", () => {
      // Founding rooms enter through the expansion/spawn triggers, not a
      // phantom 0->1 rcl edge on a room the baseline never had.
      expect(planTriggerReason(base(), base({ rclByRoom: { W1N1: 4, W9N9: 1 } }))).to.equal(null);
    });

    it("a spawn joining or leaving the census fires", () => {
      expect(planTriggerReason(base(), base({ spawnCount: 2 }))).to.equal("spawns:1->2");
      expect(planTriggerReason(base({ spawnCount: 2 }), base({ spawnCount: 1 }))).to.equal("spawns:2->1");
    });

    it("an unchanged world fires nothing", () => {
      expect(planTriggerReason(base(), base())).to.equal(null);
    });

    it("hostile-room ORDER is irrelevant (a set, not a list)", () => {
      expect(
        planTriggerReason(base({ hostileRooms: ["A", "B"] }), base({ hostileRooms: ["B", "A"] }))
      ).to.equal(null);
    });
  });

  describe("shouldForceReplan - one forced solve, debounced", () => {
    it("fires exactly once on a staged transition", () => {
      const prev = base();
      const curr = base({ hostileRooms: ["W2N2"] });
      const v = shouldForceReplan(prev, curr, undefined, 1000);
      expect(v.force).to.equal(true);
      expect(v.reason).to.equal("hostile-on:W2N2");
      // The next tick, with the transition absorbed into the baseline,
      // nothing re-fires.
      expect(shouldForceReplan(curr, curr, 1000, 1001).force).to.equal(false);
    });

    it("DEBOUNCE: a second trigger inside the window does not force again", () => {
      const afterFirst = base({ hostileRooms: ["W2N2"] });
      const second = base({ hostileRooms: ["W2N2", "W3N3"] });
      const v = shouldForceReplan(afterFirst, second, 1000, 1000 + FORCED_SOLVE_DEBOUNCE_TICKS - 1);
      expect(v.force).to.equal(false);
    });

    it("...and fires again once the window has passed", () => {
      const afterFirst = base({ hostileRooms: ["W2N2"] });
      const second = base({ hostileRooms: ["W2N2", "W3N3"] });
      const v = shouldForceReplan(afterFirst, second, 1000, 1000 + FORCED_SOLVE_DEBOUNCE_TICKS);
      expect(v.force).to.equal(true);
      expect(v.reason).to.equal("hostile-on:W3N3");
    });

    it("the FIRST observation seeds the baseline and never fires (a fresh reset is not an event)", () => {
      expect(shouldForceReplan(undefined, base({ hostileRooms: ["W2N2"] }), undefined, 5).force).to.equal(false);
    });

    it("the debounce window is a NAMED constant at half the governor's minimum cadence", () => {
      expect(FORCED_SOLVE_DEBOUNCE_TICKS).to.equal(25);
    });
  });
});

import { setupGlobals, Game, Memory } from "../mock";
import { checkPlanTriggers } from "../../../src/execution/planTriggers";

describe("checkPlanTriggers (the Memory-backed per-tick entry)", () => {
  beforeEach(() => {
    setupGlobals();
    Game.rooms = {} as never;
    (Game as { spawns: Record<string, unknown> }).spawns = {};
    delete (Memory as { planTriggerState?: unknown }).planTriggerState;
  });

  it("seeds on first observation, fires on a census change, absorbs the baseline", () => {
    expect(checkPlanTriggers(100).force, "first observation seeds").to.equal(false);
    (Game as { spawns: Record<string, unknown> }).spawns = { s1: {} };
    const v = checkPlanTriggers(101);
    expect(v.force).to.equal(true);
    expect(v.reason).to.equal("spawns:0->1");
    expect(checkPlanTriggers(102).force, "the transition was absorbed").to.equal(false);
  });

  it("debounces a second transition inside the window and ADVANCES the baseline anyway", () => {
    checkPlanTriggers(100); // seed
    (Game as { spawns: Record<string, unknown> }).spawns = { s1: {} };
    expect(checkPlanTriggers(101).force).to.equal(true);
    (Game as { spawns: Record<string, unknown> }).spawns = { s1: {}, s2: {} };
    expect(checkPlanTriggers(110).force, "inside the debounce window").to.equal(false);
    // The suppressed transition is absorbed - it does NOT re-fire when the
    // window lapses (the cadence solve owns anything the debounce skipped).
    expect(checkPlanTriggers(101 + FORCED_SOLVE_DEBOUNCE_TICKS).force).to.equal(false);
  });

  it("the detector state survives in Memory (a reset re-seeds only if Memory was lost)", () => {
    checkPlanTriggers(100);
    expect((Memory as { planTriggerState?: { snap: unknown } }).planTriggerState?.snap).to.not.equal(undefined);
  });
});
