import { expect } from "chai";
import { ContainerCensus, classifyContainers } from "../../../src/telemetry/containerCensus";

/**
 * THE CONTAINER TABLE IS A HARD-CAPPED RESOURCE AND NOTHING COULD SEE IT
 * (owner 2026-08-06: *"I'd like more information and instrumentation and
 * telemetry on the containers getting built next to the links"*).
 *
 * `CONTAINER_LIMIT = 5` is the GAME's per-room cap, not a policy knob. Every
 * container rung competes for those five slots, and captures carried no
 * structure inventory at all - so five separate diagnoses this week ended at
 * *"I can't tell from telemetry"*:
 *
 *   - the port container: `portBufferFree` never stamped, meaning
 *     `resolvePortBuffer` found nothing beside either deposit link, and
 *     nothing could say whether that was a full table, a bad tile, or a
 *     detector returning no ports;
 *   - the controller container: `controllerStock` read 2,659 against a link
 *     capacity of 800, leaving ~1,859e staged in SOMETHING, and no way to
 *     tell a container (which upgraders cannot withdraw from - they draw from
 *     `controllerInputSpot`, and a link outranks a container there) from a
 *     ground pile (which they can pick up, but which decays at 2 e/t).
 *
 * The census answers both by ROLE, because "5 containers" is not the useful
 * fact - WHICH five is. A container's role is derived from geometry the room
 * can see, never from a memory flag that can drift from where the thing
 * actually stands.
 *
 * The `supersededControllerContainer` flag is the reclaim trigger: a
 * controller-side container that a controller LINK has replaced as the input
 * spot. It is dead weight by construction - `controllerInputSpot` returns the
 * link before it ever looks at a container, and `findMissingControllerContainer`
 * refuses to build one while a link exists - so the slot it holds is free for
 * the taking.
 */
describe("containerCensus (which five slots, not how many)", () => {
  const pos = (x: number, y: number) => ({ x, y, roomName: "W1N1" });
  const container = (x: number, y: number, energy = 0) => ({
    structureType: "container",
    id: `c${x}_${y}`,
    pos: pos(x, y),
    store: { energy }
  });

  // storage(25,25) + core link(26,25); controller(40,40) + controller link(41,40);
  // sources at (10,10) and (40,10); a deposit port link at (46,11).
  const world = (containers: any[]): any => ({
    storage: pos(25, 25),
    controllerPos: pos(40, 40),
    sources: [pos(10, 10), pos(40, 10)],
    links: [pos(26, 25), pos(41, 40), pos(46, 11)],
    coreLink: pos(26, 25),
    controllerLink: pos(41, 40),
    spawns: [pos(24, 24)],
    containers,
    sites: 0
  });

  // Every case below stages a readable room, so the census is non-null; the
  // ABSENT case has its own test at the end.
  const census = (room: any): ContainerCensus => {
    const c = classifyContainers(room);
    expect(c, "a readable room always yields a census").to.not.equal(null);
    return c as ContainerCensus;
  };

  it("classifies each container by the thing it stands beside", () => {
    const c = census(
      world([
        container(11, 10, 1200), // beside source 1
        container(41, 10, 300), // beside source 2
        container(24, 25, 900), // beside storage = core depot
        container(39, 40, 1859), // beside controller
        container(45, 12, 0) // beside the deposit port link
      ])
    );
    const roles = c.containers.map((x: { role: string }) => x.role);
    expect(roles).to.have.members(["source", "source", "coreDepot", "controller", "port"]);
  });

  it("counts the table against the GAME cap, sites included - the number a rung gates on", () => {
    const c = census({ ...world([container(11, 10), container(24, 25)]), sites: 1 });
    expect(c.built, "built containers").to.equal(2);
    expect(c.sites, "container sites standing").to.equal(1);
    expect(c.limit).to.equal(5);
    expect(c.free, "slots a rung may still claim").to.equal(2);
    expect(c.full).to.equal(false);
  });

  it("reports the table FULL at the cap, which is when every rung below stalls silently", () => {
    const c = census(
      world([container(11, 10), container(41, 10), container(24, 25), container(39, 40), container(24, 23)])
    );
    expect(c.full).to.equal(true);
    expect(c.free).to.equal(0);
  });

  it("names which deposit ports HAVE a container and which do not - the portBufferFree blind spot", () => {
    const c = census(world([container(45, 12)]));
    // (46,11) is a port link with a container at range 2; the core and
    // controller links are not ports and must not appear.
    expect(c.ports).to.have.length(1);
    expect(c.ports[0].pos).to.deep.equal(pos(46, 11));
    expect(c.ports[0].hasContainer, "a container stands within 2").to.equal(true);
  });

  it("...and reports a BARE port, which is the live W43N23 state", () => {
    const c = census(world([container(11, 10)]));
    expect(c.ports).to.have.length(1);
    expect(c.ports[0].hasContainer, "nothing within 2 of the port link").to.equal(false);
  });

  it("flags a controller container SUPERSEDED by a controller link - the reclaim trigger", () => {
    const c = census(world([container(39, 40, 1859)]));
    expect(c.supersededControllerContainer, "a link owns the input spot; this container is dead weight").to.not.equal(
      undefined
    );
    expect(c.supersededControllerContainer!.pos).to.deep.equal(pos(39, 40));
    expect(c.supersededControllerContainer!.energy, "and it is holding energy nothing can withdraw").to.equal(1859);
  });

  it("does NOT flag a controller container when there is NO controller link", () => {
    // Without a link the container IS the input spot and reclaiming it would
    // strand the upgraders. The flag must be geometry-proven, never assumed.
    const w = world([container(39, 40, 1859)]);
    const c = census({ ...w, links: [pos(26, 25)], controllerLink: undefined });
    expect(c.supersededControllerContainer, "the container is load-bearing here").to.equal(undefined);
  });

  it("never flags a SOURCE or depot container, however full the table", () => {
    const c = census(world([container(11, 10), container(24, 25), container(41, 10)]));
    expect(c.supersededControllerContainer).to.equal(undefined);
  });

  it("degrades to an empty census on a room it cannot read, never to a fabricated zero", () => {
    const c = classifyContainers(undefined);
    expect(c).to.equal(null);
  });
});
