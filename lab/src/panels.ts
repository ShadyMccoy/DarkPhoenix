/**
 * panels.ts — the RESULT panels (owner ruling: "the search is less
 * interesting than the result"): the funded corps with their P&L columns,
 * the blocked frontier with its reasons, and the expected line with the
 * conservation check. Everything shown is an ENGINE OUTPUT field — the
 * GUI derives nothing (graph-lab requirement #1).
 */
import { EnginePlan } from "../../src/engine/vocabulary";
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

export function renderPanels(container: HTMLElement, plan: EnginePlan, creeps: ViewCreep[]): void {
  const rows = plan.corps
    .map(c => {
      const live = creeps.filter(k => k.corp === c.id).length;
      return (
        `<tr><td class="id">${c.id}</td><td>${fmtBody(c.body)}</td>` +
        `<td class="num">${live}/${c.target}</td>` +
        `<td class="num">${c.pnl.grossEt.toFixed(2)}</td>` +
        `<td class="num">${c.pnl.costEt.toFixed(2)}</td>` +
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

  const e = plan.expected;
  const leftover = e.deliveredEt - e.refillEt - e.upgradeEt;
  container.innerHTML =
    `<h2>The plan <span class="dim">t${plan.tick}</span></h2>` +
    `<table class="corps"><thead><tr><th>corp</th><th>body</th><th>live/target</th>` +
    `<th>gross e/t</th><th>cost e/t</th><th>net e/t</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="expected">plan: mined <b>${e.minedEt.toFixed(1)}</b> · delivered <b>${e.deliveredEt.toFixed(1)}</b> · ` +
    `refill <b>${e.refillEt.toFixed(2)}</b> · upgrade <b>${e.upgradeEt.toFixed(1)}</b> · ` +
    `to bank <b>${leftover.toFixed(2)}</b> e/t</div>` +
    `<div class="expected">standing today: delivering <b>${e.standingEt.toFixed(1)}</b> · ` +
    `upgrading <b>${e.standingUpgradeEt.toFixed(1)}</b> · sustain bill <b>${e.standingRefillEt.toFixed(2)}</b> e/t</div>` +
    `<h2>Blocked frontier</h2>` +
    (frontier || `<div class="dim">nothing blocked — every offer funded to its schedule's end</div>`);
}
