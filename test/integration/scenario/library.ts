/**
 * library - named, reusable scenarios for economy iteration.
 *
 * Each factory returns a {@link Scenario} built from {@link RoomBuilder}, so the
 * layout reads as the thing it is. Keep these minimal and composable; capture
 * richer mid-game states with exportSnapshot instead of hand-building them.
 */

import { RoomBuilder } from "./RoomBuilder";
import { Scenario } from "./Scenario";

const SPAWN = { x: 25, y: 25 };

/**
 * A single open room with two sources flanking the spawn - twice the supply, to
 * test whether the economy scales with more sources (consumption must scale too).
 */
export function twoSource(opts: { room?: string } = {}): Scenario {
  const room = opts.room ?? "W0N0";
  const builder = new RoomBuilder(room)
    .border()
    .controller(25, 10)
    .source(15, 30)
    .source(35, 30);
  return {
    name: "two-source",
    description: "Open room, two sources, spawn at centre.",
    rooms: [builder.toRoom()],
    bot: { room, ...SPAWN },
  };
}

/**
 * A single open room with one source at the given depth, a central spawn and a
 * controller near the top. `sourceY` controls how far the source is from the
 * spawn - the classic near/far mining comparison.
 */
export function singleSource(opts: { room?: string; sourceY?: number } = {}): Scenario {
  const room = opts.room ?? "W0N0";
  const sourceY = opts.sourceY ?? 30;
  const builder = new RoomBuilder(room)
    .border()
    .controller(25, 10)
    .source(25, sourceY);
  return {
    name: `single-source-y${sourceY}`,
    description: `Open room, one source at y=${sourceY}, spawn at centre.`,
    rooms: [builder.toRoom()],
    bot: { room, ...SPAWN },
  };
}

/**
 * The "three useless nodes" room: three chambers split by walls and joined by a
 * 2-tile corridor, with the source, spawn and controller each isolated in their
 * own chamber. Only viable if energy is hauled across node boundaries.
 */
export function threeChamber(opts: { room?: string } = {}): Scenario {
  const room = opts.room ?? "W0N0";
  const builder = new RoomBuilder(room)
    .border()
    .vWall(16, { gap: [24, 25] })
    .vWall(17, { gap: [24, 25] })
    .vWall(32, { gap: [24, 25] })
    .vWall(33, { gap: [24, 25] })
    .source(8, 25) // west chamber
    .controller(41, 25); // east chamber
  return {
    name: "three-chamber",
    description: "Source | spawn | controller, each isolated in its own chamber.",
    rooms: [builder.toRoom()],
    bot: { room, ...SPAWN }, // spawn lands in the centre chamber
  };
}

/**
 * A single open room pre-advanced to RCL 3 with a full set of RCL-2 extensions.
 * The clean place to exercise containers (static mining + buffered upgrading)
 * without the three-chamber logistics confounding the measurement.
 */
export function singleSourceRcl3(opts: { room?: string; sourceY?: number } = {}): Scenario {
  const base = singleSource(opts);
  const exts = [
    { x: 22, y: 24 }, { x: 28, y: 24 }, { x: 22, y: 26 }, { x: 28, y: 26 }, { x: 24, y: 22 },
  ];
  return {
    ...base,
    name: "single-source-rcl3",
    description: base.description + " Pre-advanced to RCL 3 with 5 extensions.",
    state: {
      controller: { level: 3, progress: 0 },
      structures: exts.map((e) => ({ room: base.bot.room, type: "extension", x: e.x, y: e.y, energy: 50 })),
    },
  };
}

/**
 * Two sources, pre-advanced to RCL 3 with a full set of RCL-2 extensions, so the
 * container era (static mining + buffered upgrading) and twice-the-supply scaling
 * can be exercised together without the slow climb from RCL 1.
 */
export function twoSourceRcl3(opts: { room?: string } = {}): Scenario {
  const base = twoSource(opts);
  const exts = [
    { x: 22, y: 24 }, { x: 28, y: 24 }, { x: 22, y: 26 }, { x: 28, y: 26 }, { x: 24, y: 22 },
  ];
  return {
    ...base,
    name: "two-source-rcl3",
    description: base.description + " Pre-advanced to RCL 3 with 5 extensions.",
    state: {
      controller: { level: 3, progress: 0 },
      structures: exts.map((e) => ({ room: base.bot.room, type: "extension", x: e.x, y: e.y, energy: 50 })),
    },
  };
}

/**
 * twoSourceRcl3 with the full container set already built (one on each source
 * for static mining, one by the controller to buffer the upgraders). Isolates
 * the question "do containers fix the upgrader starvation?" from the slow
 * business of actually building them.
 */
export function twoSourceRcl3Containers(opts: { room?: string } = {}): Scenario {
  const base = twoSourceRcl3(opts);
  const room = base.bot.room;
  const containers = [
    { x: 15, y: 29 }, // on source 1 (15,30)
    { x: 35, y: 29 }, // on source 2 (35,30)
    { x: 25, y: 12 }, // by the controller (25,10)
  ];
  return {
    ...base,
    name: "two-source-rcl3-containers",
    description: base.description + " Plus source + controller containers.",
    state: {
      ...base.state,
      structures: [
        ...(base.state?.structures ?? []),
        ...containers.map((c) => ({ room, type: "container", x: c.x, y: c.y, energy: 0 })),
      ],
    },
  };
}

/**
 * The three-chamber room pre-advanced to RCL 2 with two extensions already
 * built in the source chamber, so the controller-starvation-during-construction
 * regime reproduces in ~100 ticks instead of ~600. Use for fast economy
 * iteration; the bot still has to build the remaining extensions and haul
 * across the chambers.
 */
export function threeChamberRcl2(opts: { room?: string } = {}): Scenario {
  const base = threeChamber(opts);
  return {
    ...base,
    name: "three-chamber-rcl2",
    description: base.description + " Pre-advanced to RCL 2 with 2 extensions.",
    state: {
      controller: { level: 2, progress: 0 },
      structures: [
        { room: base.bot.room, type: "extension", x: 6, y: 23, energy: 50 },
        { room: base.bot.room, type: "extension", x: 6, y: 27, energy: 50 },
      ],
    },
  };
}

/**
 * The three-chamber room at RCL 3 with a full set of RCL-2 extensions, so the
 * container era (static mining + buffered upgrading, which only kicks in at
 * RCL 3) can be exercised quickly.
 */
export function threeChamberRcl3(opts: { room?: string } = {}): Scenario {
  const base = threeChamber(opts);
  const exts = [
    { x: 6, y: 23 }, { x: 6, y: 27 }, { x: 7, y: 22 }, { x: 7, y: 28 }, { x: 9, y: 22 },
  ];
  return {
    ...base,
    name: "three-chamber-rcl3",
    description: base.description + " Pre-advanced to RCL 3 with 5 extensions.",
    state: {
      controller: { level: 3, progress: 0 },
      structures: exts.map((e) => ({ room: base.bot.room, type: "extension", x: e.x, y: e.y, energy: 50 })),
    },
  };
}

/**
 * Home room (one source) plus an ADJACENT room holding a second source and no
 * owned controller - the "remote mining" shape. Nothing here is remote-specific
 * to the bot: it should scout the neighbour, claim its source as ordinary node
 * territory, and mine it like any other source, hauling the energy home across
 * the room border. Pre-advanced to RCL 3 with a full extension set so the home
 * economy has spare spawn/hauler capacity to reach across the border quickly.
 *
 * Rooms are bordered (so terrain analysis finds a peak / node in each) with an
 * aligned 2-tile gap on the shared edge, the only real exit between them; the
 * only neighbour with a source is the remote room, so it is the sole remote
 * mining opportunity.
 */
export function remoteSource(opts: { home?: string; remote?: string } = {}): Scenario {
  const home = opts.home ?? "W0N0";
  const remote = opts.remote ?? "W1N0"; // the room immediately west of home
  // Home's west edge (x=0) borders the remote room's east edge (x=49). Leave an
  // aligned 2-tile gap there so a creep can walk home <-> remote.
  const homeRoom = new RoomBuilder(home)
    .border()
    .tile(0, 24, "plain").tile(0, 25, "plain")
    .controller(25, 10)
    .source(25, 40);
  const remoteRoom = new RoomBuilder(remote)
    .border()
    .tile(49, 24, "plain").tile(49, 25, "plain")
    .source(25, 25)
    .controller(25, 40); // unowned: reserving it lifts the source to the full 3000 cap
  // Full RCL-3 extension set (10) -> 800 capacity, enough to afford a reserver
  // (CLAIM+MOVE = 650) so the remote room can be held at the full 3000 source cap.
  const exts = [
    { x: 22, y: 24 }, { x: 28, y: 24 }, { x: 22, y: 26 }, { x: 28, y: 26 }, { x: 24, y: 22 },
    { x: 26, y: 22 }, { x: 22, y: 28 }, { x: 28, y: 28 }, { x: 20, y: 24 }, { x: 30, y: 24 },
  ];
  return {
    name: "remote-source",
    description: "Home (1 source) + adjacent unowned room (1 source + controller). Should scout, claim, mine, and reserve it.",
    rooms: [homeRoom.toRoom(), remoteRoom.toRoom()],
    bot: { room: home, ...SPAWN },
    state: {
      controller: { level: 3, progress: 0 },
      structures: exts.map((e) => ({ room: home, type: "extension", x: e.x, y: e.y, energy: 50 })),
    },
  };
}
