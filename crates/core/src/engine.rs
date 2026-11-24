use crate::types::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Price-ordered trigger book. The key is (trigger price, order or position id).
type Book = BTreeMap<(Price, Id), Trig>;

#[derive(Clone, Copy, Debug)]
enum Trig {
    Sl,
    Tp,
    Pending,
    /// Margin re-check for an account (see `Engine::risk_check`).
    Risk,
}

/// Marks a book key as an account id rather than an order or position id.
const RISK: Id = 1 << 63;

/// Each symbol has four books, one per trigger condition, so a tick only
/// touches the entries it actually fires.
#[derive(Clone, Copy)]
enum BookId {
    /// Fires when bid <= price (buy SL, sell stop).
    BidLe,
    /// Fires when bid >= price (buy TP, sell limit).
    BidGe,
    /// Fires when ask <= price (sell TP, buy limit).
    AskLe,
    /// Fires when ask >= price (sell SL, buy stop).
    AskGe,
}

fn sl_book(side: Side) -> BookId {
    match side {
        Side::Buy => BookId::BidLe,
        Side::Sell => BookId::AskGe,
    }
}
fn tp_book(side: Side) -> BookId {
    match side {
        Side::Buy => BookId::BidGe,
        Side::Sell => BookId::AskLe,
    }
}
fn pending_book(side: Side, kind: OrderKind) -> BookId {
    match (side, kind) {
        (Side::Buy, OrderKind::Stop) => BookId::AskGe,
        (Side::Buy, _) => BookId::AskLe,
        (Side::Sell, OrderKind::Stop) => BookId::BidLe,
        (Side::Sell, _) => BookId::BidGe,
    }
}

struct Sym {
    spec: SymbolSpec,
    scale: i64,
    base: u16,
    profit: u16,
    bid: Price,
    ask: Price,
    ts: Ts,
    bid_le: Book,
    bid_ge: Book,
    ask_le: Book,
    ask_ge: Book,
    /// Accounts holding a position in this symbol.
    exposed: BTreeSet<AccountId>,
}

impl Sym {
    fn book(&mut self, b: BookId) -> &mut Book {
        match b {
            BookId::BidLe => &mut self.bid_le,
            BookId::BidGe => &mut self.bid_ge,
            BookId::AskLe => &mut self.ask_le,
            BookId::AskGe => &mut self.ask_ge,
        }
    }
    /// Price at which a position on `side` is closed.
    fn close_price(&self, side: Side) -> Price {
        match side {
            Side::Buy => self.bid,
            Side::Sell => self.ask,
        }
    }
    fn open_price(&self, side: Side) -> Price {
        self.close_price(side.opposite())
    }
}

/// Net exposure of one account in one symbol. Floating profit is computed from
/// these aggregates, so valuing an account does not walk its positions.
#[derive(Clone, Copy, Default)]
struct Exposure {
    symbol: SymbolId,
    buy_vol: i64,
    /// Sum of open_price * volume over buy positions.
    buy_cost: i128,
    sell_vol: i64,
    sell_cost: i128,
    /// Armed margin re-check prices (0 = none): bid at or below `risk_bid`,
    /// ask at or above `risk_ask`.
    risk_bid: Price,
    risk_ask: Price,
    /// Cross-currency only: re-check when the conversion symbol leaves a band.
    /// (symbol, quoted directly, low price, high price)
    risk_conv: Option<(SymbolId, bool, Price, Price)>,
}

/// Remove an exposure's margin re-check triggers from the books.
fn disarm_exposure(symbols: &mut [Sym], account: AccountId, e: &mut Exposure) {
    let key = RISK | account;
    let y = &mut symbols[e.symbol as usize];
    if e.risk_bid > 0 {
        y.bid_le.remove(&(e.risk_bid, key));
    }
    if e.risk_ask > 0 {
        y.ask_ge.remove(&(e.risk_ask, key));
    }
    if let Some((c, direct, lo, hi)) = e.risk_conv {
        let y = &mut symbols[c as usize];
        if direct {
            y.bid_le.remove(&(lo, key));
            y.bid_ge.remove(&(hi, key));
        } else {
            y.ask_le.remove(&(lo, key));
            y.ask_ge.remove(&(hi, key));
        }
    }
    e.risk_bid = 0;
    e.risk_ask = 0;
    e.risk_conv = None;
}

struct Group {
    spec: GroupSpec,
    ccy: u16,
}

struct Account {
    group: usize,
    name: String,
    password_hash: String,
    leverage: u32,
    balance: Money,
    credit: Money,
    margin: Money,
    /// Accrued swap on open positions.
    swap_open: Money,
    exposures: Vec<Exposure>,
    positions: Vec<Id>,
    orders: Vec<Id>,
    margin_call: bool,
    enabled: bool,
}

#[derive(Clone, Copy)]
struct Fill {
    account: AccountId,
    symbol: SymbolId,
    side: Side,
    volume: Volume,
    price: Price,
    sl: Price,
    tp: Price,
    /// Position to close (hedging), 0 = none.
    target: Id,
    order: Id,
    client_id: u64,
    reason: DealReason,
    ts: Ts,
}

#[derive(Default)]
pub struct Engine {
    symbols: Vec<Sym>,
    sym_by_name: HashMap<String, SymbolId>,
    ccys: Vec<String>,
    /// (base, profit) currency pair -> forex symbol quoting it.
    conv: HashMap<(u16, u16), SymbolId>,
    groups: Vec<Group>,
    accounts: HashMap<AccountId, Account>,
    positions: HashMap<Id, Position>,
    orders: HashMap<Id, Order>,
    next_id: Id,
    next_account: AccountId,
    hits: Vec<(Id, Trig)>,
    fired: bool,
}

fn stops_ok(side: Side, reference: Price, sl: Price, tp: Price) -> bool {
    if sl < 0 || tp < 0 {
        return false;
    }
    match side {
        Side::Buy => (sl == 0 || sl < reference) && (tp == 0 || tp > reference),
        Side::Sell => (sl == 0 || sl > reference) && (tp == 0 || tp < reference),
    }
}

impl Engine {
    pub fn new() -> Self {
        Engine {
            next_id: 1,
            next_account: 1000,
            ..Default::default()
        }
    }

    // ---------------------------------------------------------------- views

    pub fn symbol_id(&self, name: &str) -> Option<SymbolId> {
        self.sym_by_name.get(name).copied()
    }

    pub fn symbols(&self) -> impl Iterator<Item = (SymbolId, &SymbolSpec, Price, Price, Ts)> {
        self.symbols
            .iter()
            .enumerate()
            .map(|(i, y)| (i as SymbolId, &y.spec, y.bid, y.ask, y.ts))
    }

    pub fn quote(&self, symbol: SymbolId) -> Option<(Price, Price, Ts)> {
        self.symbols
            .get(symbol as usize)
            .map(|y| (y.bid, y.ask, y.ts))
    }

    pub fn password_hash(&self, account: AccountId) -> Option<&str> {
        self.accounts
            .get(&account)
            .filter(|a| a.enabled)
            .map(|a| a.password_hash.as_str())
    }

    pub fn account_name(&self, account: AccountId) -> Option<&str> {
        self.accounts.get(&account).map(|a| a.name.as_str())
    }

    pub fn account_leverage(&self, account: AccountId) -> Option<u32> {
        self.accounts.get(&account).map(|a| a.leverage)
    }

    pub fn account_group(&self, account: AccountId) -> Option<&GroupSpec> {
        self.accounts
            .get(&account)
            .map(|a| &self.groups[a.group].spec)
    }

    pub fn account_state(&self, id: AccountId) -> Option<AccountState> {
        let a = self.accounts.get(&id)?;
        let equity = self.equity(a);
        Some(AccountState {
            id,
            balance: a.balance,
            credit: a.credit,
            equity,
            margin: a.margin,
            free_margin: equity - a.margin,
            margin_level: if a.margin > 0 {
                (equity as i128 * 100 / a.margin as i128) as i64
            } else {
                0
            },
        })
    }

    pub fn positions_of(&self, account: AccountId) -> Vec<Position> {
        self.accounts
            .get(&account)
            .map(|a| a.positions.iter().map(|p| self.positions[p]).collect())
            .unwrap_or_default()
    }

    pub fn orders_of(&self, account: AccountId) -> Vec<Order> {
        self.accounts
            .get(&account)
            .map(|a| a.orders.iter().map(|o| self.orders[o]).collect())
            .unwrap_or_default()
    }

    pub fn account_count(&self) -> usize {
        self.accounts.len()
    }

    pub fn position_count(&self) -> usize {
        self.positions.len()
    }

    /// Set a quote without evaluating triggers. Used by journal replay only,
    /// for quotes that fired nothing when the live engine processed them.
    pub fn set_quote(&mut self, symbol: SymbolId, bid: Price, ask: Price, ts: Ts) {
        if let Some(y) = self.symbols.get_mut(symbol as usize) {
            y.bid = bid;
            y.ask = ask;
            y.ts = ts;
        }
    }

    /// Whether the last tick fired any trigger, i.e. changed more than the quote.
    /// Such ticks must be journaled even when they produced no event.
    pub fn last_tick_fired(&self) -> bool {
        self.fired
    }

    /// Floating profit of an exposure in the symbol's profit currency.
    fn floating(&self, e: &Exposure) -> Money {
        let y = &self.symbols[e.symbol as usize];
        let points = (y.bid as i128 * e.buy_vol as i128 - e.buy_cost)
            + (e.sell_cost - y.ask as i128 * e.sell_vol as i128);
        (points * y.spec.contract_size as i128 * 100 / y.scale as i128) as Money
    }

    /// Equity is always derived from current quotes, never cached.
    fn equity(&self, a: &Account) -> Money {
        let ccy = self.groups[a.group].ccy;
        let mut equity = a.balance + a.credit + a.swap_open;
        for e in &a.exposures {
            let raw = self.floating(e);
            let from = self.symbols[e.symbol as usize].profit;
            equity += if from == ccy {
                raw
            } else {
                self.convert(raw, from, ccy).unwrap_or(raw)
            };
        }
        equity
    }

    // ------------------------------------------------------------- commands

    pub fn apply(&mut self, cmd: &Command, out: &mut Vec<Event>) {
        let (account, client_id, res) = match cmd {
            Command::Tick {
                symbol,
                bid,
                ask,
                ts,
            } => {
                self.tick(*symbol, *bid, *ask, *ts, out);
                return;
            }
            Command::AddSymbol { spec } => (0, 0, self.add_symbol(spec, out)),
            Command::AddGroup { spec } => (0, 0, self.add_group(spec, out)),
            Command::CreateAccount {
                id,
                group,
                name,
                password_hash,
                leverage,
                ..
            } => (
                *id,
                0,
                self.create_account(*id, group, name, password_hash, *leverage, out),
            ),
            Command::Balance {
                account,
                amount,
                comment,
                ts,
            } => (
                *account,
                0,
                self.balance(*account, *amount, comment, *ts, out),
            ),
            Command::PlaceOrder { req } => (req.account, req.client_id, self.place(req, out)),
            Command::CancelOrder { account, order, .. } => {
                (*account, 0, self.cancel(*account, *order, out))
            }
            Command::ModifyPosition {
                account,
                position,
                sl,
                tp,
                ..
            } => (*account, 0, self.modify(*account, *position, *sl, *tp, out)),
            Command::ClosePosition {
                account,
                position,
                volume,
                ts,
            } => (
                *account,
                0,
                self.close(*account, *position, *volume, *ts, out),
            ),
            Command::Rollover { ts } => {
                self.rollover(*ts, out);
                return;
            }
        };
        if let Err(reason) = res {
            out.push(Event::Rejected {
                account,
                client_id,
                reason,
            });
        }
    }

    fn id(&mut self) -> Id {
        let i = self.next_id;
        self.next_id += 1;
        i
    }

    fn ccy(&mut self, name: &str) -> u16 {
        if let Some(i) = self.ccys.iter().position(|c| c == name) {
            return i as u16;
        }
        self.ccys.push(name.to_string());
        (self.ccys.len() - 1) as u16
    }

    fn add_symbol(&mut self, spec: &SymbolSpec, out: &mut Vec<Event>) -> Result<(), Reject> {
        if self.sym_by_name.contains_key(&spec.name) {
            return Err(Reject::AlreadyExists);
        }
        if spec.digits > 10 || spec.contract_size <= 0 || spec.vol_step <= 0 || spec.vol_min <= 0 {
            return Err(Reject::InvalidVolume);
        }
        let id = self.symbols.len() as SymbolId;
        let base = self.ccy(&spec.base_ccy);
        let profit = self.ccy(&spec.profit_ccy);
        if spec.calc == CalcMode::Forex && base != profit {
            self.conv.insert((base, profit), id);
        }
        self.symbols.push(Sym {
            spec: spec.clone(),
            scale: 10i64.pow(spec.digits as u32),
            base,
            profit,
            bid: 0,
            ask: 0,
            ts: 0,
            bid_le: Book::new(),
            bid_ge: Book::new(),
            ask_le: Book::new(),
            ask_ge: Book::new(),
            exposed: BTreeSet::new(),
        });
        self.sym_by_name.insert(spec.name.clone(), id);
        out.push(Event::SymbolAdded {
            id,
            spec: spec.clone(),
        });
        Ok(())
    }

    fn add_group(&mut self, spec: &GroupSpec, out: &mut Vec<Event>) -> Result<(), Reject> {
        if self.groups.iter().any(|g| g.spec.name == spec.name) {
            return Err(Reject::AlreadyExists);
        }
        if spec.leverage == 0 {
            return Err(Reject::InvalidVolume);
        }
        let ccy = self.ccy(&spec.currency);
        self.groups.push(Group {
            spec: spec.clone(),
            ccy,
        });
        out.push(Event::GroupAdded { spec: spec.clone() });
        Ok(())
    }

    fn create_account(
        &mut self,
        id: AccountId,
        group: &str,
        name: &str,
        password_hash: &str,
        leverage: u32,
        out: &mut Vec<Event>,
    ) -> Result<(), Reject> {
        let g = self
            .groups
            .iter()
            .position(|g| g.spec.name == group)
            .ok_or(Reject::UnknownGroup)?;
        let id = if id == 0 { self.next_account } else { id };
        if self.accounts.contains_key(&id) {
            return Err(Reject::AlreadyExists);
        }
        self.next_account = self.next_account.max(id + 1);
        self.accounts.insert(
            id,
            Account {
                group: g,
                name: name.to_string(),
                password_hash: password_hash.to_string(),
                leverage: if leverage == 0 {
                    self.groups[g].spec.leverage
                } else {
                    leverage
                },
                balance: 0,
                credit: 0,
                margin: 0,
                swap_open: 0,
                exposures: Vec::new(),
                positions: Vec::new(),
                orders: Vec::new(),
                margin_call: false,
                enabled: true,
            },
        );
        out.push(Event::AccountCreated {
            account: id,
            group: group.to_string(),
            name: name.to_string(),
        });
        Ok(())
    }

    fn balance(
        &mut self,
        account: AccountId,
        amount: Money,
        comment: &str,
        ts: Ts,
        out: &mut Vec<Event>,
    ) -> Result<(), Reject> {
        let a = self.accounts.get(&account).ok_or(Reject::UnknownAccount)?;
        if amount < 0 && (a.balance + amount < 0 || self.equity(a) - a.margin + amount < 0) {
            return Err(Reject::NoMoney);
        }
        self.accounts.get_mut(&account).unwrap().balance += amount;
        out.push(Event::Balance {
            account,
            amount,
            comment: comment.to_string(),
            ts,
        });
        self.settle(account, ts, out);
        Ok(())
    }

    fn place(&mut self, r: &OrderRequest, out: &mut Vec<Event>) -> Result<(), Reject> {
        let a = self
            .accounts
            .get(&r.account)
            .ok_or(Reject::UnknownAccount)?;
        if !a.enabled {
            return Err(Reject::AccountDisabled);
        }
        let y = self
            .symbols
            .get(r.symbol as usize)
            .ok_or(Reject::UnknownSymbol)?;
        if !y.spec.trade_enabled {
            return Err(Reject::TradeDisabled);
        }
        if y.bid <= 0 {
            return Err(Reject::NoQuote);
        }
        let closing = r.position != 0;
        if r.volume <= 0
            || r.volume > y.spec.vol_max
            || (!closing && (r.volume < y.spec.vol_min || r.volume % y.spec.vol_step != 0))
        {
            return Err(Reject::InvalidVolume);
        }
        match r.kind {
            OrderKind::Market => {
                let price = y.open_price(r.side);
                if !closing && !stops_ok(r.side, y.close_price(r.side), r.sl, r.tp) {
                    return Err(Reject::InvalidStops);
                }
                let order = self.id();
                self.execute(
                    Fill {
                        account: r.account,
                        symbol: r.symbol,
                        side: r.side,
                        volume: r.volume,
                        price,
                        sl: r.sl,
                        tp: r.tp,
                        target: r.position,
                        order,
                        client_id: r.client_id,
                        reason: DealReason::Client,
                        ts: r.ts,
                    },
                    out,
                )?;
                self.settle(r.account, r.ts, out);
            }
            OrderKind::Limit | OrderKind::Stop => {
                let market = y.open_price(r.side);
                let above = r.price > market;
                let below = r.price < market;
                let valid = match (r.side, r.kind) {
                    (Side::Buy, OrderKind::Limit) | (Side::Sell, OrderKind::Stop) => below,
                    _ => above,
                };
                if r.price <= 0 || !valid || closing {
                    return Err(Reject::InvalidPrice);
                }
                if !stops_ok(r.side, r.price, r.sl, r.tp) {
                    return Err(Reject::InvalidStops);
                }
                let id = self.id();
                let o = Order {
                    id,
                    account: r.account,
                    symbol: r.symbol,
                    side: r.side,
                    kind: r.kind,
                    volume: r.volume,
                    price: r.price,
                    sl: r.sl,
                    tp: r.tp,
                    ts: r.ts,
                };
                self.orders.insert(id, o);
                self.symbols[r.symbol as usize]
                    .book(pending_book(o.side, o.kind))
                    .insert((o.price, id), Trig::Pending);
                self.accounts.get_mut(&r.account).unwrap().orders.push(id);
                out.push(Event::OrderPlaced {
                    client_id: r.client_id,
                    order: o,
                });
            }
        }
        Ok(())
    }

    fn remove_order(&mut self, o: &Order) {
        self.orders.remove(&o.id);
        self.symbols[o.symbol as usize]
            .book(pending_book(o.side, o.kind))
            .remove(&(o.price, o.id));
        if let Some(a) = self.accounts.get_mut(&o.account) {
            a.orders.retain(|x| *x != o.id);
        }
    }

    fn cancel(
        &mut self,
        account: AccountId,
        order: Id,
        out: &mut Vec<Event>,
    ) -> Result<(), Reject> {
        let o = *self.orders.get(&order).ok_or(Reject::OrderNotFound)?;
        if o.account != account {
            return Err(Reject::OrderNotFound);
        }
        self.remove_order(&o);
        out.push(Event::OrderRemoved {
            account,
            order,
            filled: false,
        });
        Ok(())
    }

    fn modify(
        &mut self,
        account: AccountId,
        position: Id,
        sl: Price,
        tp: Price,
        out: &mut Vec<Event>,
    ) -> Result<(), Reject> {
        let mut p = *self
            .positions
            .get(&position)
            .ok_or(Reject::PositionNotFound)?;
        if p.account != account {
            return Err(Reject::PositionNotFound);
        }
        let reference = self.symbols[p.symbol as usize].close_price(p.side);
        if !stops_ok(p.side, reference, sl, tp) {
            return Err(Reject::InvalidStops);
        }
        self.disarm(&p);
        p.sl = sl;
        p.tp = tp;
        self.positions.insert(position, p);
        self.arm(&p);
        out.push(Event::Position { position: p });
        Ok(())
    }

    fn close(
        &mut self,
        account: AccountId,
        position: Id,
        volume: Volume,
        ts: Ts,
        out: &mut Vec<Event>,
    ) -> Result<(), Reject> {
        let p = *self
            .positions
            .get(&position)
            .ok_or(Reject::PositionNotFound)?;
        if p.account != account {
            return Err(Reject::PositionNotFound);
        }
        let volume = if volume == 0 { p.volume } else { volume };
        if volume < 0 || volume > p.volume {
            return Err(Reject::InvalidVolume);
        }
        let price = self.symbols[p.symbol as usize].close_price(p.side);
        let order = self.id();
        self.close_part(
            position,
            volume,
            price,
            order,
            0,
            DealReason::Client,
            ts,
            out,
        );
        self.settle(account, ts, out);
        Ok(())
    }

    fn rollover(&mut self, ts: Ts, out: &mut Vec<Event>) {
        let mut touched = BTreeSet::new();
        let mut ids: Vec<Id> = self.positions.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            let mut p = self.positions[&id];
            let y = &self.symbols[p.symbol as usize];
            let points = match p.side {
                Side::Buy => y.spec.swap_long,
                Side::Sell => y.spec.swap_short,
            };
            if points == 0 {
                continue;
            }
            let raw = (points as i128 * p.volume as i128 * y.spec.contract_size as i128 * 100
                / y.scale as i128) as Money;
            let profit_ccy = y.profit;
            let ccy = self.groups[self.accounts[&p.account].group].ccy;
            let swap = self.convert(raw, profit_ccy, ccy).unwrap_or(raw);
            p.swap += swap;
            self.positions.insert(id, p);
            self.accounts.get_mut(&p.account).unwrap().swap_open += swap;
            touched.insert(p.account);
            out.push(Event::Position { position: p });
        }
        for a in touched {
            self.settle(a, ts, out);
        }
    }

    // ------------------------------------------------------------ execution

    fn execute(&mut self, f: Fill, out: &mut Vec<Event>) -> Result<(), Reject> {
        if f.target != 0 {
            let p = *self
                .positions
                .get(&f.target)
                .ok_or(Reject::PositionNotFound)?;
            if p.account != f.account || p.symbol != f.symbol || p.side == f.side {
                return Err(Reject::PositionNotFound);
            }
            if f.volume > p.volume {
                return Err(Reject::InvalidVolume);
            }
            self.close_part(
                f.target,
                f.volume,
                f.price,
                f.order,
                f.client_id,
                f.reason,
                f.ts,
                out,
            );
            return Ok(());
        }
        let acc = &self.accounts[&f.account];
        if self.groups[acc.group].spec.mode == AccountMode::Netting {
            let existing = acc
                .positions
                .iter()
                .map(|p| self.positions[p])
                .find(|p| p.symbol == f.symbol);
            if let Some(p) = existing {
                if p.side == f.side {
                    return self.increase(p, f, out);
                }
                let closed = f.volume.min(p.volume);
                if f.volume > closed {
                    // A reversal is one order: check the new side's margin before
                    // closing anything, so a rejection leaves the position untouched.
                    let g = &self.groups[acc.group];
                    let rest = f.volume - closed;
                    let margin = self
                        .margin_for(f.symbol, rest, f.price, acc.leverage, g.ccy)
                        .ok_or(Reject::NoConversionRate)?;
                    let fees = commission(g.spec.commission_per_lot, f.volume);
                    if self.equity(acc) - (acc.margin - p.margin) < margin + fees {
                        return Err(Reject::NoMoney);
                    }
                }
                self.close_part(
                    p.id,
                    closed,
                    f.price,
                    f.order,
                    f.client_id,
                    f.reason,
                    f.ts,
                    out,
                );
                if f.volume == closed {
                    return Ok(());
                }
                // Reversal: the remainder opens a position on the other side.
                return self.open(
                    Fill {
                        volume: f.volume - closed,
                        ..f
                    },
                    out,
                );
            }
        }
        self.open(f, out)
    }

    fn open(&mut self, f: Fill, out: &mut Vec<Event>) -> Result<(), Reject> {
        let acc = &self.accounts[&f.account];
        let g = &self.groups[acc.group];
        let margin = self
            .margin_for(f.symbol, f.volume, f.price, acc.leverage, g.ccy)
            .ok_or(Reject::NoConversionRate)?;
        let commission = commission(g.spec.commission_per_lot, f.volume);
        if self.equity(acc) - acc.margin < margin + commission {
            return Err(Reject::NoMoney);
        }
        let p = Position {
            id: f.order,
            account: f.account,
            symbol: f.symbol,
            side: f.side,
            volume: f.volume,
            open_price: f.price,
            sl: f.sl,
            tp: f.tp,
            swap: 0,
            margin,
            open_ts: f.ts,
        };
        let deal = self.id();
        self.positions.insert(p.id, p);
        let a = self.accounts.get_mut(&f.account).unwrap();
        a.balance -= commission;
        a.margin += margin;
        a.positions.push(p.id);
        self.arm(&p);
        self.expose(&p, 1);
        out.push(Event::Deal {
            client_id: f.client_id,
            deal: Deal {
                id: deal,
                order: f.order,
                position: p.id,
                account: f.account,
                symbol: f.symbol,
                side: f.side,
                volume: f.volume,
                price: f.price,
                entry: Entry::In,
                reason: f.reason,
                profit: 0,
                swap: 0,
                commission,
                ts: f.ts,
            },
        });
        out.push(Event::Position { position: p });
        Ok(())
    }

    /// Netting: add to an existing position at a volume-weighted average price.
    fn increase(&mut self, old: Position, f: Fill, out: &mut Vec<Event>) -> Result<(), Reject> {
        let acc = &self.accounts[&f.account];
        let g = &self.groups[acc.group];
        let volume = old.volume + f.volume;
        let open_price = ((old.open_price as i128 * old.volume as i128
            + f.price as i128 * f.volume as i128)
            / volume as i128) as Price;
        let margin = self
            .margin_for(f.symbol, volume, open_price, acc.leverage, g.ccy)
            .ok_or(Reject::NoConversionRate)?;
        let commission = commission(g.spec.commission_per_lot, f.volume);
        if self.equity(acc) - acc.margin < (margin - old.margin).max(0) + commission {
            return Err(Reject::NoMoney);
        }
        let p = Position {
            volume,
            open_price,
            margin,
            sl: if f.sl != 0 { f.sl } else { old.sl },
            tp: if f.tp != 0 { f.tp } else { old.tp },
            ..old
        };
        let deal = self.id();
        self.disarm(&old);
        self.expose(&old, -1);
        self.positions.insert(p.id, p);
        let a = self.accounts.get_mut(&f.account).unwrap();
        a.balance -= commission;
        a.margin += margin - old.margin;
        self.arm(&p);
        self.expose(&p, 1);
        out.push(Event::Deal {
            client_id: f.client_id,
            deal: Deal {
                id: deal,
                order: f.order,
                position: p.id,
                account: f.account,
                symbol: f.symbol,
                side: f.side,
                volume: f.volume,
                price: f.price,
                entry: Entry::In,
                reason: f.reason,
                profit: 0,
                swap: 0,
                commission,
                ts: f.ts,
            },
        });
        out.push(Event::Position { position: p });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn close_part(
        &mut self,
        position: Id,
        volume: Volume,
        price: Price,
        order: Id,
        client_id: u64,
        reason: DealReason,
        ts: Ts,
        out: &mut Vec<Event>,
    ) {
        let old = self.positions[&position];
        let y = &self.symbols[old.symbol as usize];
        let raw = ((price - old.open_price) as i128
            * old.side.dir() as i128
            * volume as i128
            * y.spec.contract_size as i128
            * 100
            / y.scale as i128) as Money;
        let profit_ccy = y.profit;
        let g = &self.groups[self.accounts[&old.account].group];
        let commission = commission(g.spec.commission_per_lot, volume);
        let profit = self.convert(raw, profit_ccy, g.ccy).unwrap_or(raw);
        let full = volume == old.volume;
        let share = |x: Money| {
            if full {
                x
            } else {
                (x as i128 * volume as i128 / old.volume as i128) as Money
            }
        };
        let swap = share(old.swap);
        let margin = share(old.margin);

        self.disarm(&old);
        self.expose(&old, -1);
        let deal = self.id();
        let a = self.accounts.get_mut(&old.account).unwrap();
        a.balance += profit + swap - commission;
        a.swap_open -= swap;
        a.margin -= margin;
        out.push(Event::Deal {
            client_id,
            deal: Deal {
                id: deal,
                order,
                position,
                account: old.account,
                symbol: old.symbol,
                side: old.side.opposite(),
                volume,
                price,
                entry: Entry::Out,
                reason,
                profit,
                swap,
                commission,
                ts,
            },
        });
        if full {
            a.positions.retain(|x| *x != position);
            self.positions.remove(&position);
            out.push(Event::PositionClosed {
                account: old.account,
                position,
            });
        } else {
            let p = Position {
                volume: old.volume - volume,
                swap: old.swap - swap,
                margin: old.margin - margin,
                ..old
            };
            self.positions.insert(position, p);
            self.arm(&p);
            self.expose(&p, 1);
            out.push(Event::Position { position: p });
        }
    }

    fn arm(&mut self, p: &Position) {
        let y = &mut self.symbols[p.symbol as usize];
        if p.sl > 0 {
            y.book(sl_book(p.side)).insert((p.sl, p.id), Trig::Sl);
        }
        if p.tp > 0 {
            y.book(tp_book(p.side)).insert((p.tp, p.id), Trig::Tp);
        }
    }

    fn disarm(&mut self, p: &Position) {
        let y = &mut self.symbols[p.symbol as usize];
        if p.sl > 0 {
            y.book(sl_book(p.side)).remove(&(p.sl, p.id));
        }
        if p.tp > 0 {
            y.book(tp_book(p.side)).remove(&(p.tp, p.id));
        }
    }

    /// Add (`sign` 1) or remove (`sign` -1) a position from its account's exposure.
    fn expose(&mut self, p: &Position, sign: i64) {
        let a = self.accounts.get_mut(&p.account).unwrap();
        let i = match a.exposures.iter().position(|e| e.symbol == p.symbol) {
            Some(i) => i,
            None => {
                a.exposures.push(Exposure {
                    symbol: p.symbol,
                    ..Default::default()
                });
                self.symbols[p.symbol as usize].exposed.insert(p.account);
                a.exposures.len() - 1
            }
        };
        let e = &mut a.exposures[i];
        let cost = p.open_price as i128 * p.volume as i128 * sign as i128;
        match p.side {
            Side::Buy => {
                e.buy_vol += p.volume * sign;
                e.buy_cost += cost;
            }
            Side::Sell => {
                e.sell_vol += p.volume * sign;
                e.sell_cost += cost;
            }
        }
        if e.buy_vol == 0 && e.sell_vol == 0 {
            // Every caller re-arms the account's remaining exposures before
            // the next tick, so dropping this one's triggers here is enough.
            let mut e = a.exposures.swap_remove(i);
            disarm_exposure(&mut self.symbols, p.account, &mut e);
            self.symbols[p.symbol as usize].exposed.remove(&p.account);
        }
    }

    fn position_profit(&self, p: &Position) -> Money {
        let y = &self.symbols[p.symbol as usize];
        let raw = ((y.close_price(p.side) - p.open_price) as i128
            * p.side.dir() as i128
            * p.volume as i128
            * y.spec.contract_size as i128
            * 100
            / y.scale as i128) as Money;
        let ccy = self.groups[self.accounts[&p.account].group].ccy;
        self.convert(raw, y.profit, ccy).unwrap_or(raw) + p.swap
    }

    /// Margin for a position, in account currency.
    fn margin_for(
        &self,
        symbol: SymbolId,
        volume: Volume,
        price: Price,
        leverage: u32,
        ccy: u16,
    ) -> Option<Money> {
        let y = &self.symbols[symbol as usize];
        let units = volume as i128 * y.spec.contract_size as i128 * 100;
        let lev = leverage.max(1) as i128;
        let value = units * price as i128 / y.scale as i128;
        let (amount, from) = match y.spec.calc {
            CalcMode::Forex => (units / lev, y.base),
            CalcMode::Cfd => (value, y.profit),
            CalcMode::CfdLeverage => (value / lev, y.profit),
        };
        let amount = (amount * y.spec.margin_rate_bp as i128 / 10_000) as Money;
        self.convert(amount, from, ccy)
    }

    /// The symbol used to convert `from` into `to`, and whether it quotes
    /// that pair directly (multiply by bid) or inverted (divide by ask).
    fn conv_route(&self, from: u16, to: u16) -> Option<(SymbolId, bool)> {
        if let Some(&s) = self.conv.get(&(from, to)) {
            if self.symbols[s as usize].bid > 0 {
                return Some((s, true));
            }
        }
        if let Some(&s) = self.conv.get(&(to, from)) {
            if self.symbols[s as usize].ask > 0 {
                return Some((s, false));
            }
        }
        None
    }

    /// Convert between currencies using the current quote of the matching forex symbol.
    fn convert(&self, amount: Money, from: u16, to: u16) -> Option<Money> {
        if from == to {
            return Some(amount);
        }
        let (s, direct) = self.conv_route(from, to)?;
        let y = &self.symbols[s as usize];
        Some(if direct {
            (amount as i128 * y.bid as i128 / y.scale as i128) as Money
        } else {
            (amount as i128 * y.scale as i128 / y.ask as i128) as Money
        })
    }

    fn push_account(&self, account: AccountId, out: &mut Vec<Event>) {
        if let Some(state) = self.account_state(account) {
            out.push(Event::Account { state });
        }
    }

    // ----------------------------------------------------------------- tick

    fn tick(&mut self, symbol: SymbolId, bid: Price, ask: Price, ts: Ts, out: &mut Vec<Event>) {
        let Some(y) = self.symbols.get_mut(symbol as usize) else {
            return;
        };
        self.fired = false;
        if bid <= 0 || ask < bid {
            return;
        }
        y.bid = bid;
        y.ask = ask;
        y.ts = ts;

        let mut hits = std::mem::take(&mut self.hits);
        hits.clear();
        if y.bid_le.last_key_value().is_some_and(|(k, _)| k.0 >= bid) {
            hits.extend(y.bid_le.range((bid, 0)..).map(|(k, t)| (k.1, *t)));
        }
        if y.bid_ge.first_key_value().is_some_and(|(k, _)| k.0 <= bid) {
            hits.extend(y.bid_ge.range(..=(bid, Id::MAX)).map(|(k, t)| (k.1, *t)));
        }
        if y.ask_le.last_key_value().is_some_and(|(k, _)| k.0 >= ask) {
            hits.extend(y.ask_le.range((ask, 0)..).map(|(k, t)| (k.1, *t)));
        }
        if y.ask_ge.first_key_value().is_some_and(|(k, _)| k.0 <= ask) {
            hits.extend(y.ask_ge.range(..=(ask, Id::MAX)).map(|(k, t)| (k.1, *t)));
        }
        self.fired = !hits.is_empty();
        for (id, trig) in hits.drain(..) {
            match trig {
                Trig::Sl | Trig::Tp => {
                    // May already be gone if an earlier trigger on this tick closed it.
                    let Some(p) = self.positions.get(&id).copied() else {
                        continue;
                    };
                    let price = self.symbols[symbol as usize].close_price(p.side);
                    let reason = match trig {
                        Trig::Sl => DealReason::StopLoss,
                        _ => DealReason::TakeProfit,
                    };
                    let order = self.id();
                    self.close_part(id, p.volume, price, order, 0, reason, ts, out);
                    self.settle(p.account, ts, out);
                }
                Trig::Pending => self.trigger(id, ts, out),
                Trig::Risk => self.risk_check(id & !RISK, ts, out),
            }
        }
        self.hits = hits;
    }

    fn trigger(&mut self, order: Id, ts: Ts, out: &mut Vec<Event>) {
        let Some(o) = self.orders.get(&order).copied() else {
            return;
        };
        self.remove_order(&o);
        let price = self.symbols[o.symbol as usize].open_price(o.side);
        let res = self.execute(
            Fill {
                account: o.account,
                symbol: o.symbol,
                side: o.side,
                volume: o.volume,
                price,
                sl: o.sl,
                tp: o.tp,
                target: 0,
                order: o.id,
                client_id: 0,
                reason: DealReason::Pending,
                ts,
            },
            out,
        );
        out.push(Event::OrderRemoved {
            account: o.account,
            order,
            filled: res.is_ok(),
        });
        if let Err(reason) = res {
            out.push(Event::Rejected {
                account: o.account,
                client_id: 0,
                reason,
            });
        }
        self.settle(o.account, ts, out);
    }

    /// Margin check plus account snapshot, after anything that changed an account.
    fn settle(&mut self, account: AccountId, ts: Ts, out: &mut Vec<Event>) {
        self.risk_check(account, ts, out);
        self.push_account(account, out);
    }

    /// Evaluate margin call and stop-out for an account, then arm the prices at
    /// which it has to be evaluated again.
    ///
    /// Ticks do not revalue accounts. Instead the distance to the next margin
    /// level (the loss budget) is split across the account's exposure legs, and
    /// each leg gets a trigger price at which it would have used up its share.
    /// As long as no trigger has fired, the total loss is below the budget, so
    /// the level cannot have been reached. When one fires we land here again.
    fn risk_check(&mut self, account: AccountId, ts: Ts, out: &mut Vec<Event>) {
        self.disarm_risk(account);
        let Some(a) = self.accounts.get(&account) else {
            return;
        };
        let g = &self.groups[a.group];
        let stop_out = g.spec.stop_out_pct as i128;
        let margin_call = g.spec.margin_call_pct as i128;
        let ccy = g.ccy;
        let mut equity = self.equity(a) as i128;
        let mut margin = a.margin as i128;
        if margin > 0 && equity * 100 <= margin * stop_out {
            out.push(Event::StopOut {
                account,
                margin_level: (equity * 100 / margin) as i64,
            });
            self.stop_out(account, ts, out);
            let a = &self.accounts[&account];
            equity = self.equity(a) as i128;
            margin = a.margin as i128;
        }
        let a = self.accounts.get_mut(&account).unwrap();
        if margin <= 0 || a.exposures.is_empty() {
            a.margin_call = false;
            return;
        }
        // `margin_call` only throttles the notification; it is not financial state.
        if equity * 100 > margin * margin_call {
            a.margin_call = false;
        } else if !a.margin_call {
            a.margin_call = true;
            out.push(Event::MarginCall {
                account,
                margin_level: (equity * 100 / margin) as i64,
            });
        }
        let target = if a.margin_call {
            stop_out
        } else {
            margin_call.max(stop_out)
        };
        let budget = (equity - margin * target / 100).max(0);
        let legs: i128 = a
            .exposures
            .iter()
            .map(|e| (e.buy_vol > 0) as i128 + (e.sell_vol > 0) as i128)
            .sum();
        // A few millionths of slack per leg absorb integer rounding in valuation.
        let per_leg = (budget / legs.max(1) - 8).max(0);
        for i in 0..a.exposures.len() {
            let e = self.accounts[&account].exposures[i];
            let y = &self.symbols[e.symbol as usize];
            let unit = y.spec.contract_size as i128 * 100;
            let scale = y.scale as i128;
            // Loss per price point in the profit currency, rounded up so that
            // a trigger is never late.
            let rho = |vol: i64| ((vol as i128 * unit + scale - 1) / scale).max(1);
            let raw_buy = (y.bid as i128 * e.buy_vol as i128 - e.buy_cost) * unit / scale;
            let raw_sell = (e.sell_cost - y.ask as i128 * e.sell_vol as i128) * unit / scale;
            let route = if y.profit == ccy {
                None
            } else {
                self.conv_route(y.profit, ccy)
            };
            // Adverse points each leg may move before it must be re-checked.
            let (buy_pts, sell_pts, conv) = match route {
                None => (per_leg / rho(e.buy_vol), per_leg / rho(e.sell_vol), None),
                Some((c, direct)) => {
                    // The leg is worth raw * rate in account currency, so it can
                    // lose through its own price and through the rate. The rate
                    // is held inside a band [lo, hi] by two triggers on the
                    // conversion symbol; inside it the rate loss is at most
                    // `rate_loss`, and what is left of the share goes to price.
                    let cy = &self.symbols[c as usize];
                    let cs = cy.scale as i128;
                    let p0 = if direct { cy.bid } else { cy.ask } as i128;
                    let to_acc = |x: i128| {
                        if direct {
                            (x * p0 + cs - 1) / cs
                        } else {
                            (x * cs + p0 - 1) / p0
                        }
                    };
                    let worst = to_acc(raw_buy.abs().max(raw_sell.abs()));
                    let mut d = p0 / 200;
                    if worst > 0 {
                        d = d.min(per_leg * p0 / (4 * worst));
                    }
                    let (lo, hi) = (p0 - d, p0 + d);
                    let rate_loss = |raw: i128| (to_acc(raw.abs()) * d + lo - 1) / lo;
                    let rho_acc = |vol: i64| {
                        let r = rho(vol);
                        if direct {
                            (r * hi + cs - 1) / cs
                        } else {
                            (r * cs + lo - 1) / lo
                        }
                        .max(1)
                    };
                    (
                        (per_leg - rate_loss(raw_buy)).max(0) / rho_acc(e.buy_vol),
                        (per_leg - rate_loss(raw_sell)).max(0) / rho_acc(e.sell_vol),
                        Some((c, direct, lo as Price, hi as Price)),
                    )
                }
            };
            let mut risk_bid = 0;
            let mut risk_ask = 0;
            if e.buy_vol > 0 {
                let price = y.bid as i128 - buy_pts;
                if price > 0 {
                    risk_bid = price as Price;
                }
            }
            if e.sell_vol > 0 {
                let price = y.ask as i128 + sell_pts;
                if price < Price::MAX as i128 {
                    risk_ask = price as Price;
                }
            }
            let key = RISK | account;
            let y = &mut self.symbols[e.symbol as usize];
            if risk_bid > 0 {
                y.bid_le.insert((risk_bid, key), Trig::Risk);
            }
            if risk_ask > 0 {
                y.ask_ge.insert((risk_ask, key), Trig::Risk);
            }
            if let Some((c, direct, lo, hi)) = conv {
                let y = &mut self.symbols[c as usize];
                if direct {
                    y.bid_le.insert((lo, key), Trig::Risk);
                    y.bid_ge.insert((hi, key), Trig::Risk);
                } else {
                    y.ask_le.insert((lo, key), Trig::Risk);
                    y.ask_ge.insert((hi, key), Trig::Risk);
                }
            }
            let e = &mut self.accounts.get_mut(&account).unwrap().exposures[i];
            e.risk_bid = risk_bid;
            e.risk_ask = risk_ask;
            e.risk_conv = conv;
        }
    }

    fn disarm_risk(&mut self, account: AccountId) {
        if let Some(a) = self.accounts.get_mut(&account) {
            for e in &mut a.exposures {
                disarm_exposure(&mut self.symbols, account, e);
            }
        }
    }

    /// Close the most losing position until the margin level is back above stop-out.
    fn stop_out(&mut self, account: AccountId, ts: Ts, out: &mut Vec<Event>) {
        loop {
            let a = &self.accounts[&account];
            let limit = self.groups[a.group].spec.stop_out_pct as i128;
            if a.margin <= 0
                || a.positions.is_empty()
                || self.equity(a) as i128 * 100 > a.margin as i128 * limit
            {
                break;
            }
            let worst = a
                .positions
                .iter()
                .map(|id| self.positions[id])
                .min_by_key(|p| (self.position_profit(p), p.id))
                .unwrap();
            let price = self.symbols[worst.symbol as usize].close_price(worst.side);
            let order = self.id();
            self.close_part(
                worst.id,
                worst.volume,
                price,
                order,
                0,
                DealReason::StopOut,
                ts,
                out,
            );
        }
        self.push_account(account, out);
    }
}

fn commission(per_lot: Money, volume: Volume) -> Money {
    (per_lot as i128 * volume as i128 / VOLUME_SCALE as i128) as Money
}
