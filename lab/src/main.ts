/**
 * main.ts — the lab app: state and tool wiring. The believer stepper
 * lives in believer.ts, pure and unit-certified; every edit re-runs the
 * REAL replan (edits reprice live). The believer certifies accounting,
 * never fidelity — no number here is quotable as a measured band
 * (graph-lab requirement #4). The mockup remains the truth host.
 */
import { EnginePlan } from "../../src/engine/vocabulary";
import { ViewCreep } from "../../src/engine/view";
import { advanceChunk, planFor } from "./believer";
import { TOOLS, Tool, renderMap } from "./editor";
import { KIND_COLOR, edgesFor } from "./graph";
import { renderPanels } from "./panels";
import {
  PLAIN,
  SWAMP,
  Scenario,
  WALL,
  XY,
  cellAt,
  exportSave,
  importSave,
  mapHeight,
  mapWidth,
  resizeTerrain,
  setCell
} from "./scenario";
import { bootstrapScenario } from "./scenarios";

interface LabState {
  scenario: Scenario;
  creeps: ViewCreep[];
  bankStock: number;
  tick: number;
  cp: number;
  tool: Tool;
  seq: number;
  /** Draw the blocked frontier on the map, not just in the panel. */
  showBlocked: boolean;
  showLabels: boolean;
}

/** View prefs survive a reset — they describe the lens, not the world. */
interface ViewPrefs {
  showBlocked: boolean;
  showLabels: boolean;
}

function fresh(scenario: Scenario, prefs: ViewPrefs = { showBlocked: true, showLabels: true }): LabState {
  return {
    scenario,
    creeps: scenario.creeps.map(c => ({ ...c })),
    bankStock: scenario.bankStock,
    tick: 0,
    cp: 0,
    tool: "select",
    seq: 1,
    showBlocked: prefs.showBlocked,
    showLabels: prefs.showLabels
  };
}

let state = fresh(bootstrapScenario());

function currentPlan(): EnginePlan {
  return planFor(state);
}

/** Step the believer (believer.ts — pure, unit-certified) and re-render. */
function advance(chunks: number): void {
  for (let i = 0; i < chunks; i++) advanceChunk(state);
  render();
}

function applyTool(x: number, y: number): void {
  const s = state.scenario;
  switch (state.tool) {
    case "spawn":
      s.spawn = { x, y };
      break;
    case "bank":
      s.bank = { x, y };
      break;
    case "controller":
      s.controller = { x, y };
      break;
    case "source":
      s.sources.push({ id: `src${s.sources.length + 1}`, x, y });
      break;
    case "link":
      s.links.push({ id: `link${s.links.length + 1}`, x, y });
      break;
    case "wall":
      setCell(s.terrain, x, y, WALL);
      break;
    case "swamp":
      setCell(s.terrain, x, y, SWAMP);
      break;
    case "erase": {
      const containers = s.containers ?? [];
      const n = s.sources.length + s.links.length + s.sites.length + s.extensions.length + containers.length;
      s.sources = s.sources.filter(src => src.x !== x || src.y !== y);
      s.links = s.links.filter(l => l.x !== x || l.y !== y);
      s.sites = s.sites.filter(k => k.x !== x || k.y !== y);
      s.extensions = s.extensions.filter(k => k.x !== x || k.y !== y);
      s.containers = containers.filter(k => k.x !== x || k.y !== y);
      if (
        s.sources.length + s.links.length + s.sites.length + s.extensions.length + s.containers.length === n &&
        cellAt(s.terrain, x, y) !== PLAIN
      )
        setCell(s.terrain, x, y, PLAIN);
      if (s.controller && s.controller.x === x && s.controller.y === y) s.controller = null;
      break;
    }
    case "select":
      break;
  }
  render();
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function renderTools(): void {
  const bar = $("tools");
  bar.innerHTML = TOOLS.map(t => `<button data-tool="${t}" class="${t === state.tool ? "on" : ""}">${t}</button>`).join(
    ""
  );
  bar.querySelectorAll("button").forEach(b =>
    b.addEventListener("click", () => {
      state.tool = (b.getAttribute("data-tool") ?? "select") as Tool;
      renderTools();
    })
  );
}

/** The legend is generated from the same KIND_COLOR the map draws with. */
function renderLegend(): void {
  const swatches = (Object.keys(KIND_COLOR) as (keyof typeof KIND_COLOR)[])
    .map(k => `<span class="key"><i style="background:${KIND_COLOR[k]}"></i>${k}</span>`)
    .join("");
  $("legend").innerHTML =
    swatches +
    `<span class="key dim"><i class="dash"></i>understaffed / blocked</span>` +
    `<span class="key dim">width = gross e/t</span>`;
}

function render(): void {
  const plan = currentPlan();
  const edges = edgesFor(state.scenario, plan, state.showBlocked);
  renderMap($("map"), state.scenario, { selected: null, edges, showLabels: state.showLabels }, applyTool);
  renderPanels($("panels"), plan, state.creeps);
  $("status").textContent =
    `t${state.tick} · bank ${Math.round(state.bankStock)}e · ` +
    `${state.creeps.length} creeps · ${Math.round(state.cp)} CP`;
  ($("bankStock") as HTMLInputElement).value = String(Math.round(state.bankStock));
  ($("bodyBudget") as HTMLInputElement).value = String(state.scenario.bodyBudget);
  ($("mapW") as HTMLInputElement).value = String(mapWidth(state.scenario.terrain));
  ($("mapH") as HTMLInputElement).value = String(mapHeight(state.scenario.terrain));
}

/** Rooms are walls the editor draws — resizing never changes the model
 * (owner 2026-08-23: the map and graph are room-agnostic). */
function resizeMap(w: number, h: number): void {
  const s = state.scenario;
  s.terrain = resizeTerrain(s.terrain, w, h);
  const inside = (p: XY): boolean => p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
  s.sources = s.sources.filter(inside);
  s.links = s.links.filter(inside);
  s.sites = s.sites.filter(inside);
  s.extensions = s.extensions.filter(inside);
  s.containers = (s.containers ?? []).filter(inside);
  s.spawn = { x: Math.min(s.spawn.x, w - 1), y: Math.min(s.spawn.y, h - 1) };
  s.bank = { x: Math.min(s.bank.x, w - 1), y: Math.min(s.bank.y, h - 1) };
  if (s.controller && !inside(s.controller)) s.controller = null;
  render();
}

function toggle(id: string, read: () => boolean, write: (v: boolean) => void): void {
  const b = $(id);
  const paint = (): void => {
    if (read()) b.classList.add("on");
    else b.classList.remove("on");
  };
  b.addEventListener("click", () => {
    write(!read());
    paint();
    render();
  });
  paint();
}

function wire(): void {
  renderTools();
  renderLegend();
  toggle("toggleBlocked", () => state.showBlocked, v => (state.showBlocked = v));
  toggle("toggleLabels", () => state.showLabels, v => (state.showLabels = v));
  $("advance1").addEventListener("click", () => advance(1));
  $("advance10").addEventListener("click", () => advance(10));
  $("reset").addEventListener("click", () => {
    state = fresh(state.scenario, { showBlocked: state.showBlocked, showLabels: state.showLabels });
    render();
  });
  $("bankStock").addEventListener("change", ev => {
    state.bankStock = Number((ev.target as HTMLInputElement).value) || 0;
    render();
  });
  $("bodyBudget").addEventListener("change", ev => {
    state.scenario.bodyBudget = Number((ev.target as HTMLInputElement).value) || 0;
    render();
  });
  $("resize").addEventListener("click", () => {
    const w = Math.max(10, Math.min(200, Number(($("mapW") as HTMLInputElement).value) || 50));
    const h = Math.max(10, Math.min(200, Number(($("mapH") as HTMLInputElement).value) || 50));
    resizeMap(w, h);
  });
  $("export").addEventListener("click", () => {
    ($("io") as HTMLTextAreaElement).value = exportSave({
      scenario: state.scenario,
      creeps: state.creeps,
      bankStock: state.bankStock,
      tick: state.tick,
      cp: state.cp
    });
  });
  $("import").addEventListener("click", () => {
    try {
      const save = importSave(($("io") as HTMLTextAreaElement).value);
      state = { ...fresh(save.scenario), creeps: save.creeps, bankStock: save.bankStock, tick: save.tick, cp: save.cp };
      render();
    } catch (err) {
      alert(`import failed: ${(err as Error).message}`);
    }
  });
  render();
}

wire();
