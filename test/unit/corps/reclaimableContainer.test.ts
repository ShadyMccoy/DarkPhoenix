import { expect } from "chai";
import { reclaimableContainer } from "../../../src/corps/constructionPlacement";

/**
 * RECLAIM THE SLOT A LINK ALREADY MADE DEAD (owner 2026-08-06: *"Controller
 * Container? It's functionally replaced by the link right?"* - and it is,
 * *"yes I think we should definitely reclaim the unused container and have a
 * mechanism for that"*).
 *
 * `CONTAINER_LIMIT = 5` is the GAME's per-room cap. In the live home room all
 * five are spent - 2 source containers, the core depot, a controller
 * container and the recycle pad - so the deposit-port rung (1.6) can never
 * place anything and `resolvePortBuffer` finds nothing, which is why 22.4% of
 * port arrivals still HOLD at a full link.
 *
 * The controller container is the one to give back, and not as a trade: it is
 * ALREADY dead. `controllerInputSpot` returns a controller LINK before it
 * looks at any container, and `findMissingControllerContainer` refuses to
 * build one while a link stands - so a container there can only be a legacy
 * from before the link, and nothing reads it. Upgraders withdraw from the
 * input spot alone.
 *
 * PRECEDENT: ConstructionCorp already retires the weakest SOURCE LINK to free
 * a link-table slot for the controller link (the LINK SWAP rung). This is the
 * same shape one table over.
 *
 * The guard is the whole design. Retiring is irreversible and destroys 5,000e
 * of build, so the trigger is GEOMETRY-PROVEN at runtime, never inferred:
 * without a controller link the container IS the input spot and reclaiming it
 * would strand the upgraders mid-upgrade.
 */
describe("reclaimableContainer (give back the slot a link already made dead)", () => {
  const pos = (x: number, y: number) => ({ x, y, roomName: "W1N1" });
  const c = (x: number, y: number, energy = 0) => ({ pos: pos(x, y), role: "controller" as const, energy });

  const census = (over: any = {}) => ({
    built: 5,
    sites: 0,
    limit: 5,
    free: 0,
    full: true,
    containers: [c(39, 40, 1859)],
    ports: [{ pos: pos(46, 11), hasContainer: false }],
    supersededControllerContainer: c(39, 40, 1859),
    ...over
  });

  it("names the superseded controller container when the table is FULL and a port is BARE", () => {
    const r = reclaimableContainer(census());
    expect(r, "there is a slot to reclaim").to.not.equal(null);
    expect(r!.pos).to.deep.equal(pos(39, 40));
    expect(r!.reason).to.contain("controller link");
  });

  /**
   * THE BLOCKING CASE (owner 2026-08-08: *"the controller link should not have
   * a container"*), measured at t72862894.
   *
   * The superseded controller container sat at (41,36) and the deposit port at
   * (43,38) - chebyshev 2, which is exactly the range `resolvePortBuffer`
   * searches and `hasContainerNear` tests. So the dead container made the port
   * rung believe that port was already served, forever, while the delivery side
   * bound the CONTROLLER's store as the port's buffer. The table was 4/5 the
   * whole time, so the FULL gate never fired and nothing noticed.
   *
   * One dead container silently costing a real port its buffer is not tidiness,
   * which is why `full` is lifted here and only here.
   */
  it("reclaims a dead container that BLOCKS a port's buffer range, free slot or not", () => {
    const blocking = census({
      built: 4,
      free: 1,
      full: false,
      containers: [c(41, 36, 40)],
      ports: [{ pos: pos(43, 38), hasContainer: true }], // "served" - by the dead one
      supersededControllerContainer: c(41, 36, 40)
    });
    const r = reclaimableContainer(blocking);
    expect(r, "the dead container is inside the port's buffer range").to.not.equal(null);
    expect(r!.pos.x).to.equal(41);
    expect(r!.reason).to.contain("blocks");
  });

  /**
   * DRAIN FIRST. Destroying a container spills its contents, and a ground pile
   * decays at ceil(amount/1000) per tick - the live one held 1,900e. Nothing
   * refills a superseded container, so a blocking reclaim can simply wait; the
   * FULL-table reclaim cannot, and pays the spill as documented.
   */
  it("WAITS for a blocking container to drain rather than spilling its load", () => {
    const loaded = census({
      built: 4,
      free: 1,
      full: false,
      containers: [c(41, 36, 1900)],
      ports: [{ pos: pos(43, 38), hasContainer: true }],
      supersededControllerContainer: c(41, 36, 1900)
    });
    expect(reclaimableContainer(loaded), "1,900e would hit the ground").to.equal(null);
    // ...and once it has drained, the same census reclaims.
    const drained = { ...loaded, containers: [c(41, 36, 20)], supersededControllerContainer: c(41, 36, 20) };
    expect(reclaimableContainer(drained)).to.not.equal(null);
  });

  it("does NOTHING while the table has a free slot - reclaim is a last resort, not a tidy-up", () => {
    // 5,000e of build is destroyed by a retire. If a rung can simply place,
    // it must; the swap exists only because the cap is hard.
    expect(reclaimableContainer(census({ built: 3, free: 2, full: false }))).to.equal(null);
  });

  it("does NOTHING when no port is bare - nothing wants the slot", () => {
    expect(reclaimableContainer(census({ ports: [{ pos: pos(46, 11), hasContainer: true }] }))).to.equal(null);
    expect(reclaimableContainer(census({ ports: [] })), "no ports at all").to.equal(null);
  });

  it("REFUSES when there is no superseded container - the guard that protects a link-less room", () => {
    // Without a controller link the container IS the upgraders' input spot.
    // The census only sets the flag when a link is geometry-proven present.
    expect(reclaimableContainer(census({ supersededControllerContainer: undefined }))).to.equal(null);
  });

  it("never proposes a source, depot or port container, however bare the ports", () => {
    const only = census({
      containers: [
        { pos: pos(11, 10), role: "source" as const, energy: 900 },
        { pos: pos(24, 25), role: "coreDepot" as const, energy: 500 }
      ],
      supersededControllerContainer: undefined
    });
    expect(reclaimableContainer(only)).to.equal(null);
  });

  it("reports the energy that will be LOST, so the retire is never silent", () => {
    const r = reclaimableContainer(census());
    expect(r!.energyLost, "a destroyed container drops its contents").to.equal(1859);
  });

  it("degrades to null on an absent census, never to a speculative retire", () => {
    expect(reclaimableContainer(null)).to.equal(null);
  });
});
