import { expect } from "chai";
import { record, reset, rows } from "../../../src/telemetry/BlackBox";
import { WatchdogInput, runWatchdogs } from "../../../src/telemetry/watchdogs";
import { setupGlobals, Game } from "../mock";
import { SpawningCorp } from "../../../src/corps/SpawningCorp";
import { registerCorpKind, getCorpKind } from "../../../src/economy/CorpKind";
import { harvestKind } from "../../../src/corps/kinds/harvestKind";

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

/**
 * SPAWN ROW carries the PART COUNT (t72689264).
 *
 * F1's per-class decomposition settles actual parts/tick against the plan's
 * parts/tick, but the spawn row only ever recorded `cost`. Energy is the wrong
 * unit for that comparison and misleads in a specific direction: a reserver is
 * 600e per CLAIM part, so reservers read as 21% of spawn SPEND while being 4%
 * of spawn PARTS - a five-fold error on exactly the class P4 already got wrong
 * once. Inferring parts back out of cost needs a per-role constant, i.e. the
 * ledger re-deriving a body the bot already built. Record it at the source.
 */
describe("blackbox spawn row carries the body part count (F1 decomposition)", () => {
  // Game is a module-level singleton in the mock: a getObjectById stub left
  // installed here leaks into every later spec file (it broke sizingRecord's
  // UpgradingCorp lookup once). Restore it.
  let realGetObjectById: unknown;
  beforeEach(() => {
    realGetObjectById = (Game as any).getObjectById;
  });
  afterEach(() => {
    (Game as any).getObjectById = realGetObjectById;
  });

  it("SpawningCorp.executeSpawn returns the parts spawned, not just success", () => {
    setupGlobals();
    if (!getCorpKind("harvest")) registerCorpKind(harvestKind as any);
    (global as any).FIND_MY_STRUCTURES = (global as any).FIND_MY_STRUCTURES ?? 107;
    const body: BodyPartConstant[] = [];
    (Game as any).getObjectById = () => ({
      id: "spawn1",
      spawning: null,
      room: { name: "W1N1", energyAvailable: 5000, memory: {}, find: () => [] },
      pos: { x: 25, y: 25, roomName: "W1N1" },
      spawnCreep: (b: BodyPartConstant[]) => {
        body.push(...b);
        return OK;
      }
    });
    const corp = new SpawningCorp("W1N1-spawning", "spawn1", "W1N1");
    const purchase = corp.executeSpawn("harvest", "miner", "mining-W1N1-harvest-s1", 700, 100);
    expect(body.length).to.be.greaterThan(0);
    // Methodology #8: the executor reports the whole PURCHASE - parts for
    // F1's decomposition AND the energy actually debited for the receipt.
    expect(purchase && purchase.parts).to.equal(body.length);
    expect(purchase && purchase.cost).to.equal(650); // 5W3M miner body under a 700 grant
  });

  it("returns null (falsy, so truthiness callers are unchanged) when the spawn does not happen", () => {
    setupGlobals();
    if (!getCorpKind("harvest")) registerCorpKind(harvestKind as any);
    (global as any).FIND_MY_STRUCTURES = (global as any).FIND_MY_STRUCTURES ?? 107;
    (Game as any).getObjectById = () => ({ id: "spawn1", spawning: {} }); // already busy
    const corp = new SpawningCorp("W1N1-spawning", "spawn1", "W1N1");
    expect(corp.executeSpawn("harvest", "miner", "mining-W1N1-harvest-s1", 700, 100)).to.equal(null);
  });
});
