import { For, Show } from "solid-js";
import { ChartPanel } from "./components/Chart";
import { Header } from "./components/Header";
import { Login } from "./components/Login";
import { MarketWatch } from "./components/MarketWatch";
import { Ticket } from "./components/Ticket";
import { Trades } from "./components/Trades";
import { dismissToast, state } from "./store";

export function App() {
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
          <ChartPanel />
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
            {state.mode} · 1:{state.leverage} · {state.currency}
          </span>
          <span class="end">NTrader Web 0.1</span>
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
    </Show>
  );
}
