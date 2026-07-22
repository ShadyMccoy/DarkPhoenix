import { expect } from "chai";
import {
  splitRoadByEnergyFlow,
  aggregateTrunkRoadSinks,
  RoadTile,
  ConstructionRecord,
  TrunkRouteTiles
} from "../../../src/economy/roadSegments";

/**
 * Trunk-road A/Z split (owner directive 2026-07-22). Tiles are ordered
 * SOURCE -> HOME (index 0 nearest the mine): Z is the source-end share, A the
 * home-end share, split proportional to energy flow
 * (f_Z = sourceRate/(sourceRate+homeSupply)) by cumulative remaining WORK.
 *
 * The leak these pin retires: a 20-tile trunk became 20 construction sinks ->
 * 20 micro hauler-edges from one source (t72505602). Two aggregate segments
 * replace them: one source->Z edge, one home pool project.
 */
describe("splitRoadByEnergyFlow (trunk A/Z segmentation)", () => {
  /** N tiles along a corridor, uniform work unless overridden. */
  const corridor = (n: number, work = 300): RoadTile[] =>
    Array.from({ length: n }, (_, i) => ({ x: i, y: 0, roomName: "W1N1", remaining: work }));

  it("splits proportional to energy flow: source 10, home 30 -> Z gets ~1/4 from the mine end", () => {
    const tiles = corridor(20); // 6000 total work
    const { z, a, fZ } = splitRoadByEnergyFlow(tiles, 10, 30);
    expect(fZ).to.be.closeTo(0.25, 1e-9);
    // Z is the first ~quarter of the work from the SOURCE end (index 0..).
    expect(z.length).to.equal(5);
    expect(z[0].x).to.equal(0); // mine-most tile
    expect(a.length).to.equal(15);
    expect(a[a.length - 1].x).to.equal(19); // home-most tile
    // partition is complete and disjoint
    expect(z.length + a.length).to.equal(20);
  });

  it("equal supply splits the road in half", () => {
    const { z, a, fZ } = splitRoadByEnergyFlow(corridor(10), 20, 20);
    expect(fZ).to.be.closeTo(0.5, 1e-9);
    expect(z.length).to.equal(5);
    expect(a.length).to.equal(5);
  });

  it("splits by WORK, not tile count: a heavy mine-end tile shrinks Z's tile share", () => {
    // 4 tiles, f_Z = 0.5 -> Z target = half the work. First tile is a swamp
    // road (3x work); it alone is >= half, so Z is just that one tile.
    const tiles: RoadTile[] = [
      { x: 0, y: 0, roomName: "W1N1", remaining: 900 }, // heavy source-end
      { x: 1, y: 0, roomName: "W1N1", remaining: 300 },
      { x: 2, y: 0, roomName: "W1N1", remaining: 300 },
      { x: 3, y: 0, roomName: "W1N1", remaining: 300 }
    ]; // total 1800, half = 900
    const { z, a } = splitRoadByEnergyFlow(tiles, 10, 10);
    expect(z.map(t => t.x)).to.deep.equal([0]); // the one heavy tile fills Z's share
    expect(a.map(t => t.x)).to.deep.equal([1, 2, 3]);
  });

  it("home bankrupt (homeSupply 0): the source owns the whole road", () => {
    const { z, a, fZ } = splitRoadByEnergyFlow(corridor(8), 10, 0);
    expect(fZ).to.equal(1);
    expect(z.length).to.equal(8);
    expect(a.length).to.equal(0);
  });

  it("source dead (rate 0): the home crew owns the whole road", () => {
    const { z, a, fZ } = splitRoadByEnergyFlow(corridor(8), 0, 30);
    expect(fZ).to.equal(0);
    expect(z.length).to.equal(0);
    expect(a.length).to.equal(8);
  });

  it("both ends fund but rounding empties one: the boundary tile still goes to the empty end", () => {
    // Tiny source share (f_Z ~ 0.06) over 3 tiles would round Z to 0 tiles by
    // work, but the source DOES supply energy - it must own its mine-most tile
    // so a builder+hauler segment exists at the source (a road built from both
    // ends needs two ends).
    const { z, a } = splitRoadByEnergyFlow(corridor(3, 1000), 2, 30);
    expect(z.length).to.be.greaterThan(0);
    expect(a.length).to.be.greaterThan(0);
    expect(z[0].x, "Z owns the mine-most tile").to.equal(0);
  });

  it("a single tile is indivisible - goes to the majority-share end", () => {
    expect(splitRoadByEnergyFlow(corridor(1), 30, 10).z.length, "source majority -> Z").to.equal(1);
    expect(splitRoadByEnergyFlow(corridor(1), 10, 30).a.length, "home majority -> A").to.equal(1);
  });

  it("empty route -> empty segments (no crash)", () => {
    const { z, a } = splitRoadByEnergyFlow([], 10, 10);
    expect(z).to.deep.equal([]);
    expect(a).to.deep.equal([]);
  });

  it("neither end supplies energy: home is the contractor of last resort", () => {
    const { z, a, fZ } = splitRoadByEnergyFlow(corridor(4), 0, 0);
    expect(fZ).to.equal(0);
    expect(a.length).to.equal(4);
    expect(z.length).to.equal(0);
  });
});

/**
 * The aggregation that retires the micro-hauler leak (t72505602): N per-tile
 * road sinks -> 2 aggregate sinks per route (Z source-end, A home-end). Only
 * matched trunk-road tiles aggregate; everything else passes through per-site.
 */
describe("aggregateTrunkRoadSinks (per-route A/Z aggregation)", () => {
  const roadRec = (id: string, x: number, y: number, roomName = "W1N1", remaining = 300): ConstructionRecord => ({
    id,
    x,
    y,
    roomName,
    structureType: "road",
    remaining
  });

  // A trunk route cedc: 8 tiles ordered SOURCE(0,0) -> HOME(7,0).
  const cedcRoute = (sourceRate = 10): TrunkRouteTiles => ({
    sourceId: "cedc",
    tiles: Array.from({ length: 8 }, (_, i) => ({ x: i, y: 0, roomName: "W1N1" })),
    sourceRate
  });

  it("collapses a trunk's per-tile road sinks into exactly one Z and one A aggregate", () => {
    const records = Array.from({ length: 8 }, (_, i) => roadRec(`site${i}`, i, 0));
    const out = aggregateTrunkRoadSinks(records, [cedcRoute(10)], 30); // f_Z = 0.25
    const ids = out.map(o => o.id).sort();
    expect(ids).to.deep.equal(["road-A-cedc", "road-Z-cedc"]);
    const z = out.find(o => o.id === "road-Z-cedc")!;
    const a = out.find(o => o.id === "road-A-cedc")!;
    // Z sits at the mine-most tile (x=0), A at the home-most (x=7).
    expect(z.x).to.equal(0);
    expect(a.x).to.equal(7);
    // f_Z 0.25 of 8 tiles * 300 = 600 work at Z (2 tiles), 1800 at A (6 tiles).
    expect(z.remaining).to.equal(600);
    expect(a.remaining).to.equal(1800);
  });

  it("passes NON-road construction (extensions, containers) through per-site", () => {
    const records: ConstructionRecord[] = [
      { id: "ext1", x: 20, y: 20, roomName: "W1N1", structureType: "extension", remaining: 3000 },
      { id: "cont1", x: 30, y: 30, roomName: "W1N1", structureType: "container", remaining: 5000 }
    ];
    const out = aggregateTrunkRoadSinks(records, [cedcRoute()], 30);
    expect(out.map(o => o.id).sort()).to.deep.equal(["cont1", "ext1"]);
    expect(out.every(o => o.remaining > 0)).to.equal(true);
  });

  it("passes road sites that belong to NO known route through per-site (in-room paving)", () => {
    const records = [roadRec("stray", 44, 44)]; // not on cedc's corridor
    const out = aggregateTrunkRoadSinks(records, [cedcRoute()], 30);
    expect(out.map(o => o.id)).to.deep.equal(["stray"]);
  });

  it("a route with a single standing tile stays per-site (nothing to aggregate)", () => {
    const out = aggregateTrunkRoadSinks([roadRec("only", 3, 0)], [cedcRoute()], 30);
    expect(out.map(o => o.id)).to.deep.equal(["only"]);
  });

  it("mixes aggregated trunk tiles and passthrough sites in one call", () => {
    const records = [
      roadRec("t0", 0, 0),
      roadRec("t1", 1, 0),
      roadRec("t2", 2, 0),
      { id: "ext", x: 25, y: 25, roomName: "W1N1", structureType: "extension", remaining: 3000 }
    ];
    const out = aggregateTrunkRoadSinks(records, [cedcRoute(10)], 30);
    const ids = out.map(o => o.id).sort();
    expect(ids).to.include("ext");
    expect(ids).to.include("road-Z-cedc");
    expect(ids).to.include("road-A-cedc");
    expect(ids).to.not.include("t0"); // the trunk tiles were aggregated away
  });

  it("only ONE end funded (home bankrupt) still emits a single Z aggregate, not micro-sites", () => {
    const records = Array.from({ length: 6 }, (_, i) => roadRec(`s${i}`, i, 0));
    const out = aggregateTrunkRoadSinks(records, [cedcRoute(10)], 0); // f_Z = 1
    expect(out.map(o => o.id)).to.deep.equal(["road-Z-cedc"]);
    expect(out[0].remaining).to.equal(1800); // all 6 tiles
  });

  it("conserves total remaining work across the split (no energy invented or lost)", () => {
    const records = Array.from({ length: 8 }, (_, i) => roadRec(`s${i}`, i, 0, "W1N1", 250 + i * 10));
    const total = records.reduce((s, r) => s + r.remaining, 0);
    const out = aggregateTrunkRoadSinks(records, [cedcRoute(10)], 30);
    expect(out.reduce((s, o) => s + o.remaining, 0)).to.equal(total);
  });
});
