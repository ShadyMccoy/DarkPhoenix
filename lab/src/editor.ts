/**
 * editor.ts — the map view that is also the scenario editor (owner ruling
 * 2026-08-22: place, move, and update game elements). Renders the staged
 * world as SVG and reports cell clicks; every edit replans immediately in
 * main.ts — edits reprice live.
 */
import { SIZE, Scenario, SWAMP, WALL, cellAt } from "./scenario";

export type Tool = "select" | "spawn" | "bank" | "controller" | "source" | "wall" | "swamp" | "erase";

export const TOOLS: Tool[] = ["select", "spawn", "bank", "controller", "source", "wall", "swamp", "erase"];

const CELL = 13;

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

export function renderMap(container: HTMLElement, s: Scenario, selected: string | null, onCell: (x: number, y: number) => void): void {
  const px = SIZE * CELL;
  let cells = "";
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
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
  marks += badge(s.spawn.x, s.spawn.y, "#3f7cac", "S");
  marks += badge(s.bank.x, s.bank.y, "#2a9d8f", "B");
  if (s.controller) marks += badge(s.controller.x, s.controller.y, "#8e6bbf", "C");

  container.innerHTML =
    `<svg width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" style="background:#20242c;border-radius:6px">` +
    cells +
    marks +
    "</svg>";
  const svg = container.querySelector("svg");
  if (svg) {
    svg.addEventListener("click", ev => {
      const rect = svg.getBoundingClientRect();
      const x = Math.floor(((ev.clientX - rect.left) / rect.width) * SIZE);
      const y = Math.floor(((ev.clientY - rect.top) / rect.height) * SIZE);
      if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) onCell(x, y);
    });
  }
}
