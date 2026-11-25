// Connection to the server and all live trading state.

import { decode, encode } from "@msgpack/msgpack";
import { batch } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { AccountState, Alert, Announcement, Bar, ClientMsg, Deal, Level, Order, Position, ServerEvent, ServerMsg, SymbolInfo } from "./types";

export interface Quote {
  bid: number;
  ask: number;
  t: number;
  /** Direction of the last bid change: 1 up, -1 down, 0 none yet. */
  dir: number;
}

export interface Toast {
  id: number;
  tone: "info" | "error";
  text: string;
}

interface State {
  status: "offline" | "connecting" | "online" | "reconnecting";
  loginError: string;
  name: string;
  currency: string;
  mode: "Hedging" | "Netting";
  leverage: number;
  demo: boolean;
  account: AccountState | null;
  symbols: SymbolInfo[];
  positions: Position[];
  orders: Order[];
  deals: Deal[];
  alerts: Alert[];
  announcements: Announcement[];
  /** Depth of market for the selected symbol. */
  depth: { symbol: number; bids: Level[]; asks: Level[]; simulated: boolean } | null;
  /** Id of the symbol shown in the active chart and the order ticket. */
  selected: number;
  ping: number | null;
  /** Server clock minus local clock, in milliseconds. */
  clockOffset: number;
  toasts: Toast[];
  /** What happened in this session, newest last. */
  journal: { ts: number; text: string }[];
}

const empty: State = {
  status: "offline",
  loginError: "",
  name: "",
  currency: "",
  mode: "Hedging",
  leverage: 1,
  demo: false,
  account: null,
  symbols: [],
  positions: [],
  orders: [],
  deals: [],
  alerts: [],
  announcements: [],
  depth: null,
  selected: 0,
  ping: null,
  clockOffset: 0,
  toasts: [],
  journal: [],
};

export const [state, setState] = createStore<State>(structuredClone(empty));
export const [quotes, setQuotes] = createStore<Quote[]>([]);

const REJECTIONS: Record<string, string> = {
  NoMoney: "Not enough free margin for this order.",
  InvalidVolume: "That volume is not allowed for this symbol.",
  InvalidPrice: "That price is on the wrong side of the market for this order type.",
  InvalidStops: "Stop loss or take profit is on the wrong side of the price.",
  NoQuote: "There is no price for this symbol yet.",
  TradeDisabled: "Trading is disabled for this symbol.",
  PositionNotFound: "That position no longer exists.",
  OrderNotFound: "That order no longer exists.",
  NoConversionRate: "No conversion rate is available for this symbol.",
  AccountDisabled: "This account is disabled.",
};

let ws: WebSocket | null = null;
let credentials: { account: number; password: string } | null = null;
let retry = 0;
let retryTimer: number | undefined;
let pingTimer: number | undefined;
let pingSent = 0;
let nextClientId = 1;
let nextToast = 1;
const tickListeners = new Set<(symbol: number, bid: number, t: number) => void>();
const historyWaiters = new Map<string, (bars: Bar[]) => void>();

export function toast(text: string, tone: Toast["tone"] = "info") {
  const id = nextToast++;
  setState("toasts", (t) => [...t.slice(-3), { id, tone, text }]);
  window.setTimeout(() => dismissToast(id), 6000);
}

/** Add a line to the session journal. */
export function log(text: string) {
  setState("journal", (j) => [...j.slice(-199), { ts: Date.now() + state.clockOffset, text }]);
}

export function dismissToast(id: number) {
  setState("toasts", (t) => t.filter((x) => x.id !== id));
}

/** Called on every tick, outside the reactive system. Returns an unsubscribe. */
export function onTick(fn: (symbol: number, bid: number, t: number) => void) {
  tickListeners.add(fn);
  return () => tickListeners.delete(fn);
}

function url() {
  const secure = location.protocol === "https:";
  return `${secure ? "wss" : "ws"}://${location.host}/ws`;
}

function send(msg: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(encode(msg));
}

export function login(account: number, password: string) {
  credentials = { account, password };
  retry = 0;
  setState({ status: "connecting", loginError: "" });
  open();
}

export function logout() {
  credentials = null;
  window.clearTimeout(retryTimer);
  window.clearInterval(pingTimer);
  ws?.close();
  ws = null;
  batch(() => {
    setState(structuredClone(empty));
    setQuotes([]);
  });
}

function open() {
  const socket = new WebSocket(url());
  socket.binaryType = "arraybuffer";
  ws = socket;
  socket.onopen = () => credentials && send({ type: "Login", ...credentials });
  socket.onmessage = (ev) => {
    const msg = (typeof ev.data === "string" ? JSON.parse(ev.data) : decode(new Uint8Array(ev.data))) as ServerMsg;
    handle(msg);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    window.clearInterval(pingTimer);
    if (!credentials) return;
    if (state.status === "connecting") {
      // Never got in: the login screen shows why.
      credentials = null;
      setState({ status: "offline", loginError: state.loginError || "Could not reach the server." });
      return;
    }
    setState({ status: "reconnecting", ping: null, depth: null });
    log("Connection lost, reconnecting.");
    retry += 1;
    retryTimer = window.setTimeout(open, Math.min(1000 * 2 ** (retry - 1), 10_000));
  };
}

function handle(msg: ServerMsg) {
  switch (msg.type) {
    case "LoginOk": {
      retry = 0;
      batch(() => {
        setQuotes(msg.symbols.map((s) => ({ bid: s.bid, ask: s.ask, t: 0, dir: 0 })));
        setState({
          status: "online",
          loginError: "",
          name: msg.name,
          currency: msg.currency,
          mode: msg.mode,
          leverage: msg.leverage,
          demo: msg.demo,
          account: msg.account,
          symbols: msg.symbols,
          positions: msg.positions,
          orders: msg.orders,
          deals: msg.deals,
          alerts: msg.alerts,
          announcements: msg.announcements,
          selected: state.symbols.length ? state.selected : (msg.symbols[0]?.id ?? 0),
        });
      });
      send({ type: "Subscribe", symbols: msg.symbols.map((s) => s.name) });
      log(`Signed in to account ${msg.account.id}.`);
      depthSymbol = "";
      watchDepth(state.selected);
      window.clearInterval(pingTimer);
      const ping = () => {
        pingSent = performance.now();
        send({ type: "Ping" });
      };
      ping();
      pingTimer = window.setInterval(ping, 5000);
      break;
    }
    case "Error":
      if (state.status === "connecting") {
        setState("loginError", msg.message === "invalid login" ? "Wrong account number or password." : msg.message);
      } else {
        toast(msg.message, "error");
      }
      break;
    case "Tick":
      setQuotes(msg.s, (q) => ({
        bid: msg.b,
        ask: msg.a,
        t: msg.t,
        dir: q && msg.b !== q.bid ? Math.sign(msg.b - q.bid) : (q?.dir ?? 0),
      }));
      tickListeners.forEach((fn) => fn(msg.s, msg.b, msg.t));
      break;
    case "Event":
      onEvent(msg.event);
      break;
    case "Candles": {
      const key = `${msg.s}:${msg.tf}`;
      historyWaiters.get(key)?.(msg.bars);
      historyWaiters.delete(key);
      break;
    }
    case "Alerts":
      setState("alerts", msg.alerts);
      if (msg.fired !== null) {
        const a = msg.alerts.find((x) => x.id === msg.fired);
        const s = a && state.symbols.find((x) => x.id === a.symbol);
        if (a && s) {
          const text = `Alert: ${s.name} ${a.above ? "rose to" : "fell to"} ${(a.price / 10 ** s.digits).toFixed(s.digits)}${a.note ? ` (${a.note})` : ""}.`;
          toast(text);
          log(text);
        }
      }
      break;
    case "Depth":
      if (msg.s === state.selected) setState("depth", { symbol: msg.s, bids: msg.bids, asks: msg.asks, simulated: msg.simulated });
      break;
    case "Pong": {
      const rtt = performance.now() - pingSent;
      setState({ ping: Math.round(rtt), clockOffset: Math.round(msg.t + rtt / 2 - Date.now()) });
      break;
    }
  }
}

function symbolName(id: number) {
  return state.symbols.find((s) => s.id === id)?.name ?? `#${id}`;
}

function onEvent(ev: ServerEvent) {
  switch (ev.type) {
    case "Deal":
      // Events can arrive twice around a login snapshot; ids make them idempotent.
      if (!state.deals.some((d) => d.id === ev.deal.id)) {
        setState("deals", (d) => [...d, ev.deal]);
        log(`${ev.deal.entry === "In" ? "Opened" : "Closed"} ${symbolName(ev.deal.symbol)} ${ev.deal.side.toLowerCase()} ${(ev.deal.volume / 10_000).toFixed(2)} lots, deal ${ev.deal.id}.`);
        if (ev.deal.reason !== "Client") {
          const why = { Pending: "Pending order filled", StopLoss: "Stop loss hit", TakeProfit: "Take profit hit", StopOut: "Stop-out" }[ev.deal.reason];
          toast(`${why}: ${symbolName(ev.deal.symbol)} ${ev.deal.side.toLowerCase()} ${(ev.deal.volume / 10_000).toFixed(2)} lots.`, ev.deal.reason === "StopOut" ? "error" : "info");
        }
      }
      break;
    case "Position":
      setState(
        "positions",
        produce((list) => {
          const i = list.findIndex((p) => p.id === ev.position.id);
          if (i >= 0) list[i] = ev.position;
          else list.push(ev.position);
        }),
      );
      break;
    case "PositionClosed":
      setState("positions", (list) => list.filter((p) => p.id !== ev.position));
      break;
    case "OrderPlaced":
      if (!state.orders.some((o) => o.id === ev.order.id)) setState("orders", (list) => [...list, ev.order]);
      break;
    case "OrderRemoved":
      setState("orders", (list) => list.filter((o) => o.id !== ev.order));
      break;
    case "Account":
      setState("account", ev.state);
      break;
    case "Rejected": {
      const text = REJECTIONS[ev.reason] ?? `Order rejected: ${ev.reason}.`;
      toast(text, "error");
      log(`Rejected: ${text}`);
      break;
    }
    case "MarginCall":
      toast(`Margin call: margin level is ${ev.margin_level}%.`, "error");
      break;
    case "StopOut":
      toast(`Stop-out at margin level ${ev.margin_level}%: positions are being closed.`, "error");
      break;
    case "Balance":
      log(`Balance ${ev.amount >= 0 ? "deposit" : "withdrawal"} of ${(Math.abs(ev.amount) / 1_000_000).toFixed(2)} ${state.currency}${ev.comment ? ` (${ev.comment})` : ""}.`);
      break;
  }
}

// ----------------------------------------------------------------- actions

export function placeOrder(o: Omit<Extract<ClientMsg, { type: "Order" }>, "type" | "client_id">) {
  send({ type: "Order", client_id: nextClientId++, ...o });
  log(`Sent ${o.kind.toLowerCase()} ${o.side.toLowerCase()} ${o.symbol} ${(o.volume / 10_000).toFixed(2)} lots.`);
}

let depthSymbol = "";
/** Ask the server for depth of market on one symbol (the last call wins). */
export function watchDepth(symbolId: number) {
  const name = state.symbols.find((s) => s.id === symbolId)?.name ?? "";
  if (name === depthSymbol) return;
  depthSymbol = name;
  setState("depth", null);
  send({ type: "Depth", symbol: name });
}

export function addAlert(symbol: string, price: number, note: string) {
  send({ type: "AlertAdd", symbol, price, note });
}

export function deleteAlert(id: number) {
  send({ type: "AlertDelete", id });
}

export function demoDeposit(amount: number) {
  send({ type: "DemoDeposit", amount });
}

export function closePosition(id: number) {
  send({ type: "Close", position: id });
}

export function modifyPosition(id: number, sl: number, tp: number, trail: number) {
  send({ type: "Modify", position: id, sl, tp, trail });
}

export function cancelOrder(id: number) {
  send({ type: "Cancel", order: id });
}

export function requestHistory(symbol: SymbolInfo, tf: number, count = 600): Promise<Bar[]> {
  return new Promise((resolve) => {
    historyWaiters.set(`${symbol.id}:${tf}`, resolve);
    send({ type: "History", symbol: symbol.name, tf, count });
  });
}
