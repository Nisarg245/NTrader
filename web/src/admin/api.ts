// Manager API client. The token lives in sessionStorage, so it ends with the tab.

import { createSignal } from "solid-js";

const KEY = "ntrader.manager.token";

function saved() {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export const [token, setTokenSignal] = createSignal(saved());

export function setToken(value: string) {
  setTokenSignal(value);
  try {
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* the session then lasts until the page is reloaded */
  }
}

/** Call the Manager API. Throws an Error with the server's message on failure. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/manager${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token() ? { authorization: `Bearer ${token()}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the server.");
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== "/login") setToken("");
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status}).`);
  return data as T;
}

export interface Group {
  name: string;
  currency: string;
  mode: "Hedging" | "Netting";
  leverage: number;
  margin_call_pct: number;
  stop_out_pct: number;
  commission_per_lot: number;
  demo: boolean;
}

export interface SymbolRow {
  id: number;
  name: string;
  digits: number;
  contract_size: number;
  base_ccy: string;
  profit_ccy: string;
  calc: "Forex" | "Cfd" | "CfdLeverage";
  margin_rate_bp: number;
  vol_min: number;
  vol_max: number;
  vol_step: number;
  swap_long: number;
  swap_short: number;
  trade_enabled: boolean;
  category: string;
  bid: number;
  ask: number;
}

export interface Account {
  id: number;
  name: string;
  group: string;
  currency: string;
  leverage: number;
  enabled: boolean;
  positions: number;
  orders: number;
  balance: number;
  credit: number;
  equity: number;
  margin: number;
  free_margin: number;
  margin_level: number;
}

export interface Position {
  id: number;
  account: number;
  symbol: number;
  side: "Buy" | "Sell";
  volume: number;
  open_price: number;
  sl: number;
  tp: number;
  trail: number;
  swap: number;
  open_ts: number;
  profit: number;
  currency: string;
}

export interface Order {
  id: number;
  account: number;
  symbol: number;
  side: "Buy" | "Sell";
  kind: "Limit" | "Stop";
  volume: number;
  price: number;
  sl: number;
  tp: number;
  ts: number;
}

export interface Deal {
  id: number;
  symbol: number;
  side: "Buy" | "Sell";
  volume: number;
  price: number;
  entry: "In" | "Out";
  reason: string;
  profit: number;
  swap: number;
  commission: number;
  ts: number;
}

export interface Summary {
  accounts: number;
  positions: number;
  orders: number;
  totals: { currency: string; accounts: number; balance: number; equity: number; margin: number; floating: number }[];
  exposure: { symbol: string; bid: number; ask: number; positions: number; buy_volume: number; sell_volume: number }[];
  server_time: number;
}

export interface AccountDetail {
  account: Account;
  positions: Position[];
  orders: Order[];
  deals: Deal[];
}
