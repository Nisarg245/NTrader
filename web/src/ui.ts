// Shared UI state and actions used by more than one component.

import { createSignal } from "solid-js";
import { fmtLots, fmtPrice, symbolById, VOLUME_SCALE } from "./calc";
import { prefs, setPrefs } from "./prefs";
import { placeOrder, quotes, setState, state, toast, watchDepth } from "./store";
import type { ClientMsg, Side } from "./types";

export type TradesTab = "positions" | "orders" | "history" | "exposure" | "alerts" | "news" | "journal";
export const [tradesTab, setTradesTab] = createSignal<TradesTab>("positions");

/** Volume typed in the order ticket, shared with the chart's quick trade buttons. */
export const [volumeText, setVolumeText] = createSignal(prefs.defaultLots);
export const lots = () => {
  const v = Number.parseFloat(volumeText().replace(",", "."));
  return Number.isFinite(v) ? Math.round(v * VOLUME_SCALE) : 0;
};

export type OrderDraft = Omit<Extract<ClientMsg, { type: "Order" }>, "type" | "client_id">;
/** An order waiting for confirmation, when one-click trading is off. */
export const [pendingOrder, setPendingOrder] = createSignal<{ order: OrderDraft; text: string } | null>(null);

export const [openDialog, setOpenDialog] = createSignal<"settings" | "deposit" | "alert" | null>(null);

function describe(o: OrderDraft) {
  const s = state.symbols.find((x) => x.name === o.symbol);
  const at = o.kind === "Market" ? "at market" : `at ${fmtPrice(o.price ?? 0, s)}`;
  return `${o.side} ${fmtLots(o.volume)} ${o.symbol} ${o.kind === "Market" ? "" : o.kind.toLowerCase() + " "}${at}`;
}

/** Send an order now, or ask first when one-click trading is off. */
export function requestOrder(order: OrderDraft) {
  if (prefs.oneClick) placeOrder(order);
  else setPendingOrder({ order, text: describe(order) });
}

/** Market order on the selected symbol with the ticket's volume and no stops. */
export function quickTrade(side: Side) {
  const s = symbolById(state.selected);
  if (!s || state.status !== "online" || !(quotes[s.id]?.bid > 0)) return;
  const v = lots();
  if (v < s.vol_min || v > s.vol_max || v % s.vol_step !== 0) {
    toast(`Volume ${volumeText()} is not allowed for ${s.name}.`, "error");
    return;
  }
  requestOrder({ symbol: s.name, side, kind: "Market", volume: v });
}

/** Show a symbol in the active chart tab, the ticket and the depth panel. */
export function selectSymbol(id: number) {
  const s = symbolById(id);
  if (!s) return;
  setState("selected", id);
  if (prefs.tabs[prefs.active]) setPrefs("tabs", prefs.active, "symbol", s.name);
  watchDepth(id);
}

export function activateTab(i: number) {
  const tab = prefs.tabs[i];
  if (!tab) return;
  setPrefs("active", i);
  const s = state.symbols.find((x) => x.name === tab.symbol);
  if (s) {
    setState("selected", s.id);
    watchDepth(s.id);
  }
}

export function addTab() {
  const current = prefs.tabs[prefs.active];
  const s = symbolById(state.selected);
  if (!s || prefs.tabs.length >= 8) return;
  setPrefs("tabs", (t) => [...t, { symbol: s.name, tf: current?.tf ?? 900, type: current?.type ?? "candles" }]);
  setPrefs("active", prefs.tabs.length - 1);
}

export function closeTab(i: number) {
  if (prefs.tabs.length <= 1) return;
  setPrefs("tabs", (t) => t.filter((_, j) => j !== i));
  activateTab(Math.min(prefs.active >= i ? Math.max(prefs.active - 1, 0) : prefs.active, prefs.tabs.length - 1));
}

/** Make sure saved tabs match the server's symbols; called after login. */
export function reconcileTabs() {
  const known = new Set(state.symbols.map((s) => s.name));
  let tabs = prefs.tabs.filter((t) => known.has(t.symbol));
  if (tabs.length === 0 && state.symbols[0]) tabs = [{ symbol: state.symbols[0].name, tf: 900, type: "candles" }];
  setPrefs("tabs", tabs);
  activateTab(Math.min(prefs.active, tabs.length - 1));
}
