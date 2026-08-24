/**
 * panels.ts — the RESULT panels (owner ruling: "the search is less
 * interesting than the result"): the funded corps with their P&L columns,
 * the blocked frontier with its reasons, and the expected line with the
 * conservation check. Everything shown is an ENGINE OUTPUT field — the
 * GUI derives nothing (graph-lab requirement #1).
 */
import { EnginePlan, Flows } from "../../src/engine/vocabulary";
import { BodyShape } from "../../src/sizing";
import { ViewCreep } from "../../src/engine/view";
import { REASON_COLOR } from "./graph";

export function fmtBody(b: BodyShape | null): string {
  if (!b) return "—";
  const parts: string[] = [];
  if (b.work) parts.push(`${b.work}W`);
  if (b.carry) parts.push(`${b.carry}C`);
  if (b.move) parts.push(`${b.move}M`);
  return parts.join(" ");
}

/** The corp's whole ROSTER, grouped — every body the corp runs on, live
 * or still to hire. The old column rendered `hires[0]`, the next
 * purchase, so a settled corp's body read "—" (the 2026-08-24 finding:
 * "the link doesn't show as requiring a body — neither do the mines");
 * a corp with genuinely no bodies (a pure-structure wire) still does. */
export function fmtStaff(staff: { body: BodyShape; live: string | null }[]): string {
  if (staff.length === 0) return "—";
  const groups = new Map<string, number>();
  for (const st of staff) {
    const k = fmtBody(st.body);
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  return [...groups.entries()].map(([k, n]) => (n > 1 ? `${n}× ${k}` : k)).join(", ");
}

/** Every commodity a corp trades, rendered generically — engine fields
 * verbatim, whatever the vocabulary grows to hold. */
export function fmtFlows(f: Flows): string {
  const parts: string[] = [];
  for (const place of Object.keys(f.energyAt ?? {})) {
    parts.push(`${(f.energyAt as Record<string, number>)[place].toFixed(1)}e@${place}`);
  }
  if (f.spawnTime) parts.push(`${f.spawnTime.toFixed(3)}p/t`);
  if (f.controlPoints) parts.push(`${f.controlPoints.toFixed(1)}CP`);
  if (f.progress) parts.push(`${f.progress.toFixed(1)}build`);
  return parts.length > 0 ? parts.join(" + ") : "—";
}

export function renderPanels(container: HTMLElement, plan: EnginePlan, creeps: ViewCreep[]): void {
  const rows = plan.corps
    .map(c => {
      // Structures back steps without being creeps — standing counts too.
      const live = Math.max(creeps.filter(k => k.corp === c.id).length, c.backed);
      return (
        `<tr><td class="id">${c.id}</td><td>${fmtStaff(c.staff)}</td>` +
        `<td class="num">${live}/${c.target}</td>` +
        `<td class="flows">${fmtFlows(c.inputs)}</td>` +
        `<td class="flows">${fmtFlows(c.outputs)}</td>` +
        `<td class="num strong">${c.pnl.netEt.toFixed(2)}</td></tr>`
      );
    })
    .join("");

  const frontier = plan.frontier
    .map(
      f =>
        `<div class="fline"><span class="chip" style="background:${REASON_COLOR[f.reason] ?? "#666"}">${f.reason}</span>` +
        `<span class="fid">${f.offerId}</span><span class="fdetail">${f.detail}</span></div>`
    )
    .join("");

  const violations = plan.violations
    .map(v => `<div class="fline"><span class="chip" style="background:#b3543a">book</span><span class="fdetail">${v}</span></div>`)
    .join("");

  const positions = plan.positions
    .map(
      p =>
        `<tr><td class="id">${p.place}</td><td class="num">${p.supplyEt.toFixed(2)}</td>` +
        `<td class="num">${p.demandEt.toFixed(2)}</td><td class="num strong">${p.netEt.toFixed(2)}</td></tr>`
    )
    .join("");

  const approvals = plan.approvals
    .map(
      a =>
        `<div class="fline"><span class="chip" style="background:#2a9d8f">approved</span>` +
        `<span class="fid">${a.structure} @ ${a.at} (${a.capex}e)</span><span class="fdetail">${a.detail}</span></div>`
    )
    .join("");

  const e = plan.expected;
  const leftover = e.deliveredEt - e.refillEt - e.feesEt - e.upgradeEt - e.buildEt;
  container.innerHTML =
    `<h2>The plan <span class="dim">t${plan.tick}</span></h2>` +
    `<table class="corps"><thead><tr><th>corp</th><th>body</th><th>live/target</th>` +
    `<th>in</th><th>out</th><th>net e/t</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="expected">plan: mined <b>${e.minedEt.toFixed(1)}</b> · delivered <b>${e.deliveredEt.toFixed(1)}</b> · ` +
    `refill <b>${e.refillEt.toFixed(2)}</b> · fees <b>${e.feesEt.toFixed(2)}</b> · ` +
    `upgrade <b>${e.upgradeEt.toFixed(1)}</b> · build <b>${e.buildEt.toFixed(1)}</b> · ` +
    `warchest <b>${e.warchestEt.toFixed(1)}</b> · holding <b>${e.holdingEt.toFixed(2)}</b> · ` +
    `to bank <b>${leftover.toFixed(2)}</b> e/t</div>` +
    `<div class="expected">standing today: delivering <b>${e.standingEt.toFixed(1)}</b> · ` +
    `upgrading <b>${e.standingUpgradeEt.toFixed(1)}</b> · building <b>${e.standingBuildEt.toFixed(1)}</b> · ` +
    `sustain bill <b>${e.standingRefillEt.toFixed(2)}</b> e/t</div>` +
    (approvals ? `<h2>Approved investments</h2>${approvals}` : "") +
    (violations ? `<h2>Book violations</h2>${violations}` : "") +
    `<h2>Positions</h2>` +
    `<table class="corps"><thead><tr><th>place</th><th>supply e/t</th><th>demand e/t</th><th>net</th></tr></thead>` +
    `<tbody>${positions}</tbody></table>` +
    `<div class="expected dim">every place clears; the bank's net is the leftover — the conservation identity, live</div>` +
    `<h2>Blocked frontier</h2>` +
    (frontier || `<div class="dim">nothing blocked — every offer funded to its schedule's end</div>`);
}
