import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { convert, fmtLots, fmtMoney, fmtPrice, liveAccount, marginFor, parsePrice, pip, pointsToMoney, symbolById, VOLUME_SCALE } from "../calc";
import { placeOrder, quotes, state, toast } from "../store";
import type { OrderKind, Side } from "../types";

const KINDS: OrderKind[] = ["Market", "Limit", "Stop"];
const QUICK = [100, 1_000, 5_000, 10_000];

export function Ticket() {
  const [kind, setKind] = createSignal<OrderKind>("Market");
  const [volume, setVolume] = createSignal("0.10");
  const [price, setPrice] = createSignal("");
  const [sl, setSl] = createSignal("");
  const [tp, setTp] = createSignal("");
  const [risk, setRisk] = createSignal("1.00");

  const symbol = createMemo(() => symbolById(state.selected));
  const quote = () => quotes[state.selected];

  // Prices typed for one symbol make no sense for another.
  createEffect(
    on(
      () => state.selected,
      () => {
        setPrice("");
        setSl("");
        setTp("");
      },
      { defer: true },
    ),
  );

  const lots = createMemo(() => {
    const v = Number.parseFloat(volume().replace(",", "."));
    return Number.isFinite(v) ? Math.round(v * VOLUME_SCALE) : 0;
  });
  const volumeError = createMemo(() => {
    const s = symbol();
    if (!s) return "";
    const v = lots();
    if (v < s.vol_min) return `Minimum is ${fmtLots(s.vol_min)} lots.`;
    if (v > s.vol_max) return `Maximum is ${fmtLots(s.vol_max)} lots.`;
    if (v % s.vol_step !== 0) return `Volume must be a multiple of ${fmtLots(s.vol_step)}.`;
    return "";
  });

  const step = (dir: number) => {
    const s = symbol();
    if (!s) return;
    const next = Math.min(Math.max(lots() + dir * s.vol_step, s.vol_min), s.vol_max);
    setVolume(fmtLots(next));
  };

  /** Entry price the order would get: typed price for pending orders, market otherwise. */
  const entry = (side: Side) => {
    const s = symbol();
    const q = quote();
    if (!s || !q) return 0;
    if (kind() !== "Market") return parsePrice(price(), s);
    return side === "Buy" ? q.ask : q.bid;
  };

  /** Distance and money for a stop level. The side is inferred from which side of the price it is on. */
  const level = (text: string, isStop: boolean) => {
    const s = symbol();
    const q = quote();
    if (!s || !q) return null;
    const at = parsePrice(text, s);
    if (!at) return null;
    const mid = kind() === "Market" ? (q.bid + q.ask) / 2 : parsePrice(price(), s);
    if (!mid) return null;
    const side: Side = (at < mid) === isStop ? "Buy" : "Sell";
    const points = Math.abs(entry(side) - at);
    const p = pip(s);
    const money = convert(pointsToMoney(s, lots(), points), s.profit_ccy, state.currency);
    return { points, text: `${(points / p.points).toFixed(p.points === 10 ? 1 : 0)} ${p.label} · ${isStop ? "−" : "+"}${fmtMoney(money)}` };
  };
  const slInfo = createMemo(() => level(sl(), true));
  const tpInfo = createMemo(() => level(tp(), false));

  const sizeByRisk = () => {
    const s = symbol();
    const info = slInfo();
    const pct = Number.parseFloat(risk().replace(",", "."));
    if (!s || !info || info.points <= 0 || !(pct > 0)) return;
    const budget = (liveAccount().balance * pct) / 100;
    const perLot = convert(pointsToMoney(s, VOLUME_SCALE, info.points), s.profit_ccy, state.currency);
    const raw = (budget / perLot) * VOLUME_SCALE;
    const snapped = Math.floor(raw / s.vol_step) * s.vol_step;
    if (snapped < s.vol_min) {
      toast(`That risk is too small for the minimum volume of ${fmtLots(s.vol_min)} lots.`, "error");
      return;
    }
    setVolume(fmtLots(Math.min(snapped, s.vol_max)));
  };

  const margin = createMemo(() => {
    const s = symbol();
    const q = quote();
    return s && q && lots() > 0 ? marginFor(s, lots(), entry("Buy") || q.ask) : 0;
  });
  const perPip = createMemo(() => {
    const s = symbol();
    return s ? convert(pointsToMoney(s, lots(), pip(s).points), s.profit_ccy, state.currency) : 0;
  });

  const blocked = () => state.status !== "online" || !symbol()?.trade_enabled || !(quote()?.bid > 0);

  const submit = (side: Side) => {
    const s = symbol();
    if (!s) return;
    if (volumeError()) {
      toast(volumeError(), "error");
      return;
    }
    const at = kind() === "Market" ? 0 : parsePrice(price(), s);
    if (kind() !== "Market" && !at) {
      toast(`Enter the ${kind().toLowerCase()} price first.`, "error");
      return;
    }
    placeOrder({ symbol: s.name, side, kind: kind(), volume: lots(), price: at, sl: parsePrice(sl(), s), tp: parsePrice(tp(), s) });
  };

  const label = (side: Side) => (kind() === "Market" ? side : `${side} ${kind().toLowerCase()}`);

  return (
    <section class="panel ticket" aria-labelledby="ticket-title">
      <h2 id="ticket-title">New order · {symbol()?.name}</h2>

      <div class="segmented" role="group" aria-label="Order type">
        <For each={KINDS}>
          {(k) => (
            <button type="button" aria-pressed={kind() === k} onClick={() => setKind(k)}>
              {k}
            </button>
          )}
        </For>
      </div>

      <Show when={kind() !== "Market"}>
        <div class="field">
          <label for="ticket-price">{kind()} price</label>
          <input id="ticket-price" class="input num" inputmode="decimal" placeholder={fmtPrice(quote()?.bid ?? 0, symbol())} value={price()} onInput={(e) => setPrice(e.currentTarget.value)} />
        </div>
      </Show>

      <div class="field">
        <label for="ticket-volume">Volume (lots)</label>
        <div class="stepper">
          <button type="button" class="btn" aria-label="Decrease volume" onClick={() => step(-1)}>
            −
          </button>
          <input id="ticket-volume" class="input num" inputmode="decimal" aria-invalid={volumeError() ? "true" : undefined} aria-describedby="ticket-volume-hint" value={volume()} onInput={(e) => setVolume(e.currentTarget.value)} />
          <button type="button" class="btn" aria-label="Increase volume" onClick={() => step(1)}>
            +
          </button>
        </div>
        <div class="quick" role="group" aria-label="Quick volumes">
          <For each={QUICK}>
            {(v) => (
              <button type="button" class="btn btn-quiet num" aria-pressed={lots() === v} onClick={() => setVolume(fmtLots(v))}>
                {fmtLots(v)}
              </button>
            )}
          </For>
        </div>
        <p id="ticket-volume-hint" class="hint down">
          {volumeError()}
        </p>
      </div>

      <div class="pair">
        <div class="field">
          <label for="ticket-sl">Stop loss</label>
          <input id="ticket-sl" class="input num" inputmode="decimal" placeholder="None" value={sl()} onInput={(e) => setSl(e.currentTarget.value)} />
          <p class="hint num down">{slInfo()?.text}</p>
        </div>
        <div class="field">
          <label for="ticket-tp">Take profit</label>
          <input id="ticket-tp" class="input num" inputmode="decimal" placeholder="None" value={tp()} onInput={(e) => setTp(e.currentTarget.value)} />
          <p class="hint num up">{tpInfo()?.text}</p>
        </div>
      </div>

      <div class="field">
        <label for="ticket-risk">Size by risk (% of balance, needs a stop loss)</label>
        <div class="inline">
          <input id="ticket-risk" class="input num" inputmode="decimal" value={risk()} onInput={(e) => setRisk(e.currentTarget.value)} />
          <button type="button" class="btn" disabled={!slInfo()} onClick={sizeByRisk}>
            Calculate lots
          </button>
        </div>
      </div>

      <dl class="summary">
        <dt>Margin required</dt>
        <dd class="num">
          {fmtMoney(margin())} {state.currency}
        </dd>
        <dt>Value per {symbol() && pip(symbol()!).label === "pips" ? "pip" : "point"}</dt>
        <dd class="num">
          {fmtMoney(perPip())} {state.currency}
        </dd>
        <dt>Free margin after</dt>
        <dd class="num">
          {fmtMoney(liveAccount().free - margin())} {state.currency}
        </dd>
        <Show when={slInfo() && tpInfo() && slInfo()!.points > 0}>
          <dt>Risk : reward</dt>
          <dd class="num">1 : {(tpInfo()!.points / slInfo()!.points).toFixed(2)}</dd>
        </Show>
      </dl>

      <p class="small muted">One click sends the order. {state.mode === "Netting" ? "This account keeps one net position per symbol." : "Each order opens its own position."}</p>
      <div class="pair trade-actions">
        <button type="button" class="btn btn-trade sell" disabled={blocked()} onClick={() => submit("Sell")}>
          <span>{label("Sell")}</span>
          <span class="num">{fmtPrice(entry("Sell") || (quote()?.bid ?? 0), symbol())}</span>
        </button>
        <button type="button" class="btn btn-trade buy" disabled={blocked()} onClick={() => submit("Buy")}>
          <span>{label("Buy")}</span>
          <span class="num">{fmtPrice(entry("Buy") || (quote()?.ask ?? 0), symbol())}</span>
        </button>
      </div>
    </section>
  );
}
