import { createMemo, createSignal, For, Show } from "solid-js";
import { fmtPrice, pip } from "../calc";
import { quotes, setState, state } from "../store";

export function MarketWatch() {
  const [filter, setFilter] = createSignal("");
  const shown = createMemo(() => {
    const f = filter().trim().toUpperCase();
    return f ? state.symbols.filter((s) => s.name.includes(f)) : state.symbols;
  });

  return (
    <section class="panel watch" aria-labelledby="watch-title">
      <div class="panel-head">
        <h2 id="watch-title">Market Watch</h2>
        <span class="small muted">
          {shown().length} of {state.symbols.length} symbols
        </span>
      </div>
      <div class="watch-search">
        <label for="watch-find" class="sr-only">
          Search symbols
        </label>
        <input id="watch-find" class="input" type="search" placeholder="Search symbols" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
      </div>
      <div class="watch-cols" aria-hidden="true">
        <span>Symbol</span>
        <span>Bid</span>
        <span>Ask</span>
        <span>Spread</span>
      </div>
      <ul>
        <For each={shown()}>
          {(s) => {
            const q = () => quotes[s.id];
            const tone = () => (q()?.dir > 0 ? "up" : q()?.dir < 0 ? "down" : "");
            const spread = () => ((q().ask - q().bid) / pip(s).points).toFixed(pip(s).points === 10 ? 1 : 0);
            return (
              <li>
                <button type="button" class="watch-row" aria-current={state.selected === s.id ? "true" : undefined} onClick={() => setState("selected", s.id)}>
                  <strong>{s.name}</strong>
                  <span class={`num ${tone()}`}>{fmtPrice(q()?.bid ?? 0, s)}</span>
                  <span class={`num ${tone()}`}>{fmtPrice(q()?.ask ?? 0, s)}</span>
                  <span class="num muted">{q()?.bid > 0 ? spread() : "—"}</span>
                </button>
              </li>
            );
          }}
        </For>
      </ul>
      <Show when={shown().length === 0}>
        <p class="empty">No symbol matches “{filter()}”.</p>
      </Show>
    </section>
  );
}
