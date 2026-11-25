# NTrader

A trading platform for brokers: server backend, Web Trader, Desktop Trader, Android and iOS apps.
It is built to replace MT5 at a broker, one deployment per broker, and to let the broker keep
their liquidity bridge and back-office tools.

**Status: phase 3 of 6, in progress.** The trading core, the client gateway, the Web Trader, the
Manager API and an admin panel work, on simulated prices. There is no FIX gateway yet, and
history is not in a database yet.

## What works today

- **Trading core** (`crates/core`): accounts, groups, symbols, market / limit / stop orders,
  stop loss, take profit and trailing stop, hedging and netting accounts, margin (Forex, CFD, CFD-Leverage),
  margin call and stop-out, commission, swaps, multi-currency conversion.
- **Journal**: every change is written to an append-only log before it is announced. On start the
  server replays the log and is back in exactly the state it stopped in.
- **Client gateway** (`crates/server`): one WebSocket per trader carrying quotes, orders and
  account updates, in MessagePack (binary) or JSON.
- **Web Trader** (`web`):
  - Market Watch with symbol groups, favourites, day change and depth of market.
  - Charts: several tabs, two charts side by side, candles / line / area, six timeframes,
    indicators (moving averages, Bollinger Bands, volume, RSI), drawing tools (trend line,
    horizontal line, Fibonacci, rectangle, text, measure), trade and alert lines, image export,
    full screen, quick Sell / Buy.
  - Order ticket: market, limit and stop orders, stop loss, take profit, trailing stop, sizing by
    risk, optional confirmation instead of one-click trading.
  - Positions (modify, close, close all / profitable / losing), pending orders, deal history,
    exposure, price alerts, broker news, session journal, economic calendar.
  - Light and dark themes, blue/orange or green/red colours, keyboard shortcuts (B, S),
    demo account top-up.
- **Manager API** (`crates/server/src/manager.rs`): REST under `/api/manager` for the back office:
  accounts (create, edit, enable/disable, deposit, withdraw, reset password), groups, symbols,
  all open positions and pending orders (close, cancel), per-account deals, and a summary with
  client money and exposure.
- **Admin panel** (`web`, at `/admin`): dashboard, accounts, positions, pending orders, groups
  and symbols, built on the Manager API.
- **Simulated feed**: random-walk prices so everything can be exercised without market data.
  Chart history and depth of market are simulated too.

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

The admin panel is at http://127.0.0.1:8080/admin, with the manager login from `config.toml`
(`admin` / `admin-demo-1` as shipped). Change that login before the server is reachable by
anyone else: see "Manager logins" below.

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
{"type":"Modify","position":42,"sl":108000,"tp":109000,"trail":200}   // trail: trailing stop distance in points
{"type":"Depth","symbol":"EURUSD"}                          // receive depth of market for one symbol
{"type":"AlertAdd","symbol":"EURUSD","price":109000,"note":"breakout"}
{"type":"AlertDelete","id":3}
{"type":"DemoDeposit","amount":500000000}                   // demo groups only
{"type":"Cancel","order":43}
{"type":"History","symbol":"EURUSD","tf":900,"count":600}   // chart bars, tf in seconds
{"type":"Ping"}
```

Server → client: `LoginOk` (account, symbols, open positions, pending orders, recent deals),
`Tick` (`s` symbol id, `b` bid, `a` ask, `t` time), `Event` (wrapping `Deal`, `Position`,
`PositionClosed`, `OrderPlaced`, `OrderRemoved`, `Account`, `Rejected`, `MarginCall`, `StopOut`,
`Balance`), `Candles` (bars as `[time, open, high, low, close, ticks]`), `Depth` (bid and ask
levels as `[price, volume]`), `Alerts` (the account's alert list, sent when it changes or one
fires), `Error` and `Pong` (with the server time). Definitions: `crates/server/src/protocol.rs` and
`crates/core/src/types.rs`.

## Manager API

Sign in, then send the token on every call. Money, volumes and prices are the same scaled integers
as in the trader protocol.

```powershell
$login = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/manager/login `
  -ContentType "application/json" -Body '{"login":"admin","password":"admin-demo-1"}'
$auth = @{ Authorization = "Bearer $($login.token)" }
Invoke-RestMethod -Uri http://127.0.0.1:8080/api/manager/accounts -Headers $auth
```

| Method and path | Does |
|---|---|
| `POST /login`, `POST /logout` | Start and end a manager session (12 hours) |
| `GET /summary` | Counts, client money per currency, exposure per symbol |
| `GET /groups`, `POST /groups`, `PUT /groups/{name}` | List, create, change groups |
| `GET /symbols`, `POST /symbols`, `PUT /symbols/{name}` | List, create, change symbols |
| `GET /accounts?search=&group=&limit=`, `POST /accounts` | List and create accounts |
| `GET /accounts/{id}`, `PATCH /accounts/{id}` | Account with positions, orders, deals; change name, leverage, enabled |
| `POST /accounts/{id}/balance` | Deposit (positive) or withdraw (negative) |
| `POST /accounts/{id}/password` | Set a new trader password |
| `GET /positions`, `POST /positions/{id}/close` | All open positions; close one at market |
| `GET /orders`, `DELETE /orders/{id}` | All pending orders; cancel one |

All paths are under `/api/manager`. Errors come back as `{"error": "..."}` with a 4xx status.

### Manager logins

Managers are listed in `config.toml` and read at every start:

```toml
[[manager]]
login = "ops"
password_hash = "$argon2id$v=19$m=19456,t=2,p=1$..."   # Argon2, PHC format
```

`password = "..."` is accepted for development and logs a warning. With no `[[manager]]` entry
the Manager API and the admin panel refuse every login.

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 1 | Trading core, journal, client gateway, simulated feed | Done |
| 2 | Web Trader: every feature in the approved design | Done |
| 3 | Manager API and admin panel (done); PostgreSQL for history and reports (not yet) | In progress |
| 4 | FIX 4.4 gateway, A-book routing to liquidity bridges, real feeds | |
| 5 | MT5 importer: groups, symbols, accounts, positions, history | |
| 6 | Desktop Trader, Android and iOS apps | |

## Known limits

- Manager API: every manager has full access (no roles), sessions are lost when the server
  restarts, and there is no audit report of manager actions beyond the journal. The admin panel
  refreshes every three seconds rather than streaming.
- A symbol added while the server runs has no prices until a feed quotes it, and traders see it
  after they sign in again. An account cannot be moved to another group.
- Deal history is still in memory (the last 500 to 1000 deals per account, rebuilt from the
  journal at start). PostgreSQL storage and reports are the rest of phase 3.

- Depth of market is simulated: the server invents an order book around the quote. Real depth
  needs a feed that carries it (phase 4).
- The economic calendar and news show what the broker writes under `[[announcement]]` in
  `config.toml`. There is no connection to a calendar or news provider.
- Deposit only tops up demo accounts (groups with `demo = true`). Real payments belong to the
  back office (phase 3).
- Price alerts are stored on the server (`data/alerts.json`) but are only shown inside the Web
  Trader. There is no email or push notification.
- Favourites, chart tabs, drawings and settings are saved in the browser, not on the server.
- Trailing stops move in steps of a tenth of their distance, not on every tick.
- Chart bars are kept in memory only, from server start; history before that is simulated when the
  simulator is on and empty otherwise.

- Execution is B-book only: every order fills at the current quote. A-book routing is phase 4.
- A fully hedged pair of positions is charged margin on both legs (MT5 charges a reduced hedged margin).
- No per-group spread markup, no trading sessions or holidays, no symbol-level stop distance.
- No deal history database: the last 500 deals per account are kept in memory and rebuilt from the journal.
- The journal grows without bound; snapshots and rotation come with phase 3.
- No TLS in the server itself; put it behind a TLS-terminating proxy before exposing it.
- The demo passwords in `config.toml` are for development only.
