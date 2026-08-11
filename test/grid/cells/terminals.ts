/**
 * CROSS-HUB TERMINAL TRANSFER (spec 58 phase 3) - the executor's end-to-end
 * pin, and the exit door of the consumption-constrained regime.
 *
 * Stages the whole three-leg chain and asserts each leg by its OBSERVABLE:
 * home is a consumption-constrained hub (RCL8, storage 995k of 1M, no local
 * mining) with a terminal; east is a young owned hub (RCL6, empty storage)
 * with a terminal. The plan must route home's bank to east's storage as a
 * terminal transfer (published in Memory.terminalTransfers), the home hub
 * tender must stage the terminal from the bank (leg 1), the TerminalRunner
 * must execute the send (leg 2 - east's TERMINAL receiving is engine-verified
 * movement, not an intent), and east's hub tender must land the arrivals in
 * its STORAGE (leg 3 - the leg that completes a transfer).
 *
 * The mockup engine fully processes terminal.send (probed 2026-08-06: fee,
 * cooldown and arrival all real), so this cell measures the engine's word,
 * not the bot's.
 */
import { GridCell, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

// A 3-tile exit slot joins the two rooms at y 24-26 (the expansion cells'
// pattern): .border() walls the WHOLE perimeter, and a fully-walled pair let
// this cell's first draft strand east's tender bouncing on home's east edge
// with an empty path for 250 ticks - the transfer needs no walking, but the
// tender bought at the wrong spawn walks to its post.
const homeRoom = (roomName: string) => {
  const b = new RoomBuilder(roomName).border().controller(25, 10);
  for (let y = 24; y <= 26; y++) b.tile(49, y, "plain");
  return b.toRoom();
};
const eastRoom = (roomName: string) => {
  const b = new RoomBuilder(roomName).border().controller(15, 25);
  for (let y = 24; y <= 26; y++) b.tile(0, y, "plain");
  return b.toRoom();
};

/** Extensions so home can afford the full 550 hub-tender body (300 + 6x50). */
const EXT_6: Array<{ x: number; y: number }> = [];
for (const x of [21, 23, 27]) for (const y of [22, 28]) EXT_6.push({ x, y });

export const terminalCells: GridCell[] = [
  {
    id: "term-t8-surplus-crosses-hubs",
    tier: 8,
    avenue: "logistics",
    window: 600,
    rooms: { home: homeRoom, east: eastRoom },
    adjacency: { east: "E" },
    bot: { x: 25, y: 25 },
    controller: { level: 8 },
    structures: [
      // Home: the consumption-constrained hub. 995k banked -> a fat lender
      // (bank source at the 100 e/t guard) whose own sinks (RCL8 controller
      // 15 + spawn) leave a residual only the transfer edge can absorb.
      { type: "storage", x: 24, y: 25, energy: 995_000 },
      { type: "terminal", x: 26, y: 25, energy: 0 },
      ...EXT_6.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      // East: the borrower. An EMPTY storage (hungry bank -> not lending -> a
      // valid destination) and the receiving terminal. Its spawn is staged in
      // stage() below with the FULL schema - the declarative list omits
      // `name`/`spawning: null`, without which the runtime cannot address the
      // spawn (the multispawn cells' documented trap, hit on this cell's first
      // run: legs 1-2 green, leg 3 dark because east could never spawn its
      // hub tender).
      { type: "storage", x: 14, y: 25, energy: 0, room: "east" },
      { type: "terminal", x: 16, y: 25, energy: 0, room: "east" },
    ],
    async stage(ctx) {
      // Own east at RCL6: the send API gates on the SENDER's controller level
      // and the graph only attaches OWNED infrastructure. Flat keys only (the
      // $set-with-dotted-paths no-op is on the trap list).
      await ctx.db["rooms.objects"].update(
        { room: ctx.room("east"), type: "controller" },
        { $set: { user: ctx.userId, level: 6, progress: 0, safeMode: null, downgradeTime: null } }
      );
      await ctx.db["rooms"].update({ _id: ctx.room("east") }, { $set: { active: true } });
      // The east spawn, addBot-equivalent schema (multispawn's stageSecondSpawn).
      await ctx.db["rooms.objects"].insert({
        type: "spawn",
        room: ctx.room("east"),
        x: 20,
        y: 25,
        user: ctx.userId,
        name: "SpawnEast",
        store: { energy: 300 },
        storeCapacityResource: { energy: ctx.C.SPAWN_ENERGY_CAPACITY },
        hits: ctx.C.SPAWN_HITS,
        hitsMax: ctx.C.SPAWN_HITS,
        spawning: null,
        notifyWhenAttacked: true,
      });
    },
    assertions: [
      eventually("the plan publishes the cross-hub transfer (home -> east)", (s) => {
        const transfers = s.memory?.terminalTransfers ?? {};
        const routes = transfers[s.room("home")] ?? [];
        return routes.some((r: { to: string; rate: number }) => r.to === s.room("east") && r.rate > 0);
      }),
      eventually("energy CROSSES rooms: east's terminal receives (the engine's word, not an intent)", (s) => {
        const term = s.objects("east").find((o) => o.type === "terminal");
        return ((term?.store?.energy as number) ?? 0) > 0;
      }),
      eventually("the transfer COMPLETES: east's hub tender lands the arrivals in its storage (leg 3)", (s) => {
        const store = s.objects("east").find((o) => o.type === "storage");
        return ((store?.store?.energy as number) ?? 0) > 0;
      }),
    ],
  },
];
