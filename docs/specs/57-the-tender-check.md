# 57 — The tender check: a buffer with no drain is a hole, not a sink

**Status: SHIPPED 2026-08-08, DEPLOYED + PARTIALLY VERIFIED t72873814.**
The black box reads `alerts: []` across two live ports — no false alarm on the
tended (44,12), and none on the newly built (41,36), which is empty and is
exactly the case §2 deliberately keeps quiet. The *transient* half (an alert
between a container completing and its tender arriving) is **unobservable**, and
not for the reason first recorded: `alerts` IS exported, but `flush()`
overwrites it every 10 ticks, so the field is an instantaneous reading rather
than a window like `rows`. Giving `alerts` the same ring treatment is open item
5.

Companion to spec 56. That spec makes the port buffer get BUILT; this one makes
sure the colony never again drops energy into one that nothing empties, and
never again fails to notice.

## 1. The defect this generalises

Spec 54 opened from a measured dead end (t72862894):

```
  port container (44,12)   2000 / 2000        completely full
  portFallbacks            0                  on all 8 port-routed routes
  portWaits                up to 602 ticks    (cd98)
```

Both of a hauler's escape hatches were shut, so it queued. The cause was that
nothing owned the drain — spec 54 fixed that by giving `LinkCorp` the ports.

**But the fix was structural, not defensive.** Two things were still true
afterwards:

1. **The delivery ladder never asks whether a drain exists.**
   `pickStorageDeposit` ranks `portBuffer` second on the strength of an argument
   that *presupposes* a tender:

   > *"energy landing in the link leaves by teleport, while energy in the
   > container still needs the tender to move it across. So the buffer is the
   > SECOND choice."*

   With no tender there is no second choice to rank — there is a hole. A hauler
   that drops there has not deposited its load, it has abandoned it, and it
   leaves with an empty hold and a `portDeposits` tick that says success.
   Nothing in the code path could tell the two apart.

2. **No instrument could see it.** The container census exists because *"five
   diagnoses this week ended at 'I cannot tell from telemetry'"*. The rate
   meters cannot close this one either, and the reason is structural: a jammed
   port and a quiet port both read as a **small number** on `toHubRate`,
   `portDeposits`, `portFallbacks`. A stock against its own capacity cannot be
   read that way, and neither can "how many creeps drain this thing".

This is the same shape as the heartbeat doctrine's second consequence — reading
health from the wrong meter — but pointed at the port instead of the core.

## 2. The check

**Delivery side.** `pickStorageDeposit` gains `portTended`. The buffer is
offered only when it is positively claimed as tended.

**UNKNOWN COUNTS AS UNTENDED, and this is the one asymmetric failure on the
ladder** — the reason the default is not the convenient one:

| guess | if right | if wrong |
|---|---|---|
| "tended" | hauler saves the hub leg | the load is stranded and decays where nothing reads it |
| "untended" | correct refusal | hauler walks the hub leg it would have walked anyway |

The costs are not comparable, so the buffer must be claimed, never assumed.

`CarryCorp` supplies the claim from `livePortTenders(room)`, counted the SAME
way the demand side counts (`creepsOfWorkType("porttend", {includeSpawning:
false})`) — **`staffsPost` symmetry**: if delivery counted a spawning tender the
demand side does not, haulers would commit loads to a post whose drain is not
yet on it. The workType string lives once, as `PORT_TENDER_WORK_TYPE`.

Room membership, not a stored flag. A port tender is a PARKED creep that never
leaves the room it tends, so `creep.room` here is an identity, not the kind of
live-position trigger the trap list forbids — that rule is about ROOM state
(*"do we work this room"*), which must come from intel.

**Instrument side.** `runWatchdogs` gains a `port-untended` rule over
`portBuffers: PortBufferSample[]`, sampled every 10 ticks in `runFlightRecorder`
through `portPosts` / `livePortTenders` — the same lenses the corp staffs and
the haulers deliver by, so the alarm cannot fire on a port the runtime does not
believe in, or stay quiet about one it does. Two conditions, because there are
two ways a buffer stops being a buffer:

- **holding energy with zero tenders** — the t72862894 signature;
- **pinned at ≥ `PORT_BUFFER_PINNED_SHARE` (0.90) of its own capacity** even
  with a tender — the drain exists but is undersized.

An **empty** untended buffer is deliberately quiet: a container just built for a
port that has taken no drops is not an incident, and alarming on it would train
the reader to ignore the alarm.

## 3. Acceptance tests

`test/unit/telemetry/portTenderCheck.test.ts`:

- silent with no ports, and silent on a buffer cycling under a tender;
- **fires on energy held with no tender**, and the message names the tile and
  says *what* is wrong;
- quiet on an empty untended buffer;
- fires on a buffer pinned full *with* a tender — the undersized-drain case;
- the line is drawn at `PORT_BUFFER_PINNED_SHARE` of the buffer's OWN capacity,
  pinned either side of the threshold;
- does not judge fullness it cannot measure (capacity unknown → no alert);
- reports EVERY offending port, not just the first;
- never displaces the existing rules (a stalled spawn still alarms alongside).

`test/unit/corps/CarryCorp.behavior.test.ts`, in the existing deposit-port
BUFFER block so the ladder is pinned as one ordering:

- refuses the buffer when untended — falls to `wait`, not `portBuffer`;
- and to `storage` once the bounded wait is spent, so the load comes home
  rather than being stranded;
- **treats UNKNOWN as untended**;
- still spills to the `none` escape valve when the buffer is untended AND the
  hub is full;
- every tended case is unchanged (`port` still outranks `portBuffer`;
  `portBuffer` still outranks `wait` and still beats a full hub).

Regression gate: `npm run test-unit`, `npm run build`, `npx tsc --noEmit`, plus
the `flow-handoff` / `runt-economy` / `storage-depot` trio.

## 4. Open

1. **LIVE-UNVERIFIED.** Predicted: no `port-untended` alert on the tended
   (44,12) post; an alert on any port whose buffer is built before its tender
   arrives (a transient, and the correct thing to see); `portFallbacks` becomes
   non-zero on routes whose port is untended, where it was structurally 0.
2. **No duty meter on the port role** (carried from spec 54's open items). The
   watchdog answers "is it stuck", not "how hard is it working" — sizing the
   tender still has no measured basis, only `PORT_TENDER_CARRY`'s argument that
   a parked shuttle transfers its whole store every tick.
3. **The alarm is not yet an economic input.** The planner still routes deposit
   flow to a port through `detectLinkDepositPorts` without asking whether that
   port is tendable. Today the buffer refusal makes an untended port merely
   costlier (haulers walk the hub leg) rather than harmful, so this is a pricing
   fidelity gap, not a leak — but it is a plan the runtime does not follow, and
   it belongs on the F1 side of the ledger.
4. `PORT_BUFFER_PINNED_SHARE` is an asserted 0.90, not a measured one. It is a
   detector threshold rather than an economic constant, so the cost of being
   slightly wrong is a noisy or late alert; worth re-reading once live data
   shows the buffer's normal cycling band (t72869702 saw 0→516e against 2000).


5. **`alerts` is a snapshot, not a window.** `flush()` writes the watchdog's
   alerts verbatim and `runFlightRecorder` evaluates them on the same 10-tick
   cadence, so every evaluation reaches the segment — but each flush
   **overwrites** the field. `rows` is a ring; `alerts` is one instant. An alert
   that fires and clears between two captures cannot be seen, which is precisely
   the transient case this spec's second condition exists to catch. Give
   `alerts` the ring treatment `rows` already has.

   Recorded with its own correction attached: the first write-up of this said
   *"nothing exports them to a segment"*, which was false and was asserted
   without opening the segment (spec 14, methodology note #9).
