import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { ChartPanel } from "./components/Chart";
import { Dialogs } from "./components/Dialogs";
import { Header } from "./components/Header";
import { Login } from "./components/Login";
import { MarketWatch } from "./components/MarketWatch";
import { Ticket } from "./components/Ticket";
import { Trades } from "./components/Trades";
import { persistPrefs, prefs } from "./prefs";
import { dismissToast, state } from "./store";
import { quickTrade, reconcileTabs } from "./ui";

export function App() {
  persistPrefs();
  // Saved chart tabs are matched to the server's symbols after every login.
  createEffect(on(() => state.symbols.length, (n) => n > 0 && reconcileTabs()));

  // In split view the second chart is the tab after the active one.
  const charts = createMemo(() => {
    const n = prefs.tabs.length;
    if (n === 0) return [];
    return prefs.split && n > 1 ? [prefs.active, (prefs.active + 1) % n] : [prefs.active];
  });

  const [clock, setClock] = createSignal(Date.now());
  onMount(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    // B and S trade at market, unless the user is typing or a dialog is open.
    const keys = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || !state.account) return;
      if (el.closest("input, textarea, select, [contenteditable], dialog") || document.querySelector("dialog[open]")) return;
      if (e.key === "b" || e.key === "B") quickTrade("Buy");
      if (e.key === "s" || e.key === "S") quickTrade("Sell");
    };
    window.addEventListener("keydown", keys);
    onCleanup(() => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", keys);
    });
  });

  return (
    <Show when={state.account} fallback={<Login />}>
      <div class="app">
        <Header />
        <Show when={state.status === "reconnecting"}>
          <p class="banner" role="alert">
            Connection lost. Reconnecting… Prices on screen are not live and orders cannot be sent.
          </p>
        </Show>
        <main class="main">
          <MarketWatch />
          <div class="charts">
            <For each={charts()}>{(i) => <ChartPanel index={i} />}</For>
          </div>
          <Ticket />
        </main>
        <Trades />
        <footer class="statusbar">
          <span>
            <span class={`dot ${state.status === "online" ? "" : "off"}`} aria-hidden="true" />
            {state.status === "online" ? "Connected" : "Reconnecting"}
            <Show when={state.ping !== null}> · {state.ping} ms</Show>
          </span>
          <span>{location.host}</span>
          <span>
            {state.demo ? "Demo · " : ""}
            {state.mode} · 1:{state.leverage} · {state.currency}
          </span>
          <span class="num">Server time {new Date(clock() + state.clockOffset).toISOString().slice(11, 19)} UTC</span>
          <span class="end">Shortcuts: B buy · S sell · Esc cancel</span>
          <span>NTrader Web 0.2</span>
        </footer>
      </div>
      <div class="toasts" role="status" aria-live="polite">
        <For each={state.toasts}>
          {(t) => (
            <div class={`toast ${t.tone}`}>
              <p>{t.text}</p>
              <button type="button" class="btn btn-quiet" aria-label="Dismiss message" onClick={() => dismissToast(t.id)}>
                ✕
              </button>
            </div>
          )}
        </For>
      </div>
      <Dialogs />
    </Show>
  );
}
