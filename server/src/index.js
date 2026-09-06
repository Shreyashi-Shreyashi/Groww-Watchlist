import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { getDb, snapshotKey } from "./db.js";
import { SYMBOLS, getSnapshot, getAllSnapshots, subscribe } from "./marketFeed.js";
import { computeChange } from "./changeDetector.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// --- auth: deliberately minimal ------------------------------------------
// Real auth (OTP/OAuth) is out of scope for 72 hours and orthogonal to the
// problem being judged. A username-keyed identity is enough to demonstrate
// "state persists across sessions/devices": log in with the same username
// on a different browser/device and the watchlist + baseline snapshots
// follow you, because they're keyed by userId server-side, not localStorage.
// Swapping this for real auth only touches this one block.
app.post("/api/session", async (req, res) => {
  const { username } = req.body;
  if (!username || typeof username !== "string" || !username.trim()) {
    return res.status(400).json({ error: "username required" });
  }
  const db = await getDb();
  const clean = username.trim().toLowerCase();
  let userId = Object.keys(db.data.users).find(
    (id) => db.data.users[id].username === clean
  );
  if (!userId) {
    userId = randomUUID();
    db.data.users[userId] = { username: clean, createdAt: Date.now() };
    db.data.watchlists[userId] = [];
    await db.write();
  }
  res.json({ userId, username: clean });
});

app.get("/api/symbols", (_req, res) => {
  res.json(SYMBOLS);
});

function requireUser(req, res, next) {
  const userId = req.header("x-user-id");
  if (!userId) return res.status(401).json({ error: "X-User-Id header required" });
  req.userId = userId;
  next();
}

// GET the watchlist with change-since-last-seen computed for every symbol.
app.get("/api/watchlist", requireUser, async (req, res) => {
  const db = await getDb();
  const symbols = db.data.watchlists[req.userId] || [];
  const items = symbols.map((symbol) => {
    const meta = SYMBOLS.find((s) => s.symbol === symbol);
    const current = getSnapshot(symbol);
    const lastSeen = db.data.lastSeenSnapshots[snapshotKey(req.userId, symbol)] || null;
    return {
      symbol,
      name: meta?.name || symbol,
      current,
      change: computeChange(current, lastSeen),
    };
  });
  res.json({ items });
});

app.post("/api/watchlist", requireUser, async (req, res) => {
  const { symbol } = req.body;
  if (!SYMBOLS.some((s) => s.symbol === symbol)) {
    return res.status(400).json({ error: "unknown symbol" });
  }
  const db = await getDb();
  const list = db.data.watchlists[req.userId] || (db.data.watchlists[req.userId] = []);
  if (!list.includes(symbol)) list.push(symbol);
  await db.write();
  res.json({ ok: true });
});

app.delete("/api/watchlist/:symbol", requireUser, async (req, res) => {
  const db = await getDb();
  const list = db.data.watchlists[req.userId] || [];
  db.data.watchlists[req.userId] = list.filter((s) => s !== req.params.symbol);
  delete db.data.lastSeenSnapshots[snapshotKey(req.userId, req.params.symbol)];
  await db.write();
  res.json({ ok: true });
});

// The key endpoint for the whole "what changed since last time" model:
// explicitly commit the *current* state as the new baseline. Called by the
// client on page unload / tab hidden - i.e. "the user is done looking", not
// on every poll. This is what stops the diff from being erased the instant
// it's shown.
app.post("/api/watchlist/ack", requireUser, async (req, res) => {
  const db = await getDb();
  const symbols = db.data.watchlists[req.userId] || [];
  for (const symbol of symbols) {
    const current = getSnapshot(symbol);
    if (current) {
      db.data.lastSeenSnapshots[snapshotKey(req.userId, symbol)] = current;
    }
  }
  await db.write();
  res.json({ ok: true, ackedAt: Date.now() });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, symbols: SYMBOLS.length }));

const server = app.listen(PORT, () => {
  console.log(`Groww Smart Watchlist server on http://localhost:${PORT}`);
});

// --- live push over WebSocket ---------------------------------------------
// One marketFeed subscription per symbol is shared across every connected
// client watching it (see marketFeed.js) - the WS layer here just fans each
// tick out to the sockets that asked for that symbol.
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const userId = url.searchParams.get("userId");
  if (!userId) {
    ws.close(4001, "userId required");
    return;
  }

  let unsubscribers = [];

  async function resubscribe() {
    unsubscribers.forEach((u) => u());
    unsubscribers = [];
    const db = await getDb();
    const symbols = db.data.watchlists[userId] || [];
    symbols.forEach((symbol) => {
      const unsub = subscribe(symbol, (snapshot) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "tick", symbol, snapshot }));
        }
      });
      unsubscribers.push(unsub);
    });
  }

  await resubscribe();

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "refresh_subscriptions") await resubscribe();
    } catch {
      /* ignore malformed client messages */
    }
  });

  ws.on("close", () => unsubscribers.forEach((u) => u()));
});
