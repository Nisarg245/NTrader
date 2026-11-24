import { createMemo } from "solid-js";
import { fmtMoney, fmtSigned, liveAccount } from "../calc";
import { logout, state } from "../store";

export function Header() {
  const a = createMemo(liveAccount);
  return (
    <header class="topbar">
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
        <span>
          <span class="num">{state.account?.id}</span> · {state.name}
        </span>
        <button type="button" class="btn" onClick={logout}>
          Log out
        </button>
      </div>
    </header>
  );
}
