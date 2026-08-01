/**
 * @fileoverview FISCAL CLOSE - automated period-end dumps (owner 2026-08-01:
 * "have the telemetry data take automated dumps at month and fiscal ends so we
 * can easily look back on them ... with a methodology stamp so we can compare
 * it over time").
 *
 * The bot cannot write files, so the close is host-side: it walks the committed
 * captures, finds every fiscal-month boundary that has been crossed but not yet
 * closed, and writes that period's standard reports to `docs/fiscal/`.
 *
 * HONESTY: a capture rarely lands exactly on a boundary, so a close uses the
 * captures BRACKETING it and records the ticks it actually used. A close is
 * therefore an approximation of the period, and says so in its own header -
 * never a claim to have measured [startTick, endTick) exactly.
 *
 * Idempotent: an existing close is never overwritten (the historical record is
 * append-only), so re-running each audit cycle is safe and cheap.
 *
 * Usage: npm run fiscal:close [-- --dry]
 *
 * @module scripts/fiscal-close
 */

import * as fs from "fs";
import * as path from "path";
import { METHODOLOGY, computeLedger, formatAccounts, formatLedger, formatSourcePnL } from "./waste-ledger";
import { FiscalPeriod, boundariesBetween, isYearEnd, periodOf } from "./fiscal";

const FIXTURES = path.join(__dirname, "..", "test", "fixtures", "telemetry");
const OUT = path.join(__dirname, "..", "docs", "fiscal");

interface Capture {
  tick: number;
  file: string;
  data: any;
}

function loadCaptures(): Capture[] {
  return fs
    .readdirSync(FIXTURES)
    .filter(f => /^shard1-t\d+\.json$/.test(f))
    .map(f => ({ tick: Number(f.match(/t(\d+)/)![1]), file: f, data: null as any }))
    .sort((a, b) => a.tick - b.tick);
}

/** The capture NEAREST a tick, from either side - the best available proxy for
 *  "the colony at that instant". Nearest beats before-only: with captures every
 *  ~1-5k ticks against a 1500-tick month, an always-before rule drags the open
 *  end far back and produces a "month" several months wide. */
function nearest(caps: Capture[], tick: number): Capture | undefined {
  let best: Capture | undefined;
  let bestD = Infinity;
  for (const c of caps) {
    const d = Math.abs(c.tick - tick);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * How far off a period a close may be and still be written. A close is an
 * approximation, but one measured over 3x its nominal period is not a MONTH -
 * it is a different statistic wearing a month's label, and filing it would
 * corrupt exactly the year-over-year comparison this record exists for.
 */
const COVERAGE_MIN = 0.5;
const COVERAGE_MAX = 1.75;

function read(c: Capture): any {
  if (!c.data) c.data = JSON.parse(fs.readFileSync(path.join(FIXTURES, c.file), "utf8"));
  return c.data;
}

function closeOne(caps: Capture[], boundary: number, dry: boolean): string | null {
  // The period that just ENDED at this boundary.
  const period: FiscalPeriod = periodOf(boundary - 1);
  const outFile = path.join(OUT, `${period.label}.md`);
  if (fs.existsSync(outFile)) return null; // append-only: never rewrite history

  // Bracket the period: the capture nearest its start and the one nearest its end.
  const openCap = nearest(caps, period.startTick);
  const closeCap = nearest(caps, period.endTick);
  if (!openCap || !closeCap || openCap.tick >= closeCap.tick) return null;
  const cov = (closeCap.tick - openCap.tick) / (period.endTick - period.startTick);
  if (cov < COVERAGE_MIN || cov > COVERAGE_MAX) return null; // too far off to call a month

  const cap = read(closeCap);
  const base = read(openCap);
  // Not every historical capture carries every segment (early ones predate the
  // flow segment entirely). A close needs core + flow on BOTH ends; without
  // them it is skipped rather than half-written - a partial period in the
  // record is worse than a missing one, because it looks comparable.
  const complete = (c: any): boolean => !!c?.data?.core && !!c?.data?.flow;
  if (!complete(cap) || !complete(base)) return null;
  const rows = computeLedger(cap, base);
  const coverage = cov * 100;

  const body = [
    `# ${period.label}${isYearEnd(period) ? "  (FISCAL YEAR END)" : ""}`,
    "",
    `**Methodology #${METHODOLOGY}** — reports are only directly comparable at the same stamp.`,
    "",
    `Period ticks \`${period.startTick}\`–\`${period.endTick}\`. Closed from the captures`,
    `bracketing it: **t${openCap.tick} → t${closeCap.tick}** (${closeCap.tick - openCap.tick} ticks,`,
    `${coverage.toFixed(0)}% of the period). A close APPROXIMATES its period — captures rarely land`,
    "on a boundary, so the window actually measured is stated above and is what the figures describe.",
    "",
    "```",
    formatAccounts(cap, base, rows),
    formatSourcePnL(cap),
    "",
    formatLedger(rows, cap.tick, base.tick),
    "```",
    ""
  ].join("\n");

  if (!dry) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(outFile, body);
  }
  return `${period.label}${isYearEnd(period) ? " (YEAR END)" : ""}  t${openCap.tick}->t${closeCap.tick} (${coverage.toFixed(0)}% coverage)`;
}

if (require.main === module) {
  const dry = process.argv.includes("--dry");
  const caps = loadCaptures();
  if (caps.length < 2) {
    console.log("fiscal close: need at least two captures");
  } else {
    const crossed = boundariesBetween(caps[0].tick, caps[caps.length - 1].tick);
    const written = crossed.map(b => closeOne(caps, b, dry)).filter(Boolean) as string[];
    console.log(
      written.length
        ? `fiscal close${dry ? " (DRY)" : ""} — ${written.length} period(s):\n  ${written.join("\n  ")}`
        : `fiscal close: nothing new (${crossed.length} boundaries in range, all already closed or uncovered)`
    );
  }
}
