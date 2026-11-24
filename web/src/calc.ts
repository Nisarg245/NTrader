// Client-side valuation. Mirrors the engine's maths so equity and profit can
// update on every tick without a server round trip. The server stays the
// authority: it re-checks everything when an order arrives.

import { quotes, state } from "./store";
import type { Position, SymbolInfo } from "./types";

export const VOLUME_SCALE = 10_000;
export const MONEY_SCALE = 1_000_000;

export const symbolById = (id: number) => state.symbols.find((s) => s.id === id);
export const scaleOf = (s: SymbolInfo) => 10 ** s.digits;

/** Convert an amount between currencies using the matching forex symbol's quote. */
export function convert(amount: number, from: string, to: string): number {
  if (from === to) return amount;
  for (const s of state.symbols) {
    if (s.calc !== "Forex") continue;
    const q = quotes[s.id];
    if (!q) continue;
    if (s.base_ccy === from && s.profit_ccy === to && q.bid > 0) return (amount * q.bid) / scaleOf(s);
    if (s.base_ccy === to && s.profit_ccy === from && q.ask > 0) return (amount * scaleOf(s)) / q.ask;
  }
  return amount;
}

/** Money (millionths, profit currency) gained when the price moves by `points` in our favour. */
export function pointsToMoney(s: SymbolInfo, volume: number, points: number): number {
  return (points * volume * s.contract_size * 100) / scaleOf(s);
}

/** Floating profit of a position in account currency, millionths. Swap not included. */
export function positionProfit(p: Position): number {
  const s = symbolById(p.symbol);
  const q = quotes[p.symbol];
  if (!s || !q || q.bid <= 0) return 0;
  const points = p.side === "Buy" ? q.bid - p.open_price : p.open_price - q.ask;
  return convert(pointsToMoney(s, p.volume, points), s.profit_ccy, state.currency);
}

/** Price at which a position on `side` would be closed right now. */
export function closePrice(p: Position): number {
  const q = quotes[p.symbol];
  return q ? (p.side === "Buy" ? q.bid : q.ask) : 0;
}

/** Margin needed to open `volume` at `price`, in account currency, millionths. */
export function marginFor(s: SymbolInfo, volume: number, price: number): number {
  const units = volume * s.contract_size * 100;
  const lev = Math.max(state.leverage, 1);
  const value = (units * price) / scaleOf(s);
  const [amount, from] =
    s.calc === "Forex" ? [units / lev, s.base_ccy] : s.calc === "Cfd" ? [value, s.profit_ccy] : [value / lev, s.profit_ccy];
  return convert((amount * s.margin_rate_bp) / 10_000, from, state.currency);
}

/** Live account figures: balance and margin from the server, the rest from current quotes. */
export function liveAccount() {
  const a = state.account;
  if (!a) return { balance: 0, equity: 0, margin: 0, free: 0, level: 0, floating: 0 };
  let floating = 0;
  for (const p of state.positions) floating += positionProfit(p) + p.swap;
  const equity = a.balance + a.credit + floating;
  return {
    balance: a.balance,
    equity,
    margin: a.margin,
    free: equity - a.margin,
    level: a.margin > 0 ? (equity / a.margin) * 100 : 0,
    floating,
  };
}

/** Forex symbols are quoted with a fractional pip digit; other symbols are counted in points. */
export function pip(s: SymbolInfo): { points: number; label: string } {
  return s.calc === "Forex" && (s.digits === 5 || s.digits === 3) ? { points: 10, label: "pips" } : { points: 1, label: "points" };
}

// --------------------------------------------------------------- formatting

export const fmtPrice = (price: number, s: SymbolInfo | undefined) => (s && price > 0 ? (price / scaleOf(s)).toFixed(s.digits) : "—");

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtMoney = (micros: number) => money.format(micros / MONEY_SCALE).replace("-", "−");
export const fmtSigned = (micros: number) => (micros > 0 ? "+" : "") + fmtMoney(micros);
export const fmtLots = (volume: number) => (volume / VOLUME_SCALE).toFixed(2);

const time = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
export const fmtTime = (ts: number) => time.format(ts).replace(",", "");

/** Parse a decimal price typed by the user into a scaled integer, or 0 if empty or invalid. */
export function parsePrice(text: string, s: SymbolInfo): number {
  const v = Number.parseFloat(text.replace(",", "."));
  return Number.isFinite(v) && v > 0 ? Math.round(v * scaleOf(s)) : 0;
}
