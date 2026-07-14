# Getting live game data into the dev setup

The live bot already emits rich state every tick; this repo already has the
pull-side tooling. Nothing new to build — this doc is the map of what exists,
what each path gives you, and how to run it.

## How data leaves the live game

`src/main.ts` (PHASE 3, `updateTelemetry`, ~L392) calls
`src/telemetry/Telemetry.ts` each tick, which serialises colony state into
`RawMemory.segments[0-6]` and marks them **public** (`setPublicSegments`).
Separately, `src/telemetry/BlackBox.ts` flushes the last ~200 ticks of
decisions to segment **5**. Public segments are readable over the Screeps HTTP
API by anyone, so the pull scripts below just poll that API.

| Segment | Content | Shape |
|---|---|---|
| 0 | Core: CPU, GCL, creep counts, owned rooms | `CoreTelemetry` |
| 1 | Nodes: territories, resources, ROI | `NodeTelemetry` |
| 2 | Edges: spatial + economic edges, flow rates | `EdgesTelemetry` |
| 3 | Intel: scouted rooms | `IntelTelemetry` |
| 4 | Corps: mining/hauling/upgrading/etc. | `CorpsTelemetry` |
| 5 | **Black box**: last ~200 ticks of decisions/alerts/errors | `{v,tick,alerts,rows}` |
| 6 | Flow: sources, sinks, allocations | `FlowTelemetry` |

The exact field layouts (compact keys included) are the exported interfaces in
`src/telemetry/Telemetry.ts` — that file is the schema of record.

> **Caveat — telemetry can be skipped.** Under CPU pressure the governor sets
> `skipTelemetry`, so segments are not refreshed that tick (`main.ts` L401). A
> snapshot's `tick` field is the ground truth for how fresh the data is; don't
> assume "now".

## Three pull paths

### 1. Terrain fixtures — `npm run capture:rooms` (no token)

Snapshots terrain + sources/controller/mineral for named rooms into
`test/fixtures/real-rooms/`, in the `loadLayout` format the sims/grid consume
directly. Uses the **public map API**, so no token is needed. Player structures
are deliberately dropped — this is map geometry, not live economy state.

```bash
npm run capture:rooms -- --shard shard3 W1N8 W2N8 W1N7
npm run capture:rooms -- --shard shard3 --around W5N8   # room + 8 neighbours
```

Adjacency is derived from the room names, so a captured contiguous block drops
straight into `npm run sim:real` with working exits.

### 2. Live economy snapshot — the telemetry segments

Two consumers read the parsed segments 0–6 (this is the "live economy state"
most people mean):

**a) Browser dashboard — `telemetry-app/`.** Polls the segments and renders CPU,
GCL, nodes, corps, flow, terrain and intel live. Data stays in the browser; it
is not saved into this repo.

```bash
cd telemetry-app
npm install
SCREEPS_TOKEN=your-token-here npm start   # then open http://localhost:3000
```

Config precedence: env vars override `telemetry-app/config.json` (copy it from
`config.example.json`). Knobs: `SCREEPS_TOKEN` (required), `SCREEPS_SHARD`
(default `shard3`), `SCREEPS_API_URL` (default `https://screeps.com/api`),
`POLL_INTERVAL` (ms), `PORT`. See `telemetry-app/README.md`.

**b) Read a single segment yourself.** The dashboard is just a poller over one
endpoint — you can hit it directly to land a segment on disk:

```bash
# segment 4 = corps; change segment= for others, drop | jq to see raw
curl -s -H "X-Token: $SCREEPS_TOKEN" \
  "https://screeps.com/api/user/memory-segment?segment=4&shard=shard3" \
  | jq -r .data | jq .
```

The response is `{ ok: 1, data: "<the JSON string you set as the segment>" }`.
`data` is the raw segment string; parse it against the matching interface in
`Telemetry.ts`.

### 3. Full incident capture — `npm run capture:incident` (token)

The heaviest pull, for reproducing a live failure locally. For one shard+room it
grabs the **black box** (segment 5), the **full `/user/memory`** dump, and the
room + neighbours' terrain (delegates to `capture:rooms`), then writes
`test/fixtures/incidents/<date>-<shard>-<room>/` with `blackbox.json`,
`memory.json`, the terrain fixtures, and a skeleton grid cell to make the
incident red-first.

```bash
SCREEPS_TOKEN=... npm run capture:incident -- --shard shard3 --room W1N6
```

Note the `/user/memory` payload may arrive gzipped (`gz:` + base64); the script
un-gzips it for you.

## Token & network setup

- **Auth token:** create one at
  <https://screeps.com/a/#!/account/auth-tokens>. Paths 2 and 3 need it;
  path 1 does not. Provide it as the `SCREEPS_TOKEN` env var (or, for the
  dashboard, `telemetry-app/config.json`). It is a read scope for public
  segments — don't commit it.
- **Private server:** set `SCREEPS_API_URL` (and `SCREEPS_SHARD`) to point at
  it; the scripts send `X-Token` regardless.
- **Rate limits:** all pull scripts space calls out (≥600ms) and back off on
  HTTP 429 — leave that alone.
- **Running from this remote dev environment:** outbound HTTPS goes through the
  agent proxy. If a pull fails TLS verification or returns 403/405/407, see
  `/root/.ccr/README.md` and `curl -sS "$HTTPS_PROXY/__agentproxy/status"` —
  never disable TLS verification or unset `HTTPS_PROXY`.

## Which one do I want?

- **"What does a live room look like for a sim?"** → path 1 (`capture:rooms`).
- **"What is the economy doing right now?"** → path 2 (dashboard, or curl a
  segment).
- **"Reproduce this live bug in the grid."** → path 3 (`capture:incident`).

If you later want the segments 0–6 landed on disk as a timestamped snapshot
(diff-able economy state, no browser), that script does not exist yet — the
curl in path 2b is the manual version, and it's a small script to add if the
workflow warrants it.
