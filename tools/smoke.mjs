// End-to-end check against a running server:  node tools/smoke.mjs [ws://127.0.0.1:8080/ws]
// Logs in as demo account 1001, trades, and verifies the server's answers.
const url = process.argv[2] ?? "ws://127.0.0.1:8080/ws";
const ws = new WebSocket(url);
const seen = [];
let waiters = [];
const send = (m) => ws.send(JSON.stringify(m));
const next = (pred, what) =>
  new Promise((resolve, reject) => {
    const hit = seen.find(pred);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => reject(new Error("timed out waiting for " + what)), 5000);
    waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  seen.push(m);
  waiters = waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
};
const check = (ok, what) => {
  if (!ok) throw new Error("FAILED: " + what);
  console.log("ok  ", what);
};

ws.onopen = async () => {
  try {
    send({ type: "Order", symbol: "EURUSD", side: "Buy", kind: "Market", volume: 1000 });
    const denied = await next((m) => m.type === "Error", "login required");
    check(denied.message === "login required", "orders are refused before login");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
};
ws.onclose = () => run().catch((e) => (console.error(e.message), process.exit(1)));

async function run() {
  const bad = new WebSocket(url);
  await new Promise((r) => (bad.onopen = r));
  bad.send(JSON.stringify({ type: "Login", account: 1001, password: "wrong" }));
  const reply = await new Promise((r) => (bad.onmessage = (ev) => r(JSON.parse(ev.data))));
  check(reply.type === "Error" && reply.message === "invalid login", "wrong password is rejected");

  const c = new WebSocket(url);
  const msgs = [];
  let pending = [];
  c.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    msgs.push(m);
    pending = pending.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
  };
  const wait = (pred, what) =>
    new Promise((resolve, reject) => {
      const hit = msgs.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error("timed out waiting for " + what)), 8000);
      pending.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  const tx = (m) => c.send(JSON.stringify(m));
  await new Promise((r) => (c.onopen = r));

  tx({ type: "Login", account: 1001, password: "demo1001" });
  const login = await wait((m) => m.type === "LoginOk", "LoginOk");
  check(login.currency === "USD" && login.mode === "Hedging", "login returns the account");
  check(login.symbols.length === 4, "login returns the symbol list");
  const eur = login.symbols.find((s) => s.name === "EURUSD");

  tx({ type: "Subscribe", symbols: ["EURUSD"] });
  const tick = await wait((m) => m.type === "Tick" && m.s === eur.id, "a EURUSD tick");
  check(tick.a > tick.b, "quotes stream after subscribing");

  tx({ type: "Order", client_id: 11, symbol: "EURUSD", side: "Buy", kind: "Market", volume: 1000 });
  const deal = await wait((m) => m.type === "Event" && m.event.type === "Deal" && m.event.client_id === 11, "open deal");
  check(deal.event.deal.entry === "In" && deal.event.deal.volume === 1000, "market buy 0.10 lot fills");
  const pos = await wait((m) => m.type === "Event" && m.event.type === "Position" && m.event.position.id === deal.event.deal.position, "position");
  check(pos.event.position.margin > 0, "position carries margin");
  const acct = await wait((m) => m.type === "Event" && m.event.type === "Account" && m.event.state.margin > 0, "account update");
  check(acct.event.state.equity < acct.event.state.balance + 1, "account update follows the trade");

  tx({ type: "Order", client_id: 12, symbol: "EURUSD", side: "Buy", kind: "Market", volume: 1000000 });
  const rej = await wait((m) => m.type === "Event" && m.event.type === "Rejected" && m.event.client_id === 12, "rejection");
  check(rej.event.reason === "NoMoney", "an order beyond free margin is rejected");

  tx({ type: "Close", position: pos.event.position.id });
  const out = await wait((m) => m.type === "Event" && m.event.type === "Deal" && m.event.deal.entry === "Out", "close deal");
  check(out.event.deal.position === pos.event.position.id, "position closes at market");
  await wait((m) => m.type === "Event" && m.event.type === "PositionClosed", "PositionClosed");

  tx({ type: "Ping" });
  await wait((m) => m.type === "Pong", "Pong");
  console.log("\nall checks passed");
  process.exit(0);
}
