/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { meteredMoveTo } from "../../../src/corps/movement";

/**
 * P-CPU meter (spec 23 step 1): every metered moveTo accumulates its CPU
 * delta per corp FAMILY into Memory.pathMeter, reset on tick change - the
 * measured BEFORE number the RouteCache doctrine needs, naming the top
 * pathing spender per capture.
 */
describe("meteredMoveTo (the pathing BEFORE number)", () => {
  let used = 0;
  const mkCreep = (corpId: string, cost: number): any => ({
    pos: { x: 10, y: 10, roomName: "W1N1" },
    memory: { corpId },
    moveTo: () => {
      used += cost;
      return 0;
    }
  });

  beforeEach(() => {
    used = 0;
    (global as any).Game = { time: 500, cpu: { getUsed: () => used } };
    (global as any).Memory = {};
  });

  it("accumulates calls and cpu per corp family, families split by id prefix", () => {
    meteredMoveTo(mkCreep("hauling-W1N1-hauling-abcd", 0.7), { x: 1, y: 1, roomName: "W1N1" } as any);
    meteredMoveTo(mkCreep("hauling-W1N1-hauling-ef01", 0.3), { x: 1, y: 1, roomName: "W1N1" } as any);
    meteredMoveTo(mkCreep("upgrading-W1N1-upgrading", 0.5), { x: 1, y: 1, roomName: "W1N1" } as any);
    const m = (Memory as any).pathMeter;
    expect(m.calls).to.equal(3);
    expect(m.cpu).to.be.closeTo(1.5, 1e-9);
    expect(m.byCorp.hauling.calls).to.equal(2);
    expect(m.byCorp.hauling.cpu).to.be.closeTo(1.0, 1e-9);
    expect(m.byCorp.upgrading.cpu).to.be.closeTo(0.5, 1e-9);
  });

  it("resets on tick change and survives corpless creeps", () => {
    meteredMoveTo(mkCreep("mining-W1N1-harvest-a", 0.4), { x: 1, y: 1, roomName: "W1N1" } as any);
    (global as any).Game.time = 501;
    const orphan = mkCreep("", 0.2);
    orphan.memory = {};
    meteredMoveTo(orphan, { x: 1, y: 1, roomName: "W1N1" } as any);
    const m = (Memory as any).pathMeter;
    expect(m.tick).to.equal(501);
    expect(m.calls, "fresh tick, fresh meter").to.equal(1);
    expect(m.byCorp.unattributed.calls).to.equal(1);
  });
});
