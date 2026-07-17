/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The raid meter (spec 13): a tick-exact mirror of the engine's invader-raid
 * fuse. Accrues at the harvest site, resets on a sighted raid, and classifies
 * into idle / armed (>= 65k, guard pre-spawns) / overdue (> 130k, raids
 * provably don't fire here - guard disarms).
 */
import "../../../src/types/Memory";
import { expect } from "chai";
import { accrueRaidDebt, raidMeterState, recordRaidSighting } from "../../../src/utils/raidMeter";
import { RAID_ARM_FLOOR, RAID_GOAL_CEIL } from "../../../src/economy/primitives";

describe("utils/raidMeter - the invader-raid fuse mirror", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any };
  let savedGame: unknown;
  let savedMemory: unknown;

  beforeEach(() => {
    savedGame = g.Game;
    savedMemory = g.Memory;
    g.Game = { time: 5000 };
    g.Memory = { roomIntel: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
  });

  it("accrues harvested energy onto the room's intel entry", () => {
    g.Memory.roomIntel.W1N1 = { lastVisit: 1, sourceCount: 1 };
    accrueRaidDebt("W1N1", 10);
    accrueRaidDebt("W1N1", 12);
    expect(g.Memory.roomIntel.W1N1.raidDebt).to.equal(22);
  });

  it("creates a partial intel entry when the room was never scouted (mark precedent)", () => {
    accrueRaidDebt("W2N2", 8);
    expect(g.Memory.roomIntel.W2N2.raidDebt).to.equal(8);
    expect(g.Memory.roomIntel.W2N2.lastVisit).to.equal(5000);
  });

  it("ignores non-positive amounts and survives a missing Memory (harness-safe)", () => {
    accrueRaidDebt("W1N1", 0);
    accrueRaidDebt("W1N1", -5);
    expect(g.Memory.roomIntel.W1N1).to.equal(undefined);
    delete g.Memory;
    expect(() => accrueRaidDebt("W1N1", 10)).to.not.throw();
  });

  it("a raid sighting zeroes the debt and stamps the observation", () => {
    g.Memory.roomIntel.W1N1 = { lastVisit: 1, raidDebt: 88_000 };
    recordRaidSighting("W1N1");
    expect(g.Memory.roomIntel.W1N1.raidDebt).to.equal(0);
    expect(g.Memory.roomIntel.W1N1.lastRaidSeen).to.equal(5000);
  });

  it("classifies idle / armed / overdue at the engine-fact thresholds", () => {
    expect(raidMeterState(undefined)).to.equal("idle");
    expect(raidMeterState(0)).to.equal("idle");
    expect(raidMeterState(RAID_ARM_FLOOR - 1)).to.equal("idle");
    expect(raidMeterState(RAID_ARM_FLOOR)).to.equal("armed");
    expect(raidMeterState(100_000)).to.equal("armed");
    expect(raidMeterState(RAID_GOAL_CEIL)).to.equal("armed");
    expect(raidMeterState(RAID_GOAL_CEIL + 1)).to.equal("overdue");
  });

  it("the mirror lives in Memory, not corp state: accrual is readable after a corp churn", () => {
    // (The duplicate-miner incident: harvest corps are dropped and re-made
    // exactly when an invader wipes a remote - the counter must not ride
    // corp serialization.)
    accrueRaidDebt("W3N3", 500);
    // simulate a full corp-store loss: nothing to do - the meter is already
    // independent of any corp object.
    expect(g.Memory.roomIntel.W3N3.raidDebt).to.equal(500);
  });
});
