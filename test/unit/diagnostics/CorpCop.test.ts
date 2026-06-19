import { expect } from "chai";
import {
  CorpCop,
  CopSnapshot,
  liveCorpIdsFromMemory,
  orphanedCreeps,
  orphanStopwatchRunning,
  snapshotFromMemory
} from "../../integration/diagnostics/CorpCop";

const snap = (tick: number, creeps: CopSnapshot["creeps"], live: string[]): CopSnapshot => ({
  tick,
  creeps,
  liveCorpIds: new Set(live)
});

describe("CorpCop / orphanedCreeps rule", () => {
  it("flags a creep whose corpId matches no live corp", () => {
    const v = orphanedCreeps(snap(1, [{ name: "miner-1", corpId: "mining-W0N0-harvest-3604", workType: "harvest" }], []));
    expect(v).to.have.length(1);
    expect(v[0].rule).to.equal("orphaned-creep");
    expect(v[0].subject).to.equal("miner-1");
  });

  it("does NOT flag a creep a live corp claims", () => {
    const live = ["mining-W0N0-harvest-3604"];
    const v = orphanedCreeps(snap(1, [{ name: "miner-1", corpId: "mining-W0N0-harvest-3604" }], live));
    expect(v).to.have.length(0);
  });

  it("ignores spawning creeps and un-stamped creeps", () => {
    const v = orphanedCreeps(
      snap(
        1,
        [
          { name: "spawning-1", corpId: "gone", spawning: true },
          { name: "unstamped-1" } // no corpId
        ],
        []
      )
    );
    expect(v).to.have.length(0);
  });
});

describe("CorpCop / orphanStopwatchRunning rule", () => {
  it("surfaces a creep the bot itself marked orphaned", () => {
    const v = orphanStopwatchRunning(snap(30, [{ name: "h-1", corpId: "x", orphanedSince: 12 }], ["x"]));
    expect(v).to.have.length(1);
    expect(v[0].rule).to.equal("orphan-stopwatch");
  });
});

describe("CorpCop accumulation / sustained threshold", () => {
  it("reports a violation only once it persists for >= sustainedTicks", () => {
    const cop = new CorpCop([orphanedCreeps]);
    for (let t = 0; t < 4; t++) cop.observe(snap(t, [{ name: "m", corpId: "dead" }], []));
    expect(cop.sustained(5)).to.have.length(0); // only 4 ticks
    expect(cop.sustained(4)).to.have.length(1); // exactly 4 meets >= 4
  });

  it("treats a one-tick blip as noise", () => {
    const cop = new CorpCop([orphanedCreeps]);
    cop.observe(snap(0, [{ name: "m", corpId: "dead" }], [])); // orphaned one tick
    cop.observe(snap(1, [{ name: "m", corpId: "live" }], ["live"])); // re-adopted
    expect(cop.sustained(5)).to.have.length(0);
    expect(cop.report(5)).to.equal("");
  });

  it("ranks the longest-running violation first and renders a report", () => {
    const cop = new CorpCop([orphanedCreeps]);
    for (let t = 0; t < 10; t++) {
      const creeps =
        t >= 5
          ? [
              { name: "old", corpId: "dead" },
              { name: "new", corpId: "dead2" }
            ]
          : [{ name: "old", corpId: "dead" }];
      cop.observe(snap(t, creeps, []));
    }
    const s = cop.sustained(5);
    expect(s[0].subject).to.equal("old"); // 10 ticks
    expect(s[0].ticks).to.equal(10);
    expect(s.find(x => x.subject === "new")!.ticks).to.equal(5);
    expect(cop.report(5)).to.contain("orphaned-creep");
  });
});

describe("CorpCop / liveCorpIdsFromMemory", () => {
  it("reads runtime corp.id from the commission store (keyed by commission id) plus bootstrap/spawning", () => {
    const ids = liveCorpIdsFromMemory({
      commissionedCorps: {
        "harvest-source-d2cedf": { corp: { id: "mining-W0N0-harvest-3604" } },
        "carry-source-d2cedf": { corp: { id: "carry-W0N0-haul-3604" } }
      },
      bootstrapCorps: { W0N0: { id: "bootstrap-W0N0-bootstrap" } },
      spawningCorps: { abcd: { id: "spawning-W0N0-spawn-4c6d" } }
    });
    expect([...ids].sort()).to.deep.equal(
      ["bootstrap-W0N0-bootstrap", "carry-W0N0-haul-3604", "mining-W0N0-harvest-3604", "spawning-W0N0-spawn-4c6d"].sort()
    );
  });

  it("snapshotFromMemory marks an orphan against the derived live set", () => {
    const s = snapshotFromMemory(7, {
      creeps: { "miner-1": { corpId: "mining-W0N0-harvest-3604", workType: "harvest" } },
      commissionedCorps: { "harvest-source-x": { corp: { id: "some-other-corp" } } }
    });
    expect(orphanedCreeps(s)).to.have.length(1);
  });
});
