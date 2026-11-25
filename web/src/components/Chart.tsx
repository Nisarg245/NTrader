import {
  AreaSeries,
  CandlestickSeries,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Logical,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { fmtLots, fmtPrice, pip, scaleOf } from "../calc";
import { bollinger, ema, rsi, sma } from "../indicators";
import { prefs, setPrefs, type ChartType, type Drawing, type Point } from "../prefs";
import { onTick, quotes, requestHistory, state } from "../store";
import type { SymbolInfo } from "../types";
import { activateTab, quickTrade, setOpenDialog, volumeText } from "../ui";
import { IconCamera, IconCursor, IconEraser, IconFib, IconFullscreen, IconHLine, IconMeasure, IconRect, IconText, IconTrash, IconTrend } from "./Icons";

const TIMEFRAMES = [
  { label: "M1", sec: 60 },
  { label: "M5", sec: 300 },
  { label: "M15", sec: 900 },
  { label: "M30", sec: 1800 },
  { label: "H1", sec: 3600 },
  { label: "H4", sec: 14400 },
];
const TYPES: { label: string; type: ChartType }[] = [
  { label: "Candles", type: "candles" },
  { label: "Line", type: "line" },
  { label: "Area", type: "area" },
];
const INDICATORS = [
  { key: "ma", label: "Moving average (20)" },
  { key: "ema", label: "Exponential average (50)" },
  { key: "bb", label: "Bollinger Bands (20, 2)" },
  { key: "volume", label: "Volume (ticks)" },
  { key: "rsi", label: "RSI (14)" },
] as const;
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 1];

type Tool = "cursor" | "trend" | "hline" | "rect" | "fib" | "text" | "measure" | "erase";
const TOOLS: { tool: Tool; label: string; icon: () => unknown }[] = [
  { tool: "cursor", label: "Pointer: move and zoom the chart", icon: IconCursor },
  { tool: "trend", label: "Trend line: click two points", icon: IconTrend },
  { tool: "hline", label: "Horizontal line: click a price", icon: IconHLine },
  { tool: "fib", label: "Fibonacci retracement: click two points", icon: IconFib },
  { tool: "rect", label: "Rectangle: click two corners", icon: IconRect },
  { tool: "text", label: "Text note: click where it goes", icon: IconText },
  { tool: "measure", label: "Measure: click two points", icon: IconMeasure },
  { tool: "erase", label: "Eraser: click a drawing to remove it", icon: IconEraser },
];

interface Candle {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// The chart library draws times as UTC; shifting by the local offset shows local time.
const TZ = -new Date().getTimezoneOffset() * 60;
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function ChartPanel(props: { index: number }) {
  const tab = () => prefs.tabs[props.index];
  const tf = () => tab()?.tf ?? 900;
  const type = () => tab()?.type ?? "candles";
  const active = () => prefs.active === props.index;
  const symbol = createMemo(() => state.symbols.find((s) => s.name === tab()?.symbol));
  const quote = () => {
    const s = symbol();
    return s ? quotes[s.id] : undefined;
  };

  const [loading, setLoading] = createSignal(true);
  const [menu, setMenu] = createSignal(false);
  const [tool, setTool] = createSignal<Tool>("cursor");
  const [draft, setDraft] = createSignal<{ a: Point; b: Point } | null>(null);
  const [textAt, setTextAt] = createSignal<Point | null>(null);
  const [note, setNote] = createSignal("");
  /** Bumped whenever the chart's coordinates may have changed, to redraw the overlay. */
  const [view, setView] = createSignal(0);
  const [pane, setPane] = createSignal({ width: 0, height: 0 });
  /** A measurement is complete and stays on screen until the next click. */
  const [measured, setMeasured] = createSignal(false);

  let panel!: HTMLElement;
  let box!: HTMLDivElement;
  let overlay!: HTMLDivElement;
  let textDialog!: HTMLDialogElement;
  let chart: IChartApi | undefined;
  let main: ISeriesApi<SeriesType> | undefined;
  let studies: { series: ISeriesApi<SeriesType>; fill: () => void }[] = [];
  let data: Candle[] = [];
  let lines: IPriceLine[] = [];
  let loadId = 0;
  let frame = 0;
  let studyTimer: number | undefined;

  const redraw = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (chart) setPane(chart.paneSize(0));
      setView((v) => v + 1);
    });
  };

  // ------------------------------------------------------------- series

  const mainPoint = (c: Candle) => (type() === "candles" ? c : { time: c.time, value: c.close });

  function buildMain() {
    const s = symbol();
    if (!chart || !s) return;
    if (main) chart.removeSeries(main);
    lines = [];
    const priceFormat = { type: "price" as const, precision: s.digits, minMove: 1 / scaleOf(s) };
    if (type() === "candles") {
      main = chart.addSeries(CandlestickSeries, {
        upColor: token("--up"),
        downColor: token("--down"),
        wickUpColor: token("--up"),
        wickDownColor: token("--down"),
        borderVisible: false,
        priceLineColor: token("--muted"),
        priceFormat,
      });
    } else if (type() === "line") {
      main = chart.addSeries(LineSeries, { color: token("--text"), lineWidth: 2, priceLineColor: token("--muted"), priceFormat });
    } else {
      main = chart.addSeries(AreaSeries, { lineColor: token("--up"), topColor: token("--up") + "55", bottomColor: token("--up") + "00", lineWidth: 2, priceLineColor: token("--muted"), priceFormat });
    }
    main.setData(data.map(mainPoint) as never);
    drawTradeLines();
    redraw();
  }

  function buildStudies() {
    const s = symbol();
    if (!chart || !s) return;
    for (const st of studies) chart.removeSeries(st.series);
    studies = [];
    // Drop the panes the removed studies lived in, so new ones start from a clean stack.
    for (let i = chart.panes().length - 1; i >= 1; i--) chart.removePane(i);
    const on = prefs.indicators;
    const priceFormat = { type: "price" as const, precision: s.digits, minMove: 1 / scaleOf(s) };
    const quiet = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
    const closes = () => data.map((c) => c.close);
    const points = (values: (number | null)[]) => data.flatMap((c, i) => (values[i] === null ? [] : [{ time: c.time, value: values[i] as number }]));
    const line = (color: string, calc: () => (number | null)[], paneIndex = 0, options = {}) => {
      const series = chart!.addSeries(LineSeries, { color, lineWidth: 1, priceFormat, ...quiet, ...options }, paneIndex);
      studies.push({ series, fill: () => series.setData(points(calc())) });
    };
    if (on.ma) line(token("--indicator"), () => sma(closes(), 20));
    if (on.ema) line(token("--muted"), () => ema(closes(), 50));
    if (on.bb) {
      line(token("--edge-hover"), () => bollinger(closes(), 20, 2).upper, 0, { lineStyle: LineStyle.Dashed });
      line(token("--edge-hover"), () => bollinger(closes(), 20, 2).lower, 0, { lineStyle: LineStyle.Dashed });
    }
    let next = 1;
    if (on.volume) {
      const series = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, ...quiet }, next++);
      studies.push({
        series,
        fill: () => series.setData(data.map((c) => ({ time: c.time, value: c.volume, color: (c.close >= c.open ? token("--up") : token("--down")) + "99" }))),
      });
    }
    if (on.rsi) {
      line(token("--indicator"), () => rsi(closes(), 14), next++, { priceFormat: { type: "price", precision: 1, minMove: 0.1 }, lastValueVisible: true });
    }
    chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 5 : 1));
    studies.forEach((st) => st.fill());
    redraw();
  }

  /** Entry, stop loss and take profit of positions, pending orders, and waiting alerts. */
  function drawTradeLines() {
    const s = symbol();
    if (!main || !s) return;
    lines.forEach((l) => main!.removePriceLine(l));
    lines = [];
    const scale = scaleOf(s);
    const add = (price: number, color: string, title: string, style: LineStyle) => {
      if (price > 0) lines.push(main!.createPriceLine({ price: price / scale, color, title, lineStyle: style, lineWidth: 1, axisLabelVisible: true }));
    };
    for (const p of state.positions) {
      if (p.symbol !== s.id) continue;
      add(p.open_price, token("--text"), `${p.side} ${fmtLots(p.volume)}`, LineStyle.Dashed);
      add(p.sl, token("--down"), p.trail > 0 ? "Trailing SL" : "SL", LineStyle.Dashed);
      add(p.tp, token("--up"), "TP", LineStyle.Dashed);
    }
    for (const o of state.orders) {
      if (o.symbol === s.id) add(o.price, token("--muted"), `${o.side} ${o.kind.toLowerCase()} ${fmtLots(o.volume)}`, LineStyle.Dotted);
    }
    for (const a of state.alerts) {
      if (a.symbol === s.id && a.fired === 0) add(a.price, token("--indicator"), "Alert", LineStyle.Dotted);
    }
  }

  async function load(s: SymbolInfo, seconds: number) {
    if (!chart) return;
    const id = ++loadId;
    setLoading(true);
    const bars = await requestHistory(s, seconds);
    if (id !== loadId) return; // a newer request superseded this one
    const scale = scaleOf(s);
    data = bars.map((b) => ({ time: (b[0] + TZ) as UTCTimestamp, open: b[1] / scale, high: b[2] / scale, low: b[3] / scale, close: b[4] / scale, volume: b[5] }));
    buildMain();
    buildStudies();
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(data.length - 120, 0), to: data.length + 4 });
    setLoading(false);
    redraw();
  }

  onMount(() => {
    chart = createChart(box, {
      autoSize: true,
      layout: { background: { color: token("--ground") }, textColor: token("--muted"), fontFamily: token("--font-num"), fontSize: 14, attributionLogo: false, panes: { separatorColor: token("--line") } },
      grid: { vertLines: { color: token("--line") }, horzLines: { color: token("--line") } },
      rightPriceScale: { borderColor: token("--line") },
      timeScale: { borderColor: token("--line"), timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { labelBackgroundColor: token("--pressed") }, horzLine: { labelBackgroundColor: token("--pressed") } },
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    const resize = new ResizeObserver(redraw);
    resize.observe(box);

    const stop = onTick((id, bid, t) => {
      const s = symbol();
      if (!s || id !== s.id || !main || loading()) return;
      const price = bid / scaleOf(s);
      const time = (Math.floor(t / 1000 / tf()) * tf() + TZ) as UTCTimestamp;
      const last = data[data.length - 1];
      if (last && last.time === time) {
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        last.volume += 1;
      } else if (!last || time > last.time) {
        data.push({ time, open: price, high: price, low: price, close: price, volume: 1 });
      } else {
        return;
      }
      main.update(mainPoint(data[data.length - 1]) as never);
      // Indicators are recomputed a few times a second, not on every tick.
      studyTimer ??= window.setTimeout(() => {
        studyTimer = undefined;
        studies.forEach((st) => st.fill());
      }, 400);
      redraw();
    });

    const outside = (e: PointerEvent) => {
      if (menu() && !(e.target as Element).closest?.(".menu")) setMenu(false);
    };
    document.addEventListener("pointerdown", outside);

    onCleanup(() => {
      stop();
      resize.disconnect();
      document.removeEventListener("pointerdown", outside);
      window.clearTimeout(studyTimer);
      cancelAnimationFrame(frame);
      chart?.remove();
      chart = undefined;
    });
  });

  // Reload history when the symbol or timeframe changes, and after a reconnect.
  createEffect(
    on([symbol, tf, () => state.status], ([s, seconds, status]) => {
      if (s && status === "online") void load(s, seconds);
    }),
  );
  createEffect(on(type, buildMain, { defer: true }));
  createEffect(on(() => ({ ...prefs.indicators }), buildStudies, { defer: true }));
  createEffect(
    on(
      () => [prefs.theme, prefs.palette],
      () =>
        // Wait a frame so the new theme's colours are in effect before reading them.
        requestAnimationFrame(() => {
          if (!chart) return;
          chart.applyOptions({
            layout: { background: { color: token("--ground") }, textColor: token("--muted"), panes: { separatorColor: token("--line") } },
            grid: { vertLines: { color: token("--line") }, horzLines: { color: token("--line") } },
            rightPriceScale: { borderColor: token("--line") },
            timeScale: { borderColor: token("--line") },
            crosshair: { vertLine: { labelBackgroundColor: token("--pressed") }, horzLine: { labelBackgroundColor: token("--pressed") } },
          });
          buildMain();
          buildStudies();
        }),
      { defer: true },
    ),
  );
  createEffect(() => {
    // Touch everything the lines depend on, so they are redrawn when any of it changes.
    state.positions.forEach((p) => [p.sl, p.tp, p.volume, p.open_price, p.trail]);
    state.orders.forEach((o) => o.price);
    state.alerts.forEach((a) => a.fired);
    drawTradeLines();
  });

  // ------------------------------------------------------------ drawings

  const drawings = () => (symbol() ? (prefs.drawings[symbol()!.name] ?? []) : []);

  /** Bar position of a time, as a possibly fractional index, also outside the loaded bars. */
  const indexOf = (t: number) => {
    const n = data.length;
    if (n === 0) return null;
    const target = t + TZ;
    if (target >= data[n - 1].time) return n - 1 + (target - data[n - 1].time) / tf();
    if (target <= data[0].time) return (target - data[0].time) / tf();
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (data[mid].time <= target) lo = mid;
      else hi = mid;
    }
    return lo + (target - data[lo].time) / (data[hi].time - data[lo].time);
  };
  const xy = (p: Point) => {
    const i = indexOf(p.t);
    const x = i === null ? null : chart?.timeScale().logicalToCoordinate(i as Logical);
    const y = main?.priceToCoordinate(p.p);
    return x == null || y == null ? null : { x, y };
  };
  const pointAt = (e: PointerEvent): Point | null => {
    const r = overlay.getBoundingClientRect();
    const logical = chart?.timeScale().coordinateToLogical(e.clientX - r.left);
    const price = main?.coordinateToPrice(e.clientY - r.top);
    const n = data.length;
    if (logical == null || price == null || n === 0) return null;
    const i = Math.round(logical);
    const time = i < 0 ? data[0].time + i * tf() : i >= n ? data[n - 1].time + (i - n + 1) * tf() : data[i].time;
    return { t: time - TZ, p: price };
  };

  const save = (d: Omit<Drawing, "id">) => {
    const s = symbol();
    if (s) setPrefs("drawings", s.name, (list) => [...(list ?? []), { ...d, id: Date.now() + Math.random() }]);
  };
  const erase = (id: number) => {
    const s = symbol();
    if (s && tool() === "erase") setPrefs("drawings", s.name, (list) => (list ?? []).filter((d) => d.id !== id));
  };
  const eraseAll = () => {
    const s = symbol();
    if (s) setPrefs("drawings", s.name, []);
    setDraft(null);
  };
  const pick = (t: Tool) => {
    setTool(t);
    setDraft(null);
    setMeasured(false);
  };

  const pointerDown = (e: PointerEvent) => {
    const p = pointAt(e);
    const t = tool();
    if (!p || t === "cursor" || t === "erase") return;
    if (t === "hline") {
      save({ kind: "hline", a: p });
      pick("cursor");
    } else if (t === "text") {
      setTextAt(p);
      setNote("");
      textDialog.showModal();
    } else if (!draft() || measured()) {
      // First click of a two-point tool (or a fresh measurement).
      setMeasured(false);
      setDraft({ a: p, b: p });
    } else if (t === "measure") {
      setDraft({ a: draft()!.a, b: p });
      setMeasured(true);
    } else {
      save({ kind: t, a: draft()!.a, b: p });
      pick("cursor");
    }
  };
  const pointerMove = (e: PointerEvent) => {
    const d = draft();
    if (!d || measured()) return;
    const p = pointAt(e);
    if (p) setDraft({ a: d.a, b: p });
  };
  const saveText = (e: SubmitEvent) => {
    e.preventDefault();
    const at = textAt();
    if (at && note().trim()) save({ kind: "text", a: at, text: note().trim().slice(0, 60) });
    textDialog.close();
    pick("cursor");
  };

  const price = (p: number) => p.toFixed(symbol()?.digits ?? 2);
  const measureText = () => {
    const d = draft();
    const s = symbol();
    if (!d || !s) return "";
    const diff = d.b.p - d.a.p;
    const unit = pip(s);
    const bars = Math.round(Math.abs(d.b.t - d.a.t) / tf());
    return `${diff >= 0 ? "+" : "−"}${((Math.abs(diff) * scaleOf(s)) / unit.points).toFixed(unit.points === 10 ? 1 : 0)} ${unit.label} · ${((diff / d.a.p) * 100).toFixed(2)}% · ${bars} bars`;
  };

  /** One drawing as SVG. `view()` is read so it is redrawn when the chart moves. */
  const shape = (d: Omit<Drawing, "id">, id?: number) => {
    view();
    const a = xy(d.a);
    const b = d.b ? xy(d.b) : null;
    if (!a) return null;
    const w = pane().width;
    const hit = (path: string) => <path class="hit" d={path} onClick={() => id !== undefined && erase(id)} />;
    if (d.kind === "hline") {
      const path = `M0 ${a.y}H${w}`;
      return (
        <g>
          {hit(path)}
          <path class="shape" d={path} />
          <text x="8" y={a.y - 8}>
            {price(d.a.p)}
          </text>
        </g>
      );
    }
    if (d.kind === "text") {
      return (
        <g>
          {hit(`M${a.x} ${a.y - 8}h${(d.text?.length ?? 1) * 9}`)}
          <text class="shape-text" x={a.x} y={a.y}>
            {d.text}
          </text>
        </g>
      );
    }
    if (!b) return null;
    if (d.kind === "trend") {
      const path = `M${a.x} ${a.y}L${b.x} ${b.y}`;
      return (
        <g>
          {hit(path)}
          <path class="shape" d={path} />
        </g>
      );
    }
    if (d.kind === "rect") {
      const path = `M${a.x} ${a.y}H${b.x}V${b.y}H${a.x}Z`;
      return (
        <g>
          {hit(path)}
          <path class="shape fill" d={path} />
        </g>
      );
    }
    // Fibonacci retracement: 0% at the first point, 100% at the second.
    const left = Math.min(a.x, b.x);
    return (
      <g>
        {hit(`M${left} ${a.y}H${w}M${left} ${b.y}H${w}`)}
        <For each={FIB}>
          {(level) => {
            const y = a.y + (b.y - a.y) * level;
            return (
              <>
                <path class="shape fib" d={`M${left} ${y}H${w}`} />
                <text class="fib" x={left + 8} y={y - 4}>
                  {(level * 100).toFixed(1)}% · {price(d.a.p + (d.b!.p - d.a.p) * level)}
                </text>
              </>
            );
          }}
        </For>
      </g>
    );
  };

  // -------------------------------------------------------------- actions

  const saveImage = () => {
    chart?.takeScreenshot().toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${symbol()?.name ?? "chart"}-${TIMEFRAMES.find((t) => t.sec === tf())?.label ?? tf()}.png`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
  };
  const fullScreen = () => (document.fullscreenElement ? document.exitFullscreen() : panel.requestFullscreen?.());
  const trade = (side: "Buy" | "Sell") => {
    activateTab(props.index);
    quickTrade(side);
  };
  const keyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && (tool() !== "cursor" || menu())) {
      pick("cursor");
      setMenu(false);
    }
  };
  const spread = () => {
    const s = symbol();
    const q = quote();
    if (!s || !q || q.bid <= 0) return "";
    const p = pip(s);
    return `spread ${((q.ask - q.bid) / p.points).toFixed(p.points === 10 ? 1 : 0)} ${p.label}`;
  };
  const id = () => `chart-title-${props.index}`;

  return (
    <section class="panel chart" ref={panel} data-active={active()} aria-labelledby={id()} onPointerDown={() => !active() && activateTab(props.index)} onKeyDown={keyDown}>
      <div class="chart-head">
        <h2 id={id()}>{symbol()?.name}</h2>
        <span class={`num chart-price ${(quote()?.dir ?? 0) < 0 ? "down" : (quote()?.dir ?? 0) > 0 ? "up" : ""}`}>{fmtPrice(quote()?.bid ?? 0, symbol())}</span>
        <span class="small muted about">
          {symbol()?.base_ccy} / {symbol()?.profit_ccy} · {spread()} · swap long {symbol()?.swap_long} / short {symbol()?.swap_short}
        </span>
        <div class="quick" role="group" aria-label={`Quick trade ${symbol()?.name ?? ""}, ${volumeText()} lots at market`}>
          <button type="button" class="btn btn-quiet icon-btn" aria-label="Save chart as an image" onClick={saveImage}>
            <IconCamera />
          </button>
          <button type="button" class="btn btn-quiet icon-btn" aria-label="Full screen chart" onClick={fullScreen}>
            <IconFullscreen />
          </button>
          <button type="button" class="btn btn-trade sell" disabled={state.status !== "online"} onClick={() => trade("Sell")}>
            Sell <span class="num">{fmtPrice(quote()?.bid ?? 0, symbol())}</span>
          </button>
          <button type="button" class="btn btn-trade buy" disabled={state.status !== "online"} onClick={() => trade("Buy")}>
            Buy <span class="num">{fmtPrice(quote()?.ask ?? 0, symbol())}</span>
          </button>
        </div>
      </div>

      <div class="chart-tools">
        <div class="group" role="group" aria-label="Timeframe">
          <For each={TIMEFRAMES}>
            {(t) => (
              <button type="button" class="btn btn-quiet" aria-pressed={tf() === t.sec} onClick={() => setPrefs("tabs", props.index, "tf", t.sec)}>
                {t.label}
              </button>
            )}
          </For>
        </div>
        <div class="group" role="group" aria-label="Chart type">
          <For each={TYPES}>
            {(t) => (
              <button type="button" class="btn btn-quiet" aria-pressed={type() === t.type} onClick={() => setPrefs("tabs", props.index, "type", t.type)}>
                {t.label}
              </button>
            )}
          </For>
        </div>
        <div class="group end">
          <div class="menu">
            <button type="button" class="btn btn-outline" aria-expanded={menu()} aria-haspopup="true" onClick={() => setMenu(!menu())}>
              Indicators · {Object.values(prefs.indicators).filter(Boolean).length}
            </button>
            <Show when={menu()}>
              <div class="menu-list" role="group" aria-label="Indicators">
                <For each={INDICATORS}>
                  {(ind) => (
                    <label class="check">
                      <input type="checkbox" checked={prefs.indicators[ind.key]} onChange={(e) => setPrefs("indicators", ind.key, e.currentTarget.checked)} />
                      {ind.label}
                    </label>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <button
            type="button"
            class="btn btn-outline"
            disabled={state.status !== "online"}
            onClick={() => {
              activateTab(props.index);
              setOpenDialog("alert");
            }}
          >
            Set alert
          </button>
        </div>
      </div>

      <div class="chart-body">
        <div class="draw-tools" role="toolbar" aria-label="Drawing tools" aria-orientation="vertical">
          <For each={TOOLS}>
            {(t) => (
              <button type="button" class="btn btn-quiet icon-btn" aria-label={t.label} title={t.label} aria-pressed={tool() === t.tool} onClick={() => pick(t.tool)}>
                {t.icon() as never}
              </button>
            )}
          </For>
          <button type="button" class="btn btn-quiet icon-btn" aria-label="Delete all drawings on this symbol" title="Delete all drawings on this symbol" disabled={drawings().length === 0} onClick={eraseAll}>
            <IconTrash />
          </button>
        </div>
        <div class="chart-canvas" role="img" aria-label={`${symbol()?.name ?? ""} chart`}>
          <div class="chart-inner" ref={box} />
          <div
            class="overlay"
            ref={overlay}
            data-tool={tool() !== "cursor" && tool() !== "erase"}
            data-erase={tool() === "erase"}
            style={{ width: `${pane().width}px`, height: `${pane().height}px` }}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
          >
            <svg aria-hidden="true">
              <For each={drawings()}>{(d) => shape(d, d.id)}</For>
              <Show when={draft()}>
                {(d) => (
                  <>
                    {shape({ kind: tool() === "measure" ? "trend" : (tool() as Drawing["kind"]), a: d().a, b: d().b })}
                    <Show when={tool() === "measure" && xy(d().b)}>
                      {(at) => (
                        <text x={at().x + 8} y={at().y - 8}>
                          {(view(), measureText())}
                        </text>
                      )}
                    </Show>
                  </>
                )}
              </Show>
            </svg>
          </div>
        </div>
      </div>
      <Show when={loading()}>
        <p class="sr-only" role="status">
          Loading chart history
        </p>
      </Show>

      <dialog ref={textDialog} aria-labelledby={`${id()}-note`} onClose={() => setTextAt(null)}>
        <form onSubmit={saveText}>
          <h2 id={`${id()}-note`}>Text note on the chart</h2>
          <div class="field">
            <label for={`${id()}-note-text`}>Note (up to 60 characters)</label>
            <input id={`${id()}-note-text`} class="input" maxLength={60} value={note()} onInput={(e) => setNote(e.currentTarget.value)} />
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn btn-outline" onClick={() => textDialog.close()}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary">
              Add note
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
