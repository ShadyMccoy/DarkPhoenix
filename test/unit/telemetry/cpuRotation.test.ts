/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, RawMemory } from "../mock";
import { Telemetry } from "../../../src/telemetry/Telemetry";

/**
 * The corpCpu ledger rides a 10-tick ROTATION in the captured core segment
 * (Telemetry.buildCore). The live `global.cpuReport()` reads Memory.corpCpu
 * directly every tick — this gate only governs what lands in the polled
 * segment, so committed fixtures carry the ledger ~1/10 as often. These pin
 * the gate: present on a %10 tick, absent otherwise, Memory.corpCpu untouched
 * either way (the console command must not lose data on off-rotation ticks).
 */
describe("corpCpu ledger rotation (10-tick, captured segment only)", () => {
  const ledger = {
    tick: 0,
    corpsTotal: 6.0,
    byKind: { harvest: 3.0, carry: 2.0, upgrade: 1.0 },
    top: [{ corpId: "harvest-aaa", kind: "harvest", cpu: 1.5, avg: 1.4 }]
  };

  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.creeps = {};
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    (Game as any).shard = { name: "shard1" };
    Game.rooms = {} as any;
    Memory.corpCpu = { ...ledger };
  });

  function coreAt(tick: number): any {
    Game.time = tick;
    new Telemetry().update(undefined, [], undefined);
    return JSON.parse(RawMemory.segments[0]);
  }

  it("embeds the ledger in the captured core on a %10 tick", () => {
    const core = coreAt(72555190);
    expect(core.corpCpu).to.exist;
    expect(core.corpCpu.corpsTotal).to.equal(6.0);
  });

  it("omits the ledger from the captured core off-rotation", () => {
    const core = coreAt(72555187);
    expect(core.corpCpu).to.be.undefined;
  });

  it("leaves Memory.corpCpu in place off-rotation (live console still reads it)", () => {
    coreAt(72555187);
    expect(Memory.corpCpu).to.exist;
    expect(Memory.corpCpu!.corpsTotal).to.equal(6.0);
  });
});
