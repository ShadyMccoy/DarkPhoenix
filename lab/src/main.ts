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
import { renderPanels } from "./panels";
import { PLAIN, SWAMP, Scenario, WALL, assemble, cellAt, exportSave, importSave, setCell } from "./scenario";
import { bootstrapScenario } from "./scenarios";

/** One believer chunk: the replan cadence's order of magnitude. */
const DT = 150;
const CREEP_LIFE = 1500;

interface LabState {
  scenario: Scenario;
  creeps: ViewCreep[];
  bankStock: number;
  tick: number;
  cp: number;
  tool: Tool;
  seq: number;
}

function fresh(scenario: Scenario): LabState {
  return {
    scenario,
    creeps: scenario.creeps.map(c => ({ ...c })),
    bankStock: scenario.bankStock,
    tick: 0,
    cp: 0,
    tool: "select",
    seq: 1
  };
}

let state = fresh(bootstrapScenario());

function currentPlan(): EnginePlan {
  return replan(assemble(state.scenario, state.creeps, state.bankStock, state.tick));
}

/**
 * The believer stepper, in CASH terms: only the LIVE fleet earns and burns
 * (the plan's standing rates — engine output, never a GUI derivation);
 * bodies cost their price at purchase, producers buy before sinks, and the
 * spawn's 1 e/t auto-regeneration to 300 keeps a dead world bootable —
 * the same physics the real cold start leans on.
 */
function advance(chunks: number): void {
  for (let i = 0; i < chunks; i++) {
    const plan = currentPlan();
    const e = plan.expected;
    // Earn at the standing rate; burn at the standing rate BOUNDED BY CASH
    // — the plan may fund upgraders against planned inflow, but the
    // believer's bank never overdraws (an upgrader with no energy idles).
    const earn = e.standingEt * DT;
    const burn = Math.min(e.standingUpgradeEt * DT, Math.max(state.bankStock + earn, 0));
    state.bankStock += earn - burn;
    state.cp += burn;
    if (state.bankStock < 300) state.bankStock = Math.min(300, state.bankStock + DT);
    state.creeps = state.creeps.map(c => ({ ...c, ttl: c.ttl - DT })).filter(c => c.ttl > 0);
    const buyOrder = [...plan.corps].sort((a, b) => (a.chain === null ? 1 : 0) - (b.chain === null ? 1 : 0));
    for (const corp of buyOrder) {
      if (!corp.body) continue;
      const cost = bodyCost(corp.body);
      let live = state.creeps.filter(c => c.corp === corp.id).length;
      while (live < corp.target && cost <= state.bankStock) {
        state.creeps.push({ id: `c${state.seq++}`, corp: corp.id, body: corp.body, ttl: CREEP_LIFE });
        state.bankStock -= cost;
        live++;
      }
    }
    state.tick += DT;
  }
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
    case "wall":
      setCell(s.terrain, x, y, WALL);
      break;
    case "swamp":
      setCell(s.terrain, x, y, SWAMP);
      break;
    case "erase": {
      const n = s.sources.length;
      s.sources = s.sources.filter(src => src.x !== x || src.y !== y);
      if (s.sources.length === n && cellAt(s.terrain, x, y) !== PLAIN) setCell(s.terrain, x, y, PLAIN);
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

function render(): void {
  const plan = currentPlan();
  renderMap($("map"), state.scenario, null, applyTool);
  renderPanels($("panels"), plan, state.creeps);
  $("status").textContent =
    `t${state.tick} · bank ${Math.round(state.bankStock)}e · ` +
    `${state.creeps.length} creeps · ${Math.round(state.cp)} CP`;
  ($("bankStock") as HTMLInputElement).value = String(Math.round(state.bankStock));
  ($("bodyBudget") as HTMLInputElement).value = String(state.scenario.bodyBudget);
}

function wire(): void {
  renderTools();
  $("advance1").addEventListener("click", () => advance(1));
  $("advance10").addEventListener("click", () => advance(10));
  $("reset").addEventListener("click", () => {
    state = fresh(state.scenario);
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
