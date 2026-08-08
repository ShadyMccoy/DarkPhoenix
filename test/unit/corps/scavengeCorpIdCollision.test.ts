import { expect } from "chai";
import { legacyNodeId } from "../../../src/corps/kinds/carryKind";
import { stockId } from "../../../src/economy/scavenge";

/**
 * THE SCAVENGE CORP-ID COLLISION (found while joining the SCAV outflow split,
 * audit t72866607 — currently LATENT, documented, deliberately NOT renamed).
 *
 * A carry corp's runtime handle is `${room}-hauling-${sourceId.slice(-4)}`. On a
 * real Screeps object id (24 hex chars) the last four characters are a fine
 * unique suffix — that is the convention's premise. A SCAVENGE stock id is not
 * an object id: `stockId` encodes it POSITIONALLY as `scavenge-ROOM-X-Y`, so
 * slice(-4) takes a fragment of the COORDINATES. The live corp ids show it
 * plainly — a stock at (8,8) produces the handle `-8-8`, and one at (36,27)
 * produces `6-27` with the tens digit of x cut off.
 *
 * Cutting a digit off x is not itself harmful; losing UNIQUENESS is. Any two
 * stocks in one room whose x differ only in the tens digit, at the same y, map
 * to the SAME corp — so one of the two piles silently gets no hauler. That is
 * indistinguishable from the symptom this cycle is chasing (a standing pile no
 * mechanism ever clears), which is why it is pinned here rather than left as a
 * remark.
 *
 * NOT FIXED IN PLACE: changing the handle renames every live hauling corp and
 * orphans its creeps — CLAUDE.md's corp-id-prefix trap, verbatim. The fix needs
 * a migration (or a positional-id branch that keeps existing handles stable),
 * and that is an owner-visible decision, not a drive-by rename. This test
 * documents the defect and will fail the moment someone fixes it — at which
 * point it becomes the regression pin. Its assertions are written to assert the
 * COLLISION, so read a failure here as "the bug was fixed, update this test".
 */
describe("scavenge corp id - positional ids lose uniqueness under slice(-4)", () => {
  const ROOM = "W1N1";

  it("takes a coordinate FRAGMENT, not an object-id suffix", () => {
    // (36,27) -> "scavenge-W1N1-36-27" -> last 4 chars are "6-27": x's tens digit is gone.
    expect(legacyNodeId(ROOM, stockId({ x: 36, y: 27, roomName: ROOM }))).to.equal("W1N1-hauling-6-27");
    // (8,8) -> "...-8-8" -> the slice reaches back across the separator.
    expect(legacyNodeId(ROOM, stockId({ x: 8, y: 8, roomName: ROOM }))).to.equal("W1N1-hauling--8-8");
  });

  it("COLLIDES for two distinct stocks in one room (x differing by ten, same y)", () => {
    const a = stockId({ x: 5, y: 30, roomName: ROOM });
    const b = stockId({ x: 15, y: 30, roomName: ROOM });
    expect(a).to.not.equal(b, "the stock ids themselves are distinct");
    expect(legacyNodeId(ROOM, a)).to.equal(legacyNodeId(ROOM, b));
    // ^ the defect: two piles, one corp. Whichever commission materializes
    //   second adopts the first's corp, and one pile is left with no hauler.
  });

  it("and again at a two-digit boundary - it is the whole tens digit that is lost", () => {
    expect(legacyNodeId(ROOM, stockId({ x: 1, y: 30, roomName: ROOM }))).to.equal(
      legacyNodeId(ROOM, stockId({ x: 11, y: 30, roomName: ROOM }))
    );
  });

  it("is sound on a real object id, which is why the convention was written this way", () => {
    const s1 = "source-5982fc1db097071b4adbcd90";
    const s2 = "source-5982fc1db097071b4adbcd92";
    expect(legacyNodeId(ROOM, s1)).to.not.equal(legacyNodeId(ROOM, s2));
    expect(legacyNodeId(ROOM, s1)).to.equal("W1N1-hauling-cd90");
  });
});
