import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { closePrice, fmtLots, fmtMoney, fmtPrice, fmtSigned, fmtTime, parsePrice, positionProfit, scaleOf, symbolById } from "../calc";
import { cancelOrder, closePosition, modifyPosition, quotes, state } from "../store";
import type { Position } from "../types";

type Tab = "positions" | "orders" | "history";

const tone = (v: number) => (v < 0 ? "down" : v > 0 ? "up" : "");
const REASONS = { Client: "Manual", Pending: "Pending order", StopLoss: "Stop loss", TakeProfit: "Take profit", StopOut: "Stop-out" };

export function Trades() {
  const [tab, setTab] = createSignal<Tab>("positions");
  const [editing, setEditing] = createSignal<Position | null>(null);
  const [sl, setSl] = createSignal("");
  const [tp, setTp] = createSignal("");
  let modifyDialog!: HTMLDialogElement;
  let closeAllDialog!: HTMLDialogElement;

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
  // Newest deals first.
  const history = createMemo(() => [...state.deals].reverse());
  const offline = () => state.status !== "online";

  const edit = (p: Position) => {
    const s = symbolById(p.symbol);
    setEditing(p);
    setSl(p.sl && s ? (p.sl / scaleOf(s)).toFixed(s.digits) : "");
    setTp(p.tp && s ? (p.tp / scaleOf(s)).toFixed(s.digits) : "");
    modifyDialog.showModal();
  };
  const saveEdit = (e: SubmitEvent) => {
    e.preventDefault();
    const p = editing();
    const s = p && symbolById(p.symbol);
    if (p && s) modifyPosition(p.id, parsePrice(sl(), s), parsePrice(tp(), s));
    modifyDialog.close();
  };
  const closeAll = (e: SubmitEvent) => {
    e.preventDefault();
    for (const p of state.positions) closePosition(p.id);
    closeAllDialog.close();
  };

  return (
    <section class="trades" aria-labelledby="trades-title">
      <div class="trades-head">
        <h2 id="trades-title" class="sr-only">
          Trades
        </h2>
        <div class="tabs" role="tablist" aria-label="Trade lists">
          <button type="button" class="tab" role="tab" id="tab-positions" aria-controls="trades-panel" aria-selected={tab() === "positions"} onClick={() => setTab("positions")}>
            Positions · {state.positions.length}
          </button>
          <button type="button" class="tab" role="tab" id="tab-orders" aria-controls="trades-panel" aria-selected={tab() === "orders"} onClick={() => setTab("orders")}>
            Pending orders · {state.orders.length}
          </button>
          <button type="button" class="tab" role="tab" id="tab-history" aria-controls="trades-panel" aria-selected={tab() === "history"} onClick={() => setTab("history")}>
            History
          </button>
        </div>
        <Show when={tab() === "positions"}>
          <button type="button" class="btn btn-outline end" disabled={offline() || state.positions.length === 0} onClick={() => closeAllDialog.showModal()}>
            Close all
          </button>
        </Show>
      </div>

      <div id="trades-panel" class="table-box" role="tabpanel" aria-labelledby={`tab-${tab()}`}>
        <Switch>
          <Match when={tab() === "positions"}>
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
                          <td>{fmtPrice(p.sl, s())}</td>
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

          <Match when={tab() === "orders"}>
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

          <Match when={tab() === "history"}>
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

      <dialog ref={closeAllDialog} aria-labelledby="closeall-title">
        <form onSubmit={closeAll}>
          <h2 id="closeall-title">Close all {state.positions.length} positions at market?</h2>
          <p>
            Floating profit right now is <span class={`num ${tone(totals().profit)}`}>{fmtSigned(totals().profit)}</span> {state.currency}. This cannot be undone.
          </p>
          <div class="dialog-actions">
            <button type="button" class="btn btn-outline" onClick={() => closeAllDialog.close()}>
              Keep positions
            </button>
            <button type="submit" class="btn btn-primary">
              Close all
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
