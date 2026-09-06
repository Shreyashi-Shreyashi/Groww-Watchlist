# Smart Watchlist — Code, by Groww

A market watchlist built around one question: what actually changed since I
last checked, not just what's the price right now.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design decisions and
trade-offs behind this build.

## What it does

- Add/remove symbols from a personal watchlist.
- See live prices over WebSocket while the tab is open.
- On return visits, each symbol that moved meaningfully since you last looked
  is flagged with *why* (price move, volume spike, new high/low, reversal) —
  not just a raw number.
- State (watchlist + "what you've seen") persists server-side, so logging in
  with the same username on another device/browser picks up where you left
  off.
- Stale data is called out explicitly rather than silently shown as live.

Market data is a self-contained simulator (see `server/src/marketFeed.js`)
so the demo doesn't depend on a paid data vendor or API keys — it's isolated
behind a small interface specifically so it can be swapped for a real feed
without touching any other code.

## Project structure

```
groww-watchlist/
├── ARCHITECTURE.md        # design decisions, trade-offs, scaling story
├── server/                # Node/Express + WebSocket backend
│   └── src/
│       ├── index.js       # routes + WS server
│       ├── db.js          # persistence (lowdb/JSON)
│       ├── marketFeed.js  # simulated market data source
│       └── changeDetector.js  # "what's meaningful" rules engine
└── client/                # static frontend, no build step
    ├── index.html
    ├── style.css
    └── app.js
```

## Running it

Requires Node.js 18+.

**1. Start the backend**

```bash
cd server
npm install
npm start
```

This starts the API + WebSocket server on `http://localhost:4000` and begins
simulating live ticks for 10 symbols immediately (check
`http://localhost:4000/api/health`).

**2. Serve the frontend**

The client is static — any static server works. From the `client/` folder:

```bash
cd client
npx serve .
# or: python3 -m http.server 5173
```

Open the printed URL (e.g. `http://localhost:5173`) in your browser.

> The client talks to the API at `http://localhost:4000` by default — see
> `API_BASE` at the top of `client/app.js` if you need to change that.

**3. Try it**

1. Enter any username (no password) to create/resume a session.
2. Add a couple of symbols from the dropdown.
3. Watch prices tick live for ~10–20 seconds, then leave the tab (switch
   tabs, or close and reopen the browser) — this commits your baseline.
4. Come back: symbols that crossed a threshold since you left are visually
   flagged with the specific reason why.
5. Use "Mark all as seen" any time to manually reset the baseline to now.

## Notes for reviewers

- No `.env` or API keys needed — the whole stack runs locally with the
  commands above.
- Persisted state lives in `server/data/db.json`, created on first run.
  Delete it to reset all users/watchlists.
- The 1.5% / 2× / staleness thresholds are constants at the top of
  `changeDetector.js` — intentionally easy to find and tune.
