/**
 * spawn-exec cells (docs/specs/08, avenue: spawn-execution).
 *
 * T0: the first flow miner's memory stamp must resolve to a live commissioned
 * corp (the flow-id prefix regressions: harvestKind.materialize must strip
 * 'source-' or the spawned miner's corpId never resolves and it freezes), and
 * the cold-start floor body is 2W1M within the 300 budget.
 *
 * The decoy hauler applies the reviewer's fix (errata wrong-behavior #4 /
 * infeasible #3 pattern): workType 'haul' with NO corpId suppresses
 * BootstrapCorp's jack path from tick 1 (it counts haul-workType creeps)
 * while OrphanRescue provably never adopts or recycles it - so the spawn's
 * 300 energy is untouched and the first spawn IS the flow miner, giving this
 * cell a tight, deterministic window.
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

/** Source pocketed to one mining spot: walls on all neighbours except north. */
const homeRoom = (roomName: string) => {
  const b = new RoomBuilder(roomName).border().controller(35, 20);
  // pocket(19,25): 8 neighbours walled except the (19,24) opening
  for (const [x, y] of [
    [18, 24],
    [20, 24],
    [18, 25],
    [20, 25],
    [18, 26],
    [19, 26],
    [20, 26],
  ]) {
    b.tile(x, y, "wall");
  }
  return b.source(19, 25).toRoom();
};

const minerEntries = (s: { memory: any }): Array<[string, any]> =>
  Object.entries(s.memory?.creeps ?? {}).filter(([name]) => name.startsWith("miner-"));

export const spawnExecCells: GridCell[] = [
  {
    id: "spawnexec-first-miner-stamp-300",
    tier: 0,
    avenue: "spawn-execution",
    window: 60,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    creeps: [{ name: "decoy", x: 24, y: 23, body: ["carry", "move"], memory: { workType: "haul" } }],
    assertions: [
      eventually("first flow miner spawned with the 2W1M floor body", (s) => {
        const m = s
          .objects()
          .find((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("miner-"));
        if (!m || !Array.isArray(m.body)) return false;
        const parts = m.body.map((p: any) => p.type);
        return parts.length === 3 && parts.filter((t: string) => t === "work").length === 2;
      }),
      eventually("corpId stamps a live commissioned mining corp", (s) => {
        const store = JSON.stringify(s.memory?.commissionedCorps ?? {});
        return minerEntries(s).some(
          ([, mem]) =>
            typeof mem?.corpId === "string" && mem.corpId.startsWith("mining-") && store.includes(mem.corpId)
        );
      }),
      eventually("spawnedBy stamped with the spawning corp", (s) =>
        minerEntries(s).some(([, mem]) => typeof mem?.spawnedBy === "string" && mem.spawnedBy.startsWith("spawning-"))
      ),
      eventually("workType stamped harvest", (s) =>
        minerEntries(s).some(([, mem]) => mem?.workType === "harvest")
      ),
      // The prefix-regression signature: a spawned miner whose corpId never
      // resolves gets orphanedSince stamped by OrphanRescue. None may ever.
      always("no spawned miner is ever orphaned", (s) =>
        minerEntries(s).every(([, mem]) => mem?.orphanedSince === undefined)
      ),
    ],
  },
];
