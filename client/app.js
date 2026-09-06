const API_BASE = "http://localhost:4000";

const state = {
  userId: localStorage.getItem("watchlist:userId") || null,
  username: localStorage.getItem("watchlist:username") || null,
  symbols: [],       // catalogue from /api/symbols
  items: new Map(),  // symbol -> { symbol, name, current, change }
  ws: null,
};

const el = {
  loginScreen: document.getElementById("login-screen"),
  appScreen: document.getElementById("app-screen"),
  usernameInput: document.getElementById("username-input"),
  loginBtn: document.getElementById("login-btn"),
  userLabel: document.getElementById("user-label"),
  connStatus: document.getElementById("conn-status"),
  symbolPicker: document.getElementById("symbol-picker"),
  addBtn: document.getElementById("add-btn"),
  ackBtn: document.getElementById("ack-btn"),
  watchlist: document.getElementById("watchlist"),
  emptyState: document.getElementById("empty-state"),
};

async function api(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(state.userId ? { "X-User-Id": state.userId } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// ---------------- login ----------------

async function login(username) {
  const data = await api("/api/session", { method: "POST", body: JSON.stringify({ username }) });
  state.userId = data.userId;
  state.username = data.username;
  localStorage.setItem("watchlist:userId", data.userId);
  localStorage.setItem("watchlist:username", data.username);
  showApp();
}

el.loginBtn.addEventListener("click", () => {
  const v = el.usernameInput.value.trim();
  if (v) login(v).catch((e) => alert(e.message));
});
el.usernameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") el.loginBtn.click();
});

function showApp() {
  el.loginScreen.classList.add("hidden");
  el.appScreen.classList.remove("hidden");
  el.userLabel.textContent = state.username;
  init();
}

// ---------------- init ----------------

async function init() {
  state.symbols = await api("/api/symbols");
  el.symbolPicker.innerHTML =
    '<option value="">Add a symbol…</option>' +
    state.symbols.map((s) => `<option value="${s.symbol}">${s.symbol} — ${s.name}</option>`).join("");

  await refreshWatchlist();
  connectSocket();

  // Commit the current view as the new "last seen" baseline when the user
  // actually leaves - not on every fetch. This is what makes "what changed
  // since last time" mean something on the next visit.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") ackSeen();
  });
  window.addEventListener("beforeunload", () => ackSeen(true));
}

async function refreshWatchlist() {
  const { items } = await api("/api/watchlist");
  state.items = new Map(items.map((i) => [i.symbol, i]));
  render();
}

async function ackSeen(useBeacon = false) {
  if (!state.userId) return;
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon(
      API_BASE + "/api/watchlist/ack",
      new Blob([JSON.stringify({})], { type: "application/json" })
    );
    // sendBeacon can't set custom headers, so also fire a normal request as
    // best-effort for browsers where beforeunload gives us enough time.
  }
  api("/api/watchlist/ack", { method: "POST" }).catch(() => {});
}

el.addBtn.addEventListener("click", async () => {
  const symbol = el.symbolPicker.value;
  if (!symbol) return;
  await api("/api/watchlist", { method: "POST", body: JSON.stringify({ symbol }) });
  el.symbolPicker.value = "";
  await refreshWatchlist();
  state.ws?.send(JSON.stringify({ type: "refresh_subscriptions" }));
});

el.ackBtn.addEventListener("click", async () => {
  await api("/api/watchlist/ack", { method: "POST" });
  await refreshWatchlist();
});

async function removeSymbol(symbol) {
  await api(`/api/watchlist/${symbol}`, { method: "DELETE" });
  await refreshWatchlist();
  state.ws?.send(JSON.stringify({ type: "refresh_subscriptions" }));
}

// ---------------- websocket live ticks ----------------

function connectSocket() {
  const wsUrl = API_BASE.replace("http", "ws") + `/ws?userId=${state.userId}`;
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => setConn("live");
  ws.onclose = () => {
    setConn("offline");
    setTimeout(connectSocket, 2000); // simple reconnect
  };
  ws.onerror = () => ws.close();

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "tick") {
      const item = state.items.get(msg.symbol);
      if (item) {
        item.current = msg.snapshot;
        // Recompute against the *stored* baseline (unchanged) so the diff
        // stays anchored to "since you last checked", live prices just
        // update the numbers feeding that comparison.
        renderRow(item);
      }
    }
  };
}

function setConn(status) {
  el.connStatus.className = "pill pill-" + status;
  el.connStatus.textContent = status === "live" ? "live" : status === "offline" ? "reconnecting…" : "connecting…";
}

// ---------------- change recompute on client for live ticks ----------------
// The server computes the authoritative diff on each /api/watchlist fetch.
// Between fetches, ticks update the displayed price/volume, but we don't
// invent new "meaningful" flags client-side to avoid drifting from the
// server's rules - we just re-fetch periodically to reconcile.
setInterval(() => {
  if (state.userId && document.visibilityState === "visible") refreshWatchlist();
}, 6000);

// ---------------- rendering ----------------

function render() {
  el.watchlist.innerHTML = "";
  if (state.items.size === 0) {
    el.emptyState.classList.remove("hidden");
    return;
  }
  el.emptyState.classList.add("hidden");
  for (const item of state.items.values()) renderRow(item);
}

function renderRow(item) {
  let row = document.getElementById("row-" + item.symbol);
  const isNewRow = !row;
  if (isNewRow) {
    row = document.createElement("div");
    row.id = "row-" + item.symbol;
    row.className = "row";
    el.watchlist.appendChild(row);
  }

  const { current, change } = item;
  const deltaClass = change.priceDeltaPct > 0 ? "up" : change.priceDeltaPct < 0 ? "down" : "flat";
  const dayClass = current.dayChangePct > 0 ? "up" : current.dayChangePct < 0 ? "down" : "flat";
  const sign = (n) => (n > 0 ? "+" : "");

  row.className = "row" + (change.meaningful ? " flagged" : "");
  row.innerHTML = `
    <div class="row-symbol">
      <span class="ticker">${item.symbol}</span>
      <span class="name">${item.name}</span>
      ${
        change.reasons.length
          ? `<div class="reasons">${change.reasons
              .map((r) => `<span class="reason-tag">${r.detail}</span>`)
              .join("")}</div>`
          : ""
      }
    </div>
    <div class="row-price">
      <div class="price">₹${current.price.toLocaleString("en-IN")}</div>
      <div class="delta ${dayClass}">${sign(current.dayChangePct)}${current.dayChangePct}% today</div>
      ${
        !change.isNew
          ? `<div class="delta ${deltaClass}">${sign(change.priceDeltaPct)}${change.priceDeltaPct}% since last seen</div>`
          : `<div class="delta flat">new to your list</div>`
      }
    </div>
    <div class="row-meta">
      ${change.stale ? `<span class="stale-badge">stale data</span>` : ""}
      <button class="remove-btn" title="Remove" data-symbol="${item.symbol}">×</button>
    </div>
  `;
  row.querySelector(".remove-btn").addEventListener("click", (e) => {
    removeSymbol(e.currentTarget.dataset.symbol);
  });
}

// ---------------- boot ----------------

if (state.userId && state.username) {
  showApp();
}
