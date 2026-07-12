import { expect } from "chai";
import { record, reset, rows } from "../../../src/telemetry/BlackBox";
import { WatchdogInput, runWatchdogs } from "../../../src/telemetry/watchdogs";

describe("BlackBox (flight recorder)", () => {
  beforeEach(() => reset());

  it("records fixed-shape rows in order", () => {
    record("spawn", { role: "miner", corp: "harvest-1", cost: 250 }, 100);
    record("hold", { role: "hauler", bank: 120 }, 101);
    expect(rows()).to.have.length(2);
    expect(rows()[0]).to.deep.equal({ t: 100, k: "spawn", d: { role: "miner", corp: "harvest-1", cost: 250 } });
    expect(rows()[1].k).to.equal("hold");
  });

  it("caps the ring (oldest rows drop first)", () => {
    for (let i = 0; i < 450; i++) record("watch", { i }, i);
    expect(rows().length).to.be.at.most(400);
    expect(rows()[0].d.i).to.equal(450 - rows().length);
    expect(rows()[rows().length - 1].d.i).to.equal(449);
  });

  it("truncates oversized error messages", () => {
    record("err", { phase: "loop", msg: "x".repeat(500) }, 1);
    expect((rows()[0].d.msg as string).length).to.be.at.most(160);
  });
});

describe("watchdogs (pure alert rules)", () => {
  const healthy: WatchdogInput = {
    tick: 10_000,
    rcl: 3,
    lastSpawnTick: 9_950,
    minDowngradeTicks: 20_000,
    bucket: 9_000,
    errRowsInWindow: 0
  };

  it("stays quiet on a healthy colony", () => {
    expect(runWatchdogs(healthy)).to.deep.equal([]);
  });

  it("fires the wedge alarm: no spawn for too long at RCL>=2", () => {
    const alerts = runWatchdogs({ ...healthy, lastSpawnTick: 10_000 - 1500 });
    expect(alerts.some(a => a.kind === "no-spawn")).to.equal(true);
  });

  it("does not fire the wedge alarm at RCL1 (bootstrap owns it)", () => {
    expect(runWatchdogs({ ...healthy, rcl: 1, lastSpawnTick: 0 })).to.deep.equal([]);
  });

  it("fires on a low downgrade timer", () => {
    const alerts = runWatchdogs({ ...healthy, minDowngradeTicks: 3_000 });
    expect(alerts.some(a => a.kind === "downgrade")).to.equal(true);
  });

  it("fires on bucket collapse", () => {
    const alerts = runWatchdogs({ ...healthy, bucket: 800 });
    expect(alerts.some(a => a.kind === "bucket")).to.equal(true);
  });

  it("fires on a caught-error burst", () => {
    const alerts = runWatchdogs({ ...healthy, errRowsInWindow: 12 });
    expect(alerts.some(a => a.kind === "errors")).to.equal(true);
  });
});
