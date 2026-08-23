/**
 * graph.ts — the match graph as geometry: engine output → drawable edges.
 * Pure and DOM-free, like scenario.ts, so the unit suite drives it headless.
 *
 * The GUI derives NO economics here (graph-lab requirement #1). An edge's
 * width, label and staffing read CorpInstance / FrontierLine fields straight
 * off the plan; the frontier's reason is the engine's own word. The one
 * thing this file adds is what the engine has no opinion on — WHERE a place
 * id sits on the staged map — and that is the same lab-side knowledge
 * assemble() already uses to mint those ids (source ids, `bank`, `ctrl`).
 *
 * An edge is a corp: the flow it moves, drawn between the places it joins.
 * A production corp that never leaves its tile (mine) is a self-edge — the
 * renderer rings it. Competing routes on the same pair (the specialist
 * chain vs the fused workman, bidding on one source) bow apart so both stay
 * readable when the market funds one and blocks the other.
 */
import { CorpKindName, EnginePlan, FrontierReason } from "../../src/engine/vocabulary";
import { Scenario, XY } from "./scenario";

/** Kind colors, shared with the legend — one definition (law 2). */
export const KIND_COLOR: Record<CorpKindName, string> = {
  mine: "#c9a227",
  haul: "#9ecbff",
  workman: "#e08a4a",
  upgrade: "#8e6bbf",
  spawning: "#3f7cac"
};

/** Frontier reason colors, shared with the panels — one definition. */
export const REASON_COLOR: Record<FrontierReason, string> = {
  "net<0": "#b3543a",
  "spawn capacity": "#3f7cac",
  "energy residual": "#c9a227",
  "ramp insolvent": "#8e6bbf",
  "source saturated": "#6b7280",
  outcompeted: "#2a9d8f"
};

export interface LabEdge {
  /** The corp / offer id — the engine's own identity, unchanged. */
  id: string;
  kind: CorpKindName;
  from: XY;
  to: XY;
  /** Which way this route bows off the straight line, so co-located
   * competitors stay distinguishable. 0 draws straight. */
  bow: number;
  /** True for a funded corp, false for a blocked frontier line. */
  funded: boolean;
  /** Plan fields, verbatim. Blocked edges carry zeros — the engine never
   * priced them past the step that stopped it. */
  grossEt: number;
  netEt: number;
  backed: number;
  target: number;
  reason: FrontierReason | null;
  detail: string;
}

function sourceXY(s: Scenario, id: string): XY | null {
  const src = s.sources.find(x => x.id === id);
  return src ? { x: src.x, y: src.y } : null;
}

/** Place id → tile, mirroring the ids assemble() mints. A source IS its
 * place (owner 2026-08-23 — "mouth" retired), so anything that is not the
 * bank or the controller resolves as a source id. */
function placeXY(s: Scenario, place: string): XY | null {
  if (place === "bank") return s.bank;
  if (place === "ctrl") return s.controller;
  return sourceXY(s, place);
}

/** Split on the FIRST colon only: a haul id nests place ids after its own. */
function splitKind(offerId: string): [string, string] {
  const i = offerId.indexOf(":");
  return i < 0 ? [offerId, ""] : [offerId.slice(0, i), offerId.slice(i + 1)];
}

/**
 * Where an offer id lands on the map. Returns null for offers with no
 * geometry — `spawning:capacity` is spawn machine time, a rate with no
 * place — and those are simply not drawn.
 */
function anchorsFor(s: Scenario, offerId: string): { from: XY; to: XY; bow: number } | null {
  const [kind, rest] = splitKind(offerId);
  switch (kind) {
    case "mine": {
      const src = sourceXY(s, rest);
      // Mining provides at the mouth, which IS the source tile: a self-edge.
      return src ? { from: src, to: src, bow: 0 } : null;
    }
    case "workman": {
      const src = sourceXY(s, rest);
      // The fused chain: harvest and carry in one body, source → bank.
      return src ? { from: src, to: s.bank, bow: -1 } : null;
    }
    case "haul": {
      const arrow = rest.indexOf("->");
      if (arrow < 0) return null;
      const from = placeXY(s, rest.slice(0, arrow));
      const to = placeXY(s, rest.slice(arrow + 2));
      return from && to ? { from, to, bow: 1 } : null;
    }
    case "upgrade":
      return s.controller ? { from: s.bank, to: s.controller, bow: 0 } : null;
    case "spawning":
      // The tender shuttles bank → spawn estate; capacity has no place.
      return rest === "estate" ? { from: s.bank, to: s.spawn, bow: 0 } : null;
    case "chain": {
      // Frontier lines for whole chains carry the chain id:
      // `chain:<srcId>:<variant>`. Both variants run source → bank; they
      // bow like their funded counterparts so rivals stay side by side.
      const cut = rest.lastIndexOf(":");
      if (cut < 0) return null;
      const src = sourceXY(s, rest.slice(0, cut));
      return src ? { from: src, to: s.bank, bow: rest.slice(cut + 1) === "workman" ? -1 : 1 } : null;
    }
    default:
      return null;
  }
}

function kindOf(offerId: string): CorpKindName | null {
  const [kind, rest] = splitKind(offerId);
  if (kind === "chain") return rest.endsWith(":workman") ? "workman" : "haul";
  return kind in KIND_COLOR ? (kind as CorpKindName) : null;
}

/**
 * The plan's edges: every funded corp, then — when asked — the blocked
 * frontier, so you can see WHERE the market stopped without leaving the map.
 */
export function edgesFor(s: Scenario, plan: EnginePlan, includeBlocked: boolean): LabEdge[] {
  const edges: LabEdge[] = [];

  for (const corp of plan.corps) {
    const at = anchorsFor(s, corp.id);
    if (!at) continue;
    edges.push({
      id: corp.id,
      kind: corp.kind,
      from: at.from,
      to: at.to,
      bow: at.bow,
      funded: true,
      grossEt: corp.pnl.grossEt,
      netEt: corp.pnl.netEt,
      backed: corp.backed,
      target: corp.target,
      reason: null,
      detail: ""
    });
  }

  if (includeBlocked) {
    for (const line of plan.frontier) {
      const at = anchorsFor(s, line.offerId);
      const kind = kindOf(line.offerId);
      if (!at || !kind) continue;
      edges.push({
        id: line.offerId,
        kind,
        from: at.from,
        to: at.to,
        bow: at.bow,
        funded: false,
        grossEt: 0,
        netEt: 0,
        backed: 0,
        target: 0,
        reason: line.reason,
        detail: line.detail
      });
    }
  }

  return edges;
}

/** Stroke width from the flow the edge carries — the plan's gross e/t. */
export function edgeWidth(e: LabEdge): number {
  if (!e.funded) return 1.4;
  return Math.min(1.6 + e.grossEt * 0.55, 9);
}

export function edgeColor(e: LabEdge): string {
  return e.funded ? KIND_COLOR[e.kind] : REASON_COLOR[e.reason as FrontierReason] ?? "#666";
}

/** The midpoint label: what the plan says about this edge, nothing more. */
export function edgeLabel(e: LabEdge): string {
  if (!e.funded) return e.reason ?? "";
  return `${e.netEt >= 0 ? "+" : ""}${e.netEt.toFixed(1)} e/t · ${e.backed}/${e.target}`;
}
