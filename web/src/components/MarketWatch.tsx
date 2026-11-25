import { createMemo, createSignal, For, Show } from "solid-js";
import { fmtLots, fmtPrice, pip, symbolById } from "../calc";
import { prefs, setPrefs } from "../prefs";
import { quotes, state } from "../store";
import { selectSymbol } from "../ui";
import type { Level } from "../types";
import { IconStar } from "./Icons";

export function MarketWatch() {
  const [filter, setFilter] = createSignal("");
  const [group, setGroup] = createSignal("All");
  const groups = createMemo(() => ["All", "Favourites", ...new Set(state.symbols.map((s) => s.category).filter(Boolean))]);
  const shown = createMemo(() => {
    const f = filter().trim().toUpperCase();
    return state.symbols.filter((s) => {
      if (f && !s.name.includes(f)) return false;
      if (group() === "Favourites") return prefs.favourites.includes(s.name);
      return group() === "All" || s.category === group();
    });
  });
  const toggleFavourite = (name: string) =>
    setPrefs("favourites", (f) => (f.includes(name) ? f.filter((x) => x !== name) : [...f, name]));

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
      <div class="groups" role="group" aria-label="Symbol groups">
        <For each={groups()}>
          {(g) => (
            <button type="button" class="btn btn-quiet" aria-pressed={group() === g} onClick={() => setGroup(g)}>
              {g}
            </button>
          )}
        </For>
      </div>
      <div class="watch-cols" aria-hidden="true">
        <span>Symbol</span>
        <span>Bid</span>
        <span>Ask</span>
        <span>Day</span>
      </div>
      <ul>
        <For each={shown()}>
          {(s) => {
            const q = () => quotes[s.id];
            const tone = () => (q()?.dir > 0 ? "up" : q()?.dir < 0 ? "down" : "");
            const day = () => (s.day_open > 0 && q()?.bid > 0 ? ((q().bid - s.day_open) / s.day_open) * 100 : null);
            const starred = () => prefs.favourites.includes(s.name);
            return (
              <li class="watch-line" data-current={state.selected === s.id}>
                <button type="button" class="star" aria-pressed={starred()} aria-label={`${starred() ? "Remove" : "Add"} ${s.name} ${starred() ? "from" : "to"} favourites`} onClick={() => toggleFavourite(s.name)}>
                  <IconStar />
                </button>
                <button type="button" class="watch-row" aria-current={state.selected === s.id ? "true" : undefined} onClick={() => selectSymbol(s.id)}>
                  <strong>{s.name}</strong>
                  <span class={`num ${tone()}`}>{fmtPrice(q()?.bid ?? 0, s)}</span>
                  <span class={`num ${tone()}`}>{fmtPrice(q()?.ask ?? 0, s)}</span>
                  <span class={`num ${day() === null ? "muted" : day()! < 0 ? "down" : "up"}`}>{day() === null ? "—" : `${day()! > 0 ? "+" : day()! < 0 ? "−" : ""}${Math.abs(day()!).toFixed(2)}%`}</span>
                </button>
              </li>
            );
          }}
        </For>
      </ul>
      <Show when={shown().length === 0}>
        <p class="empty">{group() === "Favourites" && !filter() ? "No favourites yet. Use the star next to a symbol to add it." : "No symbol matches."}</p>
      </Show>
      <Depth />
    </section>
  );
}

function Depth() {
  const symbol = () => symbolById(state.selected);
  const depth = () => (state.depth?.symbol === state.selected ? state.depth : null);
  const largest = createMemo(() => Math.max(1, ...(depth()?.bids ?? []).map((l) => l[1]), ...(depth()?.asks ?? []).map((l) => l[1])));
  const total = () => [...(depth()?.bids ?? []), ...(depth()?.asks ?? [])].reduce((sum, l) => sum + l[1], 0);
  const spread = () => {
    const s = symbol();
    const d = depth();
    if (!s || !d?.bids[0] || !d.asks[0]) return "";
    const p = pip(s);
    return `Spread ${((d.asks[0][0] - d.bids[0][0]) / p.points).toFixed(p.points === 10 ? 1 : 0)} ${p.label}`;
  };
  const row = (l: Level, tone: string) => (
    <li>
      <span class="bar" aria-hidden="true" style={{ width: `${(l[1] / largest()) * 100}%` }} />
      <span class={`num ${tone}`}>{fmtPrice(l[0], symbol())}</span>
      <span class="num">{fmtLots(l[1])}</span>
    </li>
  );
  return (
    <section class="depth" aria-labelledby="depth-title">
      <div class="panel-head">
        <h2 id="depth-title">Depth of market · {symbol()?.name}</h2>
        <span class="small muted">{depth()?.simulated ? "Simulated · lots" : "Lots"}</span>
      </div>
      <Show when={depth()} fallback={<p class="empty">No depth is available for this symbol.</p>}>
        <ul class="asks" aria-label="Ask levels, highest first">
          <For each={[...depth()!.asks].reverse()}>{(l) => row(l, "down")}</For>
        </ul>
        <p class="mid num">
          <span>{spread()}</span>
          <span>Total {fmtLots(total())}</span>
        </p>
        <ul class="bids" aria-label="Bid levels, highest first">
          <For each={depth()!.bids}>{(l) => row(l, "up")}</For>
        </ul>
      </Show>
    </section>
  );
}
