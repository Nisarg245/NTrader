use serde::{Deserialize, Serialize};

pub type AccountId = u64;
/// Orders, positions and deals share one id sequence.
pub type Id = u64;
pub type SymbolId = u32;
/// Price as an integer scaled by `10^digits` of the symbol (EURUSD 1.08345 with 5 digits = 108345).
pub type Price = i64;
/// Volume in 1/10000 of a lot (1.00 lot = 10000).
pub type Volume = i64;
/// Money in millionths of the account currency (1.00 USD = 1_000_000).
pub type Money = i64;
/// Unix time in milliseconds.
pub type Ts = i64;

pub const VOLUME_SCALE: i64 = 10_000;
pub const MONEY_SCALE: i64 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
    pub fn dir(self) -> i64 {
        match self {
            Side::Buy => 1,
            Side::Sell => -1,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderKind {
    Market,
    Limit,
    Stop,
}

/// Margin calculation modes, named after their MT5 equivalents.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CalcMode {
    /// lots * contract / leverage, in the base currency.
    Forex,
    /// lots * contract * price, in the profit currency (no leverage).
    Cfd,
    /// lots * contract * price / leverage, in the profit currency.
    CfdLeverage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AccountMode {
    /// Many positions per symbol, each closed individually.
    Hedging,
    /// One net position per symbol.
    Netting,
}

fn default_true() -> bool {
    true
}
fn default_rate() -> u32 {
    10_000
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SymbolSpec {
    pub name: String,
    pub digits: u8,
    /// Units per 1.00 lot (100000 for forex majors).
    pub contract_size: i64,
    pub base_ccy: String,
    pub profit_ccy: String,
    pub calc: CalcMode,
    /// Margin multiplier in basis points (10000 = 100%).
    #[serde(default = "default_rate")]
    pub margin_rate_bp: u32,
    pub vol_min: Volume,
    pub vol_max: Volume,
    pub vol_step: Volume,
    /// Swap in points per lot per rollover.
    #[serde(default)]
    pub swap_long: i64,
    #[serde(default)]
    pub swap_short: i64,
    #[serde(default = "default_true")]
    pub trade_enabled: bool,
    /// Market Watch group shown to traders ("Forex", "Metals", ...).
    #[serde(default)]
    pub category: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GroupSpec {
    pub name: String,
    pub currency: String,
    pub mode: AccountMode,
    pub leverage: u32,
    pub margin_call_pct: u32,
    pub stop_out_pct: u32,
    /// Commission per lot per deal, in account currency.
    #[serde(default)]
    pub commission_per_lot: Money,
    /// Demo groups let traders top up their own balance.
    #[serde(default)]
    pub demo: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct OrderRequest {
    pub account: AccountId,
    /// Echoed back in the resulting events so the client can correlate.
    #[serde(default)]
    pub client_id: u64,
    pub symbol: SymbolId,
    pub side: Side,
    pub kind: OrderKind,
    pub volume: Volume,
    /// Trigger price for Limit/Stop, ignored for Market.
    #[serde(default)]
    pub price: Price,
    /// 0 = none.
    #[serde(default)]
    pub sl: Price,
    #[serde(default)]
    pub tp: Price,
    /// Hedging accounts: the position this market order closes (0 = open a new one).
    #[serde(default)]
    pub position: Id,
    /// Trailing stop distance in points (0 = none).
    #[serde(default)]
    pub trail: Price,
    pub ts: Ts,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    AddSymbol {
        spec: SymbolSpec,
    },
    AddGroup {
        spec: GroupSpec,
    },
    CreateAccount {
        /// 0 = assign the next free login.
        #[serde(default)]
        id: AccountId,
        group: String,
        name: String,
        password_hash: String,
        /// 0 = group default.
        #[serde(default)]
        leverage: u32,
        ts: Ts,
    },
    /// Deposit (positive) or withdrawal (negative).
    Balance {
        account: AccountId,
        amount: Money,
        comment: String,
        ts: Ts,
    },
    PlaceOrder {
        req: OrderRequest,
    },
    CancelOrder {
        account: AccountId,
        order: Id,
        ts: Ts,
    },
    ModifyPosition {
        account: AccountId,
        position: Id,
        sl: Price,
        tp: Price,
        /// Trailing stop distance in points (0 = none).
        #[serde(default)]
        trail: Price,
        ts: Ts,
    },
    /// Close a position at market. `volume` 0 = all of it.
    ClosePosition {
        account: AccountId,
        position: Id,
        #[serde(default)]
        volume: Volume,
        ts: Ts,
    },
    Tick {
        symbol: SymbolId,
        bid: Price,
        ask: Price,
        ts: Ts,
    },
    /// End-of-day swap charge on all open positions.
    Rollover {
        ts: Ts,
    },
    /// Change a group's settings. Its name, currency and mode cannot change.
    UpdateGroup {
        spec: GroupSpec,
        ts: Ts,
    },
    /// Change a symbol's trading settings. Its name, digits, contract size,
    /// currencies and margin mode cannot change.
    UpdateSymbol {
        spec: SymbolSpec,
    },
    /// Change an account. Fields left out stay as they are.
    UpdateAccount {
        account: AccountId,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        leverage: Option<u32>,
        #[serde(default)]
        enabled: Option<bool>,
        ts: Ts,
    },
    SetPassword {
        account: AccountId,
        password_hash: String,
        ts: Ts,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Reject {
    /// The request tries to change something that is fixed once created.
    Immutable,
    /// A group, symbol or account setting is out of range.
    InvalidSettings,
    UnknownAccount,
    AccountDisabled,
    UnknownSymbol,
    UnknownGroup,
    TradeDisabled,
    NoQuote,
    InvalidVolume,
    InvalidPrice,
    InvalidStops,
    NoMoney,
    NoConversionRate,
    PositionNotFound,
    OrderNotFound,
    AlreadyExists,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Entry {
    In,
    Out,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DealReason {
    Client,
    Pending,
    StopLoss,
    TakeProfit,
    StopOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Deal {
    pub id: Id,
    pub order: Id,
    pub position: Id,
    pub account: AccountId,
    pub symbol: SymbolId,
    pub side: Side,
    pub volume: Volume,
    pub price: Price,
    pub entry: Entry,
    pub reason: DealReason,
    pub profit: Money,
    pub swap: Money,
    pub commission: Money,
    pub ts: Ts,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub id: Id,
    pub account: AccountId,
    pub symbol: SymbolId,
    pub side: Side,
    pub volume: Volume,
    pub open_price: Price,
    pub sl: Price,
    pub tp: Price,
    /// Trailing stop distance in points (0 = none). The stop loss follows the
    /// price at this distance and only ever moves in the position's favour.
    #[serde(default)]
    pub trail: Price,
    pub swap: Money,
    pub margin: Money,
    pub open_ts: Ts,
}

/// A resting (pending) order.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Order {
    pub id: Id,
    pub account: AccountId,
    pub symbol: SymbolId,
    pub side: Side,
    pub kind: OrderKind,
    pub volume: Volume,
    pub price: Price,
    pub sl: Price,
    pub tp: Price,
    #[serde(default)]
    pub trail: Price,
    pub ts: Ts,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct AccountState {
    pub id: AccountId,
    pub balance: Money,
    pub credit: Money,
    pub equity: Money,
    pub margin: Money,
    pub free_margin: Money,
    /// Equity / margin in percent, 0 when there is no margin in use.
    pub margin_level: i64,
}

/// One account as a manager sees it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AccountRow {
    pub id: AccountId,
    pub name: String,
    pub group: String,
    pub currency: String,
    pub leverage: u32,
    pub enabled: bool,
    pub positions: usize,
    pub orders: usize,
    pub balance: Money,
    pub credit: Money,
    pub equity: Money,
    pub margin: Money,
    pub free_margin: Money,
    pub margin_level: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Event {
    SymbolAdded {
        id: SymbolId,
        spec: SymbolSpec,
    },
    GroupAdded {
        spec: GroupSpec,
    },
    GroupUpdated {
        spec: GroupSpec,
    },
    SymbolUpdated {
        id: SymbolId,
        spec: SymbolSpec,
    },
    AccountUpdated {
        account: AccountId,
        name: String,
        leverage: u32,
        enabled: bool,
    },
    PasswordChanged {
        account: AccountId,
    },
    AccountCreated {
        account: AccountId,
        group: String,
        name: String,
    },
    Balance {
        account: AccountId,
        amount: Money,
        comment: String,
        ts: Ts,
    },
    Rejected {
        account: AccountId,
        client_id: u64,
        reason: Reject,
    },
    OrderPlaced {
        client_id: u64,
        order: Order,
    },
    OrderRemoved {
        account: AccountId,
        order: Id,
        /// True when the order was filled, false when cancelled.
        filled: bool,
    },
    Deal {
        client_id: u64,
        deal: Deal,
    },
    Position {
        position: Position,
    },
    PositionClosed {
        account: AccountId,
        position: Id,
    },
    Account {
        state: AccountState,
    },
    MarginCall {
        account: AccountId,
        margin_level: i64,
    },
    StopOut {
        account: AccountId,
        margin_level: i64,
    },
}

impl Event {
    /// The account this event belongs to, if it is account-specific.
    pub fn account(&self) -> Option<AccountId> {
        Some(match self {
            Event::SymbolAdded { .. }
            | Event::GroupAdded { .. }
            | Event::GroupUpdated { .. }
            | Event::SymbolUpdated { .. } => return None,
            Event::AccountCreated { account, .. }
            | Event::AccountUpdated { account, .. }
            | Event::PasswordChanged { account }
            | Event::Balance { account, .. }
            | Event::Rejected { account, .. }
            | Event::OrderRemoved { account, .. }
            | Event::PositionClosed { account, .. }
            | Event::MarginCall { account, .. }
            | Event::StopOut { account, .. } => *account,
            Event::OrderPlaced { order, .. } => order.account,
            Event::Deal { deal, .. } => deal.account,
            Event::Position { position } => position.account,
            Event::Account { state } => state.id,
        })
    }
}
