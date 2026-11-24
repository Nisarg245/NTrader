import { CandlestickSeries, createChart, LineSeries, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { fmtLots, fmtPrice, pip, scaleOf, symbolById } from "../calc";
import { onTick, quotes, requestHistory, state } from "../store";
import type { SymbolInfo } from "../types";

const TIMEFRAMES = [
  { label: "M1", sec: 60 },
  { label: "M5", sec: 300 },
  { label: "M15", sec: 900 },
  { label: "M30", sec: 1800 },
  { label: "H1", sec: 3600 },
  { label: "H4", sec: 14400 },
];
const MA_PERIOD = 20;

interface Candle {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

// The chart library draws times as UTC; shifting by the local offset shows local time.
const TZ = -new Date().getTimezoneOffset() * 60;
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function ChartPanel() {
  const [tf, setTf] = createSignal(900);
  const [showMa, setShowMa] = createSignal(true);
  const [loading, setLoading] = createSignal(true);
  const symbol = createMemo(() => symbolById(state.selected));
  const quote = () => quotes[state.selected];

  let box!: HTMLDivElement;
  let chart: IChartApi | undefined;
  let candles: ISeriesApi<"Candlestick"> | undefined;
  let ma: ISeriesApi<"Line"> | undefined;
  let data: Candle[] = [];
  let lines: IPriceLine[] = [];
  let loadId = 0;

  const average = (end: number) => {
    let sum = 0;
    for (let i = end - MA_PERIOD + 1; i <= end; i++) sum += data[i].close;
    return sum / MA_PERIOD;
  };

  async function load(s: SymbolInfo, seconds: number) {
    if (!candles || !ma || !chart) return;
    const id = ++loadId;
    setLoading(true);
    const bars = await requestHistory(s, seconds);
    if (id !== loadId) return; // a newer request superseded this one
    const scale = scaleOf(s);
    data = bars.map((b) => ({ time: (b[0] + TZ) as UTCTimestamp, open: b[1] / scale, high: b[2] / scale, low: b[3] / scale, close: b[4] / scale }));
    candles.applyOptions({ priceFormat: { type: "price", precision: s.digits, minMove: 1 / scale } });
    ma.applyOptions({ priceFormat: { type: "price", precision: s.digits, minMove: 1 / scale } });
    candles.setData(data);
    ma.setData(data.slice(MA_PERIOD - 1).map((c, i) => ({ time: c.time, value: average(i + MA_PERIOD - 1) })));
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(data.length - 120, 0), to: data.length + 4 });
    setLoading(false);
  }

  onMount(() => {
    chart = createChart(box, {
      autoSize: true,
      layout: { background: { color: token("--ground") }, textColor: token("--muted"), fontFamily: token("--font-num"), fontSize: 14, attributionLogo: false },
      grid: { vertLines: { color: token("--line") }, horzLines: { color: token("--line") } },
      rightPriceScale: { borderColor: token("--line") },
      timeScale: { borderColor: token("--line"), timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { labelBackgroundColor: token("--pressed") }, horzLine: { labelBackgroundColor: token("--pressed") } },
    });
    candles = chart.addSeries(CandlestickSeries, {
      upColor: token("--up"),
      downColor: token("--down"),
      wickUpColor: token("--up"),
      wickDownColor: token("--down"),
      borderVisible: false,
      priceLineColor: token("--muted"),
    });
    ma = chart.addSeries(LineSeries, { color: token("--indicator"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

    const stop = onTick((id, bid, t) => {
      const s = symbol();
      if (!s || id !== s.id || !candles || !ma || loading()) return;
      const price = bid / scaleOf(s);
      const time = (Math.floor(t / 1000 / tf()) * tf() + TZ) as UTCTimestamp;
      const last = data[data.length - 1];
      if (last && last.time === time) {
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
      } else if (!last || time > last.time) {
        data.push({ time, open: price, high: price, low: price, close: price });
      } else {
        return;
      }
      candles.update(data[data.length - 1]);
      if (data.length >= MA_PERIOD) ma.update({ time, value: average(data.length - 1) });
    });
    onCleanup(() => {
      stop();
      chart?.remove();
    });
  });

  // Reload history when the symbol or timeframe changes, and after a reconnect.
  createEffect(
    on([symbol, tf, () => state.status], ([s, seconds, status]) => {
      if (s && status === "online") void load(s, seconds);
    }),
  );

  createEffect(() => ma?.applyOptions({ visible: showMa() }));

  // Trade lines: entry, stop loss and take profit of positions, and pending orders.
  createEffect(() => {
    const s = symbol();
    if (!candles || !s) return;
    lines.forEach((l) => candles!.removePriceLine(l));
    lines = [];
    const scale = scaleOf(s);
    const add = (price: number, color: string, title: string, style: LineStyle) => {
      if (price > 0) lines.push(candles!.createPriceLine({ price: price / scale, color, title, lineStyle: style, lineWidth: 1, axisLabelVisible: true }));
    };
    for (const p of state.positions) {
      if (p.symbol !== s.id) continue;
      add(p.open_price, token("--text"), `${p.side} ${fmtLots(p.volume)}`, LineStyle.Dashed);
      add(p.sl, token("--down"), "SL", LineStyle.Dashed);
      add(p.tp, token("--up"), "TP", LineStyle.Dashed);
    }
    for (const o of state.orders) {
      if (o.symbol !== s.id) continue;
      add(o.price, token("--muted"), `${o.side} ${o.kind.toLowerCase()} ${fmtLots(o.volume)}`, LineStyle.Dotted);
    }
  });

  const spread = () => {
    const s = symbol();
    const q = quote();
    if (!s || !q || q.bid <= 0) return "";
    const p = pip(s);
    return `spread ${((q.ask - q.bid) / p.points).toFixed(p.points === 10 ? 1 : 0)} ${p.label}`;
  };

  return (
    <section class="panel chart" aria-labelledby="chart-title">
      <div class="chart-head">
        <h2 id="chart-title">{symbol()?.name}</h2>
        <span class={`num chart-price ${quote()?.dir < 0 ? "down" : quote()?.dir > 0 ? "up" : ""}`}>{fmtPrice(quote()?.bid ?? 0, symbol())}</span>
        <span class="small muted">
          {symbol()?.base_ccy} / {symbol()?.profit_ccy} · {spread()}
        </span>
      </div>
      <div class="chart-tools">
        <div class="group" role="group" aria-label="Timeframe">
          <For each={TIMEFRAMES}>
            {(t) => (
              <button type="button" class="btn btn-quiet" aria-pressed={tf() === t.sec} onClick={() => setTf(t.sec)}>
                {t.label}
              </button>
            )}
          </For>
        </div>
        <div class="group end">
          <button type="button" class="btn btn-quiet" aria-pressed={showMa()} onClick={() => setShowMa(!showMa())}>
            MA {MA_PERIOD}
          </button>
        </div>
      </div>
      <div class="chart-canvas" role="img" aria-label={`${symbol()?.name ?? ""} candlestick chart`}>
        <div class="chart-inner" ref={box} />
      </div>
      <Show when={loading()}>
        <p class="sr-only" role="status">
          Loading chart history
        </p>
      </Show>
    </section>
  );
}
