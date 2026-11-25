// Per-browser settings, kept in localStorage. Storage can be missing or
// blocked, so every read and write is guarded and the app works without it.

import { createEffect } from "solid-js";
import { createStore } from "solid-js/store";

export type ChartType = "candles" | "line" | "area";
export interface ChartTab {
  symbol: string;
  tf: number;
  type: ChartType;
}
export interface Point {
  /** Bar time, Unix seconds. */
  t: number;
  /** Price as a decimal. */
  p: number;
}
export interface Drawing {
  id: number;
  kind: "trend" | "hline" | "rect" | "fib" | "text";
  a: Point;
  b?: Point;
  text?: string;
}

export interface Prefs {
  theme: "dark" | "light";
  /** Colours for up/buy and down/sell. */
  palette: "blue-orange" | "green-red";
  /** Send orders on a single click, without a confirmation step. */
  oneClick: boolean;
  defaultLots: string;
  favourites: string[];
  tabs: ChartTab[];
  active: number;
  /** Show two charts side by side. */
  split: boolean;
  indicators: { ma: boolean; ema: boolean; bb: boolean; volume: boolean; rsi: boolean };
  /** Chart drawings per symbol name. */
  drawings: Record<string, Drawing[]>;
}

const KEY = "ntrader.prefs.v1";
const defaults: Prefs = {
  theme: "dark",
  palette: "blue-orange",
  oneClick: true,
  defaultLots: "0.10",
  favourites: [],
  tabs: [],
  active: 0,
  split: false,
  indicators: { ma: true, ema: false, bb: false, volume: true, rsi: false },
  drawings: {},
};

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { ...defaults, ...saved, indicators: { ...defaults.indicators, ...saved.indicators } };
  } catch {
    return structuredClone(defaults);
  }
}

export const [prefs, setPrefs] = createStore<Prefs>(load());

/** Call once from the root component: saves on change and applies the theme. */
export function persistPrefs() {
  createEffect(() => {
    const text = JSON.stringify(prefs);
    try {
      localStorage.setItem(KEY, text);
    } catch {
      /* not saved; settings last for this visit only */
    }
  });
  createEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
    document.documentElement.dataset.palette = prefs.palette;
  });
}
