/**
 * @fileoverview The CPU report: a clear, human-readable breakdown of how the
 * bot's CPU is ACTUALLY spent this tick, formatted from the `Memory.corpCpu`
 * ledger (spec 20 phases 1-2).
 *
 * The ledger already carries every number — per-kind corp CPU (`byKind`),
 * the corp total (`corpsTotal`), the named infrastructure buckets (`infra`),
 * the whole-tick anchor (`wholeTick`), and the worst per-corp offenders by
 * ~100-tick EMA (`top`). What was missing was any place a human could READ it:
 * it was published every tick but surfaced in no console command, no audit
 * report, and no telemetry export. This module is that missing surface.
 *
 * It is PURE — no Game, no Memory, no console. It takes the ledger shape and
 * returns lines. The live `global.cpuReport()` console command and the offline
 * `audit:report` both feed it the same data, so the report reads identically
 * whether pulled live or from a captured segment. Tests inject a hand-built
 * ledger (`cpuReport.test.ts`).
 *
 * ## The reconciliation (spec 20's core invariant)
 *
 * The report leads with the reconciliation the ledger was built to expose:
 *
 *     wholeTick = corps + infra + unnamed
 *
 * where `corps` is CPU attributed to a commissioned corp, `infra` is the sum
 * of the named bulkhead buckets, and `unnamed` is the residual — everything
 * not yet attributable to either (the planner solve, cleanup, planning-phase
 * work outside a bulkhead). A residual that grows is the signal spec 20 phase
 * 3 shrinks; naming it here is what keeps it from growing unnoticed.
 */

/** The `Memory.corpCpu` ledger shape (structurally identical to the field). */
export interface CorpCpuLedger {
  tick: number;
  corpsTotal: number;
  byKind: { [kind: string]: number };
  top: { corpId: string; kind: string; cpu: number; avg: number }[];
  infra?: { [bucket: string]: number };
  wholeTick?: number;
}

/** Live CPU context the console command adds (not in the persisted ledger). */
export interface CpuReportContext {
  /** Game.cpu.bucket at report time. */
  bucket?: number;
  /** Game.cpu.limit (the per-tick allowance). */
  limit?: number;
}

/** How many by-kind / infra / top rows to print before eliding the tail. */
const MAX_ROWS = 12;

function pct(part: number, whole: number): string {
  if (whole <= 0) return "  -";
  return `${Math.round((part / whole) * 100)}%`.padStart(3);
}

function fmt(n: number): string {
  return n.toFixed(2).padStart(7);
}

/**
 * Format the CPU ledger into report lines. Tolerant of a partial ledger: a
 * capture taken before `infra`/`wholeTick` were published still renders (the
 * reconciliation just falls back to the corp+infra sum as the denominator).
 */
export function formatCpuReport(ledger: CorpCpuLedger | undefined, ctx: CpuReportContext = {}): string[] {
  if (!ledger) return ["[CPU] no ledger yet (Memory.corpCpu unset — has a live tick run?)"];

  const infra = ledger.infra ?? {};
  const infraTotal = Object.values(infra).reduce((s, v) => s + v, 0);
  const corps = ledger.corpsTotal;
  // The whole-tick anchor is the true denominator; without it (partial
  // capture) fall back to what we can attribute, so percentages still sum.
  const accounted = corps + infraTotal;
  const whole = ledger.wholeTick ?? accounted;
  // The residual: whole-tick CPU no corp and no named bucket claimed. Clamp at
  // zero — metering overhead can make the parts sum a hair above wholeTick.
  const unnamed = Math.max(0, whole - accounted);

  const lines: string[] = [];
  const bucketStr = ctx.bucket !== undefined ? `  bucket ${(ctx.bucket / 1000).toFixed(1)}k` : "";
  const limitStr = ctx.limit !== undefined ? `/${ctx.limit}` : "";
  lines.push(`=== CPU Report (tick ${ledger.tick}) ===`);
  lines.push(`whole-tick ${fmt(whole)}${limitStr}${bucketStr}`);
  lines.push(`  corps   ${fmt(corps)}  (${pct(corps, whole)})`);
  lines.push(`  infra   ${fmt(infraTotal)}  (${pct(infraTotal, whole)})`);
  lines.push(`  unnamed ${fmt(unnamed)}  (${pct(unnamed, whole)})  <- solve / cleanup / planning outside buckets`);
  if (ledger.wholeTick === undefined) {
    lines.push(`  (partial capture: no whole-tick anchor — percentages are of the corp+infra sum)`);
  }

  const kinds = Object.entries(ledger.byKind).sort((a, b) => b[1] - a[1]);
  if (kinds.length > 0) {
    lines.push(`corps by kind (this tick):`);
    for (const [kind, cpu] of kinds.slice(0, MAX_ROWS)) {
      lines.push(`  ${kind.padEnd(16)} ${fmt(cpu)}  (${pct(cpu, whole)})`);
    }
    if (kinds.length > MAX_ROWS) lines.push(`  ... and ${kinds.length - MAX_ROWS} more kinds`);
  }

  const buckets = Object.entries(infra).sort((a, b) => b[1] - a[1]);
  if (buckets.length > 0) {
    lines.push(`infra buckets (this tick):`);
    for (const [name, cpu] of buckets.slice(0, MAX_ROWS)) {
      lines.push(`  ${name.padEnd(16)} ${fmt(cpu)}  (${pct(cpu, whole)})`);
    }
    if (buckets.length > MAX_ROWS) lines.push(`  ... and ${buckets.length - MAX_ROWS} more buckets`);
  }

  if (ledger.top.length > 0) {
    lines.push(`top corps (100t EMA):`);
    for (const row of ledger.top.slice(0, MAX_ROWS)) {
      lines.push(`  ${row.corpId.padEnd(22)} cpu ${fmt(row.cpu)}  avg ${fmt(row.avg)}`);
    }
  }

  return lines;
}
