# 41 — Fiscal periods and the standing report set

**Status: LANDED 2026-08-01** (owner: *"Let's call a fiscal month 1500 ticks
and a fiscal year 15000 ticks. Have the telemetry data take automated dumps at
month and fiscal ends so we can easily look back on them. Maybe with a
methodology stamp # so we can compare it over time. Document all this as a
standing principle and design spec."*)

## The principle

**The audit is a continuous accounting function, not a series of one-off
investigations.** It periodises, it closes each period into an immutable
record, and it stamps the methodology so a figure from one period can be
compared to another — or explicitly cannot be.

## The calendar

| | ticks | why |
|---|---|---|
| fiscal MONTH | **1500** | `CREEP_LIFETIME` — the exact horizon every body cost amortizes over |
| fiscal YEAR | **15000** | ten months |

The month is **not arbitrary**. `minerOverhead`, `haulerOverhead`,
`infraSpawnLoad` and `sustainableConsumptionRate` all divide by
`CREEP_LIFETIME`, so a fiscal month is precisely the period across which a
spawn purchase is expensed. Accrual and cash accounting coincide at a month
boundary, which is what makes the energy account's balancing identity
meaningful over one.

The year at ten months is long enough to contain ~1.7 of the measured
~9000-tick bank limit cycle (ledger **OSC**), so an **annual** figure averages
OVER the oscillation. A **monthly** figure does not — months are phase samples
by construction and must be read as such.

Periods are absolute functions of the tick, so they need no epoch and cannot
drift:

```
FY    = floor(tick / 15000)
month = floor((tick % 15000) / 1500) + 1        label: FY4847-M02
```

## The close

`npm run fiscal:close` walks the committed captures, finds every month boundary
crossed but not yet closed, and writes that period's standard reports to
`docs/fiscal/<label>.md`. The production-audit command runs it every cycle, so
closes happen as periods roll.

Three properties, each deliberate:

- **Append-only.** An existing close is never rewritten. The record is history;
  re-running is safe and idempotent.
- **Approximate, and says so.** Captures rarely land on a boundary, so a close
  uses the captures NEAREST each end and prints the ticks it actually measured
  plus the coverage %. A close describes its stated window, never a claim to
  have measured `[start, end)` exactly.
- **Refuses a bad close.** Coverage outside **50–175%** is skipped rather than
  filed. A window three times its nominal period is not a month — it is a
  different statistic wearing a month's label, and filing it would corrupt the
  very comparison this record exists for. Captures missing the `core` or `flow`
  segment are skipped for the same reason: a partial period is worse than a
  missing one because it looks comparable.

## The methodology stamp

`METHODOLOGY` (scripts/waste-ledger.ts) prints on every report and is written
into every close. **Two reports are only directly comparable at the same
stamp.**

Bump it when HOW a figure is computed changes — a new account, a reclassified
line, a changed budget derivation, a corrected sign. Do NOT bump for a new
capture, a threshold tweak that changes only a verdict, or wording.

The stamp exists because of a measured failure: **P10** was carried as a real
28 e/t leak for four audit cycles and cited as the root cause of the bank
saw-tooth, before being withdrawn as double accounting. Without a stamp, its
numbers would sit in the historical record indistinguishable from figures
computed correctly.

**Methodology #1** — energy account (revenue / direct cost of mining /
overhead / capital / appropriations / residual), budget-vs-actual-vs-variance,
source P&L, controller variance bridge, ground-rot split, capital vs operating,
reserving as COGS.

## The standing report set

Every audit cycle produces these, in this order. **This is a contract**: a
future session changes the set only deliberately, and bumps the methodology
stamp when it does.

1. **ENERGY ACCOUNT** — the income statement, budget vs actual vs variance,
   balancing to a named RESIDUAL (spec 15).
2. **SOURCE P&L** — the same accounts one level down, per source, against the
   planner's own `candidates[].net`.
3. **CONTROLLER VARIANCE BRIDGE** — decomposes the top-line variance into
   accounting terms vs behaviour terms.
4. **WASTE LEDGER** — the leak rows, ranked, with the TOP LINE named.
5. **FISCAL CLOSE** — any newly-crossed period written to `docs/fiscal/`.

## Known limits (stated, not hidden)

- **Revenue is plan CAPACITY**, less the measured pile change — there is no
  independent meter of energy delivered into storage, so the revenue variance
  is structurally ~0 and cannot detect an income shortfall.
- **The residual is real but unattributed** (~14% of gross at methodology #1).
  Ground rot is split out (core segment v19); repair and tombstone losses are
  not yet metered.
- **Historical backfill is patchy.** Captures were taken at audit cadence, not
  at period boundaries, so many past months are skipped by the coverage guard.
  Going forward the audit's own cadence fills them.
