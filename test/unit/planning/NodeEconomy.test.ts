import { expect } from "chai";
import {
  buildNodeSpawnInput,
  valuateNodeSpawn,
  nodeSpawnValue,
  NodeSpawnValuationInput,
} from "../../../src/planning/NodeEconomy";
import { Position } from "../../../src/types/Position";

function at(x: number, y: number): Position {
  return { x, y, roomName: "W0N0" };
}

/** A node with a spawn + controller at the peak and `n` local sources nearby. */
function node(overrides: Partial<NodeSpawnValuationInput> = {}): NodeSpawnValuationInput {
  return {
    spawnPos: at(25, 25),
    controllerPos: at(25, 22),
    localSources: [{ id: "source-A", capacity: 3000, pos: at(25, 30) }],
    ...overrides,
  };
}

describe("NodeEconomy", () => {
  describe("buildNodeSpawnInput", () => {
    it("returns null when the node has no controller to create value", () => {
      expect(buildNodeSpawnInput(node({ controllerPos: undefined }))).to.equal(null);
    });

    it("returns null when the node has no sources at all", () => {
      expect(buildNodeSpawnInput(node({ localSources: [], reachableSources: [] }))).to.equal(null);
    });

    it("places a reachable source at its true range from the spawn", () => {
      const input = buildNodeSpawnInput(
        node({ localSources: [], reachableSources: [{ capacity: 3000, distance: 40 }] })
      );
      expect(input).to.not.equal(null);
      const reach = input!.sources.find((s) => s.id === "reach-0");
      expect(reach).to.not.equal(undefined);
      // Chebyshev distance from the spawn to the synthesised source is its range.
      expect(input!.dist(reach!.pos, input!.sinks[0].pos)).to.equal(40);
    });
  });

  describe("nodeSpawnValue", () => {
    it("is positive for a node with a local source and a controller", () => {
      expect(nodeSpawnValue(node())).to.be.greaterThan(0);
    });

    it("is zero for a site that can sustain no chain", () => {
      expect(nodeSpawnValue(node({ controllerPos: undefined }))).to.equal(0);
    });

    it("rises with a second local source", () => {
      const one = nodeSpawnValue(node());
      const two = nodeSpawnValue(
        node({
          localSources: [
            { id: "source-A", capacity: 3000, pos: at(20, 30) },
            { id: "source-B", capacity: 3000, pos: at(30, 30) },
          ],
        })
      );
      expect(two).to.be.greaterThan(one);
    });

    it("counts a reachable adjacent-node source, but worth less than a local one", () => {
      const localOnly = nodeSpawnValue(node());

      // Add a reachable source far across the boundary: it adds value...
      const withReachable = nodeSpawnValue(
        node({ reachableSources: [{ capacity: 3000, distance: 35 }] })
      );
      expect(withReachable).to.be.greaterThan(localOnly);

      // ...but a far reachable source contributes less than a second LOCAL one,
      // because the longer haul burns more spawn overhead.
      const withSecondLocal = nodeSpawnValue(
        node({
          localSources: [
            { id: "source-A", capacity: 3000, pos: at(25, 30) },
            { id: "source-B", capacity: 3000, pos: at(25, 29) },
          ],
        })
      );
      expect(withReachable).to.be.lessThan(withSecondLocal);
    });

    it("values a nearer reachable source above a farther one", () => {
      const near = nodeSpawnValue(node({ reachableSources: [{ capacity: 3000, distance: 15 }] }));
      const far = nodeSpawnValue(node({ reachableSources: [{ capacity: 3000, distance: 45 }] }));
      expect(near).to.be.greaterThan(far);
    });
  });

  describe("valuateNodeSpawn", () => {
    it("returns the full chain of corps the spawn would stand up", () => {
      const v = valuateNodeSpawn(node())!;
      expect(v).to.not.equal(null);
      const kinds = v.enabledCorps.map((c) => c.kind);
      expect(kinds).to.include("mine");
      expect(kinds).to.include("haul");
      expect(kinds).to.include("upgrade");
    });
  });
});
