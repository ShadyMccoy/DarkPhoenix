/**
 * cells/index - the grid cell registry. One import per avenue file; the
 * duplicate-id check makes a copy-pasted cell loud instead of silently
 * shadowing another's verdict.
 */

import { GridCell } from "../GridCell";
import { calibrationCells } from "./calibration";
import { churnCells } from "./churn";

export const ALL_CELLS: GridCell[] = [...calibrationCells, ...churnCells];

const seen = new Set<string>();
for (const cell of ALL_CELLS) {
  if (seen.has(cell.id)) throw new Error(`duplicate grid cell id: ${cell.id}`);
  seen.add(cell.id);
}
