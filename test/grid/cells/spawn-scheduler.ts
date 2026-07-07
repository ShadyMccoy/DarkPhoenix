/**
 * spawn-scheduler cells (docs/specs/08, avenue: spawn-decision).
 *
 * T0: at a cold RCL2 start, the scheduler's very first spawned creep must be
 * the source's first miner - income+blocking tier - never a hauler (dropped by
 * withMinerPrecedence while no miner is fielded), upgrader (emits no demand
 * without a hauler), or builder. Bootstrap jacks are allowed and excluded from
 * the check: the bootstrap-to-flow handoff is exactly what's under test
 * (known bug: colonyHasMiner once counted jacks, making the first flow miner
 * non-blocking so the handoff never happened).
 *
 * Window 170 comes from measurement, not the designer's 80: the calibration
 * cell recorded the first flow miner at tick 138 on this exact geometry
 * (jack economy first, then energy accumulation for the 250 floor body).
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(30, 25).toRoom();

const SCHEDULED = /^(hauler|upgrader|builder|tanker|reserver)-/;

const minerCreep = (s: { objects(h?: string): any[] }) =>
  s.objects().find((o: any) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("miner-"));

export const spawnSchedulerCells: GridCell[] = [
  {
    id: "spawn-first-miner-outranks-all",
    tier: 0,
    avenue: "spawn-decision",
    window: 170,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    assertions: [
      eventually("the first scheduler-spawned creep is a miner", (s) => !!minerCreep(s)),
      // Until the first miner exists, NO consumption/transport creep may have
      // been scheduled (jacks are bootstrap, not the scheduler).
      always("no hauler/upgrader/builder before the first miner", (s) => {
        if (minerCreep(s)) return true; // ordering satisfied from here on
        return !s
          .objects()
          .some((o: any) => o.type === "creep" && typeof o.name === "string" && SCHEDULED.test(o.name));
      }),
      eventually("miner spawned at the 2W1M cold-start floor", (s) => {
        const m = minerCreep(s);
        if (!m || !Array.isArray(m.body)) return false;
        const parts = m.body.map((p: any) => p.type);
        return (
          parts.length === 3 &&
          parts.filter((t: string) => t === "work").length === 2 &&
          parts.filter((t: string) => t === "move").length === 1
        );
      }),
      eventually("miner memory stamped workType harvest", (s) => {
        const m = minerCreep(s);
        return !!m && s.memory?.creeps?.[m.name]?.workType === "harvest";
      }),
    ],
  },
];
