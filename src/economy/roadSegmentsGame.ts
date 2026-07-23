/**
 * @fileoverview World-reading glue for trunk A/Z aggregation (the ADAPTER half
 * of economy/roadSegments). Reads Game.rooms roadRoutes receipts and owned
 * storages; the split/aggregation math itself stays PURE in roadSegments.ts.
 *
 * Separated so the receipts-gated decode is unit-testable with a mock Game -
 * the trap CLAUDE.md names explicitly: roadRoutes receipts are staged by NO
 * integration-trio world, so a gate on them "can pass for the wrong reason".
 *
 * @module economy/roadSegmentsGame
 */

import "../types/Memory"; // RoomMemory.roadRoutes augmentation
import { bankSurplusRate, resolveReserveTarget } from "./bank";
import { TrunkRouteTiles } from "./roadSegments";

/**
 * The energy/tick the HOME end can push into a trunk's A segment: the largest
 * bank-surplus draw across owned storages (the pool tankers' fuel). Zero while
 * every warchest still fills, so the source end (Z) proportionally owns more
 * of the road until a bank is in surplus.
 */
export function homeBankSupply(): number {
  if (typeof Game === "undefined" || !Game.rooms) return 0;
  const reserveTarget = resolveReserveTarget(typeof Memory !== "undefined" ? Memory.warchestTarget : undefined);
  let best = 0;
  for (const roomName in Game.rooms) {
    const storage = Game.rooms[roomName].storage;
    if (storage?.my) best = Math.max(best, bankSurplusRate(storage.store[RESOURCE_ENERGY] ?? 0, reserveTarget));
  }
  return best;
}

/**
 * Decode the durable trunk routes (roadRoutes receipts) into ordered
 * SOURCE->HOME tile lists with each source's mine rate. Only ACTIVE trunks
 * (tiles3 present, not paved/declined) participate - a paved or in-room route
 * has nothing to aggregate. `sourceRate` resolves a source's mine capacity
 * (the flow graph, in production); an unknown source falls back to 10 e/t so a
 * still-analyzing remote still splits sensibly. Each route is keyed once; a
 * route seen in two rooms' memory is deduped (built once, attributed once).
 */
export function collectTrunkRoutes(sourceRate: (sourceId: string) => number | undefined): TrunkRouteTiles[] {
  if (typeof Game === "undefined" || !Game.rooms) return [];
  const routes: TrunkRouteTiles[] = [];
  const seen = new Set<string>();
  for (const roomName in Game.rooms) {
    const roadRoutes = Game.rooms[roomName].memory?.roadRoutes;
    if (!roadRoutes) continue;
    for (const sourceId in roadRoutes) {
      const e = roadRoutes[sourceId];
      if (!e || e.paved || e.declined || !e.tiles3 || !e.rooms) continue;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      const tiles: { x: number; y: number; roomName: string }[] = [];
      for (let i = 2; i < e.tiles3.length; i += 3) {
        const rn = e.rooms[e.tiles3[i]];
        if (rn) tiles.push({ x: e.tiles3[i - 2], y: e.tiles3[i - 1], roomName: rn });
      }
      if (tiles.length === 0) continue;
      routes.push({ sourceId, tiles, sourceRate: sourceRate(sourceId) ?? 10 });
    }
  }
  return routes;
}
