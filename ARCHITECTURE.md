# Architecture & Design Decisions

## The actual problem

Anyone can render a live price. The brief is asking: when someone comes back
to their watchlist, what deserves their attention *right now*, versus what's
just normal noise they can ignore? That's a diffing problem, not a
data-display problem, so the system is built around one core object: a
**baseline snapshot of what the user last saw**, compared against the
current state.

## What counts as a meaningful change

Four explicit, tunable rules (`server/src/changeDetector.js`), not a learned
score:

| Signal | Rule |
|---|---|
| Price move | `\|Δ%\|` since last-seen baseline ≥ 1.5% |
| Volume spike | volume accumulated since last visit ≥ 2× average |
| New extreme | current price exceeds the high/low seen last visit |
| Reversal | direction flipped since last visit, beyond the price threshold |

Rules over ML because: (a) there's no historical data to train anything
meaningful on in 72 hours, (b) every flag needs to be explainable to a judge
who asks "why did this get flagged," and (c) thresholds are one config object
away from being tuned per-symbol or per-user later — an ML model would
require a retraining loop to change behavior at all.

## The baseline: when does "last checked" update?

This is the decision the whole feature depends on. The baseline is **not**
overwritten on every page load — that would erase the diff the instant it's
shown. It's committed via an explicit `POST /api/watchlist/ack`, fired when
the tab is hidden or closed (`visibilitychange` / `beforeunload`), or when the
user taps "mark all as seen." Between visits, live ticks update the *current*
numbers but never touch the stored baseline, so the comparison stays anchored
to "since you actually looked away."

## Persistence & cross-device state

A single JSON store (`lowdb`) keyed by three maps: `users`, `watchlists`, and
`lastSeenSnapshots`. State is keyed by server-assigned `userId`, not by
browser storage, so logging in with the same username on a second device
restores the same watchlist and the same baseline — the diff a user sees is
correct even if they never opened this device before. This is intentionally
the simplest persistence that satisfies that requirement; every route talks
to `db.js` through named functions, not the file directly, so swapping in
Postgres (relational: users / watchlists / snapshots tables) is a one-file
change.

Auth is deliberately a bare username with no password — a placeholder for
real auth (OTP/OAuth), chosen because building real auth would spend hours of
the 72 on a solved problem instead of the one being judged.

## Staleness and conflicting data

Every price carries `sourceTimestamp` (when the feed produced it) separately
from when the server or client received it. If `now - sourceTimestamp`
exceeds a threshold, the row is marked `stale` in the API response and shown
with a badge in the UI — a frozen number is never allowed to look live.
There's a single upstream source in this build, so there's no multi-source
conflict to resolve yet, but the timestamp-per-value shape is what a
conflict-resolution layer (e.g. "prefer the source with the newer
`sourceTimestamp`, log the discrepancy") would need — it's a one-function
addition, not a schema change.

## How this scales

- **One feed subscription per symbol, not per user.** `marketFeed.js` keeps
  one in-memory stream per symbol and fans ticks out over an event emitter;
  the WebSocket layer subscribes sockets to symbols, not the other way
  around. 10,000 users watching `INFY` costs one upstream stream, not 10,000.
- **Diff computation is O(watchlist size)**, independent of total user count,
  because it only ever compares a user's own symbols against their own
  baseline row.
- **Path to horizontal scale**: swap the in-process `EventEmitter` fan-out for
  Redis pub/sub (one process ingests the real feed and publishes; any number
  of API/WS processes subscribe), and swap lowdb for Postgres + a Redis cache
  for hot snapshots. Nothing in the route or detector logic changes — both
  swaps are isolated to `db.js` and `marketFeed.js` by design.

## Where complexity was deliberately avoided

- **No framework on the frontend.** Vanilla HTML/CSS/JS over React, because
  the UI is a handful of stateful rows and a WebSocket handler — a build
  step and component tree would add ceremony without adding capability at
  this scope. This is itself an answerable trade-off: it would become the
  wrong call the moment the UI needs routing, shared component state across
  many views, or a design system to enforce consistency across a team.
- **No real market data integration.** The feed is abstracted behind
  `subscribe()` / `getSnapshot()` specifically so it's a contained swap, not
  because it wasn't considered — see `marketFeed.js` header comment.
- **No ML-based relevance scoring.** See "what counts as a meaningful
  change" above.
