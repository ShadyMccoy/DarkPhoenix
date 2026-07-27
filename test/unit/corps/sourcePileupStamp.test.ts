import { expect } from "chai";
import { CarryCorp } from "../../../src/corps/CarryCorp";

/**
 * Source-pileup instrument (2026-07-26, owner-reported "energy piling up and
 * rotting at the sources"). The hauler sizing (haulCarryNeeded) reads sustained
 * inflow only - no buffer-drain term - so a standing pile is invisible to the
 * decision. Before changing behaviour we stamp the ACTUAL pickup buffer + the
 * source-link state so the next capture names the mechanism: hauler under-sizing
 * (pile high, no link with headroom) vs a link-throughput backlog (pile high, an
 * adjacent link pinned at capacity because the hub link is clamped).
 */
describe("CarryCorp source-pileup stamp (spec 14 instrument)", () => {
  const G: any = global;

  const link = (x: number, y: number, energy: number, cap: number) => ({
    structureType: "link",
    pos: { x, y },
    store: {
      [G.RESOURCE_ENERGY]: energy,
      getCapacity: (_r: string) => cap
    }
  });
  const container = (x: number, y: number, energy: number) => ({
    structureType: "container",
    pos: { x, y },
    store: { [G.RESOURCE_ENERGY]: energy }
  });
  const pile = (x: number, y: number, amount: number) => ({
    resourceType: G.RESOURCE_ENERGY,
    pos: { x, y },
    amount
  });

  const roomWith = (structures: any[], resources: any[], owned: any[]) => ({
    find: (type: number) => {
      if (type === G.FIND_STRUCTURES) return structures;
      if (type === G.FIND_DROPPED_RESOURCES) return resources;
      if (type === G.FIND_MY_STRUCTURES) return owned;
      return [];
    }
  });

  const mkCorp = (pickup: { x: number; y: number; roomName: string } | null): any => {
    const corp = new CarryCorp("W43N23-hauling-cd92", "spawn-1") as any;
    corp.pickupPos = pickup;
    return corp;
  };

  beforeEach(() => {
    G.RESOURCE_ENERGY = "energy";
    G.STRUCTURE_CONTAINER = "container";
    G.STRUCTURE_LINK = "link";
    G.FIND_STRUCTURES = 107;
    G.FIND_DROPPED_RESOURCES = 106;
    G.FIND_MY_STRUCTURES = 108;
    G.Game = { rooms: {} as any };
  });

  it("under-sized signature: sums container + pile within range 1, reports NO link", () => {
    // dbcd92 shape live t72588289: container overflowing (5993), a fringe pile,
    // and no source link -> the fix is the missing drain term, not the network.
    G.Game.rooms.W43N23 = roomWith([container(37, 40, 1993)], [pile(38, 40, 4000)], []);
    const s = mkCorp({ x: 37, y: 40, roomName: "W43N23" }).readPickupBuffer();
    expect(s.staged).to.equal(5993);
    expect(s.srcLinkEnergy).to.equal(null);
    expect(s.srcLinkCap).to.equal(null);
  });

  it("link-backlog signature: reports the adjacent source link at capacity", () => {
    // container full AND a link within range 2 pinned at cap => a link the hub
    // can't drain, not a hauler shortfall.
    G.Game.rooms.W43N23 = roomWith([container(37, 40, 2000)], [], [link(38, 41, 800, 800)]);
    const s = mkCorp({ x: 37, y: 40, roomName: "W43N23" }).readPickupBuffer();
    expect(s.staged).to.equal(2000);
    expect(s.srcLinkEnergy).to.equal(800);
    expect(s.srcLinkCap).to.equal(800);
  });

  it("excludes structures/piles outside range (Chebyshev): a far container is not this source's buffer", () => {
    G.Game.rooms.W43N23 = roomWith([container(37, 40, 1000), container(30, 30, 9999)], [pile(29, 29, 500)], []);
    const s = mkCorp({ x: 37, y: 40, roomName: "W43N23" }).readPickupBuffer();
    expect(s.staged).to.equal(1000);
  });

  it("reports null (unmeasurable, NOT zero) when the pickup room is not visible", () => {
    // remote source, no creep on station -> Game.rooms has no entry. Null is the
    // signal that a remote drain term must read a durable buffer, not vision.
    const s = mkCorp({ x: 9, y: 3, roomName: "W42N22" }).readPickupBuffer();
    expect(s.staged).to.equal(null);
    expect(s.srcLinkEnergy).to.equal(null);
  });

  it("reports null when the corp has no resolved pickup position yet", () => {
    const s = mkCorp(null).readPickupBuffer();
    expect(s.staged).to.equal(null);
  });
});
