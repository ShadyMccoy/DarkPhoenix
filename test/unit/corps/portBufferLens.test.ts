import { expect } from "chai";
import {
  CONTROLLER_CONTAINER_RANGE,
  PORT_BUFFER_RANGE,
  isPortBuffer,
  pickPortBuffer
} from "../../../src/corps/nodeEnergy";
import { classifyContainers, ContainerCensus } from "../../../src/telemetry/containerCensus";
import { reclaimableContainer } from "../../../src/corps/constructionPlacement";

/**
 * SPEC 56 - ONE ANSWER TO "WHICH CONTAINER IS THIS PORT'S BUFFER".
 *
 * There were four answers in the tree and three were wrong. The failure is not
 * that any one reader is mistaken - it is that the three wrong ones agree with
 * each other and DEADLOCK the fourth:
 *
 *   - placement (`findMissingPortContainer`) sees a container within 2, calls
 *     the port served, and skips it forever;
 *   - the census reports that same port `hasContainer: true`, so
 *     `reclaimableContainer`'s `wanted` never fires and no slot is freed;
 *   - delivery (`resolvePortBuffer`) drops loads into it;
 *   - the tender (`portPosts`) refuses it - correctly, it is the controller's
 *     feed store - so the port has no post and nothing drains the drop.
 *
 * Measured t72862894/t72869702: the live (43,38) port, with the controller
 * container at (41,36) sitting at chebyshev 2.
 */
describe("the port-buffer lens (spec 56: one predicate, four readers)", () => {
  const pos = (x: number, y: number) => ({ x, y, roomName: "W1N1" });
  const link = pos(43, 38);
  const controller = pos(40, 36);

  it("accepts a container inside the buffer range", () => {
    expect(isPortBuffer(pos(44, 39), link, controller)).to.equal(true);
  });

  it("rejects one beyond it - the range is a parked tender's reach, not a preference", () => {
    expect(isPortBuffer(pos(46, 41), link, controller)).to.equal(false);
    expect(PORT_BUFFER_RANGE, "the reach a parked tender bridges").to.equal(2);
  });

  it("REJECTS the controller's feed store even when it sits inside the range", () => {
    // (41,36) is chebyshev 2 from the link and chebyshev 1 from the controller:
    // in range for a port buffer by distance alone, and the one container the
    // tender will never pump back out through a link.
    const ctrlContainer = pos(41, 36);
    expect(Math.max(Math.abs(ctrlContainer.x - link.x), Math.abs(ctrlContainer.y - link.y))).to.equal(2);
    expect(isPortBuffer(ctrlContainer, link, controller)).to.equal(false);
  });

  it("draws the controller guard at CONTROLLER_CONTAINER_RANGE, not a hand-picked number", () => {
    const justInside = pos(41, 39); // cheb 2 from link, cheb 3 from controller
    const justOutside = pos(41, 40); // cheb 2 from link, cheb 4 from controller
    expect(Math.max(Math.abs(justInside.x - controller.x), Math.abs(justInside.y - controller.y))).to.equal(
      CONTROLLER_CONTAINER_RANGE
    );
    expect(isPortBuffer(justInside, link, controller), "at the guard = feed store").to.equal(false);
    expect(isPortBuffer(justOutside, link, controller), "past the guard = a real buffer").to.equal(true);
  });

  it("with no controller in view it is pure distance - a partial room must not invent a guard", () => {
    expect(isPortBuffer(pos(41, 36), link)).to.equal(true);
  });

  describe("pickPortBuffer", () => {
    it("takes the NEAREST qualifying container, not the first one scanned", () => {
      const far = { pos: pos(45, 40) }; // cheb 2
      const near = { pos: pos(44, 38) }; // cheb 1
      expect(pickPortBuffer(link, [far, near], controller)).to.equal(near);
      expect(pickPortBuffer(link, [near, far], controller), "order must not matter").to.equal(near);
    });

    it("skips the controller's feed store even when it is the NEAREST thing to the link", () => {
      const ctrlContainer = { pos: pos(42, 37) }; // cheb 1 from link, cheb 2 from controller
      const real = { pos: pos(44, 40) }; // cheb 2 from link, cheb 4 from controller
      expect(pickPortBuffer(link, [ctrlContainer, real], controller)).to.equal(real);
    });

    it("returns null when the only containers nearby are the controller's", () => {
      expect(pickPortBuffer(link, [{ pos: pos(41, 36) }], controller)).to.equal(null);
    });
  });
});

/**
 * The census is one of the four readers, and its answer is load-bearing: it
 * feeds `reclaimableContainer`, which is what frees a capped table's slot for a
 * port that has none.
 */
describe("the census reads the port buffer through the same lens (spec 56)", () => {
  const pos = (x: number, y: number) => ({ x, y, roomName: "W1N1" });
  const container = (x: number, y: number, energy = 0) => ({ pos: pos(x, y), store: { energy } });

  // Live W43N23 in miniature: a port link at (43,38) with NO buffer of its own,
  // and the superseded controller container at (41,36) two tiles away.
  const world = (containers: ReturnType<typeof container>[], sites = 0): any => ({
    storage: pos(25, 25),
    controllerPos: pos(40, 36),
    sources: [pos(10, 10), pos(20, 40)],
    links: [pos(26, 25), pos(39, 35), pos(43, 38)],
    coreLink: pos(26, 25),
    controllerLink: pos(39, 35),
    spawns: [pos(24, 24)],
    containers,
    sites
  });

  const census = (room: any): ContainerCensus => {
    const c = classifyContainers(room);
    expect(c, "a readable room always yields a census").to.not.equal(null);
    return c as ContainerCensus;
  };

  it("does NOT report a port buffered off the controller's feed store", () => {
    const c = census(world([container(41, 36, 1900)]));
    const port = c.ports.find(p => p.pos.x === 43 && p.pos.y === 38);
    expect(port, "the (43,38) link is a port").to.not.equal(undefined);
    expect(port!.hasContainer, "the controller's container is not this port's buffer").to.equal(false);
  });

  it("...so the capped table FREES the dead slot the port has been waiting on", () => {
    // Five slots spent, one of them the dead controller container. Before the
    // shared lens the census called the port served, `wanted` stayed false, and
    // the reclaim never fired - the port waited forever behind a full table.
    const c = census(
      world([
        container(11, 10),
        container(21, 40),
        container(24, 25),
        container(41, 36, 1900),
        container(24, 23)
      ])
    );
    expect(c.full, "five containers is the game cap").to.equal(true);
    const r = reclaimableContainer(c);
    expect(r, "a bare port + a dead controller container + a full table = reclaim").to.not.equal(null);
    expect(r!.pos.x).to.equal(41);
    expect(r!.pos.y).to.equal(36);
    expect(r!.energyLost, "the spill stays visible, never silent").to.equal(1900);
  });

  it("classifies a genuine port buffer as 'port' even when it sits 4 from the controller", () => {
    // cheb 4 from the controller is PAST the tender's guard, so this is a real
    // buffer. The old census role range of 4 called it "controller", which made
    // it a `supersededControllerContainer` - a demolition target while a tender
    // stood on it.
    const c = census(world([container(43, 40)]));
    const row = c.containers.find(x => x.pos.x === 43 && x.pos.y === 40)!;
    expect(Math.max(Math.abs(43 - 40), Math.abs(40 - 36)), "cheb from the controller").to.equal(4);
    expect(row.role).to.equal("port");
    expect(c.supersededControllerContainer, "a live port buffer is not dead controller plumbing").to.equal(undefined);
  });

  it("still flags the port BUFFERED once a real container is built for it", () => {
    const c = census(world([container(44, 39, 500)]));
    const port = c.ports.find(p => p.pos.x === 43 && p.pos.y === 38)!;
    expect(port.hasContainer).to.equal(true);
  });
});
