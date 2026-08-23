/**
 * main.ts — the lab app: state, tool wiring, and the believer stepper.
 * Every edit re-runs the REAL replan (edits reprice live); the stepper
 * applies the plan's own expected rates — it certifies accounting, never
 * fidelity, and no number here is quotable as a measured band (graph-lab
 * requirement #4). The mockup remains the truth host.
 */
import { replan } from "../../src/engine/replan";
import { EnginePlan } from "../../src/engine/vocabulary";
import { ViewCreep } from "../../src/engine/view";
import { bodyCost } from "../../src/primitives";
import { TOOLS, Tool, renderMap } from "./editor";
import { KIND_COLOR, edgesFor } from "./graph";
import { renderPanels } from "./panels";
import {
  PLAIN,
  SWAMP,
  Scenario,
  WALL,
  XY,
  assemble,
  cellAt,
  exportSave,
  importSave,
  mapHeight,
  mapWidth,
  resizeTerrain,
  setCell
} from "./scenario";
import { bootstrapScenario } from "./scenarios";
import { LINK_COST } from "../../src/primitives";

/** One believer chunk: the replan cadence's order of magnitude. */
const DT = 150;

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
  return replan(assemble(state.scenario, state.creeps, state.bankStock, state.tick));
}

/**
 * The believer stepper — STEADY STATE, like the plan itself (owner
 * 2026-08-23: "we're just doing abstract steady state planning"). There is
 * no expiry event: a live body persists and its replacement is its
 * amortized bill (standingRefillEt), paid continuously as cash. Only the
 * live fleet earns and burns, at the plan's standing rates — all engine
 * outputs, nothing derived here. Staffing follows the plan: funded backed
 * steps sustain, unfunded staffing lapses (the plan stopped renewing it),
 * deficits hire while the bank affords the body. The spawn's 1 e/t
 * auto-regeneration to 300 keeps an empty world bootable — the physics
 * the real cold start leans on. Discrete ttl churn is execution's
 * business, measured at the mockup, not modeled here.
 */
function advance(chunks: number): void {
  for (let i = 0; i < chunks; i++) {
    const plan = currentPlan();
    const e = plan.expected;
    const earn = e.standingEt * DT;
    const sustain = e.standingRefillEt * DT;
    const burn = Math.min(e.standingUpgradeEt * DT, Math.max(state.bankStock + earn - sustain, 0));
    state.bankStock = Math.max(state.bankStock + earn - sustain - burn, 0);
    state.cp += burn;
    if (state.bankStock < 300) state.bankStock = Math.min(300, state.bankStock + DT);

    // Staffing follows the plan: lapse what is no longer funded, then hire
    // toward targets (producers before sinks) while the bank affords it.
    const next: ViewCreep[] = [];
    for (const corp of plan.corps) {
      next.push(...state.creeps.filter(c => c.corp === corp.id).slice(0, corp.target));
    }
    state.creeps = next;
    // Hire CHAIN-ATOMICALLY: a chain's bodies are worthless apart (a miner
    // without its collector only strands supply — the engine would rightly
    // refuse the incomplete chain next replan and the lapse rule would cull
    // the orphan). A chain hires only when the bank affords its whole
    // deficit; producers' chains before solo corps.
    const groups = new Map<string, typeof plan.corps>();
    for (const corp of plan.corps) {
      const key = corp.chain ?? `solo:${corp.id}`;
      const g = groups.get(key) ?? [];
      g.push(corp);
      groups.set(key, g);
    }
    const ordered = [...groups.entries()].sort(
      ([a], [b]) =>
        (a.indexOf("solo:") === 0 ? 1 : 0) - (b.indexOf("solo:") === 0 ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0)
    );
    for (const [, group] of ordered) {
      let cost = 0;
      const hires: { corpId: string; body: NonNullable<(typeof group)[number]["body"]>; n: number }[] = [];
      for (const corp of group) {
        if (corp.kind === "link") continue;
        if (!corp.body) continue;
        const live = state.creeps.filter(c => c.corp === corp.id).length;
        const n = corp.target - live;
        if (n > 0) {
          cost += n * bodyCost(corp.body);
          hires.push({ corpId: corp.id, body: corp.body, n });
        }
      }
      if (cost > 0 && cost <= state.bankStock) {
        for (const h of hires) {
          for (let k = 0; k < h.n; k++) {
            state.creeps.push({ id: `c${state.seq++}`, corp: h.corpId, body: h.body, ttl: 1500 });
          }
        }
        state.bankStock -= cost;
      }
      for (const corp of group) if (corp.kind === "link" && corp.backed === 0) buildLinks(corp.id);
    }
    state.tick += DT;
  }
  render();
}

/**
 * The believer as builder: when the plan funds a CANDIDATE link (piece 5's
 * investment, approved at full cost), place the missing structures at the
 * gap's endpoints and pay the capex from the bank — the interim stand-in
 * for the build corp, so the investment loop closes on screen.
 */
function buildLinks(corpId: string): void {
  const s = state.scenario;
  const rest = corpId.slice("link:".length);
  const arrow = rest.indexOf("->");
  if (arrow < 0) return;
  const tileOf = (place: string): XY | null => {
    if (place === "bank") return s.bank;
    if (place === "ctrl") return s.controller;
    const src = s.sources.find(k => k.id === place);
    return src ? { x: src.x, y: src.y } : null;
  };
  for (const place of [rest.slice(0, arrow), rest.slice(arrow + 2)]) {
    const tile = tileOf(place);
    if (!tile) continue;
    const near = s.links.some(l => Math.max(Math.abs(l.x - tile.x), Math.abs(l.y - tile.y)) <= 2);
    if (near || state.bankStock < LINK_COST) continue;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = tile.x + dx;
        const y = tile.y + dy;
        const taken =
          cellAt(s.terrain, x, y) === WALL ||
          s.links.some(l => l.x === x && l.y === y) ||
          s.sources.some(k => k.x === x && k.y === y) ||
          (s.spawn.x === x && s.spawn.y === y) ||
          (s.bank.x === x && s.bank.y === y);
        if (taken) continue;
        s.links.push({ id: `link${s.links.length + 1}`, x, y });
        state.bankStock -= LINK_COST;
        dx = 2;
        break;
      }
    }
  }
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
      const n = s.sources.length + s.links.length;
      s.sources = s.sources.filter(src => src.x !== x || src.y !== y);
      s.links = s.links.filter(l => l.x !== x || l.y !== y);
      if (s.sources.length + s.links.length === n && cellAt(s.terrain, x, y) !== PLAIN) setCell(s.terrain, x, y, PLAIN);
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
