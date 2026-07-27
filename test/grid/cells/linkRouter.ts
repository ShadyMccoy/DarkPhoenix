/**
 * link-core-router cell (docs/specs/02, avenue: logistics).
 *
 * The spec-02 feeder-router fix in a RUNNING engine - the one place the full
 * link topology is staged (sims never build links; spec-26 blind spot). Stages
 * a link-served source (source link -> core link), a controller link, storage,
 * parked upgraders, and a feeder, then asserts on RECEIPTS and NET MOVEMENT,
 * never link fill as a proxy:
 *
 *  A. the FEEDER drains the core to storage (lastDeliver.to === "storage-drain")
 *     - the empty direction the old load-only feeder never had. RED on old.
 *  B. NO walking carry corp is commissioned for the link-served source
 *     (`carry-source-*` absent) - the link + feeder own its transport. The old
 *     code commissioned one (the thrash's second creep). RED on old.
 *  C. the source is actually MINED (funding proof, so B is not vacuous).
 *  D. energy still lands as controller PROGRESS (value is delivered, not
 *     gridlocked).
 *
 * The core + controller links are staged FULL so the feeder MUST drain (target
 * ~0), which makes A deterministic regardless of the LinkRunner/feeder tick
 * order; the upgraders burn the staged controller-link energy for D.
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const linkRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(40, 25).toRoom();

export function buildLinkRouterCells(): GridCell[] {
  let sawDrain = false;

  return [
    {
      id: "link-core-router",
      tier: 6,
      avenue: "logistics",
      window: 250,
      rooms: { home: linkRoom },
      bot: { x: 25, y: 25 },
      // RCL6 allows 3 links (core + controller + source), which the topology needs.
      controller: { level: 6, progress: 0 },
      structures: [
        { type: "storage", x: 24, y: 24, energy: 8000 }, // save regime (< warchest)
        { type: "link", x: 25, y: 23, energy: 800 }, // CORE link (beside storage), FULL
        { type: "link", x: 25, y: 12, energy: 800 }, // CONTROLLER link, FULL (upgraders burn it)
        { type: "link", x: 40, y: 26, energy: 400 }, // SOURCE link (beside the source)
      ],
      creeps: [
        {
          name: "mS",
          x: 41,
          y: 25,
          body: ["work", "work", "work", "work", "work", "carry", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-lr-m", assignedSourceId: "$id(home,source,40,25)" },
        },
        {
          // Adopted-stale feeder (OrphanRescue maps feed -> controllerFeeder kind),
          // parked range-1 to BOTH the core link (25,23) and the storage (24,24).
          name: "fd",
          x: 24,
          y: 23,
          body: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"],
          memory: { workType: "feed", corpId: "stale-lr-feeder" },
        },
        // Parked upgraders ringing the controller link - they burn the staged
        // 800 into controller progress (assertion D), decoupled from relay timing.
        {
          name: "u1",
          x: 24,
          y: 11,
          body: ["work", "work", "work", "work", "work", "work", "carry", "carry", "carry", "move", "move"],
          memory: { workType: "upgrade", corpId: "stale-lr-upgrading", working: false, upgradeSpot: { x: 24, y: 11 } },
        },
        {
          name: "u2",
          x: 26,
          y: 11,
          body: ["work", "work", "work", "work", "work", "work", "carry", "carry", "carry", "move", "move"],
          memory: { workType: "upgrade", corpId: "stale-lr-upgrading", working: false, upgradeSpot: { x: 26, y: 11 } },
        },
      ],
      assertions: [
        // C: the source is mined (funding proof) - so B is a real discriminator,
        // not "the source was never funded so of course no carry corp".
        eventually("the link-served source is mined (funded)", (s) =>
          JSON.stringify(s.memory?.commissionedCorps ?? {}).includes("harvest-source-")
        ),
        // B: EMERGENT kind selection - the only source is link-served, so no
        // walking carry corp is ever commissioned for it. RED on the old code,
        // which commissioned `carry-source-<id>` (the thrash's second creep).
        always(
          "no walking carry corp for the link-served source",
          (s) => !JSON.stringify(s.memory?.commissionedCorps ?? {}).includes("carry-source-"),
          10
        ),
        // A: the feeder is the SOLE bidirectional operator - it drains the core
        // to storage (the empty direction). RED on old (load-only, never drained).
        eventually("the feeder drains the core to storage (the empty direction)", (s) => {
          const creeps = s.memory?.creeps ?? {};
          for (const name in creeps) {
            if (creeps[name]?.lastDeliver?.to === "storage-drain") sawDrain = true;
          }
          return sawDrain;
        }),
        // D: value lands - energy becomes controller progress (not gridlocked).
        eventually("energy lands as controller progress", (s) => {
          const ctrl = s.objects().find((o: any) => o.type === "controller");
          return !!ctrl && (ctrl.progress ?? 0) >= 100;
        }),
      ],
    },
  ];
}
