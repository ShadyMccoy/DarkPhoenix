/**
 * believer.ts — the believer stepper, pure and DOM-free (extracted from
 * main.ts so the unit suite can certify the whole investment loop
 * headless). STEADY STATE, like the plan itself (owner 2026-08-23: "we're
 * just doing abstract steady state planning"): no expiry event — a live
 * body persists and its replacement is its amortized bill, paid
 * continuously. Only the live fleet earns and burns, at the plan's
 * standing rates — all engine outputs, nothing derived here.
 *
 * Tier 1.1 makes the believer the plan's EXECUTOR for capital formation:
 * approvals become sites, the build corp's standing burn pays capex down
 * as cash, and a finished site realizes its structure — the investment
 * loop closes on screen with construction TIME in it, which the old
 * instant-build stand-in hid.
 */
import { replan } from "../../src/engine/replan";
import { EnginePlan } from "../../src/engine/vocabulary";
import { ViewCreep } from "../../src/engine/view";
import { bodyCost } from "../../src/primitives";
import { stationSearch, stationTile, wireStations } from "./placement";
import { Scenario, ScenarioSite, WALL, XY, assemble, cellAt, placeTile as scenarioPlaceTile } from "./scenario";

/** One believer chunk: the replan cadence's order of magnitude. */
export const DT = 150;

export interface BelieverState {
  scenario: Scenario;
  creeps: ViewCreep[];
  bankStock: number;
  tick: number;
  cp: number;
  seq: number;
}

export function planFor(state: BelieverState): EnginePlan {
  return replan(assemble(state.scenario, state.creeps, state.bankStock, state.tick));
}

const placeTile = scenarioPlaceTile;

function freeTileNear(s: Scenario, tile: XY, maxR = 2): XY | null {
  for (let r = 1; r <= maxR; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tile.x + dx;
        const y = tile.y + dy;
        const taken =
          cellAt(s.terrain, x, y) === WALL ||
          s.links.some(l => l.x === x && l.y === y) ||
          s.sites.some(k => k.x === x && k.y === y) ||
          s.sources.some(k => k.x === x && k.y === y) ||
          s.extensions.some(k => k.x === x && k.y === y) ||
          (s.spawn.x === x && s.spawn.y === y) ||
          (s.bank.x === x && s.bank.y === y) ||
          (s.controller !== null && s.controller.x === x && s.controller.y === y);
        if (!taken) return { x, y };
      }
    }
  }
  return null;
}

/** Approvals become SITES: the plan committed the capex; the ground gets
 * the project. One site per approval, at its `at` place. */
function placeSites(state: BelieverState, plan: EnginePlan): void {
  const s = state.scenario;
  const stationMembers = (place: string): string[] =>
    place.indexOf("station:") === 0 ? place.slice("station:".length).split("+") : [];
  for (const a of plan.approvals) {
    if (a.edge && s.sites.some(k => k.edge && k.edge.from === a.edge?.from && k.edge.to === a.edge?.to)) continue;
    // A station under construction suppresses any station approval
    // SHARING a member, not just its exact id: mid-build occupancy can
    // drift the search's kept set, and the drifted id re-approved a
    // second station for the same cluster while the first was still
    // paying (review finding).
    if (
      a.edge &&
      stationMembers(a.edge.from).length > 0 &&
      s.sites.some(k => k.edge && stationMembers(k.edge.from).some(m => stationMembers(a.edge!.from).includes(m)))
    ) {
      continue;
    }
    // A shared station's place does not exist yet — the search names its
    // tile deterministically from the member sources.
    const anchor =
      a.at.indexOf("station:") === 0 ? stationTile(s, a.at.slice("station:".length).split("+")) : placeTile(s, a.at);
    if (!anchor) continue;
    const tile = freeTileNear(s, anchor) ?? anchor;
    s.sites.push({
      id: `s${state.seq++}`,
      structure: a.structure,
      x: tile.x,
      y: tile.y,
      total: a.capex,
      remaining: a.capex,
      edge: a.edge
    });
  }
}

/** A finished site realizes its structure. A link approval carries an
 * EDGE: the placement search names the exact station tiles (owner
 * 2026-08-24 — the same search that priced the wire builds it). An
 * extension joins the estate around the spawn. */
function realize(state: BelieverState, site: ScenarioSite): void {
  const s = state.scenario;
  if (site.structure === "link") {
    if (site.edge && site.edge.from.indexOf("station:") === 0) {
      // The branching tree's shared station: one link at the searched
      // displacement tile (it becomes an OUTPOST place next assembly,
      // and the standing trunk machinery routes the members through
      // it), plus the SEARCH's own hub if this project paid for one —
      // the hub must share the station's room, which a first-member
      // wireStations re-derivation did not guarantee.
      const ids = site.edge.from.slice("station:".length).split("+");
      const search = stationSearch(s, ids);
      if (search && !s.links.some(l => l.x === search.tile.x && l.y === search.tile.y)) {
        s.links.push({ id: `link${s.links.length + 1}`, x: search.tile.x, y: search.tile.y });
      }
      if (Math.round(site.total / 5000) > 1 && search?.missingHub) {
        if (!s.links.some(l => l.x === search.hub.x && l.y === search.hub.y)) {
          s.links.push({ id: `link${s.links.length + 1}`, x: search.hub.x, y: search.hub.y });
        }
      }
      return;
    }
    const w = site.edge ? wireStations(s, site.edge.from, site.edge.to) : null;
    if (w) {
      if (w.missingMouth) s.links.push({ id: `link${s.links.length + 1}`, x: w.mouth.x, y: w.mouth.y });
      if (w.missingHub) s.links.push({ id: `link${s.links.length + 1}`, x: w.hub.x, y: w.hub.y });
    }
  } else if (site.structure === "extension") {
    const at = freeTileNear(s, s.spawn, 4);
    if (at) s.extensions.push(at);
  } else if (site.structure === "container" || site.structure === "storage") {
    s.bankBranch = site.structure;
  } else if (site.structure === "road" && site.edge) {
    const e = site.edge;
    if (!s.roads.some(r => r.from === e.from && r.to === e.to)) s.roads.push({ from: e.from, to: e.to });
  }
}

/**
 * One believer chunk. Cash first (earn, sustain, capex burn, upgrade
 * burn — engine rates, believer arithmetic), then completion, then
 * staffing toward the plan. Returns the plan it acted on.
 */
export function advanceChunk(state: BelieverState): EnginePlan {
  const plan = planFor(state);
  const e = plan.expected;

  placeSites(state, plan);

  // Earn net of the sustain bill, the standing operating fees (the
  // link's tax on flow that ran — without the debit the wire's loss was
  // phantom cash), and the branch's holding cost (the pile ROTS while
  // the warchest accumulates — piece 9's own cost line).
  let stock = state.bankStock + (e.standingEt - e.standingRefillEt - e.standingFeesEt - e.holdingEt) * DT;

  // Capex leaves the bank as build flow: the standing burn pays sites
  // down in order, bounded by the stock the approvals reserved.
  let pool = e.standingBuildEt * DT;
  for (const site of state.scenario.sites) {
    const take = Math.min(pool, site.remaining, Math.max(stock, 0));
    site.remaining -= take;
    stock -= take;
    pool -= take;
  }

  const burn = Math.min(e.standingUpgradeEt * DT, Math.max(stock, 0));
  stock -= burn;
  state.cp += burn;
  state.bankStock = Math.max(stock, 0);
  // The spawn's 1 e/t auto-regeneration to 300 keeps an empty world
  // bootable — the physics the real cold start leans on.
  if (state.bankStock < 300) state.bankStock = Math.min(300, state.bankStock + DT);

  const done = state.scenario.sites.filter(s => s.remaining <= 1e-6);
  for (const site of done) realize(state, site);
  state.scenario.sites = state.scenario.sites.filter(s => s.remaining > 1e-6);

  // Staffing follows the plan: lapse what is no longer funded, then hire
  // toward targets while the bank affords it.
  const next: ViewCreep[] = [];
  for (const corp of plan.corps) {
    next.push(...state.creeps.filter(c => c.corp === corp.id).slice(0, corp.target));
  }
  state.creeps = next;
  // Hire CHAIN-ATOMICALLY, in ROUNDS: a chain's bodies are worthless
  // apart (a miner without its collector only strands supply), so each
  // round buys ONE body per deficit corp in the chain, together, while
  // the bank affords the round. Whole-deficit atomicity deadlocked the
  // cold ramp: an 8-workman target could never start from a 300e bank.
  // Producers' chains hire before solo corps.
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
    for (;;) {
      let cost = 0;
      const hires: { corpId: string; body: (typeof group)[number]["hires"][number] }[] = [];
      for (const corp of group) {
        // The plan's hire list, body by body — the fleet may end in a
        // remainder-sized runt, and hiring the FIRST body for every slot
        // overshot the quoted machine time (the forest stall).
        const live = state.creeps.filter(c => c.corp === corp.id).length;
        const body = corp.hires[live - corp.backed];
        if (body) {
          cost += bodyCost(body);
          hires.push({ corpId: corp.id, body });
        }
      }
      if (hires.length === 0 || cost > state.bankStock) break;
      for (const h of hires) {
        state.creeps.push({ id: `c${state.seq++}`, corp: h.corpId, body: h.body, ttl: 1500 });
      }
      state.bankStock -= cost;
    }
  }
  state.tick += DT;
  return plan;
}
