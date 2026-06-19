/**
 * The extensibility proof (spec 00, test C) - rungs 2 and 3 of the proof
 * ladder. This file defines a toy "beacon" corp kind USING ONLY THE
 * FRAMEWORK'S PUBLIC API (Corp base + economy modules) and proves the full
 * lifecycle: planning -> materialization -> execution -> persistence ->
 * demobilization. If this test ever needs an edit elsewhere in src/ to pass,
 * the framework has a hardwired seam - that is the bug.
 */

import { expect } from "chai";
import { Corp, SerializedCorp } from "../../../src/corps/Corp";
import { Position } from "../../../src/types/Position";
import { Commission, corpIdFor } from "../../../src/economy/Commission";
import {
  CorpKind,
  CorpStore,
  deserializeStore,
  materializeCommissions,
  registerCorpKind,
  resetCorpKinds,
  runCommissionedCorps,
  serializeStore
} from "../../../src/economy/CorpKind";
import { planCommissions } from "../../../src/economy/commissionPlan";
import { ColonyProblem } from "../../../src/economy/CorpPlanner";
import { describeCorpKindConformance } from "./conformance";

// ---------------------------------------------------------------------------
// The toy kind: a "beacon" that wants to exist wherever the colony has a spawn.
// Auxiliary shape, no spawn build-time, no creeps - the minimal full citizen.
// ---------------------------------------------------------------------------

class BeaconCorp extends Corp {
  public ticksRun = 0;
  public constructor(customId: string) {
    super("moving", "beacon", customId);
  }
  public work(_tick: number): void {
    this.ticksRun += 1;
  }
  public getPosition(): Position {
    return { x: 25, y: 25, roomName: "W0N0" };
  }
}

const runLog: string[] = [];

const beaconKind: CorpKind<BeaconCorp> = {
  kind: "beacon",
  runOrder: 40,
  propose(problem: ColonyProblem): Commission[] {
    return problem.spawns.map(s => ({
      corpId: corpIdFor("beacon", s.id),
      kind: "beacon",
      shape: "auxiliary",
      consumes: { spawnPartsPerTick: 0 },
      produces: { valuePerTick: 1 },
      assignment: { spawnId: s.id }
    }));
  },
  materialize(c: Commission, existing: BeaconCorp | undefined): BeaconCorp {
    return existing ?? new BeaconCorp(c.corpId);
  },
  run(corp: BeaconCorp, tick: number): void {
    corp.work(tick);
    runLog.push(`${corp.id}@${tick}`);
  },
  serializeCorp(corp: BeaconCorp): SerializedCorp {
    return corp.serialize();
  },
  deserializeCorp(data: SerializedCorp): BeaconCorp {
    const corp = new BeaconCorp(data.id);
    corp.deserialize(data);
    return corp;
  },
  body(): BodyPartConstant[] {
    return [];
  }
};

// A minimal pure world: one spawn, one source, a controller sink.
const ROOM = "W0N0";
const at = (x: number, y = 0): Position => ({ x, y, roomName: ROOM });
const world: ColonyProblem = {
  spawns: [{ id: "spawn1", pos: at(0) }],
  sources: [{ id: "src1", nodeId: "n1", pos: at(10), rate: 10, maxMiners: 1 }],
  sinks: [{ id: "ctrl", kind: "controller", pos: at(5), value: 50, capacity: 100 }],
  dist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
};

describe("framework extensibility: a new corp kind via the public API only", () => {
  beforeEach(() => {
    resetCorpKinds();
    runLog.length = 0;
    registerCorpKind(beaconKind as CorpKind);
  });
  after(() => resetCorpKinds());

  it("rejects duplicate registration (wiring bug surfaces immediately)", () => {
    expect(() => registerCorpKind(beaconKind as CorpKind)).to.throw(/already registered/);
  });

  it("PLAN: the kind's proposal appears in planCommissions alongside the solver's", () => {
    const { commissions } = planCommissions(world);
    const beacon = commissions.filter(c => c.kind === "beacon");
    expect(beacon).to.have.length(1);
    expect(beacon[0].corpId).to.equal("beacon-spawn1");
    // the solver's own commissions are present too (composition, not replacement)
    expect(commissions.some(c => c.kind === "harvest")).to.equal(true);
    expect(commissions.some(c => c.kind === "carry")).to.equal(true);
  });

  it("BIND: materialize creates once, then updates the same instance", () => {
    const { commissions } = planCommissions(world);
    const store: CorpStore = new Map();
    const first = materializeCommissions(commissions, store);
    expect(first.created).to.equal(1); // only beacon is registered; solver kinds skipped
    expect(first.skipped).to.be.greaterThan(0);
    const instance = store.get("beacon-spawn1")!.corp;
    const second = materializeCommissions(commissions, store);
    expect(second.created).to.equal(0);
    expect(second.updated).to.equal(1);
    expect(store.get("beacon-spawn1")!.corp).to.equal(instance);
  });

  it("EXECUTE: runCommissionedCorps drives the kind exactly once per tick", () => {
    const { commissions } = planCommissions(world);
    const store: CorpStore = new Map();
    materializeCommissions(commissions, store);
    runCommissionedCorps(store, 7);
    runCommissionedCorps(store, 8);
    expect(runLog).to.deep.equal(["beacon-spawn1@7", "beacon-spawn1@8"]);
    expect((store.get("beacon-spawn1")!.corp as BeaconCorp).ticksRun).to.equal(2);
  });

  it("PERSIST: the store round-trips through Memory-shaped data with the commission intact", () => {
    const { commissions } = planCommissions(world);
    const store: CorpStore = new Map();
    materializeCommissions(commissions, store);
    const restored = deserializeStore(JSON.parse(JSON.stringify(serializeStore(store))));
    const entry = restored.get("beacon-spawn1");
    expect(entry).to.not.equal(undefined);
    expect(entry!.corp.id).to.equal("beacon-spawn1");
    expect(entry!.commission.assignment).to.deep.equal({ spawnId: "spawn1" });
  });

  it("DEMOBILIZE: a vanished commission removes the corp; unregistered kinds untouched", () => {
    const { commissions } = planCommissions(world);
    const store: CorpStore = new Map();
    materializeCommissions(commissions, store);
    expect(store.size).to.equal(1);
    const without = commissions.filter(c => c.kind !== "beacon");
    const result = materializeCommissions(without, store);
    expect(result.removed).to.equal(1);
    expect(store.size).to.equal(0);
  });

  it("HYSTERESIS: a vanished corp is KEPT (retiring) while canDemobilize forbids dropping", () => {
    const { commissions } = planCommissions(world);
    const store: CorpStore = new Map();
    materializeCommissions(commissions, store);
    expect(store.get("beacon-spawn1")!.corp.retiring).to.equal(false);

    const without = commissions.filter(c => c.kind !== "beacon");

    // canDemobilize forbids dropping (e.g. the corp still has living creeps):
    // kept in the store and flagged retiring, not removed.
    const kept = materializeCommissions(without, store, () => false);
    expect(kept.removed).to.equal(0);
    expect(kept.retained).to.equal(1);
    expect(store.size).to.equal(1);
    expect(store.get("beacon-spawn1")!.corp.retiring).to.equal(true);

    // Re-commissioning clears the retiring flag (it's back in the plan).
    materializeCommissions(commissions, store, () => false);
    expect(store.get("beacon-spawn1")!.corp.retiring).to.equal(false);

    // Once canDemobilize allows it (the fleet has drained), the corp drops.
    const dropped = materializeCommissions(without, store, () => true);
    expect(dropped.removed).to.equal(1);
    expect(store.size).to.equal(0);
  });
});

// Rung 1 for the toy kind itself - proves the conformance harness runs.
describeCorpKindConformance(beaconKind as CorpKind, {
  problem: world,
  commission: {
    corpId: "beacon-spawn1",
    kind: "beacon",
    shape: "auxiliary",
    consumes: { spawnPartsPerTick: 0 },
    produces: { valuePerTick: 1 },
    assignment: { spawnId: "spawn1" }
  },
  expectedSpawnPartsPerTick: 0
});
