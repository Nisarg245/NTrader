// App-level dialogs: settings, demo deposit, new price alert, order confirmation.

import { createEffect, createSignal, Show } from "solid-js";
import { fmtPrice, MONEY_SCALE, parsePrice, scaleOf, symbolById } from "../calc";
import { prefs, setPrefs } from "../prefs";
import { addAlert, demoDeposit, placeOrder, quotes, state } from "../store";
import { openDialog, pendingOrder, setOpenDialog, setPendingOrder, setVolumeText } from "../ui";

export function Dialogs() {
  let settings!: HTMLDialogElement;
  let deposit!: HTMLDialogElement;
  let alert!: HTMLDialogElement;
  let confirm!: HTMLDialogElement;
  const [amount, setAmount] = createSignal("1000");
  const [price, setPrice] = createSignal("");
  const [note, setNote] = createSignal("");
  const [error, setError] = createSignal("");
  const symbol = () => symbolById(state.selected);

  createEffect(() => {
    const which = openDialog();
    setError("");
    if (which === "settings") settings.showModal();
    if (which === "deposit") deposit.showModal();
    if (which === "alert") {
      const s = symbol();
      const q = quotes[state.selected];
      setPrice(s && q ? (q.bid / scaleOf(s)).toFixed(s.digits) : "");
      setNote("");
      alert.showModal();
    }
  });
  createEffect(() => {
    if (pendingOrder()) confirm.showModal();
  });
  const closed = () => setOpenDialog(null);

  const submitDeposit = (e: SubmitEvent) => {
    e.preventDefault();
    const v = Number.parseFloat(amount().replace(",", "."));
    if (!(v >= 1 && v <= 1_000_000)) {
      setError("Enter an amount between 1 and 1,000,000.");
      return;
    }
    demoDeposit(Math.round(v * MONEY_SCALE));
    deposit.close();
  };
  const submitAlert = (e: SubmitEvent) => {
    e.preventDefault();
    const s = symbol();
    const at = s ? parsePrice(price(), s) : 0;
    if (!s || !at) {
      setError("Enter the price to be alerted at.");
      return;
    }
    if (at === quotes[s.id]?.bid) {
      setError("That is the current price. Enter a price above or below it.");
      return;
    }
    addAlert(s.name, at, note().trim());
    alert.close();
  };
  const submitOrder = (e: SubmitEvent) => {
    e.preventDefault();
    const p = pendingOrder();
    if (p) placeOrder(p.order);
    confirm.close();
  };

  return (
    <>
      <dialog ref={settings} aria-labelledby="settings-title" onClose={closed}>
        <form method="dialog">
          <h2 id="settings-title">Settings</h2>
          <fieldset class="fieldset">
            <legend>Theme</legend>
            <div class="radio-row">
              <label class="check">
                <input type="radio" name="theme" checked={prefs.theme === "dark"} onChange={() => setPrefs("theme", "dark")} />
                Dark
              </label>
              <label class="check">
                <input type="radio" name="theme" checked={prefs.theme === "light"} onChange={() => setPrefs("theme", "light")} />
                Light
              </label>
            </div>
          </fieldset>
          <fieldset class="fieldset">
            <legend>Colours for up / buy and down / sell</legend>
            <div class="radio-row">
              <label class="check">
                <input type="radio" name="palette" checked={prefs.palette === "blue-orange"} onChange={() => setPrefs("palette", "blue-orange")} />
                Blue and orange
              </label>
              <label class="check">
                <input type="radio" name="palette" checked={prefs.palette === "green-red"} onChange={() => setPrefs("palette", "green-red")} />
                Green and red
              </label>
            </div>
          </fieldset>
          <label class="check">
            <input type="checkbox" checked={prefs.oneClick} onChange={(e) => setPrefs("oneClick", e.currentTarget.checked)} />
            One-click trading (no confirmation before an order is sent)
          </label>
          <div class="field">
            <label for="settings-lots">Default volume (lots)</label>
            <input
              id="settings-lots"
              class="input num"
              inputmode="decimal"
              value={prefs.defaultLots}
              onChange={(e) => {
                const v = Number.parseFloat(e.currentTarget.value.replace(",", "."));
                if (v > 0) {
                  setPrefs("defaultLots", v.toFixed(2));
                  setVolumeText(v.toFixed(2));
                }
              }}
            />
          </div>
          <p class="small muted">Settings, favourites, chart tabs and drawings are saved in this browser only.</p>
          <div class="dialog-actions">
            <button type="submit" class="btn btn-primary">
              Done
            </button>
          </div>
        </form>
      </dialog>

      <dialog ref={deposit} aria-labelledby="deposit-title" onClose={closed}>
        <form onSubmit={submitDeposit}>
          <h2 id="deposit-title">Top up demo account</h2>
          <p>This adds practice money to a demo account. It is not a real payment.</p>
          <div class="field">
            <label for="deposit-amount">Amount ({state.currency})</label>
            <input id="deposit-amount" class="input num" inputmode="decimal" aria-invalid={error() ? "true" : undefined} value={amount()} onInput={(e) => setAmount(e.currentTarget.value)} />
          </div>
          <Show when={error()}>
            <p class="down" role="alert">
              {error()}
            </p>
          </Show>
          <div class="dialog-actions">
            <button type="button" class="btn btn-outline" onClick={() => deposit.close()}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary">
              Add funds
            </button>
          </div>
        </form>
      </dialog>

      <dialog ref={alert} aria-labelledby="alert-title" onClose={closed}>
        <form onSubmit={submitAlert}>
          <h2 id="alert-title">Price alert on {symbol()?.name}</h2>
          <p class="small muted">
            Current price {fmtPrice(quotes[state.selected]?.bid ?? 0, symbol())}. You are told when the bid reaches your price, even after signing in again later.
          </p>
          <div class="field">
            <label for="alert-price">Alert me at</label>
            <input id="alert-price" class="input num" inputmode="decimal" aria-invalid={error() ? "true" : undefined} value={price()} onInput={(e) => setPrice(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label for="alert-note">Note (optional)</label>
            <input id="alert-note" class="input" maxLength={80} value={note()} onInput={(e) => setNote(e.currentTarget.value)} />
          </div>
          <Show when={error()}>
            <p class="down" role="alert">
              {error()}
            </p>
          </Show>
          <div class="dialog-actions">
            <button type="button" class="btn btn-outline" onClick={() => alert.close()}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary">
              Create alert
            </button>
          </div>
        </form>
      </dialog>

      <dialog ref={confirm} aria-labelledby="confirm-title" onClose={() => setPendingOrder(null)}>
        <form onSubmit={submitOrder}>
          <h2 id="confirm-title">Send this order?</h2>
          <p class="num">{pendingOrder()?.text}</p>
          <div class="dialog-actions">
            <button type="button" class="btn btn-outline" onClick={() => confirm.close()}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary">
              Send order
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
