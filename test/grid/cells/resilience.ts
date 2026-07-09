/**
 * resilience cells (spec 09) - the bot on REAL captured terrain.
 *
 * The respawn-tolerant strategy ("losing a room is fine") stands on one leg:
 * a fresh colony must reliably cold-start on an arbitrary live-map room.
 * These cells run the full RCL1 cold start - bootstrap jack economy ->
 * RCL2 -> first flow miner -> source worked - on three fixtures spanning the
 * difficulty ladder (see test/fixtures/real-rooms/INDEX.md):
 *
 *   open   shard3-W11N5  (21% walls, source walk 5)
 *   plain  shard3-W2N6   (34% walls, source walks 22/23)
 *   maze   shard3-W1N6   (55% walls, source walks 25/38 - the room that
 *                         found the 550-tick bootstrap crawl and the
 *                         scout-escape harness wedge)
 *
 * True cold start: no controller level staged (addBot leaves RCL1), no
 * creeps, no quiet kit - the organic pipeline IS the subject. Fixtures are
 * border-sealed by fixtureRoom (real rooms have open exits; see its doc).
 */

import { GridCell, eventually } from "../GridCell";
import { fixtureRoom } from "../fixtureRoom";

/** The cold-start inflection points, shared by all three cells. */
function coldStartAssertions(): GridCell["assertions"] {
  return [
    eventually("bootstrap crosses to RCL2", (s) => {
      const ctrl = s.objects().find((o: any) => o.type === "controller");
      return (ctrl?.level ?? 1) >= 2;
    }),
    eventually("a flow miner is fielded (bootstrap handed over)", (s) =>
      Object.entries(s.memory?.creeps ?? {}).some(
        ([name, mem]: [string, any]) => name.startsWith("miner-") && mem?.workType === "harvest"
      )
    ),
    eventually("a source is actively worked", (s) =>
      s.objects().some((o: any) => o.type === "source" && (o.energy ?? o.energyCapacity) < (o.energyCapacity ?? 3000))
    ),
    eventually("a flow hauler follows (the loop closes)", (s) =>
      Object.entries(s.memory?.creeps ?? {}).some(
        ([name, mem]: [string, any]) => name.startsWith("hauler-") && mem?.workType === "haul"
      )
    ),
  ];
}

export function buildResilienceCells(): GridCell[] {
  return [
    {
      // The floor: an easy open room. If this is red, cold start is broken
      // everywhere, not just on hard maps.
      id: "boot-real-open-w11n5",
      tier: 3,
      avenue: "resilience",
      window: 500,
      rooms: { home: fixtureRoom("shard3-W11N5") },
      bot: { x: 40, y: 33 },
      assertions: coldStartAssertions(),
    },
    {
      // Median difficulty: 2 sources at walk ~22 - the distance regime the
      // synthetic calibration never covered (its jack was tuned at 5 tiles).
      id: "boot-real-plain-w2n6",
      tier: 3,
      avenue: "resilience",
      // 900, measured: RCL2 at ~600 on this geometry, hauler ~+130.
      window: 900,
      rooms: { home: fixtureRoom("shard3-W2N6") },
      bot: { x: 25, y: 27 },
      assertions: coldStartAssertions(),
    },
    {
      // The maze that found the crawl: 55% walls, walks 25/38. Window
      // calibrated to the measured pre-fix RCL2 at ~552 plus handover; the
      // long-jack sizing should pull it well inside.
      id: "boot-real-maze-w1n6",
      tier: 3,
      avenue: "resilience",
      window: 900,
      rooms: { home: fixtureRoom("shard3-W1N6") },
      bot: { x: 28, y: 30 },
      assertions: coldStartAssertions(),
    },
  ];
}
