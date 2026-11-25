import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { createStore } from "solid-js/store";
import { api, setToken, token, type Account, type AccountDetail, type Group, type Order, type Position, type Summary, type SymbolRow } from "./api";

type View = "dashboard" | "accounts" | "positions" | "orders" | "groups" | "symbols";
const VIEWS: { id: View; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "accounts", label: "Accounts" },
  { id: "positions", label: "Positions" },
  { id: "orders", label: "Pending orders" },
  { id: "groups", label: "Groups" },
  { id: "symbols", label: "Symbols" },
];

// ------------------------------------------------------------- formatting

const moneyFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (micros: number) => moneyFmt.format(micros / 1_000_000).replace("-", "−");
const signed = (micros: number) => (micros > 0 ? "+" : "") + money(micros);
const lots = (volume: number) => (volume / 10_000).toFixed(2);
const tone = (v: number) => (v < 0 ? "down" : v > 0 ? "up" : "");
const timeFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const time = (ts: number) => timeFmt.format(ts).replace(",", "");
const num = (text: string) => Number.parseFloat(String(text).replace(",", "."));

const emptyGroup: Group = { name: "", currency: "USD", mode: "Hedging", leverage: 100, margin_call_pct: 100, stop_out_pct: 50, commission_per_lot: 0, demo: false };
const emptySymbol = {
  name: "",
  category: "Forex",
  digits: "5",
  contract_size: "100000",
  base_ccy: "",
  profit_ccy: "USD",
  calc: "Forex" as SymbolRow["calc"],
  margin_pct: "100",
  vol_min: "0.01",
  vol_max: "100",
  vol_step: "0.01",
  swap_long: "0",
  swap_short: "0",
  trade_enabled: true,
};

export function Admin() {
  const [view, setView] = createSignal<View>("dashboard");
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [summary, setSummary] = createSignal<Summary | null>(null);
  const [accounts, setAccounts] = createSignal<Account[]>([]);
  const [positions, setPositions] = createSignal<Position[]>([]);
  const [orders, setOrders] = createSignal<Order[]>([]);
  const [groups, setGroups] = createSignal<Group[]>([]);
  const [symbols, setSymbols] = createSignal<SymbolRow[]>([]);
  const [search, setSearch] = createSignal("");
  const [groupFilter, setGroupFilter] = createSignal("");

  const symbol = (id: number) => symbols().find((s) => s.id === id);
  const price = (p: number, id: number) => {
    const s = symbol(id);
    return s && p > 0 ? (p / 10 ** s.digits).toFixed(s.digits) : "—";
  };

  // Errors from the background refresh and from the user's own actions are kept
  // apart, so a successful refresh never wipes the reason an action was refused.
  let errorFrom: "refresh" | "action" | "" = "";
  const fail = (e: unknown, from: "refresh" | "action") => {
    errorFrom = from;
    setError(e instanceof Error ? e.message : String(e));
  };

  /** A background refresh: shows a failure, and clears it again once a refresh works. */
  async function refresh<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      const result = await work();
      if (errorFrom === "refresh") setError("");
      return result;
    } catch (e) {
      if (errorFrom !== "action") fail(e, "refresh");
      return undefined;
    }
  }

  /** Something the manager asked for: shows why it was refused, or a short confirmation. */
  async function run<T>(work: () => Promise<T>, done?: string): Promise<T | undefined> {
    errorFrom = "";
    setError("");
    try {
      const result = await work();
      if (done) {
        setNotice(done);
        window.setTimeout(() => setNotice((n) => (n === done ? "" : n)), 5000);
      }
      return result;
    } catch (e) {
      fail(e, "action");
      return undefined;
    }
  }

  async function load(v: View) {
    await refresh(async () => {
      if (v === "dashboard") setSummary(await api<Summary>("GET", "/summary"));
      if (v === "accounts") {
        const q = new URLSearchParams({ search: search(), group: groupFilter(), limit: "500" });
        setAccounts(await api<Account[]>("GET", `/accounts?${q}`));
      }
      if (v === "positions") setPositions(await api<Position[]>("GET", "/positions"));
      if (v === "orders") setOrders(await api<Order[]>("GET", "/orders"));
      if (v === "groups" || v === "accounts") setGroups(await api<Group[]>("GET", "/groups"));
      if (v !== "groups" && v !== "dashboard") setSymbols(await api<SymbolRow[]>("GET", "/symbols"));
    });
  }

  // Load the visible page now and every three seconds while it is shown.
  createEffect(
    on([view, token, search, groupFilter], ([v, t]) => {
      if (!t) return;
      void load(v);
      const timer = window.setInterval(() => void load(v), 3000);
      onCleanup(() => window.clearInterval(timer));
    }),
  );

  // ---------------------------------------------------------------- login

  const [loginName, setLoginName] = createSignal("");
  const [loginPassword, setLoginPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const signIn = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    const result = await run(() => api<{ token: string }>("POST", "/login", { login: loginName(), password: loginPassword() }));
    setBusy(false);
    if (result) {
      setLoginPassword("");
      setToken(result.token);
    }
  };
  const signOut = async () => {
    await api("POST", "/logout").catch(() => undefined);
    setToken("");
  };

  // --------------------------------------------------------------- groups

  let groupDialog!: HTMLDialogElement;
  const [group, setGroup] = createStore({ ...emptyGroup, commission: "0", isNew: true });
  const editGroup = (g?: Group) => {
    setGroup({ ...(g ?? emptyGroup), commission: ((g?.commission_per_lot ?? 0) / 1_000_000).toFixed(2), isNew: !g });
    groupDialog.showModal();
  };
  const saveGroup = async (e: SubmitEvent) => {
    e.preventDefault();
    const { commission, isNew, ...spec } = group;
    const body: Group = { ...spec, leverage: Number(spec.leverage), margin_call_pct: Number(spec.margin_call_pct), stop_out_pct: Number(spec.stop_out_pct), commission_per_lot: Math.round(num(commission) * 1_000_000) };
    const ok = await run(() => (isNew ? api("POST", "/groups", body) : api("PUT", `/groups/${encodeURIComponent(body.name)}`, body)), `Group ${body.name} saved.`);
    if (ok) {
      groupDialog.close();
      void load("groups");
    }
  };

  // -------------------------------------------------------------- symbols

  let symbolDialog!: HTMLDialogElement;
  const [sym, setSym] = createStore({ ...emptySymbol, isNew: true });
  const editSymbol = (s?: SymbolRow) => {
    setSym(
      s
        ? {
            name: s.name,
            category: s.category,
            digits: String(s.digits),
            contract_size: String(s.contract_size),
            base_ccy: s.base_ccy,
            profit_ccy: s.profit_ccy,
            calc: s.calc,
            margin_pct: String(s.margin_rate_bp / 100),
            vol_min: lots(s.vol_min),
            vol_max: lots(s.vol_max),
            vol_step: lots(s.vol_step),
            swap_long: String(s.swap_long),
            swap_short: String(s.swap_short),
            trade_enabled: s.trade_enabled,
            isNew: false,
          }
        : { ...emptySymbol, isNew: true },
    );
    symbolDialog.showModal();
  };
  const saveSymbol = async (e: SubmitEvent) => {
    e.preventDefault();
    const body = {
      name: sym.name.trim(),
      category: sym.category.trim(),
      digits: Number(sym.digits),
      contract_size: Number(sym.contract_size),
      base_ccy: sym.base_ccy.trim().toUpperCase(),
      profit_ccy: sym.profit_ccy.trim().toUpperCase(),
      calc: sym.calc,
      margin_rate_bp: Math.round(num(sym.margin_pct) * 100),
      vol_min: Math.round(num(sym.vol_min) * 10_000),
      vol_max: Math.round(num(sym.vol_max) * 10_000),
      vol_step: Math.round(num(sym.vol_step) * 10_000),
      swap_long: Math.round(num(sym.swap_long)),
      swap_short: Math.round(num(sym.swap_short)),
      trade_enabled: sym.trade_enabled,
    };
    const ok = await run(() => (sym.isNew ? api("POST", "/symbols", body) : api("PUT", `/symbols/${encodeURIComponent(body.name)}`, body)), `Symbol ${body.name} saved.`);
    if (ok) {
      symbolDialog.close();
      void load("symbols");
    }
  };

  // ------------------------------------------------------------- accounts

  let newAccountDialog!: HTMLDialogElement;
  let accountDialog!: HTMLDialogElement;
  const [fresh, setFresh] = createStore({ id: "", group: "", name: "", password: "", leverage: "", deposit: "" });
  const [detail, setDetail] = createSignal<AccountDetail | null>(null);
  const [edit, setEdit] = createStore({ name: "", leverage: "", amount: "", comment: "", password: "" });
  let detailTimer: number | undefined;

  const newAccount = () => {
    setFresh({ id: "", group: groups()[0]?.name ?? "", name: "", password: "", leverage: "", deposit: "" });
    newAccountDialog.showModal();
  };
  const createAccount = async (e: SubmitEvent) => {
    e.preventDefault();
    const body = {
      id: fresh.id ? Number(fresh.id) : 0,
      group: fresh.group,
      name: fresh.name,
      password: fresh.password,
      leverage: fresh.leverage ? Number(fresh.leverage) : 0,
      deposit: fresh.deposit ? Math.round(num(fresh.deposit) * 1_000_000) : 0,
    };
    const created = await run(() => api<Account>("POST", "/accounts", body));
    if (created) {
      newAccountDialog.close();
      setNotice(`Account ${created.id} created.`);
      void load("accounts");
    }
  };

  const refreshDetail = async (id: number) => {
    const d = await refresh(() => api<AccountDetail>("GET", `/accounts/${id}`));
    if (d) setDetail(d);
    return d;
  };
  const openAccount = async (id: number) => {
    const d = await refreshDetail(id);
    if (!d) return;
    setEdit({ name: d.account.name, leverage: String(d.account.leverage), amount: "", comment: "", password: "" });
    accountDialog.showModal();
    window.clearInterval(detailTimer);
    detailTimer = window.setInterval(() => void refreshDetail(id), 3000);
  };
  const closeAccount = () => {
    window.clearInterval(detailTimer);
    setDetail(null);
    void load(view());
  };
  onCleanup(() => window.clearInterval(detailTimer));
  const id = () => detail()!.account.id;
  const saveAccount = async (e: SubmitEvent) => {
    e.preventDefault();
    await run(() => api("PATCH", `/accounts/${id()}`, { name: edit.name, leverage: Number(edit.leverage) }), "Account saved.");
    void refreshDetail(id());
  };
  const setEnabled = async (enabled: boolean) => {
    await run(() => api("PATCH", `/accounts/${id()}`, { enabled }), enabled ? "Account enabled." : "Account disabled: it can no longer sign in or trade.");
    void refreshDetail(id());
  };
  const moveMoney = async (sign: 1 | -1) => {
    const amount = Math.round(num(edit.amount) * 1_000_000);
    if (!(amount > 0)) {
      fail("Enter an amount above zero.", "action");
      return;
    }
    const ok = await run(() => api("POST", `/accounts/${id()}/balance`, { amount: sign * amount, comment: edit.comment }), sign > 0 ? "Deposit booked." : "Withdrawal booked.");
    if (ok) setEdit({ amount: "", comment: "" });
    void refreshDetail(id());
  };
  const resetPassword = async () => {
    const ok = await run(() => api("POST", `/accounts/${id()}/password`, { password: edit.password }), "Password changed.");
    if (ok) setEdit("password", "");
  };

  const closePosition = async (p: Position) => {
    await run(() => api("POST", `/positions/${p.id}/close`), `Position ${p.id} closed at market.`);
    if (detail()) void refreshDetail(id());
    else void load("positions");
  };
  const cancelOrder = async (o: Order) => {
    await run(() => api("DELETE", `/orders/${o.id}`), `Order ${o.id} cancelled.`);
    if (detail()) void refreshDetail(id());
    else void load("orders");
  };

  // ---------------------------------------------------------- table parts

  const positionRows = (list: Position[], withAccount: boolean) => (
    <table>
      <thead>
        <tr>
          <th scope="col">Ticket</th>
          <th scope="col">Symbol</th>
          <Show when={withAccount}>
            <th scope="col">Account</th>
          </Show>
          <th scope="col">Side</th>
          <th scope="col">Volume</th>
          <th scope="col">Opened</th>
          <th scope="col">Open price</th>
          <th scope="col">Stop loss</th>
          <th scope="col">Take profit</th>
          <th scope="col">Profit</th>
          <th scope="col">
            <span class="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody class="num">
        <For each={list}>
          {(p) => (
            <tr>
              <td>{p.id}</td>
              <td class="name">{symbol(p.symbol)?.name}</td>
              <Show when={withAccount}>
                <td>
                  <button type="button" class="btn btn-quiet num" onClick={() => void openAccount(p.account)}>
                    {p.account}
                  </button>
                </td>
              </Show>
              <td class={p.side === "Buy" ? "up" : "down"}>{p.side}</td>
              <td>{lots(p.volume)}</td>
              <td>{time(p.open_ts)}</td>
              <td>{price(p.open_price, p.symbol)}</td>
              <td>
                {price(p.sl, p.symbol)}
                {p.trail > 0 ? " trailing" : ""}
              </td>
              <td>{price(p.tp, p.symbol)}</td>
              <td class={tone(p.profit)}>
                <strong>{signed(p.profit)}</strong> {p.currency}
              </td>
              <td class="actions">
                <span>
                  <button type="button" class="btn btn-outline" aria-label={`Close position ${p.id} at market`} onClick={() => void closePosition(p)}>
                    Close
                  </button>
                </span>
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );

  const orderRows = (list: Order[], withAccount: boolean) => (
    <table>
      <thead>
        <tr>
          <th scope="col">Ticket</th>
          <th scope="col">Symbol</th>
          <Show when={withAccount}>
            <th scope="col">Account</th>
          </Show>
          <th scope="col">Type</th>
          <th scope="col">Volume</th>
          <th scope="col">Placed</th>
          <th scope="col">Price</th>
          <th scope="col">Stop loss</th>
          <th scope="col">Take profit</th>
          <th scope="col">
            <span class="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody class="num">
        <For each={list}>
          {(o) => (
            <tr>
              <td>{o.id}</td>
              <td class="name">{symbol(o.symbol)?.name}</td>
              <Show when={withAccount}>
                <td>
                  <button type="button" class="btn btn-quiet num" onClick={() => void openAccount(o.account)}>
                    {o.account}
                  </button>
                </td>
              </Show>
              <td class={o.side === "Buy" ? "up" : "down"}>
                {o.side} {o.kind.toLowerCase()}
              </td>
              <td>{lots(o.volume)}</td>
              <td>{time(o.ts)}</td>
              <td>{price(o.price, o.symbol)}</td>
              <td>{price(o.sl, o.symbol)}</td>
              <td>{price(o.tp, o.symbol)}</td>
              <td class="actions">
                <span>
                  <button type="button" class="btn btn-outline" aria-label={`Cancel order ${o.id}`} onClick={() => void cancelOrder(o)}>
                    Cancel
                  </button>
                </span>
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );

  const field = (label: string, id: string, value: () => string, set: (v: string) => void, extra: Record<string, unknown> = {}) => (
    <div class="field">
      <label for={id}>{label}</label>
      <input id={id} class="input" value={value()} onInput={(e) => set(e.currentTarget.value)} {...extra} />
    </div>
  );

  // ------------------------------------------------------------------ view

  return (
    <Show
      when={token()}
      fallback={
        <main class="login">
          <form onSubmit={signIn}>
            <h1 class="brand">NTrader Manager</h1>
            {field("Manager login", "m-login", loginName, setLoginName, { autocomplete: "username", required: true })}
            {field("Password", "m-password", loginPassword, setLoginPassword, { type: "password", autocomplete: "current-password", required: true })}
            <Show when={error()}>
              <p class="error" role="alert">
                {error()}
              </p>
            </Show>
            <button type="submit" class="btn btn-primary" disabled={busy()}>
              {busy() ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </main>
      }
    >
      <div class="admin">
        <header class="admin-nav">
          <span class="brand">
            NTrader <span>Manager</span>
          </span>
          <nav class="tabs" aria-label="Sections">
            <For each={VIEWS}>
              {(v) => (
                <button type="button" class="tab" aria-current={view() === v.id ? "page" : undefined} onClick={() => setView(v.id)}>
                  {v.label}
                </button>
              )}
            </For>
          </nav>
          <div class="end">
            <a href="/">Web Trader</a>
            <button type="button" class="btn" onClick={() => void signOut()}>
              Log out
            </button>
          </div>
        </header>

        <main class="page">
          <Show when={error()}>
            <p class="alert" role="alert">
              {error()}
            </p>
          </Show>
          <Show when={notice()}>
            <p class="small up" role="status">
              {notice()}
            </p>
          </Show>

          <Switch>
            <Match when={view() === "dashboard"}>
              <div class="page-head">
                <h1>Dashboard</h1>
              </div>
              <dl class="tiles">
                <div class="card tile">
                  <dt>Accounts</dt>
                  <dd class="num">{summary()?.accounts ?? "—"}</dd>
                </div>
                <div class="card tile">
                  <dt>Open positions</dt>
                  <dd class="num">{summary()?.positions ?? "—"}</dd>
                </div>
                <div class="card tile">
                  <dt>Pending orders</dt>
                  <dd class="num">{summary()?.orders ?? "—"}</dd>
                </div>
              </dl>
              <section class="card" aria-labelledby="totals-title">
                <h2 id="totals-title">Client money by currency</h2>
                <div class="table-box">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Currency</th>
                        <th scope="col">Accounts</th>
                        <th scope="col">Balance</th>
                        <th scope="col">Equity</th>
                        <th scope="col">Margin in use</th>
                        <th scope="col">Clients' floating P/L</th>
                        <th scope="col">Broker's B-book result</th>
                      </tr>
                    </thead>
                    <tbody class="num">
                      <For each={summary()?.totals ?? []}>
                        {(t) => (
                          <tr>
                            <td class="name">{t.currency}</td>
                            <td>{t.accounts}</td>
                            <td>{money(t.balance)}</td>
                            <td>{money(t.equity)}</td>
                            <td>{money(t.margin)}</td>
                            <td class={tone(t.floating)}>{signed(t.floating)}</td>
                            <td class={tone(-t.floating)}>
                              <strong>{signed(-t.floating)}</strong>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </section>
              <section class="card" aria-labelledby="exposure-title">
                <h2 id="exposure-title">Exposure by symbol (lots)</h2>
                <div class="table-box">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Symbol</th>
                        <th scope="col">Positions</th>
                        <th scope="col">Clients bought</th>
                        <th scope="col">Clients sold</th>
                        <th scope="col">Clients' net</th>
                        <th scope="col">Broker's net</th>
                      </tr>
                    </thead>
                    <tbody class="num">
                      <For each={summary()?.exposure ?? []}>
                        {(x) => {
                          const net = x.buy_volume - x.sell_volume;
                          const side = (v: number) => (v > 0 ? "Long " : v < 0 ? "Short " : "");
                          return (
                            <tr>
                              <td class="name">{x.symbol}</td>
                              <td>{x.positions}</td>
                              <td>{lots(x.buy_volume)}</td>
                              <td>{lots(x.sell_volume)}</td>
                              <td>
                                {side(net)}
                                {lots(Math.abs(net))}
                              </td>
                              <td>
                                <strong>
                                  {side(-net)}
                                  {lots(Math.abs(net))}
                                </strong>
                              </td>
                            </tr>
                          );
                        }}
                      </For>
                    </tbody>
                  </table>
                </div>
              </section>
            </Match>

            <Match when={view() === "accounts"}>
              <div class="page-head">
                <h1>Accounts</h1>
                <div class="end">
                  <label for="acc-search" class="sr-only">
                    Search by account number or name
                  </label>
                  <input id="acc-search" class="input" type="search" placeholder="Number or name" value={search()} onInput={(e) => setSearch(e.currentTarget.value)} />
                  <label for="acc-group" class="sr-only">
                    Group
                  </label>
                  <select id="acc-group" class="input" value={groupFilter()} onChange={(e) => setGroupFilter(e.currentTarget.value)}>
                    <option value="">All groups</option>
                    <For each={groups()}>{(g) => <option value={g.name}>{g.name}</option>}</For>
                  </select>
                  <button type="button" class="btn btn-primary" onClick={newAccount}>
                    New account
                  </button>
                </div>
              </div>
              <div class="card table-box">
                <Show when={accounts().length} fallback={<p class="empty">No account matches. Clear the search, or create one with New account.</p>}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Account</th>
                        <th scope="col">Name</th>
                        <th scope="col">Group</th>
                        <th scope="col">Leverage</th>
                        <th scope="col">Balance</th>
                        <th scope="col">Equity</th>
                        <th scope="col">Margin</th>
                        <th scope="col">Margin level</th>
                        <th scope="col">Positions</th>
                        <th scope="col">Status</th>
                        <th scope="col">
                          <span class="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody class="num">
                      <For each={accounts()}>
                        {(a) => (
                          <tr>
                            <td>{a.id}</td>
                            <td class="name">{a.name}</td>
                            <td class="name">{a.group}</td>
                            <td>1:{a.leverage}</td>
                            <td>
                              {money(a.balance)} {a.currency}
                            </td>
                            <td>{money(a.equity)}</td>
                            <td>{money(a.margin)}</td>
                            <td>{a.margin > 0 ? `${a.margin_level}%` : "—"}</td>
                            <td>{a.positions}</td>
                            <td class={`name ${a.enabled ? "status-on" : "status-off"}`}>{a.enabled ? "Active" : "Disabled"}</td>
                            <td class="actions">
                              <span>
                                <button type="button" class="btn btn-outline" aria-label={`Open account ${a.id}`} onClick={() => void openAccount(a.id)}>
                                  Open
                                </button>
                              </span>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </div>
            </Match>

            <Match when={view() === "positions"}>
              <div class="page-head">
                <h1>Positions</h1>
                <span class="muted">{positions().length} open across all accounts</span>
              </div>
              <div class="card table-box">
                <Show when={positions().length} fallback={<p class="empty">No client has an open position.</p>}>
                  {positionRows(positions(), true)}
                </Show>
              </div>
            </Match>

            <Match when={view() === "orders"}>
              <div class="page-head">
                <h1>Pending orders</h1>
                <span class="muted">{orders().length} waiting across all accounts</span>
              </div>
              <div class="card table-box">
                <Show when={orders().length} fallback={<p class="empty">No client has a pending order.</p>}>
                  {orderRows(orders(), true)}
                </Show>
              </div>
            </Match>

            <Match when={view() === "groups"}>
              <div class="page-head">
                <h1>Groups</h1>
                <div class="end">
                  <button type="button" class="btn btn-primary" onClick={() => editGroup()}>
                    New group
                  </button>
                </div>
              </div>
              <div class="card table-box">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Group</th>
                      <th scope="col">Currency</th>
                      <th scope="col">Accounting</th>
                      <th scope="col">Default leverage</th>
                      <th scope="col">Margin call</th>
                      <th scope="col">Stop-out</th>
                      <th scope="col">Commission per lot</th>
                      <th scope="col">Type</th>
                      <th scope="col">
                        <span class="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody class="num">
                    <For each={groups()}>
                      {(g) => (
                        <tr>
                          <td class="name">{g.name}</td>
                          <td class="name">{g.currency}</td>
                          <td>{g.mode}</td>
                          <td>1:{g.leverage}</td>
                          <td>{g.margin_call_pct}%</td>
                          <td>{g.stop_out_pct}%</td>
                          <td>{money(g.commission_per_lot)}</td>
                          <td>{g.demo ? "Demo" : "Live"}</td>
                          <td class="actions">
                            <span>
                              <button type="button" class="btn btn-outline" aria-label={`Edit group ${g.name}`} onClick={() => editGroup(g)}>
                                Edit
                              </button>
                            </span>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Match>

            <Match when={view() === "symbols"}>
              <div class="page-head">
                <h1>Symbols</h1>
                <div class="end">
                  <button type="button" class="btn btn-primary" onClick={() => editSymbol()}>
                    New symbol
                  </button>
                </div>
              </div>
              <div class="card table-box">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Symbol</th>
                      <th scope="col">Group</th>
                      <th scope="col">Bid</th>
                      <th scope="col">Ask</th>
                      <th scope="col">Contract</th>
                      <th scope="col">Margin</th>
                      <th scope="col">Volume min / step / max</th>
                      <th scope="col">Swap long / short</th>
                      <th scope="col">Trading</th>
                      <th scope="col">
                        <span class="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody class="num">
                    <For each={symbols()}>
                      {(s) => (
                        <tr>
                          <td class="name">{s.name}</td>
                          <td class="name">{s.category || "—"}</td>
                          <td>{price(s.bid, s.id)}</td>
                          <td>{price(s.ask, s.id)}</td>
                          <td>
                            {s.contract_size.toLocaleString("en-US")} {s.base_ccy}
                          </td>
                          <td>
                            {s.calc} · {s.margin_rate_bp / 100}%
                          </td>
                          <td>
                            {lots(s.vol_min)} / {lots(s.vol_step)} / {lots(s.vol_max)}
                          </td>
                          <td>
                            {s.swap_long} / {s.swap_short}
                          </td>
                          <td class={`name ${s.trade_enabled ? "status-on" : "status-off"}`}>{s.trade_enabled ? "On" : "Off"}</td>
                          <td class="actions">
                            <span>
                              <button type="button" class="btn btn-outline" aria-label={`Edit symbol ${s.name}`} onClick={() => editSymbol(s)}>
                                Edit
                              </button>
                            </span>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <p class="small muted">A new symbol has no prices until a feed quotes it, and traders see it after they sign in again.</p>
            </Match>
          </Switch>
        </main>
      </div>

      {/* ------------------------------------------------------------ dialogs */}

      <dialog ref={groupDialog} aria-labelledby="group-title">
        <form onSubmit={saveGroup}>
          <h2 id="group-title">{group.isNew ? "New group" : `Group ${group.name}`}</h2>
          <div class="form-grid">
            {field("Name", "g-name", () => group.name, (v) => setGroup("name", v), { required: true, disabled: !group.isNew })}
            {field("Currency", "g-ccy", () => group.currency, (v) => setGroup("currency", v.toUpperCase()), { required: true, maxLength: 5, disabled: !group.isNew })}
            <div class="field">
              <label for="g-mode">Accounting</label>
              <select id="g-mode" class="input" value={group.mode} disabled={!group.isNew} onChange={(e) => setGroup("mode", e.currentTarget.value as Group["mode"])}>
                <option value="Hedging">Hedging (many positions per symbol)</option>
                <option value="Netting">Netting (one position per symbol)</option>
              </select>
            </div>
            {field("Default leverage (1:x)", "g-lev", () => String(group.leverage), (v) => setGroup("leverage", Number(v) || 0), { inputmode: "numeric", required: true })}
            {field("Margin call level (%)", "g-mc", () => String(group.margin_call_pct), (v) => setGroup("margin_call_pct", Number(v) || 0), { inputmode: "numeric" })}
            {field("Stop-out level (%)", "g-so", () => String(group.stop_out_pct), (v) => setGroup("stop_out_pct", Number(v) || 0), { inputmode: "numeric" })}
            {field(`Commission per lot, per deal (${group.currency})`, "g-comm", () => group.commission, (v) => setGroup("commission", v), { inputmode: "decimal" })}
          </div>
          <label class="check">
            <input type="checkbox" checked={group.demo} onChange={(e) => setGroup("demo", e.currentTarget.checked)} />
            Demo group (traders can top up their own balance)
          </label>
          <Show when={!group.isNew}>
            <p class="small muted">Name, currency and accounting cannot change. New margin call and stop-out levels apply to open positions at once.</p>
          </Show>
          <Show when={error()}>
            <p class="down" role="alert">
              {error()}
            </p>
          </Show>
          <div class="dialog-actions">
            <button type="button" class="btn btn-outline" onClick={() => groupDialog.close()}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary">
              Save group
            </button>
          </div>
        </form>
      </dialog>

      <dialog ref={symbolDialog} class="wide" aria-labelledby="symbol-title">
        <form onSubmit={saveSymbol}>
          <h2 id="symbol-title">{sym.isNew ? "New symbol" : `Symbol ${sym.name}`}</h2>
          <div class="form-grid">
            {field("Name", "s-name", () => sym.name, (v) => setSym("name", v), { required: true, disabled: !sym.isNew })}
            {field("Market Watch group", "s-cat", () => sym.category, (v) => setSym("category", v))}
            {field("Digits after the decimal point", "s-digits", () => sym.digits, (v) => setSym("digits", v), { inputmode: "numeric", disabled: !sym.isNew })}
            {field("Contract size (units per lot)", "s-contract", () => sym.contract_size, (v) => setSym("contract_size", v), { inputmode: "numeric", disabled: !sym.isNew })}
            {field("Base currency", "s-base", () => sym.base_ccy, (v) => setSym("base_ccy", v), { required: true, maxLength: 8, disabled: !sym.isNew })}
            {field("Profit currency", "s-profit", () => sym.profit_ccy, (v) => setSym("profit_ccy", v), { required: true, maxLength: 8, disabled: !sym.isNew })}
            <div class="field">
              <label for="s-calc">Margin calculation</label>
              <select id="s-calc" class="input" value={sym.calc} disabled={!sym.isNew} onChange={(e) => setSym("calc", e.currentTarget.value as SymbolRow["calc"])}>
                <option value="Forex">Forex: lots × contract ÷ leverage</option>
                <option value="CfdLeverage">CFD with leverage: lots × contract × price ÷ leverage</option>
                <option value="Cfd">CFD: lots × contract × price</option>
              </select>
            </div>
            {field("Margin rate (%)", "s-margin", () => sym.margin_pct, (v) => setSym("margin_pct", v), { inputmode: "decimal" })}
            {field("Minimum volume (lots)", "s-min", () => sym.vol_min, (v) => setSym("vol_min", v), { inputmode: "decimal" })}
            {field("Volume step (lots)", "s-step", () => sym.vol_step, (v) => setSym("vol_step", v), { inputmode: "decimal" })}
            {field("Maximum volume (lots)", "s-max", () => sym.vol_max, (v) => setSym("vol_max", v), { inputmode: "decimal" })}
            {field("Swap long (points per lot per day)", "s-swl", () => sym.swap_long, (v) => setSym("swap_long", v), { inputmode: "numeric" })}
            {field("Swap short (points per lot per day)", "s-sws", () => sym.swap_short, (v) => setSym("swap_short", v), { inputmode: "numeric" })}
          </div>
          <label class="check">
            <input type="checkbox" checked={sym.trade_enabled} onChange={(e) => setSym("trade_enabled", e.currentTarget.checked)} />
            Trading enabled
          </label>
          <Show when={error()}>
            <p class="down" role="alert">
              {error()}
            </p>
          </Show>
          <div class="dialog-actions">
            <button type="button" class="btn btn-outline" onClick={() => symbolDialog.close()}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary">
              Save symbol
            </button>
          </div>
        </form>
      </dialog>

      <dialog ref={newAccountDialog} aria-labelledby="new-account-title">
        <form onSubmit={createAccount}>
          <h2 id="new-account-title">New account</h2>
          <div class="field">
            <label for="a-group">Group</label>
            <select id="a-group" class="input" value={fresh.group} onChange={(e) => setFresh("group", e.currentTarget.value)}>
              <For each={groups()}>
                {(g) => (
                  <option value={g.name}>
                    {g.name} · {g.currency} · {g.mode}
                  </option>
                )}
              </For>
            </select>
          </div>
          {field("Name", "a-name", () => fresh.name, (v) => setFresh("name", v), { required: true })}
          {field("Password (at least 8 characters)", "a-password", () => fresh.password, (v) => setFresh("password", v), { type: "password", autocomplete: "new-password", required: true, minLength: 8 })}
          <div class="form-grid">
            {field("Account number (empty = next free)", "a-id", () => fresh.id, (v) => setFresh("id", v), { inputmode: "numeric" })}
            {field("Leverage (empty = group default)", "a-lev", () => fresh.leverage, (v) => setFresh("leverage", v), { inputmode: "numeric" })}
          </div>
          {field("Opening deposit (optional)", "a-deposit", () => fresh.deposit, (v) => setFresh("deposit", v), { inputmode: "decimal" })}
          <Show when={error()}>
            <p class="down" role="alert">
              {error()}
            </p>
          </Show>
          <div class="dialog-actions">
            <button type="button" class="btn btn-outline" onClick={() => newAccountDialog.close()}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary">
              Create account
            </button>
          </div>
        </form>
      </dialog>

      <dialog ref={accountDialog} class="wide" aria-labelledby="account-title" onClose={closeAccount}>
        <Show when={detail()}>
          {(d) => (
            <form onSubmit={saveAccount}>
              <h2 id="account-title">
                Account <span class="num">{d().account.id}</span> · {d().account.name} · <span class={d().account.enabled ? "status-on" : "status-off"}>{d().account.enabled ? "Active" : "Disabled"}</span>
              </h2>
              <dl class="summary">
                <dt>Group</dt>
                <dd>
                  {d().account.group} · {d().account.currency}
                </dd>
                <dt>Balance</dt>
                <dd class="num">{money(d().account.balance)}</dd>
                <dt>Equity</dt>
                <dd class="num">{money(d().account.equity)}</dd>
                <dt>Margin · free margin</dt>
                <dd class="num">
                  {money(d().account.margin)} · {money(d().account.free_margin)}
                </dd>
                <dt>Margin level</dt>
                <dd class="num">{d().account.margin > 0 ? `${d().account.margin_level}%` : "—"}</dd>
              </dl>
              <Show when={error()}>
                <p class="down" role="alert">
                  {error()}
                </p>
              </Show>
              <Show when={notice()}>
                <p class="small up" role="status">
                  {notice()}
                </p>
              </Show>

              <div class="section">
                <div class="row">
                  {field("Name", "d-name", () => edit.name, (v) => setEdit("name", v), { required: true })}
                  {field("Leverage (1:x), for new positions", "d-lev", () => edit.leverage, (v) => setEdit("leverage", v), { inputmode: "numeric", required: true })}
                  <button type="submit" class="btn">
                    Save
                  </button>
                  <button type="button" class="btn btn-outline" onClick={() => void setEnabled(!d().account.enabled)}>
                    {d().account.enabled ? "Disable account" : "Enable account"}
                  </button>
                </div>
              </div>

              <div class="section">
                <h2>Balance operation</h2>
                <div class="row">
                  {field(`Amount (${d().account.currency})`, "d-amount", () => edit.amount, (v) => setEdit("amount", v), { inputmode: "decimal" })}
                  {field("Comment", "d-comment", () => edit.comment, (v) => setEdit("comment", v), { maxLength: 80 })}
                  <button type="button" class="btn" onClick={() => void moveMoney(1)}>
                    Deposit
                  </button>
                  <button type="button" class="btn btn-outline" onClick={() => void moveMoney(-1)}>
                    Withdraw
                  </button>
                </div>
              </div>

              <div class="section">
                <h2>Password</h2>
                <div class="row">
                  {field("New password (at least 8 characters)", "d-password", () => edit.password, (v) => setEdit("password", v), { type: "password", autocomplete: "new-password" })}
                  <button type="button" class="btn" disabled={edit.password.length < 8} onClick={() => void resetPassword()}>
                    Change password
                  </button>
                </div>
              </div>

              <div class="section">
                <h2>Open positions · {d().positions.length}</h2>
                <Show when={d().positions.length} fallback={<p class="small muted">None.</p>}>
                  <div class="table-box">{positionRows(d().positions, false)}</div>
                </Show>
              </div>
              <div class="section">
                <h2>Pending orders · {d().orders.length}</h2>
                <Show when={d().orders.length} fallback={<p class="small muted">None.</p>}>
                  <div class="table-box">{orderRows(d().orders, false)}</div>
                </Show>
              </div>
              <div class="section">
                <h2>Recent deals · {d().deals.length}</h2>
                <Show when={d().deals.length} fallback={<p class="small muted">None.</p>}>
                  <div class="table-box">
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
                          <th scope="col">Commission</th>
                          <th scope="col">Profit</th>
                        </tr>
                      </thead>
                      <tbody class="num">
                        <For each={[...d().deals].reverse().slice(0, 50)}>
                          {(x) => (
                            <tr>
                              <td>{x.id}</td>
                              <td class="name">{symbol(x.symbol)?.name}</td>
                              <td class={x.side === "Buy" ? "up" : "down"}>{x.side}</td>
                              <td>{x.entry === "In" ? "Open" : `Close (${x.reason})`}</td>
                              <td>{lots(x.volume)}</td>
                              <td>{time(x.ts)}</td>
                              <td>{price(x.price, x.symbol)}</td>
                              <td>{money(-x.commission)}</td>
                              <td class={tone(x.profit)}>{x.entry === "Out" ? signed(x.profit) : "—"}</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>

              <div class="dialog-actions">
                <button type="button" class="btn btn-primary" onClick={() => accountDialog.close()}>
                  Done
                </button>
              </div>
            </form>
          )}
        </Show>
      </dialog>
    </Show>
  );
}
