import { expect } from "chai";
import { buildRank, nextBuildTarget } from "../../../src/corps/repair";

/**
 * BATCH-PLACE, BUILD-ONE-AT-A-TIME (owner 2026-07-29: "instead of just
 * placing one construction site at a time for the extensions, etc. can we
 * place all of them, however we still only build them one at a time, but we
 * size the builders to the size of all the construction sites").
 *
 * Placing the whole wanted SET makes the outstanding work visible to the
 * sum-of-projects lens (siteWorkRemaining -> projectAbsorbRate), which is
 * what sizes the crew - one-at-a-time placement hid the backlog and capped
 * the fleet against a single site (owner 2026-07-20, the extension batch;
 * generalized here to every rung).
 *
 * The cost of a wide placement is that "nearest" stops being a safe build
 * order: the ladder's ordering is ECONOMICS (source containers turn roaming
 * drop-mining static, extensions compound spawn capacity, roads are pure
 * efficiency and pay only over long horizons), and the code already carries
 * the measured lesson that starting with the far controller container
 * "stalls the whole build set on one slow, hard-to-feed structure". So the
 * build target ranks by ladder position FIRST and distance only within a
 * rank - the latch still guarantees one site finishes before the next.
 */
describe("build ladder: batch placement needs ranked build focus", () => {
  describe("buildRank (the ladder's economics as a sort key)", () => {
    it("ranks capacity/efficiency structures ahead of roads", () => {
      expect(buildRank("container")).to.be.lessThan(buildRank("road"));
      expect(buildRank("extension")).to.be.lessThan(buildRank("road"));
      expect(buildRank("storage")).to.be.lessThan(buildRank("road"));
    });

    it("keeps the owner build order: containers, then extensions, then storage/link", () => {
      expect(buildRank("container")).to.be.lessThan(buildRank("extension"));
      expect(buildRank("extension")).to.be.lessThan(buildRank("storage"));
      expect(buildRank("storage")).to.be.at.most(buildRank("link"));
    });

    it("gives an unknown structure type a finite rank ahead of roads (never crashes the sort)", () => {
      expect(buildRank("observer" as string)).to.be.a("number");
      expect(buildRank("observer" as string)).to.be.lessThan(buildRank("road"));
    });
  });

  describe("nextBuildTarget with ranks (one at a time, in ladder order)", () => {
    interface TSite {
      id: string;
      pos: { x: number; y: number };
      structureType: string;
    }
    const site = (id: string, x: number, structureType: string): TSite => ({ id, pos: { x, y: 10 }, structureType });
    const rangeFrom = (x: number) => (s: TSite) => Math.abs(s.pos.x - x);

    it("builds the HIGHER-RANK site even when a road is much nearer", () => {
      // The batch-placement regression this guards: with the whole set
      // standing, plain nearest-first paves a road under the builder's feet
      // while the extension set (spawn capacity) waits.
      const road = site("road-adjacent", 1, "road");
      const ext = site("ext-far", 25, "extension");
      expect(nextBuildTarget([road, ext], undefined, rangeFrom(0))).to.equal(ext);
    });

    it("within one rank, nearest still wins (logistics inside the tier)", () => {
      const near = site("ext-near", 4, "extension");
      const far = site("ext-far", 30, "extension");
      expect(nextBuildTarget([far, near], undefined, rangeFrom(2))).to.equal(near);
    });

    it("the LATCH still outranks everything - a started site is finished first", () => {
      // Focus is the whole point of "build them one at a time": a
      // higher-rank site appearing mid-build must not abandon the current
      // one at 90% (the measured ping-pong the latch exists to prevent).
      const started = site("road-started", 20, "road");
      const better = site("container-new", 1, "container");
      expect(nextBuildTarget([better, started], "road-started", rangeFrom(0))).to.equal(started);
    });

    it("ranks unchanged for a homogeneous set: pure paving still runs nearest-first", () => {
      const a = site("t1", 10, "road");
      const b = site("t2", 3, "road");
      expect(nextBuildTarget([a, b], undefined, rangeFrom(0))).to.equal(b);
    });
  });
});

/**
 * The PLACEMENT half: the ladder must place the whole wanted set, not stall
 * at `activeSites === 0`. These pin the gate's shape without a full room
 * harness - placementGateOpen is the extracted predicate.
 */
describe("placement gate: batch the whole wanted set (owner 2026-07-29)", () => {
  const { placementGateOpen } = require("../../../src/corps/constructionPlacement");

  it("OPENS with sites already standing when a SURPLUS funds the set", () => {
    // The old rule (activeSites === 0) hid the backlog: the crew was sized
    // against one visible site while the rest of the set waited invisibly.
    expect(placementGateOpen({ activeSites: 3, wantsMore: true, atSiteCap: false, hasSurplus: true })).to.equal(true);
  });

  it("does NOT widen the board in a BOOTSTRAP room (no surplus): finish what you started", () => {
    // Production over consumption: in a cold room every extra site inflates
    // the construction sink against a ~20 e/t income and starves the very
    // spawn energy the miner upsize needs (the runt-economy world places 3
    // sites per pass instead of 1 under a naive widening). Batching is a
    // SURPLUS-SPEND lever - the same rule paving already follows - so a room
    // with nothing banked keeps the conservative one-at-a-time ladder.
    expect(placementGateOpen({ activeSites: 1, wantsMore: true, atSiteCap: false, hasSurplus: false })).to.equal(false);
  });

  it("still places on an EMPTY board without a surplus (bootstrap must progress)", () => {
    expect(placementGateOpen({ activeSites: 0, wantsMore: true, atSiteCap: false, hasSurplus: false })).to.equal(true);
  });

  it("stays open on an empty board when structures are wanted (unchanged)", () => {
    expect(placementGateOpen({ activeSites: 0, wantsMore: true, atSiteCap: false, hasSurplus: true })).to.equal(true);
  });

  it("closes when nothing more is wanted", () => {
    expect(placementGateOpen({ activeSites: 0, wantsMore: false, atSiteCap: false, hasSurplus: true })).to.equal(false);
  });

  it("closes at the engine's global site cap (never spam ERR_FULL every cooldown)", () => {
    expect(placementGateOpen({ activeSites: 40, wantsMore: true, atSiteCap: true, hasSurplus: true })).to.equal(false);
  });
});
