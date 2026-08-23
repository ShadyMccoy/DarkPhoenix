/**
 * editor.ts — the map view that is also the scenario editor (owner ruling
 * 2026-08-22: place, move, and update game elements). Renders the staged
 * world as SVG and reports cell clicks; every edit replans immediately in
 * main.ts — edits reprice live.
 */
import { Scenario, SWAMP, WALL, XY, cellAt } from "./scenario";
import { LabEdge, edgeColor, edgeLabel, edgeWidth } from "./graph";

export type Tool = "select" | "spawn" | "bank" | "controller" | "source" | "link" | "wall" | "swamp" | "erase";

export const TOOLS: Tool[] = ["select", "spawn", "bank", "controller", "source", "link", "wall", "swamp", "erase"];

const CELL = 13;

/** What the map draws on top of the terrain, beyond the elements themselves. */
export interface MapOverlay {
  selected: string | null;
  edges: LabEdge[];
  showLabels: boolean;
}

function el(tag: string, attrs: Record<string, string | number>, text?: string): string {
  const a = Object.keys(attrs)
    .map(k => `${k}="${attrs[k]}"`)
    .join(" ");
  return text === undefined ? `<${tag} ${a}/>` : `<${tag} ${a}>${text}</${tag}>`;
}

function badge(x: number, y: number, fill: string, label: string): string {
  return (
    el("rect", { x: x * CELL, y: y * CELL, width: CELL, height: CELL, rx: 2, fill }) +
    el(
      "text",
      {
        x: x * CELL + CELL / 2,
        y: y * CELL + CELL / 2 + 3.5,
        "text-anchor": "middle",
        "font-size": 9,
        "font-weight": 700,
        fill: "#fff"
      },
      label
    )
  );
}

function center(p: XY): XY {
  return { x: p.x * CELL + CELL / 2, y: p.y * CELL + CELL / 2 };
}

/** Quadratic bezier point and tangent — the arrowhead needs both. */
function bezier(a: XY, c: XY, b: XY, t: number): XY {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function tangent(a: XY, c: XY, b: XY, t: number): XY {
  const u = 1 - t;
  return { x: 2 * u * (c.x - a.x) + 2 * t * (b.x - c.x), y: 2 * u * (c.y - a.y) + 2 * t * (b.y - c.y) };
}

/** A filled triangle pointing along the route — direction is the whole
 * point of an edge here: energy flows one way. */
function arrowhead(a: XY, c: XY, b: XY, color: string, size: number): string {
  const tip = bezier(a, c, b, 0.88);
  const dir = tangent(a, c, b, 0.88);
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len;
  const uy = dir.y / len;
  const back = { x: tip.x - ux * size, y: tip.y - uy * size };
  const half = size * 0.5;
  const pts = [
    `${tip.x.toFixed(1)},${tip.y.toFixed(1)}`,
    `${(back.x - uy * half).toFixed(1)},${(back.y + ux * half).toFixed(1)}`,
    `${(back.x + uy * half).toFixed(1)},${(back.y - ux * half).toFixed(1)}`
  ].join(" ");
  return el("polygon", { points: pts, fill: color });
}

function labelAt(p: XY, text: string, color: string): string {
  // A stroke drawn under the glyphs keeps the label legible over terrain.
  return el(
    "text",
    {
      x: p.x.toFixed(1),
      y: p.y.toFixed(1),
      "text-anchor": "middle",
      "font-size": 9,
      "font-weight": 600,
      fill: color,
      stroke: "#14171d",
      "stroke-width": 3,
      "paint-order": "stroke",
      "pointer-events": "none"
    },
    text
  );
}

function renderEdge(e: LabEdge, showLabel: boolean): string {
  const color = edgeColor(e);
  const w = edgeWidth(e);
  const dash = e.funded ? (e.backed < e.target ? `${w * 1.6},${w * 1.4}` : "") : "3,3";
  const opacity = e.funded ? 0.95 : 0.55;
  const a = center(e.from);
  const b = center(e.to);

  // A corp that never leaves its tile (mining at the source) is a self-edge:
  // ring the tile rather than drawing a zero-length line.
  if (e.from.x === e.to.x && e.from.y === e.to.y) {
    const ring = el("circle", {
      cx: a.x,
      cy: a.y,
      r: CELL * 0.95,
      fill: "none",
      stroke: color,
      "stroke-width": w,
      "stroke-dasharray": dash,
      opacity
    });
    const label = showLabel ? labelAt({ x: a.x, y: a.y - CELL * 1.4 }, edgeLabel(e), color) : "";
    return ring + label;
  }

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  // Bow competitors off the straight line so a funded route and a blocked
  // one on the same pair never hide each other.
  const lift = e.bow * Math.min(Math.max(dist * 0.16, 12), 46);
  const c = { x: (a.x + b.x) / 2 - (dy / dist) * lift, y: (a.y + b.y) / 2 + (dx / dist) * lift };

  const path = el("path", {
    d: `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${c.x.toFixed(1)} ${c.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
    fill: "none",
    stroke: color,
    "stroke-width": w,
    "stroke-dasharray": dash,
    "stroke-linecap": "round",
    opacity
  });
  const head = arrowhead(a, c, b, color, Math.max(w * 1.9, 6));
  const label = showLabel ? labelAt(bezier(a, c, b, 0.5), edgeLabel(e), color) : "";
  return path + head + label;
}

export function renderMap(container: HTMLElement, s: Scenario, overlay: MapOverlay, onCell: (x: number, y: number) => void): void {
  const selected = overlay.selected;
  const mh = s.terrain.length;
  const mw = mh > 0 ? s.terrain[0].length : 0;
  const px = mw * CELL;
  const py = mh * CELL;
  let cells = "";
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const ch = cellAt(s.terrain, x, y);
      if (ch === WALL) cells += el("rect", { x: x * CELL, y: y * CELL, width: CELL, height: CELL, fill: "#3d4451" });
      else if (ch === SWAMP)
        cells += el("rect", { x: x * CELL, y: y * CELL, width: CELL, height: CELL, fill: "#4a5d3a" });
    }
  }
  let marks = "";
  for (const src of s.sources) {
    const hot = selected === src.id ? el("rect", { x: src.x * CELL - 2, y: src.y * CELL - 2, width: CELL + 4, height: CELL + 4, rx: 3, fill: "none", stroke: "#ffd54d", "stroke-width": 2 }) : "";
    marks += hot + badge(src.x, src.y, "#c9a227", "E");
  }
  for (const l of s.links) marks += badge(l.x, l.y, "#d16ba5", "L");
  for (const k of s.extensions) marks += badge(k.x, k.y, "#5b8bb0", "x");
  // Open construction sites: the structure-to-be, hollow until built.
  for (const k of s.sites) marks += badge(k.x, k.y, "#b0803c", "▲");
  marks += badge(s.spawn.x, s.spawn.y, "#3f7cac", "S");
  // The bank badge names its branch: pile B, container C̶→"K", storage "T".
  const bankLabel = s.bankBranch === "storage" ? "T" : s.bankBranch === "container" ? "K" : "B";
  marks += badge(s.bank.x, s.bank.y, "#2a9d8f", bankLabel);
  if (s.controller) marks += badge(s.controller.x, s.controller.y, "#8e6bbf", "C");

  // Blocked routes go down first so a funded edge always wins the overlap.
  const ordered = [...overlay.edges].sort((a, b) => (a.funded ? 1 : 0) - (b.funded ? 1 : 0));
  const wires = ordered.map(e => renderEdge(e, overlay.showLabels)).join("");

  container.innerHTML =
    `<svg width="${px}" height="${py}" viewBox="0 0 ${px} ${py}" style="background:#20242c;border-radius:6px">` +
    cells +
    wires +
    marks +
    "</svg>";
  const svg = container.querySelector("svg");
  if (svg) {
    svg.addEventListener("click", ev => {
      const rect = svg.getBoundingClientRect();
      const x = Math.floor(((ev.clientX - rect.left) / rect.width) * mw);
      const y = Math.floor(((ev.clientY - rect.top) / rect.height) * mh);
      if (x >= 0 && y >= 0 && x < mw && y < mh) onCell(x, y);
    });
  }
}
