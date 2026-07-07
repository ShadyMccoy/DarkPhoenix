/**
 * cells/index - the grid cell registry. One import per avenue file; the
 * duplicate-id check makes a copy-pasted cell loud instead of silently
 * shadowing another's verdict.
 *
 * Avenue files export either a `GridCell[]` (stateless cells) or a
 * `build*Cells(): GridCell[]` factory (cells carrying closure state, e.g.
 * cross-sample trackers) - factories are invoked here, once per process.
 */

import { GridCell } from "../GridCell";
import { arrivalCells } from "./arrival";
import { buildHaulingCells } from "./hauling";
import { calibrationCells } from "./calibration";
import { churnCells } from "./churn";
import { constructionCells } from "./construction";
import { movementCells } from "./movement";
import { plannerCells } from "./planner";
import { spawnExecCells } from "./spawn-exec";
import { spawnSchedulerCells } from "./spawn-scheduler";

export const ALL_CELLS: GridCell[] = [
  ...calibrationCells,
  ...churnCells,
  ...movementCells,
  ...spawnSchedulerCells,
  ...spawnExecCells,
  ...arrivalCells,
  ...buildHaulingCells(),
  ...constructionCells,
  ...plannerCells,
];

const seen = new Set<string>();
for (const cell of ALL_CELLS) {
  if (seen.has(cell.id)) throw new Error(`duplicate grid cell id: ${cell.id}`);
  seen.add(cell.id);
}
