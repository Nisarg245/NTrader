import { createMemo, For, Show } from "solid-js";
import { fmtMoney, fmtSigned, liveAccount } from "../calc";
import { prefs, setPrefs } from "../prefs";
import { logout, state } from "../store";
import { activateTab, addTab, closeTab, setOpenDialog, setTradesTab } from "../ui";
import { IconBell, IconMoon, IconPlus, IconSettings, IconSplit, IconSun } from "./Icons";

const TF_LABEL: Record<number, string> = { 60: "M1", 300: "M5", 900: "M15", 1800: "M30", 3600: "H1", 14400: "H4" };

export function Header() {
  const a = createMemo(liveAccount);
  const waiting = () => state.alerts.filter((x) => x.fired === 0).length;
  return (
    <header>
      <div class="topbar">
        <h1 class="brand">
          N<span>Trader</span>
        </h1>
        <dl class="metrics">
          <div>
            <dt>Balance</dt>
            <dd class="num">{fmtMoney(a().balance)}</dd>
          </div>
          <div>
            <dt>Equity</dt>
            <dd class="num">
              <strong>{fmtMoney(a().equity)}</strong>
            </dd>
          </div>
          <div>
            <dt>Margin</dt>
            <dd class="num">{fmtMoney(a().margin)}</dd>
          </div>
          <div>
            <dt>Free margin</dt>
            <dd class="num">{fmtMoney(a().free)}</dd>
          </div>
          <div>
            <dt>Margin level</dt>
            <dd class="num">{a().margin > 0 ? `${a().level.toFixed(2)}%` : "—"}</dd>
          </div>
          <div>
            <dt>Floating P/L</dt>
            <dd class={`num ${a().floating < 0 ? "down" : "up"}`}>
              {fmtSigned(a().floating)} {state.currency}
            </dd>
          </div>
        </dl>
        <div class="topbar-actions">
          <Show when={state.demo}>
            <button type="button" class="btn btn-primary" disabled={state.status !== "online"} onClick={() => setOpenDialog("deposit")}>
              Deposit
            </button>
          </Show>
          <span>
            <span class="num">{state.account?.id}</span> · {state.name}
          </span>
          <button type="button" class="btn" onClick={logout}>
            Log out
          </button>
        </div>
      </div>

      <div class="toolbar">
        <div class="tabs" role="tablist" aria-label="Open charts">
          <For each={prefs.tabs}>
            {(tab, i) => (
              <span class="chart-tab">
                <button type="button" class="tab" role="tab" aria-selected={prefs.active === i()} onClick={() => activateTab(i())}>
                  {tab.symbol} · {TF_LABEL[tab.tf] ?? tab.tf}
                </button>
                <Show when={prefs.tabs.length > 1}>
                  <button type="button" class="close" aria-label={`Close ${tab.symbol} chart`} onClick={() => closeTab(i())}>
                    ✕
                  </button>
                </Show>
              </span>
            )}
          </For>
          <button type="button" class="btn btn-quiet icon-btn" aria-label="Open another chart" disabled={prefs.tabs.length >= 8} onClick={addTab}>
            <IconPlus />
          </button>
        </div>
        <div class="end">
          <button type="button" class="switch" role="switch" aria-checked={prefs.oneClick} onClick={() => setPrefs("oneClick", !prefs.oneClick)}>
            <span class="track" aria-hidden="true">
              <span class="knob" />
            </span>
            One-click trading
          </button>
          <button type="button" class="btn btn-quiet icon-btn" onClick={() => setTradesTab("alerts")}>
            <IconBell />
            Alerts · {waiting()}
          </button>
          <button type="button" class="btn btn-quiet icon-btn" aria-label="Two charts side by side" aria-pressed={prefs.split} onClick={() => setPrefs("split", !prefs.split)}>
            <IconSplit />
          </button>
          <button
            type="button"
            class="btn btn-quiet icon-btn"
            aria-label={prefs.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => setPrefs("theme", prefs.theme === "dark" ? "light" : "dark")}
          >
            {prefs.theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <button type="button" class="btn btn-quiet icon-btn" aria-label="Settings" onClick={() => setOpenDialog("settings")}>
            <IconSettings />
          </button>
        </div>
      </div>
    </header>
  );
}
