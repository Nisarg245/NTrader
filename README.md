# NTrader

A trading platform for brokers: server backend, Web Trader, Desktop Trader, Android and iOS apps.
It is built to replace MT5 at a broker, one deployment per broker, and to let the broker keep
their liquidity bridge and back-office tools.

**Status: phase 2 of 6.** The trading core, the client gateway and a first Web Trader work, on
simulated prices. There is no FIX gateway and no admin panel yet.

## What works today

- **Trading core** (`crates/core`): accounts, groups, symbols, market / limit / stop orders,
  stop loss and take profit, hedging and netting accounts, margin (Forex, CFD, CFD-Leverage),
  margin call and stop-out, commission, swaps, multi-currency conversion.
- **Journal**: every change is written to an append-only log before it is announced. On start the
  server replays the log and is back in exactly the state it stopped in.
- **Client gateway** (`crates/server`): one WebSocket per trader carrying quotes, orders and
  account updates, in MessagePack (binary) or JSON.
- **Web Trader** (`web`): login, live market watch, candlestick chart with timeframes and a moving
  average, trade lines on the chart, order ticket (market, limit, stop, stop loss, take profit,
  sizing by risk), positions with modify and close, pending orders, deal history.
- **Simulated feed**: random-walk prices so everything can be exercised without market data.
  Chart history is simulated too.

## Run it

Needs [Rust](https://rustup.rs) (stable) and [Node.js](https://nodejs.org) 22 or newer.

```powershell
cd web
npm install
npm run build
cd ..
cargo run --release -p ntrader-server
```

Then open http://127.0.0.1:8080 and sign in with a demo login: `1001` / `demo1001` (hedging) or
`1002` / `demo1002` (netting).

The server reads `config.toml`, creates the demo groups, symbols and accounts on first start,
serves the built Web Trader from `web/dist`, and takes trader connections on
`ws://127.0.0.1:8080/ws`. While working on the Web Trader, `npm run dev` in `web` gives live
reload on its own port and forwards `/ws` to the server.

```powershell
cargo test --release                                   # engine tests
cargo run --release -p ntrader-core --example bench    # throughput benchmark
node tools/smoke.mjs                                   # end-to-end check against a running server (Node 22+)
```

## Performance

`cargo run --release -p ntrader-core --example bench`, single core, 10,000 accounts holding 50,000
open positions with stops across 20 symbols:

| | Throughput | Per operation |
|---|---|---|
| Ticks, each checking all stops, pending orders and margin levels on its symbol | about 11 million / s | about 90 ns |
| Orders, with margin check | about 0.8 million / s | about 1.3 µs |

Measured on the development machine; the benchmark also runs in CI, so numbers for the CI runner
are in each run's log. These are engine numbers only: they exclude the network and the journal.

How the tick path stays that fast:

- All state lives on one thread, in memory. No locks, no database on the hot path.
- Prices, volumes and money are scaled integers, never floating point.
- Stops and pending orders sit in price-ordered books, so a tick only touches what it fires.
- Margin levels are not recomputed on every tick. Each account's distance to its next margin
  level is converted into trigger prices, and the account is re-checked only when one is crossed.
  The tests verify this gives the same result as checking every account on every tick.

## Units

| Value | Stored as | Example |
|---|---|---|
| Price | integer, scaled by `10^digits` | EURUSD 1.08345 → `108345` |
| Volume | 1/10000 lot | 0.10 lot → `1000` |
| Money | millionths of the account currency | 250.00 USD → `250000000` |
| Time | Unix milliseconds | |

## Client protocol

Connect to `/ws` and send `Login` first. Binary frames are MessagePack, text frames are JSON with
the same field names; the server replies in the format of the login frame.

Client → server:

```jsonc
{"type":"Login","account":1001,"password":"demo1001"}
{"type":"Subscribe","symbols":["EURUSD","XAUUSD"]}
{"type":"Order","client_id":1,"symbol":"EURUSD","side":"Buy","kind":"Market","volume":1000,"sl":0,"tp":0}
{"type":"Order","client_id":2,"symbol":"EURUSD","side":"Sell","kind":"Limit","volume":1000,"price":109500}
{"type":"Order","symbol":"EURUSD","side":"Sell","kind":"Market","volume":500,"position":42}   // hedging: partial close
{"type":"Close","position":42}
{"type":"Modify","position":42,"sl":108000,"tp":109000}
{"type":"Cancel","order":43}
{"type":"History","symbol":"EURUSD","tf":900,"count":600}   // chart bars, tf in seconds
{"type":"Ping"}
```

Server → client: `LoginOk` (account, symbols, open positions, pending orders, recent deals),
`Tick` (`s` symbol id, `b` bid, `a` ask, `t` time), `Event` (wrapping `Deal`, `Position`,
`PositionClosed`, `OrderPlaced`, `OrderRemoved`, `Account`, `Rejected`, `MarginCall`, `StopOut`,
`Balance`), `Candles` (bars as `[time, open, high, low, close, ticks]`), `Error` and `Pong`. Definitions: `crates/server/src/protocol.rs` and
`crates/core/src/types.rs`.

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 1 | Trading core, journal, client gateway, simulated feed | Done |
| 2 | Web Trader: quotes, chart, order ticket, positions, history | First version done |
| 3 | Manager API (REST + WebSocket), admin panel, PostgreSQL for history and reports | |
| 4 | FIX 4.4 gateway, A-book routing to liquidity bridges, real feeds | |
| 5 | MT5 importer: groups, symbols, accounts, positions, history | |
| 6 | Desktop Trader, Android and iOS apps | |

## Known limits

- Web Trader: no depth of market, alerts, trailing stop, drawing tools, multiple chart tabs, light
  theme, economic calendar or deposit yet. These are in the approved design and still to build.
- Chart bars are kept in memory only, from server start; history before that is simulated when the
  simulator is on and empty otherwise.

- Execution is B-book only: every order fills at the current quote. A-book routing is phase 4.
- A fully hedged pair of positions is charged margin on both legs (MT5 charges a reduced hedged margin).
- No per-group spread markup, no trading sessions or holidays, no symbol-level stop distance.
- No deal history database: the last 500 deals per account are kept in memory and rebuilt from the journal.
- The journal grows without bound; snapshots and rotation come with phase 3.
- No TLS in the server itself; put it behind a TLS-terminating proxy before exposing it.
- The demo passwords in `config.toml` are for development only.
