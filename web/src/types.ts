// Mirrors crates/core/src/types.rs and crates/server/src/protocol.rs.
// Prices are integers scaled by 10^digits, volumes are 1/10000 lot,
// money is millionths of the account currency, times are Unix milliseconds.

export type Side = "Buy" | "Sell";
export type OrderKind = "Market" | "Limit" | "Stop";
export type CalcMode = "Forex" | "Cfd" | "CfdLeverage";

export interface SymbolInfo {
  id: number;
  name: string;
  digits: number;
  contract_size: number;
  base_ccy: string;
  profit_ccy: string;
  calc: CalcMode;
  margin_rate_bp: number;
  vol_min: number;
  vol_max: number;
  vol_step: number;
  swap_long: number;
  swap_short: number;
  trade_enabled: boolean;
  bid: number;
  ask: number;
}

export interface Position {
  id: number;
  account: number;
  symbol: number;
  side: Side;
  volume: number;
  open_price: number;
  sl: number;
  tp: number;
  swap: number;
  margin: number;
  open_ts: number;
}

export interface Order {
  id: number;
  account: number;
  symbol: number;
  side: Side;
  kind: OrderKind;
  volume: number;
  price: number;
  sl: number;
  tp: number;
  ts: number;
}

export interface Deal {
  id: number;
  order: number;
  position: number;
  account: number;
  symbol: number;
  side: Side;
  volume: number;
  price: number;
  entry: "In" | "Out";
  reason: "Client" | "Pending" | "StopLoss" | "TakeProfit" | "StopOut";
  profit: number;
  swap: number;
  commission: number;
  ts: number;
}

export interface AccountState {
  id: number;
  balance: number;
  credit: number;
  equity: number;
  margin: number;
  free_margin: number;
  margin_level: number;
}

/** [time in seconds, open, high, low, close, ticks] */
export type Bar = [number, number, number, number, number, number];

export type ServerEvent =
  | { type: "Deal"; client_id: number; deal: Deal }
  | { type: "Position"; position: Position }
  | { type: "PositionClosed"; account: number; position: number }
  | { type: "OrderPlaced"; client_id: number; order: Order }
  | { type: "OrderRemoved"; account: number; order: number; filled: boolean }
  | { type: "Account"; state: AccountState }
  | { type: "Rejected"; account: number; client_id: number; reason: string }
  | { type: "MarginCall"; account: number; margin_level: number }
  | { type: "StopOut"; account: number; margin_level: number }
  | { type: "Balance"; account: number; amount: number; comment: string; ts: number };

export type ServerMsg =
  | {
      type: "LoginOk";
      name: string;
      currency: string;
      mode: "Hedging" | "Netting";
      leverage: number;
      account: AccountState;
      symbols: SymbolInfo[];
      positions: Position[];
      orders: Order[];
      deals: Deal[];
    }
  | { type: "Error"; message: string }
  | { type: "Tick"; s: number; b: number; a: number; t: number }
  | { type: "Event"; event: ServerEvent }
  | { type: "Candles"; s: number; tf: number; bars: Bar[] }
  | { type: "Pong" };

export type ClientMsg =
  | { type: "Login"; account: number; password: string }
  | { type: "Subscribe"; symbols: string[] }
  | {
      type: "Order";
      client_id: number;
      symbol: string;
      side: Side;
      kind: OrderKind;
      volume: number;
      price?: number;
      sl?: number;
      tp?: number;
      position?: number;
    }
  | { type: "Cancel"; order: number }
  | { type: "Modify"; position: number; sl: number; tp: number }
  | { type: "Close"; position: number; volume?: number }
  | { type: "History"; symbol: string; tf: number; count: number }
  | { type: "Ping" };
