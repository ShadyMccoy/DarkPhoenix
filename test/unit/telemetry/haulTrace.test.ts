/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import {
  HAUL_TRACE_MAX_ROWS,
  haulTraceRows,
  haulTraceSubject,
  resetHaulTrace,
  traceHaulTick
} from "../../../src/telemetry/HaulTrace";

/**
 * THE PER-TICK HAULER RECORDER (owner 2026-08-02: "store to memory each of the
 * 1500 ticks of a hauler. See what it's doing. Or not doing.").
 *
 * Every hauling instrument we have is an aggregate, and the aggregates all read
 * healthy on a source that never drained: duty 0.94 "active", carry fielded
 * ABOVE plan, and cd8e buffer-full for 100% of a window with 2860 staged. A
 * mean over a bimodal life cannot show a creep standing on one tile for forty
 * ticks - which is exactly the class of blindness spec 40 names.
 */
describe("HaulTrace (one hauler, one tick per row)", () => {
  const creep = (name: string, x = 10, y = 20, mem: any = {}): any => ({
    name,
    pos: { x, y, roomName: "W1N1" },
    memory: mem,
    getActiveBodyparts: (p: string) => (p === "carry" ? 4 : 4)
  });

  beforeEach(() => {
    resetHaulTrace();
    (global as any).CARRY = "carry";
    (global as any).MOVE = "move";
    (global as any).Memory = {};
    (global as any).RawMemory = { segments: {} };
  });

  it("records NOTHING until armed - the recorder is opt-in", () => {
    traceHaulTick(creep("h1"), "corp-a", 100, 0, "active");
    expect(haulTraceRows()).to.have.length(0);
  });

  it("LOCKS onto one subject, so the timeline is one life and not a crowd", () => {
    (global as any).Memory.haulTrace = { corp: "corp-a" };
    traceHaulTick(creep("h1"), "corp-a", 100, 0, "active");
    traceHaulTick(creep("h2"), "corp-a", 100, 0, "active"); // a sibling, same corp
    traceHaulTick(creep("h1"), "corp-a", 101, 50, "active");
    expect(haulTraceSubject()).to.equal("h1");
    expect(haulTraceRows()).to.have.length(2);
  });

  it("honours a corp filter, so an unrelated corp's hauler is never adopted", () => {
    (global as any).Memory.haulTrace = { corp: "corp-a" };
    traceHaulTick(creep("other"), "corp-b", 100, 0, "active");
    expect(haulTraceSubject()).to.equal(undefined);
    expect(haulTraceRows()).to.have.length(0);
  });

  it("captures position, load, leg and verdict - the fields a stall is read from", () => {
    (global as any).Memory.haulTrace = { creep: "h1" };
    traceHaulTick(creep("h1", 34, 21, { working: true, assignedSourceId: "source-cd8e" }), "corp-a", 100, 0, "idleSource");
    const [row] = haulTraceRows();
    expect(row[0], "tick").to.equal(100);
    expect([row[1], row[2]], "position").to.deep.equal([34, 21]);
    expect(row[4], "energy").to.equal(0);
    expect(row[5], "leg: 1 = loading").to.equal(1);
    expect(row[6], "class: idleSource").to.equal(1);
  });

  it("rings at one creep generation rather than growing without bound", () => {
    (global as any).Memory.haulTrace = { creep: "h1" };
    for (let i = 0; i < HAUL_TRACE_MAX_ROWS + 50; i += 1) {
      traceHaulTick(creep("h1"), "corp-a", 100 + i, 0, "active");
    }
    const rows = haulTraceRows();
    expect(rows).to.have.length(HAUL_TRACE_MAX_ROWS);
    expect(rows[rows.length - 1][0], "keeps the MOST RECENT ticks").to.equal(100 + HAUL_TRACE_MAX_ROWS + 49);
  });

  it("flushes to its own segment, not to Memory (Memory is parsed every tick)", () => {
    (global as any).Memory.haulTrace = { creep: "h1" };
    for (let i = 0; i < 30; i += 1) traceHaulTick(creep("h1"), "corp-a", 100 + i, i, "active");
    const seg = (global as any).RawMemory.segments[7];
    expect(seg, "segment 7 carries the trace").to.be.a("string");
    expect(JSON.parse(seg).subject).to.equal("h1");
    expect((global as any).Memory.haulTraceRows, "never in Memory").to.equal(undefined);
  });

  it("stops cleanly when disarmed live", () => {
    (global as any).Memory.haulTrace = { creep: "h1" };
    traceHaulTick(creep("h1"), "corp-a", 100, 0, "active");
    delete (global as any).Memory.haulTrace;
    traceHaulTick(creep("h1"), "corp-a", 101, 0, "active");
    expect(haulTraceSubject()).to.equal(undefined);
  });
});
