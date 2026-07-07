/**
 * calibration cells - measure the timing constants every other cell's verdict
 * window is built on (docs/specs/08, "run one calibration probe first").
 *
 * The whole staged-cell mechanism assumes a cold colony reaches "corps
 * commissioned + OrphanRescue can adopt" within the 25-tick orphan grace. That
 * pipeline (terrain analysis -> node creation -> eager bootstrap solve every
 * 10 ticks -> commission materialization -> first spawn) has never been
 * measured; designer windows guessed at it. This cell records the actual
 * satisfaction tick of each pipeline stage - read them from the "assertion
 * timings" section of the grid report and recalibrate windows from data.
 */

import { GridCell, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(30, 25).toRoom();

export const calibrationCells: GridCell[] = [
  {
    id: "calib-adoption-timing",
    tier: 0,
    avenue: "churn-recovery",
    window: 150,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    assertions: [
      eventually("terrain analyzed: nodes exist", (s) => {
        const nodes = s.memory?.nodes;
        return !!nodes && Object.keys(nodes).length > 0;
      }),
      eventually("economy solved: harvest corp commissioned", (s) =>
        JSON.stringify(s.memory?.commissionedCorps ?? {}).includes("harvest")
      ),
      eventually("first flow miner spawned", (s) =>
        s.objects().some(
          (o) =>
            o.type === "creep" &&
            o.user === s.userId &&
            typeof o.name === "string" &&
            o.name.startsWith("miner-")
        )
      ),
    ],
  },
];
