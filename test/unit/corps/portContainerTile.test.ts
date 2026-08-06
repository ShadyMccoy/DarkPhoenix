import { expect } from "chai";
import { bestPortContainerTile, PortApproach } from "../../../src/corps/constructionPlacement";

const open = (): ((x: number, y: number) => boolean) => () => false;
const nothingOccupied = (): ((x: number, y: number) => boolean) => () => false;

/** A route's ENTRY TILE - the exit it comes in through (see PortApproach: a
 *  remote source's raw position would be a cross-room geometry bug). */
function from(x: number, y: number, flowRate = 10): PortApproach {
  return { from: { x, y }, flowRate };
}

/**
 * DEPOSIT-PORT CONTAINER SITING (owner 2026-08-06: *"it's important to build
 * the container where it's best accessible to incoming hauling routes as well
 * as adjacent to the link of course"*).
 *
 * The two requirements are only compatible because a parked TENDER bridges the
 * gap: `parkedRelayCarry`'s premise is a creep standing adjacent to both its
 * bank and its sink, which forces `range(container, link) <= 2` and nothing
 * tighter. That slack is the whole budget for hauler accessibility.
 */
describe("bestPortContainerTile", () => {
  const link = { x: 25, y: 25 };

  it("never returns the link's own tile, and stays within range 2 of it", () => {
    const t = bestPortContainerTile(link, [from(25, 5)], open(), nothingOccupied());
    expect(t).to.not.equal(null);
    expect(t!.x === link.x && t!.y === link.y, "picked the link's own tile").to.equal(false);
    expect(Math.max(Math.abs(t!.x - link.x), Math.abs(t!.y - link.y))).to.be.at.most(2);
  });

  it("sites toward the approach: a route from the NORTH puts the container north", () => {
    const t = bestPortContainerTile(link, [from(25, 2)], open(), nothingOccupied())!;
    expect(t.y, `expected north of the link, got ${JSON.stringify(t)}`).to.be.lessThan(link.y);
  });

  it("and from the SOUTH puts it south - the scorer follows the flow, not a fixed offset", () => {
    const t = bestPortContainerTile(link, [from(25, 48)], open(), nothingOccupied())!;
    expect(t.y, `expected south of the link, got ${JSON.stringify(t)}`).to.be.greaterThan(link.y);
  });

  it("weights by flowRate: the fatter route wins a two-sided pull", () => {
    // Equal geometry north and south; the south route carries 4x the energy.
    const t = bestPortContainerTile(link, [from(25, 2, 10), from(25, 48, 40)], open(), nothingOccupied())!;
    expect(t.y, "the 40 e/t route should win over the 10 e/t one").to.be.greaterThan(link.y);
  });

  it("requires a parking tile adjacent to BOTH container and link", () => {
    // Wall off everything except a corridor that leaves the far ring with no
    // tile touching the link: only range-1 candidates can then qualify.
    const blocked = (x: number, y: number): boolean =>
      Math.max(Math.abs(x - link.x), Math.abs(y - link.y)) === 1 && !(x === link.x && y === link.y - 1);
    const t = bestPortContainerTile(link, [from(25, 2)], blocked, nothingOccupied())!;
    expect(t).to.not.equal(null);
    // Whatever it picked must have a free neighbour that also touches the link.
    const cheb = (ax: number, ay: number, bx: number, by: number): number =>
      Math.max(Math.abs(ax - bx), Math.abs(ay - by));
    let ok = false;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const px = t.x + dx;
        const py = t.y + dy;
        if (px === t.x && py === t.y) continue;
        if (px === link.x && py === link.y) continue;
        if (!blocked(px, py) && cheb(px, py, link.x, link.y) <= 1) ok = true;
      }
    }
    expect(ok, "elected tile has no shared parking tile with the link").to.equal(true);
  });

  it("skips occupied tiles (an existing structure or pending site)", () => {
    const north = { x: 25, y: 24 };
    const occupied = (x: number, y: number): boolean => x === north.x && y === north.y;
    const t = bestPortContainerTile(link, [from(25, 2)], open(), occupied)!;
    expect(t.x === north.x && t.y === north.y, "elected an occupied tile").to.equal(false);
  });

  it("returns null when nothing legal is reachable", () => {
    const allBlocked = (): boolean => true;
    expect(bestPortContainerTile(link, [from(25, 2)], allBlocked, nothingOccupied())).to.equal(null);
  });

  it("never leaves the room bounds when the link sits on the edge", () => {
    const edge = { x: 1, y: 1 };
    const t = bestPortContainerTile(edge, [from(48, 48)], open(), nothingOccupied())!;
    expect(t.x).to.be.at.least(1);
    expect(t.y).to.be.at.least(1);
    expect(t.x).to.be.at.most(48);
    expect(t.y).to.be.at.most(48);
  });

  it("with NO approaches it still returns a legal tile, nearest the link", () => {
    // Degenerate but reachable: a port whose routes have not been planned yet.
    const t = bestPortContainerTile(link, [], open(), nothingOccupied())!;
    expect(Math.max(Math.abs(t.x - link.x), Math.abs(t.y - link.y))).to.equal(1);
  });
});
