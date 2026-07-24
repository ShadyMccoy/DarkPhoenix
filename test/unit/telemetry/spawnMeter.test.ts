/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, RawMemory } from "../mock";
import { Telemetry } from "../../../src/telemetry/Telemetry";

/**
 * Spec 14 phase 3 - spawn meter. "What is spawn capacity at" must be MEASURED
 * (busy ticks over observed ticks), not derived by hand from receipts + body
 * constants (the live audit did exactly that: 94 parts x 3t in a 275t window =
 * 103% vs a 77% steady-state estimate). Every busy tick builds exactly 1/3
 * part, so partsPerTick = utilization / 3 with no spawn-start detection.
 */
describe("Telemetry spawn meter (segment 0, spec 14 phase 3)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.rooms = {};
    Game.creeps = {};
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    (Game as any).shard = { name: "shard1" };
    (Memory as any).spawnMeter = undefined;
    (Memory as any).spawnAgenda = undefined;
  });

  const spawn: any = {
    id: "sid1",
    name: "Spawn1",
    spawning: null,
    room: { energyAvailable: 2300, energyCapacityAvailable: 2300 }
  };

  const tickOnce = (t: Telemetry, time: number, busy: boolean, energy?: number): void => {
    Game.time = time;
    spawn.spawning = busy ? { name: "x", needTime: 9, remainingTime: 3 } : null;
    if (energy !== undefined) spawn.room.energyAvailable = energy;
    t.update(undefined, [], undefined);
  };

  it("measures utilization as busy/observed ticks and derives parts/tick", () => {
    (Game as any).spawns = { Spawn1: spawn };
    (Memory as any).spawnAgenda = { sid1: { tick: 100, fundingNeed: 0, queue: [{ role: "feeder" }, { role: "miner" }] } };
    const t = new Telemetry();

    tickOnce(t, 101, true);
    tickOnce(t, 102, true);
    tickOnce(t, 103, false);
    tickOnce(t, 104, true);

    const core = JSON.parse(RawMemory.segments[0]);
    expect(core.version).to.equal(14);
    const m = core.spawns[0];
    expect(m.id).to.equal("sid1");
    expect(m.windowTicks).to.equal(4);
    expect(m.utilization).to.be.closeTo(3 / 4, 1e-9);
    expect(m.partsPerTick).to.be.closeTo(3 / 4 / 3, 1e-9);
    expect(m.ceiling).to.be.closeTo(1 / 3, 1e-9);
    expect(m.queueDepth).to.equal(2);
  });

  it("endFill probe: a GAPPED build-finish records energyAvailable at the finish tick (owner: refill must overlap the build)", () => {
    (Game as any).spawns = { Spawn1: spawn };
    const t = new Telemetry();
    // Build for two ticks, then finish with the bank only 20% refilled - the
    // refill did NOT overlap the build (the tender-lag signature). A second
    // finish at 90% averages in.
    tickOnce(t, 301, true);
    tickOnce(t, 302, true);
    tickOnce(t, 303, false, 460); // finish #1: fill 0.2
    tickOnce(t, 304, true);
    tickOnce(t, 305, false, 2070); // finish #2: fill 0.9
    const core = JSON.parse(RawMemory.segments[0]);
    const m = core.spawns[0];
    expect(m.finishes).to.equal(2);
    expect(m.endFill).to.be.closeTo((0.2 + 0.9) / 2, 1e-3);
  });

  it("endFill probe: back-to-back builds never register a finish (nothing to explain)", () => {
    (Game as any).spawns = { Spawn1: spawn };
    const t = new Telemetry();
    tickOnce(t, 401, true);
    tickOnce(t, 402, true); // a new body started the same tick the old ended: spawning stays truthy
    tickOnce(t, 403, true);
    const core = JSON.parse(RawMemory.segments[0]);
    expect(core.spawns[0].finishes).to.equal(undefined);
    expect(core.spawns[0].endFill).to.equal(undefined);
  });

  it("survives across Telemetry instances (window state in Memory, not heap)", () => {
    (Game as any).spawns = { Spawn1: spawn };
    tickOnce(new Telemetry(), 201, true);
    tickOnce(new Telemetry(), 202, false);

    const m = JSON.parse(RawMemory.segments[0]).spawns[0];
    expect(m.windowTicks).to.equal(2);
    expect(m.utilization).to.be.closeTo(0.5, 1e-9);
  });

  it("reports queueDepth 0 with no agenda and never NaNs on the first tick", () => {
    (Game as any).spawns = { Spawn1: spawn };
    tickOnce(new Telemetry(), 301, false);
    const m = JSON.parse(RawMemory.segments[0]).spawns[0];
    expect(m.queueDepth).to.equal(0);
    expect(m.utilization).to.equal(0);
  });
});
