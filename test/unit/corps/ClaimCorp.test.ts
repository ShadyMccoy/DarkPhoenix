import { expect } from "chai";
import "../../../src/types/Memory";
import { Game as MockGame } from "../mock";
import { ClaimCorp } from "../../../src/corps/ClaimCorp";

/**
 * The claimer is the expansion campaign's one body (spec 06): demanded only
 * while Memory.expansion is live and the target is not yet ours, held-funded
 * (CLAIM 600 is indivisible), never doubled, and priced BELOW income corps -
 * expansion is CAPEX, and the economy that pays for it spawns first.
 */

function setWorld(opts: { creeps?: Record<string, unknown>; rooms?: Record<string, unknown>; expansion?: unknown }): void {
  const spawn = { id: "spawn1", room: { name: "W0N0" }, owner: { username: "me" } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).Game = {
    ...MockGame,
    creeps: opts.creeps ?? {},
    rooms: opts.rooms ?? {},
    time: 100,
    getObjectById: (id: string) => (id === "spawn1" ? spawn : null)
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).Memory = { expansion: opts.expansion };
}

const EXPANSION = {
  roomName: "W1N0",
  nodeId: "n1",
  spawnPos: { x: 25, y: 25, roomName: "W1N0" },
  sinceTick: 50
};
const ctx = { energyCapacity: 800, tick: 100 };

describe("ClaimCorp demand (one held-funded claimer per campaign)", () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game = MockGame;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).Memory;
  });

  it("demands one claimer while the campaign is live", () => {
    setWorld({ expansion: EXPANSION });
    const demands = new ClaimCorp("W1N0-claim", "spawn1").getSpawnDemand(ctx);
    expect(demands).to.have.length(1);
    const d = demands[0];
    expect(d.role).to.equal("claimer");
    expect(d.holdToFund, "CLAIM 600 is indivisible - bank for it").to.equal(true);
    expect(d.blocking).to.equal(false);
    expect(d.minCost).to.equal(650);
    expect(d.value, "below income corps (reserver 115, haulers 90-110)").to.be.lessThan(90);
  });

  it("demands nothing without a campaign", () => {
    setWorld({ expansion: undefined });
    expect(new ClaimCorp("W1N0-claim", "spawn1").getSpawnDemand(ctx)).to.have.length(0);
  });

  it("demands nothing once the target room is ours", () => {
    setWorld({ expansion: EXPANSION, rooms: { W1N0: { controller: { my: true } } } });
    expect(new ClaimCorp("W1N0-claim", "spawn1").getSpawnDemand(ctx)).to.have.length(0);
  });

  it("never doubles: a claimer in the pipe (even mid-spawn) satisfies it", () => {
    setWorld({
      expansion: EXPANSION,
      creeps: { c1: { memory: { corpId: "claim-W1N0", workType: "claim" }, spawning: true } }
    });
    const corp = new ClaimCorp("W1N0-claim", "spawn1", "claim-W1N0");
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("demands nothing while a CLAIM is unaffordable", () => {
    setWorld({ expansion: EXPANSION });
    expect(new ClaimCorp("W1N0-claim", "spawn1").getSpawnDemand({ energyCapacity: 550, tick: 100 })).to.have.length(0);
  });
});
