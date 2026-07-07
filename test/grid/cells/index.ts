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
import { arrivalCells, buildArrivalT1Cells } from "./arrival";
import { buildConstructionT1Cells, constructionCells } from "./construction";
import { buildHaulingCells } from "./hauling";
import { buildPlannerT1Cells, plannerCells } from "./planner";
import { buildStatefulMovementCells, movementCells } from "./movement";
import { buildStatefulSchedulerCells, spawnSchedulerCells } from "./spawn-scheduler";
import { calibrationCells } from "./calibration";
import { churnCells } from "./churn";
import { spawnExecCells, spawnExecT1Cells } from "./spawn-exec";

export const ALL_CELLS: GridCell[] = [
  ...calibrationCells,
  ...churnCells,
  ...movementCells,
  ...buildStatefulMovementCells(),
  ...spawnSchedulerCells,
  ...buildStatefulSchedulerCells(),
  ...spawnExecCells,
  ...spawnExecT1Cells,
  ...arrivalCells,
  ...buildArrivalT1Cells(),
  ...buildHaulingCells(),
  ...buildConstructionT1Cells(),
  ...constructionCells,
  ...plannerCells,
  ...buildPlannerT1Cells(),
];

const seen = new Set<string>();
for (const cell of ALL_CELLS) {
  if (seen.has(cell.id)) throw new Error(`duplicate grid cell id: ${cell.id}`);
  seen.add(cell.id);
}
