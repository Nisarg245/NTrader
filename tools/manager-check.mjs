// Exercises the Manager API against a running server:  node tools/manager-check.mjs [http://127.0.0.1:8080]
const base = (process.argv[2] ?? "http://127.0.0.1:8080") + "/api/manager";
let token = "";
const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const check = (ok, what) => {
  console.log(ok ? "ok  " : "FAIL", what);
  if (!ok) process.exitCode = 1;
};
const USD = 1_000_000;

check((await call("GET", "/summary")).status === 401, "calls without a token are refused");
check((await call("POST", "/login", { login: "admin", password: "wrong-password" })).status === 401, "wrong manager password is refused");
const login = await call("POST", "/login", { login: "admin", password: "admin-demo-1" });
check(login.status === 200 && login.body.token.length === 64, "manager login returns a token");
token = login.body.token;

const summary = await call("GET", "/summary");
check(summary.body.accounts >= 2 && summary.body.exposure.length >= 4, "summary lists accounts and symbols");

// Groups
const group = { name: "api-test", currency: "USD", mode: "Hedging", leverage: 200, margin_call_pct: 100, stop_out_pct: 50, commission_per_lot: 3_500_000, demo: false };
check((await call("POST", "/groups", group)).status === 200, "group is created");
check((await call("POST", "/groups", group)).status === 409, "a duplicate group is refused");
check((await call("PUT", "/groups/api-test", { ...group, leverage: 100 })).status === 200, "group leverage is updated");
check((await call("PUT", "/groups/api-test", { ...group, currency: "EUR" })).status === 400, "a group's currency cannot change");
check((await call("GET", "/groups")).body.find((g) => g.name === "api-test").leverage === 100, "group list shows the change");

// Symbols
const symbols = (await call("GET", "/symbols")).body;
const eur = symbols.find((s) => s.name === "EURUSD");
check(eur.bid > 0, "symbol list includes live quotes");
const { id: _id, bid: _bid, ask: _ask, ...eurSpec } = eur;
check((await call("PUT", "/symbols/EURUSD", { ...eurSpec, swap_long: -7 })).status === 200, "symbol swap is updated");
check((await call("PUT", "/symbols/EURUSD", { ...eurSpec, digits: 4 })).status === 400, "a symbol's digits cannot change");
const added = await call("POST", "/symbols", { ...eurSpec, name: "EURUSD.x", category: "Test" });
check(added.status === 200 && (await call("GET", "/symbols")).body.length === symbols.length + 1, "symbol is added");

// Accounts
check((await call("POST", "/accounts", { group: "api-test", name: "Short", password: "short" })).status === 400, "a short password is refused");
check((await call("POST", "/accounts", { group: "nope", name: "X", password: "long-enough-1" })).status === 404, "an unknown group is refused");
const created = await call("POST", "/accounts", { group: "api-test", name: "API Trader", password: "long-enough-1", deposit: 5_000 * USD });
check(created.status === 200 && created.body.balance === 5_000 * USD && created.body.leverage === 100, "account is created with a deposit");
const id = created.body.id;
check((await call("GET", `/accounts?search=api tr`)).body.some((a) => a.id === id), "search finds the account by name");
check((await call("GET", `/accounts?group=api-test`)).body.length === 1, "accounts filter by group");
check((await call("POST", `/accounts/${id}/balance`, { amount: -1_000 * USD, comment: "withdrawal" })).body.balance === 4_000 * USD, "withdrawal lowers the balance");
check((await call("POST", `/accounts/${id}/balance`, { amount: -9_000 * USD })).status === 400, "overdrawing is refused");
check((await call("PATCH", `/accounts/${id}`, { leverage: 50, name: "Renamed" })).body.leverage === 50, "account leverage and name are updated");
check((await call("POST", `/accounts/${id}/password`, { password: "another-long-1" })).status === 200, "password is reset");

// The new account can trade with its new password; the manager sees and closes the position.
const trade = (password) =>
  new Promise((resolve) => {
    const ws = new WebSocket(base.replace("http", "ws").replace("/api/manager", "/ws"));
    ws.onopen = () => ws.send(JSON.stringify({ type: "Login", account: id, password }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "Error") resolve(m.message);
      if (m.type === "LoginOk") ws.send(JSON.stringify({ type: "Order", symbol: "EURUSD", side: "Buy", kind: "Market", volume: 1000 }));
      if (m.type === "Event" && m.event.type === "Deal") (ws.close(), resolve("traded"));
      if (m.type === "Event" && m.event.type === "Rejected") (ws.close(), resolve("rejected: " + m.event.reason));
    };
    setTimeout(() => resolve("timed out"), 8000);
  });
check((await trade("long-enough-1")) === "invalid login", "the old password no longer works");
check((await trade("another-long-1")) === "traded", "the account trades with the new password");
const positions = (await call("GET", "/positions")).body;
const mine = positions.find((p) => p.account === id);
check(mine && typeof mine.profit === "number" && mine.currency === "USD", "manager sees the open position with its profit");
const detail = (await call("GET", `/accounts/${id}`)).body;
check(detail.positions.length === 1 && detail.deals.length === 1 && detail.account.name === "Renamed", "account detail shows positions and deals");
check((await call("POST", `/positions/${mine.id}/close`)).status === 200, "manager closes the position");
check((await call("POST", `/positions/${mine.id}/close`)).status === 404, "closing it twice says it is gone");
check((await call("GET", `/accounts/${id}`)).body.deals.length === 2, "the close is in the deal history");

check((await call("PATCH", `/accounts/${id}`, { enabled: false })).body.enabled === false, "account is disabled");
check((await trade("another-long-1")) === "invalid login", "a disabled account cannot sign in");

check((await call("POST", "/logout")).status === 200 && (await call("GET", "/summary")).status === 401, "logout ends the session");
console.log(process.exitCode ? "\nsome checks failed" : "\nall checks passed");
