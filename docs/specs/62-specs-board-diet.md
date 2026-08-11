# Spec 62 — The specs board: status is not archaeology

**Status: PROPOSED (2026-08-11, session follow-up).** Zero code risk, but it
restructures the owner's own audit surface, so it wants an explicit owner go
before the migration session runs.

## Problem (measured on this repo, today)

`docs/specs/README.md` is the first file the read order sends a developer to
after ONTOLOGY and PIPELINE — and it has become an audit JOURNAL wearing a
status table's clothes:

- the file is ~28k tokens; single table rows exceed **4,000 characters**
  (spec 08's row is a session-by-session history of the grid program; spec
  26's row carries a superseded diagnosis kept "for archaeology" — inside a
  status cell);
- **NOW is indistinguishable from history.** "P0 (go next)" stamps from
  2026-08-05 sit beside "P0" stamps from 2026-07-22 (spec 27 has been "next
  session's first work item" for three weeks of sessions); a reader cannot
  tell a standing priority from a stale one without reading every row;
- the same fact lands in two places (the row AND the spec file), so rows
  drift from their specs — the exact two-books defect this codebase spends
  specs 51/60 deleting from its energy accounting, reproduced in its
  project management.

The journal itself is VALUABLE — the epistemics culture here runs on
greppable incident history — so nothing may be deleted. The defect is only
WHERE it lives.

## Design

**1. The README becomes a status BOARD.** One row per spec:

```
| # | Spec | STATUS <stamp> | one line, <= 400 chars | priority |
```

- `STATUS` from a closed vocabulary: `PROPOSED | BACKLOG | DESIGN |
  IN PROGRESS | PARKED | LANDED | DONE | SUPERSEDED`, each with a date.
- The one-liner says what the spec IS and what state it is in — never how
  it got there. Everything else is a pointer into the spec file.

**2. History moves VERBATIM into the spec files** under a `## Journal`
section (newest first, append-only). Moves, not rewrites: every sentence in
today's README rows must be findable in a spec file afterward, so `git log
-S` and plain grep keep working. Rows that reference other specs' history
move to the spec that OWNS the event.

**3. The deployment-status prose block** at the README's head (live-on-shard
state, verified telemetry versions, the standing top line) moves to
`docs/specs/NOW.md` — a page that is ALLOWED to be current-state-only and is
expected to be rewritten every audit cycle, with three fixed sections:
what's live (deploy stamps), the live-unverified queue, and the current
priority order (each entry dated, so staleness is visible). The README
links it first.

**4. The docs ratchet** (house style — acceptance criteria live in tests):
`test/unit/docs/specsBoard.test.ts`:

- every `docs/specs/NN-*.md` has exactly one README row, and every row
  points at an existing file;
- every row's status matches the vocabulary regex `STATUS DATE` and every
  row is ≤ 400 characters;
- `NOW.md`'s three sections exist and every entry carries a date.

The length bound is the teeth: the next session that tries to append a
paragraph of history to a row fails the suite and is pointed at the spec's
Journal instead. (The rows added 2026-08-11 for specs 61–63 are written in
the short form already — the exemplars; every older row migrates.)

## Migration

One mechanical session: move row bodies into Journals, write the
one-liners, extract NOW.md, land the ratchet test in the same commit so the
new shape is pinned the moment it exists. Acceptance beyond the ratchet:
`git diff` shows pure moves (owner spot-check that no sentence was lost),
and a grep for three known incident strings (e.g. `t72455355`,
`stranded-reserver`, `90-vs-85`) still hits.

## Non-goals

- No condensing, no rewriting, no deleting history — relocation only.
- CLAUDE.md is untouched (spec 61 owns its diet, by a different mechanism).
