import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { closePrice, fmtLots, fmtMoney, fmtPrice, fmtSigned, fmtTime, parsePrice, pip, positionProfit, scaleOf, symbolById } from "../calc";
import { cancelOrder, closePosition, deleteAlert, modifyPosition, quotes, state } from "../store";
import type { Position } from "../types";
import { setOpenDialog, setTradesTab, tradesTab, type TradesTab } from "../ui";

const tone = (v: number) => (v < 0 ? "down" : v > 0 ? "up" : "");
const REASONS = { Client: "Manual", Pending: "Pending order", StopLoss: "Stop loss", TakeProfit: "Take profit", StopOut: "Stop-out" };
type Which = "all" | "profitable" | "losing";
const WHICH: Record<Which, (profit: number) => boolean> = { all: () => true, profitable: (p) => p > 0, losing: (p) => p < 0 };

export function Trades() {
  const [editing, setEditing] = createSignal<Position | null>(null);
  const [sl, setSl] = createSignal("");
  const [tp, setTp] = createSignal("");
  const [trail, setTrail] = createSignal("");
  const [closing, setClosing] = createSignal<Which>("all");
  let modifyDialog!: HTMLDialogElement;
  let closeDialog!: HTMLDialogElement;

  const totals = createMemo(() => {
    let volume = 0;
    let swap = 0;
    let profit = 0;
    for (const p of state.positions) {
      volume += p.volume;
      swap += p.swap;
      profit += positionProfit(p);
    }
    return { volume, swap, profit };
  });
  // Newest first.
  const history = createMemo(() => [...state.deals].reverse());
  const journal = createMemo(() => [...state.journal].reverse());
  const news = createMemo(() => state.announcements.filter((a) => a.kind !== "calendar"));
  const waiting = () => state.alerts.filter((a) => a.fired === 0).length;
  const offline = () => state.status !== "online";

  const exposure = createMemo(() => {
    const rows = new Map<number, { symbol: number; buy: number; sell: number; margin: number; profit: number }>();
    for (const p of state.positions) {
      const r = rows.get(p.symbol) ?? { symbol: p.symbol, buy: 0, sell: 0, margin: 0, profit: 0 };
      if (p.side === "Buy") r.buy += p.volume;
      else r.sell += p.volume;
      r.margin += p.margin;
      r.profit += positionProfit(p) + p.swap;
      rows.set(p.symbol, r);
    }
    return [...rows.values()];
  });

  const edit = (p: Position) => {
    const s = symbolById(p.symbol);
    setEditing(p);
    setSl(p.sl && s && !p.trail ? (p.sl / scaleOf(s)).toFixed(s.digits) : "");
    setTp(p.tp && s ? (p.tp / scaleOf(s)).toFixed(s.digits) : "");
    setTrail(p.trail && s ? String(p.trail / pip(s).points) : "");
    modifyDialog.showModal();
  };
  const saveEdit = (e: SubmitEvent) => {
    e.preventDefault();
    const p = editing();
    const s = p && symbolById(p.symbol);
    if (p && s) {
      const distance = Number.parseFloat(trail().replace(",", "."));
      modifyPosition(p.id, parsePrice(sl(), s), parsePrice(tp(), s), distance > 0 ? Math.round(distance * pip(s).points) : 0);
    }
    modifyDialog.close();
  };
  const matching = () => state.positions.filter((p) => WHICH[closing()](positionProfit(p)));
  const askClose = (which: Which) => {
    setClosing(which);
    closeDialog.showModal();
  };
  const closeMany = (e: SubmitEvent) => {
    e.preventDefault();
    for (const p of matching()) closePosition(p.id);
    closeDialog.close();
  };

  const tabButton = (id: TradesTab, label: () => string) => (
    <button type="button" class="tab" role="tab" id={`tab-${id}`} aria-controls="trades-panel" aria-selected={tradesTab() === id} onClick={() => setTradesTab(id)}>
      {label()}
    </button>
  );

  return (
    <section class="trades" aria-labelledby="trades-title">
      <div class="trades-head">
        <h2 id="trades-title" class="sr-only">
          Trades
        </h2>
        <div class="tabs" role="tablist" aria-label="Trade lists">
          {tabButton("positions", () => `Positions · ${state.positions.length}`)}
          {tabButton("orders", () => `Pending orders · ${state.orders.length}`)}
          {tabButton("history", () => "History")}
          {tabButton("exposure", () => "Exposure")}
          {tabButton("alerts", () => `Alerts · ${waiting()}`)}
          {tabButton("news", () => "News")}
          {tabButton("journal", () => "Journal")}
        </div>
        <Show when={tradesTab() === "positions"}>
          <div class="tabs end">
            <button type="button" class="btn btn-outline" disabled={offline() || !state.positions.some((p) => positionProfit(p) > 0)} onClick={() => askClose("profitable")}>
              Close profitable
            </button>
            <button type="button" class="btn btn-outline" disabled={offline() || !state.positions.some((p) => positionProfit(p) < 0)} onClick={() => askClose("losing")}>
              Close losing
            </button>
            <button type="button" class="btn btn-outline" disabled={offline() || state.positions.length === 0} onClick={() => askClose("all")}>
              Close all
            </button>
          </div>
        </Show>
        <Show when={tradesTab() === "alerts"}>
          <button type="button" class="btn btn-outline end" disabled={offline()} onClick={() => setOpenDialog("alert")}>
            New alert
          </button>
        </Show>
      </div>

      <div id="trades-panel" class="table-box" role="tabpanel" aria-labelledby={`tab-${tradesTab()}`}>
        <Switch>
          <Match when={tradesTab() === "positions"}>
            <Show when={state.positions.length} fallback={<p class="empty">No open positions. Use the order ticket to open one.</p>}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Ticket</th>
                    <th scope="col">Symbol</th>
                    <th scope="col">Side</th>
                    <th scope="col">Volume</th>
                    <th scope="col">Opened</th>
                    <th scope="col">Open price</th>
                    <th scope="col">Current</th>
                    <th scope="col">Stop loss</th>
                    <th scope="col">Take profit</th>
                    <th scope="col">Swap</th>
                    <th scope="col">Profit ({state.currency})</th>
                    <th scope="col">
                      <span class="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody class="num">
                  <For each={state.positions}>
                    {(p) => {
                      const s = () => symbolById(p.symbol);
                      return (
                        <tr>
                          <td>{p.id}</td>
                          <td class="name">{s()?.name}</td>
                          <td class={p.side === "Buy" ? "up" : "down"}>{p.side}</td>
                          <td>{fmtLots(p.volume)}</td>
                          <td>{fmtTime(p.open_ts)}</td>
                          <td>{fmtPrice(p.open_price, s())}</td>
                          <td>{fmtPrice(closePrice(p), s())}</td>
                          <td>
                            {fmtPrice(p.sl, s())}
                            <Show when={p.trail > 0}>
                              <span class="small muted"> trailing</span>
                            </Show>
                          </td>
                          <td>{fmtPrice(p.tp, s())}</td>
                          <td>{fmtMoney(p.swap)}</td>
                          <td class={tone(positionProfit(p))}>
                            <strong>{fmtSigned(positionProfit(p))}</strong>
                          </td>
                          <td class="actions">
                            <span>
                              <button type="button" class="btn btn-outline" disabled={offline()} aria-label={`Modify ${s()?.name} position ${p.id}`} onClick={() => edit(p)}>
                                Modify
                              </button>
                              <button type="button" class="btn btn-outline" disabled={offline()} aria-label={`Close ${s()?.name} position ${p.id}`} onClick={() => closePosition(p.id)}>
                                Close
                              </button>
                            </span>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                  <tr class="total">
                    <td class="name muted">Total</td>
                    <td />
                    <td />
                    <td>{fmtLots(totals().volume)}</td>
                    <td />
                    <td />
                    <td />
                    <td />
                    <td />
                    <td>{fmtMoney(totals().swap)}</td>
                    <td class={tone(totals().profit)}>{fmtSigned(totals().profit)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </Show>
          </Match>

          <Match when={tradesTab() === "orders"}>
            <Show when={state.orders.length} fallback={<p class="empty">No pending orders. Choose Limit or Stop in the order ticket to place one.</p>}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Ticket</th>
                    <th scope="col">Symbol</th>
                    <th scope="col">Type</th>
                    <th scope="col">Volume</th>
                    <th scope="col">Placed</th>
                    <th scope="col">Price</th>
                    <th scope="col">Current</th>
                    <th scope="col">Stop loss</th>
                    <th scope="col">Take profit</th>
                    <th scope="col">
                      <span class="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody class="num">
                  <For each={state.orders}>
                    {(o) => {
                      const s = () => symbolById(o.symbol);
                      return (
                        <tr>
                          <td>{o.id}</td>
                          <td class="name">{s()?.name}</td>
                          <td class={o.side === "Buy" ? "up" : "down"}>
                            {o.side} {o.kind.toLowerCase()}
                          </td>
                          <td>{fmtLots(o.volume)}</td>
                          <td>{fmtTime(o.ts)}</td>
                          <td>{fmtPrice(o.price, s())}</td>
                          <td>{fmtPrice(o.side === "Buy" ? (quotes[o.symbol]?.ask ?? 0) : (quotes[o.symbol]?.bid ?? 0), s())}</td>
                          <td>{fmtPrice(o.sl, s())}</td>
                          <td>{fmtPrice(o.tp, s())}</td>
                          <td class="actions">
                            <span>
                              <button type="button" class="btn btn-outline" disabled={offline()} aria-label={`Cancel ${s()?.name} order ${o.id}`} onClick={() => cancelOrder(o.id)}>
                                Cancel
                              </button>
                            </span>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </Show>
          </Match>

          <Match when={tradesTab() === "history"}>
            <Show when={history().length} fallback={<p class="empty">No deals yet. Every fill will be listed here.</p>}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Deal</th>
                    <th scope="col">Symbol</th>
                    <th scope="col">Side</th>
                    <th scope="col">Entry</th>
                    <th scope="col">Volume</th>
                    <th scope="col">Time</th>
                    <th scope="col">Price</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Commission</th>
                    <th scope="col">Swap</th>
                    <th scope="col">Profit ({state.currency})</th>
                  </tr>
                </thead>
                <tbody class="num">
                  <For each={history()}>
                    {(d) => {
                      const s = () => symbolById(d.symbol);
                      return (
                        <tr>
                          <td>{d.id}</td>
                          <td class="name">{s()?.name}</td>
                          <td class={d.side === "Buy" ? "up" : "down"}>{d.side}</td>
                          <td>{d.entry === "In" ? "Open" : "Close"}</td>
                          <td>{fmtLots(d.volume)}</td>
                          <td>{fmtTime(d.ts)}</td>
                          <td>{fmtPrice(d.price, s())}</td>
                          <td>{REASONS[d.reason]}</td>
                          <td>{fmtMoney(-d.commission)}</td>
                          <td>{fmtMoney(d.swap)}</td>
                          <td class={tone(d.profit)}>{d.entry === "Out" ? fmtSigned(d.profit) : "—"}</td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </Show>
          </Match>

          <Match when={tradesTab() === "exposure"}>
            <Show when={exposure().length} fallback={<p class="empty">No exposure. It appears here, per symbol, once you hold positions.</p>}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Symbol</th>
                    <th scope="col">Direction</th>
                    <th scope="col">Net volume</th>
                    <th scope="col">Bought</th>
                    <th scope="col">Sold</th>
                    <th scope="col">Margin used</th>
                    <th scope="col">Floating P/L ({state.currency})</th>
                  </tr>
                </thead>
                <tbody class="num">
                  <For each={exposure()}>
                    {(r) => {
                      const net = () => r.buy - r.sell;
                      return (
                        <tr>
                          <td class="name">{symbolById(r.symbol)?.name}</td>
                          <td class={net() > 0 ? "up" : net() < 0 ? "down" : "muted"}>{net() > 0 ? "Long" : net() < 0 ? "Short" : "Flat"}</td>
                          <td>{fmtLots(Math.abs(net()))}</td>
                          <td>{fmtLots(r.buy)}</td>
                          <td>{fmtLots(r.sell)}</td>
                          <td>{fmtMoney(r.margin)}</td>
                          <td class={tone(r.profit)}>
                            <strong>{fmtSigned(r.profit)}</strong>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </Show>
          </Match>

          <Match when={tradesTab() === "alerts"}>
            <Show when={state.alerts.length} fallback={<p class="empty">No price alerts. Use New alert, or Set alert above a chart, to be told when a price is reached.</p>}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Symbol</th>
                    <th scope="col">Condition</th>
                    <th scope="col">Price</th>
                    <th scope="col">Current</th>
                    <th scope="col">Note</th>
                    <th scope="col">Created</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span class="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody class="num">
                  <For each={state.alerts}>
                    {(a) => {
                      const s = () => symbolById(a.symbol);
                      return (
                        <tr>
                          <td class="name">{s()?.name}</td>
                          <td class="name">{a.above ? "Rises to" : "Falls to"}</td>
                          <td>{fmtPrice(a.price, s())}</td>
                          <td>{fmtPrice(quotes[a.symbol]?.bid ?? 0, s())}</td>
                          <td class="name">{a.note || "—"}</td>
                          <td>{fmtTime(a.created)}</td>
                          <td class={a.fired ? "up" : "muted"}>{a.fired ? `Reached ${fmtTime(a.fired)}` : "Waiting"}</td>
                          <td class="actions">
                            <span>
                              <button type="button" class="btn btn-outline" disabled={offline()} aria-label={`Delete ${s()?.name} alert at ${fmtPrice(a.price, s())}`} onClick={() => deleteAlert(a.id)}>
                                Delete
                              </button>
                            </span>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </Show>
          </Match>

          <Match when={tradesTab() === "news"}>
            <Show when={news().length} fallback={<p class="empty">No news from your broker.</p>}>
              <ul class="news">
                <For each={news()}>
                  {(n) => (
                    <li>
                      <span>
                        <strong>{n.title}</strong> <span class="small muted">{n.time}</span>
                      </span>
                      <Show when={n.body}>
                        <span>{n.body}</span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Match>

          <Match when={tradesTab() === "journal"}>
            <Show when={journal().length} fallback={<p class="empty">Nothing has happened in this session yet.</p>}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Event</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={journal()}>
                    {(j) => (
                      <tr>
                        <td class="num">{new Date(j.ts).toLocaleTimeString("en-GB")}</td>
                        <td>{j.text}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </Match>
        </Switch>
      </div>

      <dialog ref={modifyDialog} aria-labelledby="modify-title" onClose={() => setEditing(null)}>
        <form onSubmit={saveEdit}>
          <h2 id="modify-title">
            Modify {symbolById(editing()?.symbol ?? -1)?.name} {editing()?.side.toLowerCase()} {fmtLots(editing()?.volume ?? 0)} · #{editing()?.id}
          </h2>
          <div class="field">
            <label for="modify-sl">Stop loss (leave empty for none)</label>
            <input id="modify-sl" class="input num" inputmode="decimal" value={sl()} onInput={(e) => setSl(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label for="modify-tp">Take profit (leave empty for none)</label>
            <input id="modify-tp" class="input num" inputmode="decimal" value={tp()} onInput={(e) => setTp(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label for="modify-trail">Trailing stop distance in {editing() && symbolById(editing()!.symbol) ? pip(symbolById(editing()!.symbol)!).label : "points"} (leave empty for none)</label>
            <input id="modify-trail" class="input num" inputmode="decimal" value={trail()} onInput={(e) => setTrail(e.currentTarget.value)} />
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn btn-outline" onClick={() => modifyDialog.close()}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary">
              Save
            </button>
          </div>
        </form>
      </dialog>

      <dialog ref={closeDialog} aria-labelledby="closemany-title">
        <form onSubmit={closeMany}>
          <h2 id="closemany-title">
            Close {closing() === "all" ? "all" : `the ${closing()}`} {matching().length} position{matching().length === 1 ? "" : "s"} at market?
          </h2>
          <p>
            Their floating profit right now is{" "}
            <span class={`num ${tone(matching().reduce((sum, p) => sum + positionProfit(p), 0))}`}>{fmtSigned(matching().reduce((sum, p) => sum + positionProfit(p), 0))}</span> {state.currency}. This cannot be undone.
          </p>
          <div class="dialog-actions">
            <button type="button" class="btn btn-outline" onClick={() => closeDialog.close()}>
              Keep positions
            </button>
            <button type="submit" class="btn btn-primary">
              Close {matching().length}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
