mod alerts;
mod candles;
mod config;
mod manager;
mod protocol;

use alerts::{Alert, Alerts};
use anyhow::{Context, Result};
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, SaltString};
use argon2::{Argon2, PasswordVerifier};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use candles::Candles;
use config::Config;
use ntrader_core::*;
use protocol::{Bar, ClientMsg, ServerMsg, SymbolInfo};
use rand::{rngs::SmallRng, Rng, SeedableRng};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, mpsc, oneshot};

/// Deals kept in memory per account for the history tab (until phase 3 adds a database).
const HISTORY_PER_ACCOUNT: usize = 500;

type History = HashMap<AccountId, Vec<Deal>>;

/// State derived from the event and tick streams, owned by the engine thread.
struct Derived {
    history: History,
    candles: Candles,
    alerts: Alerts,
}

type Query = Box<dyn FnOnce(&Engine, &mut Derived) + Send>;

/// Something pushed to the sessions of one account.
enum Push {
    Event(Event),
    Alerts {
        account: AccountId,
        alerts: Vec<Alert>,
        fired: Option<u64>,
    },
}

/// Depth of market for one symbol: (price, volume) levels, best first.
struct DepthMsg {
    symbol: SymbolId,
    bids: Vec<(Price, Volume)>,
    asks: Vec<(Price, Volume)>,
}

enum Msg {
    Cmd(Command),
    /// Run a query or a change to derived state on the engine thread.
    Call(Query),
    /// Apply a command and hand its events back to the caller (Manager API).
    Exec(Command, oneshot::Sender<Vec<Event>>),
}

#[derive(Clone, Copy)]
struct Tick {
    symbol: SymbolId,
    bid: Price,
    ask: Price,
    ts: Ts,
}

struct App {
    engine: mpsc::UnboundedSender<Msg>,
    ticks: broadcast::Sender<Tick>,
    events: broadcast::Sender<Arc<Push>>,
    depth: broadcast::Sender<Arc<DepthMsg>>,
    /// Symbol ids by name. Managers can add symbols while the server runs.
    symbols: std::sync::RwLock<HashMap<String, SymbolId>>,
    announcements: Vec<config::Announcement>,
    managers: manager::Managers,
}

impl App {
    fn symbol(&self, name: &str) -> Option<SymbolId> {
        self.symbols.read().ok()?.get(name).copied()
    }
}

fn now() -> Ts {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as Ts)
        .unwrap_or(0)
}

fn record(history: &mut History, ev: &Event) {
    if let Event::Deal { deal, .. } = ev {
        let h = history.entry(deal.account).or_default();
        if h.len() >= HISTORY_PER_ACCOUNT * 2 {
            h.drain(..HISTORY_PER_ACCOUNT);
        }
        h.push(*deal);
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().init();
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config.toml".into());
    let cfg: Config =
        toml::from_str(&std::fs::read_to_string(&path).with_context(|| format!("reading {path}"))?)
            .with_context(|| format!("parsing {path}"))?;

    if let Some(dir) = cfg.journal.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut history = History::new();
    let mut node = Node::open(&cfg.journal, |ev| record(&mut history, ev))
        .with_context(|| format!("opening journal {}", cfg.journal.display()))?;
    node.sync = cfg.journal_sync;
    if node.engine.symbols().next().is_none() {
        bootstrap(&mut node, &cfg)?;
    }
    tracing::info!(
        accounts = node.engine.account_count(),
        positions = node.engine.position_count(),
        "engine ready"
    );

    let symbols: HashMap<String, SymbolId> = node
        .engine
        .symbols()
        .map(|(id, spec, ..)| (spec.name.clone(), id))
        .collect();
    let (engine_tx, engine_rx) = mpsc::unbounded_channel();
    let (ticks, _) = broadcast::channel(1 << 16);
    let (events, _) = broadcast::channel(1 << 16);
    let mut candles = Candles::default();
    if cfg.feed.sim_ticks_per_second > 0 && cfg.feed.sim_history_minutes > 0 {
        seed_history(&mut candles, &cfg, &symbols);
    }
    let alerts = Alerts::load(cfg.journal.with_file_name("alerts.json"));
    let derived = Derived {
        history,
        candles,
        alerts,
    };
    let (depth, _) = broadcast::channel(1 << 10);
    let app = Arc::new(App {
        engine: engine_tx.clone(),
        ticks: ticks.clone(),
        events: events.clone(),
        depth,
        symbols: std::sync::RwLock::new(symbols),
        announcements: cfg.announcements.clone(),
        managers: manager::Managers::from_config(&cfg.managers)?,
    });

    // The engine owns all trading state on one dedicated thread: no locks on the hot path.
    std::thread::Builder::new()
        .name("engine".into())
        .spawn(move || run_engine(node, derived, engine_rx, ticks, events))?;

    let addr = std::env::var("NTRADER_LISTEN").unwrap_or_else(|_| cfg.listen.clone());
    let web_root = cfg.web_root.clone();
    if cfg.feed.sim_ticks_per_second > 0 {
        tokio::spawn(simulate_feed(cfg, app.clone()));
        tracing::warn!("simulated feed is ON - prices are random, not market data");
    }

    let mut router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(upgrade))
        .route(
            "/admin",
            get(|| async { axum::response::Redirect::to("/admin.html") }),
        )
        .nest("/api/manager", manager::router(app.clone()))
        .with_state(app);
    if let Some(root) = &web_root {
        if root.join("index.html").exists() {
            tracing::info!("serving Web Trader from {}", root.display());
            router = router.fallback_service(tower_http::services::ServeDir::new(root));
        } else {
            tracing::warn!(
                "web_root {} has no index.html - build the Web Trader first (see README)",
                root.display()
            );
        }
    }
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    tracing::info!("client gateway listening on ws://{addr}/ws");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

/// First start: create groups, symbols and accounts from the config file.
fn bootstrap(node: &mut Node, cfg: &Config) -> Result<()> {
    let mut out = Vec::new();
    let mut cmds = Vec::new();
    for g in &cfg.groups {
        cmds.push(Command::AddGroup { spec: g.clone() });
    }
    for s in &cfg.symbols {
        cmds.push(Command::AddSymbol {
            spec: s.spec.clone(),
        });
    }
    for a in &cfg.accounts {
        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default()
            .hash_password(a.password.as_bytes(), &salt)
            .map_err(|e| anyhow::anyhow!("hashing password: {e}"))?
            .to_string();
        cmds.push(Command::CreateAccount {
            id: a.id,
            group: a.group.clone(),
            name: a.name.clone(),
            password_hash: hash,
            leverage: 0,
            ts: now(),
        });
        if a.deposit > 0.0 {
            cmds.push(Command::Balance {
                account: a.id,
                amount: (a.deposit * MONEY_SCALE as f64).round() as Money,
                comment: "Initial deposit".into(),
                ts: now(),
            });
        }
    }
    for c in &cmds {
        node.apply(c, &mut out)?;
    }
    for ev in &out {
        if let Event::Rejected { reason, .. } = ev {
            anyhow::bail!("config rejected by the engine: {reason:?}");
        }
    }
    tracing::info!("bootstrapped from config: {} commands", cmds.len());
    Ok(())
}

fn run_engine(
    mut node: Node,
    mut derived: Derived,
    mut rx: mpsc::UnboundedReceiver<Msg>,
    ticks: broadcast::Sender<Tick>,
    events: broadcast::Sender<Arc<Push>>,
) {
    let mut out = Vec::new();
    while let Some(msg) = rx.blocking_recv() {
        match msg {
            Msg::Exec(cmd, reply) => {
                if let Err(e) = node.apply(&cmd, &mut out) {
                    tracing::error!("journal write failed, stopping engine: {e}");
                    std::process::exit(1);
                }
                let _ = reply.send(out.clone());
                for ev in out.drain(..) {
                    record(&mut derived.history, &ev);
                    let _ = events.send(Arc::new(Push::Event(ev)));
                }
            }
            Msg::Cmd(cmd) => {
                if let Err(e) = node.apply(&cmd, &mut out) {
                    // Never publish events that are not on disk.
                    tracing::error!("journal write failed, stopping engine: {e}");
                    std::process::exit(1);
                }
                if let Command::Tick {
                    symbol,
                    bid,
                    ask,
                    ts,
                } = cmd
                {
                    derived.candles.tick(symbol, bid, ts);
                    for (account, id) in derived.alerts.on_tick(symbol, bid, ts) {
                        let _ = events.send(Arc::new(Push::Alerts {
                            account,
                            alerts: derived.alerts.of(account),
                            fired: Some(id),
                        }));
                    }
                    let _ = ticks.send(Tick {
                        symbol,
                        bid,
                        ask,
                        ts,
                    });
                }
                for ev in out.drain(..) {
                    record(&mut derived.history, &ev);
                    let _ = events.send(Arc::new(Push::Event(ev)));
                }
            }
            Msg::Call(f) => f(&node.engine, &mut derived),
        }
    }
}

/// Made-up one-minute bars ending at each symbol's simulator start price, so
/// charts have something to show in development.
fn seed_history(candles: &mut Candles, cfg: &Config, symbols: &HashMap<String, SymbolId>) {
    let mut rng = SmallRng::from_entropy();
    let minutes = cfg.feed.sim_history_minutes.min(10_000) as i64;
    let end = now() / 60_000 * 60 - 60;
    // A bar spans this many simulated ticks; a tick moves about 0.58 * sim_step.
    let per_bar = (cfg.feed.sim_ticks_per_second as f64 * 60.0).sqrt() * 0.58;
    for s in cfg.symbols.iter().filter(|s| s.sim_price > 0.0) {
        let Some(&id) = symbols.get(&s.spec.name) else {
            continue;
        };
        let step = if s.sim_step > 0.0 { s.sim_step } else { 1.0 } * per_bar;
        let mut walk = Vec::with_capacity(minutes as usize);
        let mut mid = 0.0f64;
        for _ in 0..minutes {
            let open = mid;
            let mut high = open;
            let mut low = open;
            for _ in 0..4 {
                mid += rng.gen_range(-1.0..1.0) * step / 2.0;
                high = high.max(mid);
                low = low.min(mid);
            }
            walk.push((open, high, low, mid));
        }
        // Tick counts like the live simulator produces, so the volume pane has a sensible scale.
        let per_minute = cfg.feed.sim_ticks_per_second * 60;
        let mut ticks = || {
            rng.gen_range(per_minute * 7 / 10..=per_minute * 13 / 10)
                .max(1)
        };
        // Shift the whole walk so it ends at the configured start price.
        let shift = s.sim_price * 10f64.powi(s.spec.digits as i32) - mid;
        let bars = walk
            .iter()
            .enumerate()
            .map(|(i, (o, h, l, c))| {
                let p = |v: &f64| ((v + shift).round() as Price).max(1);
                Bar(
                    end - (minutes - 1 - i as i64) * 60,
                    p(o),
                    p(h),
                    p(l),
                    p(c),
                    ticks(),
                )
            })
            .collect();
        candles.seed(id, bars);
    }
    tracing::warn!("chart history for the last {minutes} minutes is simulated");
}

/// Random-walk quotes so the platform can be exercised without a market feed.
async fn simulate_feed(cfg: Config, app: Arc<App>) {
    struct Sim {
        id: SymbolId,
        mid: f64,
        spread: i64,
        step: f64,
        depth_at: std::time::Instant,
    }
    let mut sims: Vec<Sim> = cfg
        .symbols
        .iter()
        .filter(|s| s.sim_price > 0.0)
        .filter_map(|s| {
            Some(Sim {
                id: app.symbol(&s.spec.name)?,
                mid: s.sim_price * 10f64.powi(s.spec.digits as i32),
                spread: s.sim_spread.max(0),
                step: if s.sim_step > 0.0 { s.sim_step } else { 1.0 },
                depth_at: std::time::Instant::now(),
            })
        })
        .collect();
    if sims.is_empty() {
        return;
    }
    let mut rng = SmallRng::from_entropy();
    let period =
        Duration::from_secs_f64(1.0 / (cfg.feed.sim_ticks_per_second as f64 * sims.len() as f64));
    let mut timer = tokio::time::interval(period);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
    loop {
        timer.tick().await;
        let i = rng.gen_range(0..sims.len());
        let s = &mut sims[i];
        // Sum of uniforms: a cheap bell-shaped step.
        let z: f64 = (0..4).map(|_| rng.gen_range(-1.0..1.0)).sum::<f64>() / 2.0;
        s.mid = (s.mid + z * s.step).max(s.spread as f64 + 1.0);
        let bid = (s.mid - s.spread as f64 / 2.0).round() as Price;
        let cmd = Command::Tick {
            symbol: s.id,
            bid,
            ask: bid + s.spread,
            ts: now(),
        };
        if app.engine.send(Msg::Cmd(cmd)).is_err() {
            return;
        }
        // A made-up order book around the quote, a few times a second.
        if s.depth_at.elapsed() >= Duration::from_millis(300) && app.depth.receiver_count() > 0 {
            s.depth_at = std::time::Instant::now();
            let mut side = |best: Price, dir: i64| -> Vec<(Price, Volume)> {
                (0..5)
                    .map(|i| (best + dir * i, rng.gen_range(5..=100) * 1_000))
                    .collect()
            };
            let msg = DepthMsg {
                symbol: s.id,
                bids: side(bid, -1),
                asks: side(bid + s.spread, 1),
            };
            let _ = app.depth.send(Arc::new(msg));
        }
    }
}

async fn upgrade(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> Response {
    ws.max_message_size(64 * 1024)
        .on_upgrade(move |socket| async move {
            if let Err(e) = session(socket, app).await {
                tracing::debug!("session ended: {e}");
            }
        })
}

fn decode(msg: &Message) -> Option<(Result<ClientMsg, String>, bool)> {
    match msg {
        Message::Text(t) => Some((
            serde_json::from_str(t.as_str()).map_err(|e| e.to_string()),
            false,
        )),
        Message::Binary(b) => Some((rmp_serde::from_slice(b).map_err(|e| e.to_string()), true)),
        _ => None,
    }
}

fn encode(msg: &ServerMsg, binary: bool) -> Result<Message> {
    Ok(if binary {
        Message::Binary(rmp_serde::to_vec_named(msg)?.into())
    } else {
        Message::Text(serde_json::to_string(msg)?.into())
    })
}

/// Ask the engine thread a question and wait for the answer.
async fn call<T: Send + 'static>(
    app: &App,
    f: impl FnOnce(&Engine, &mut Derived) -> T + Send + 'static,
) -> Result<T> {
    let (tx, rx) = oneshot::channel();
    app.engine
        .send(Msg::Call(Box::new(move |e, h| {
            let _ = tx.send(f(e, h));
        })))
        .map_err(|_| anyhow::anyhow!("engine stopped"))?;
    Ok(rx.await?)
}

async fn session(mut ws: WebSocket, app: Arc<App>) -> Result<()> {
    // 1. Login. Nothing else is accepted first, and the client gets 10 seconds.
    let first = tokio::time::timeout(Duration::from_secs(10), ws.recv())
        .await?
        .context("closed before login")??;
    let Some((Ok(ClientMsg::Login { account, password }), binary)) = decode(&first) else {
        let _ = ws
            .send(encode(
                &ServerMsg::Error {
                    message: "login required",
                },
                !matches!(first, Message::Text(_)),
            )?)
            .await;
        return Ok(());
    };
    let hash = call(&app, move |e, _| e.password_hash(account).map(String::from)).await?;
    let ok = tokio::task::spawn_blocking(move || {
        // Unknown accounts take the same time as wrong passwords.
        const DUMMY: &str = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm8";
        let known = hash.is_some();
        let hash = hash.unwrap_or_else(|| DUMMY.into());
        let valid = PasswordHash::new(&hash)
            .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
            .unwrap_or(false);
        known && valid
    })
    .await?;
    if !ok {
        ws.send(encode(
            &ServerMsg::Error {
                message: "invalid login",
            },
            binary,
        )?)
        .await?;
        return Ok(());
    }

    // 2. Subscribe before the snapshot so no event is missed in between.
    //    An event may then arrive twice; clients apply events idempotently by id.
    let mut ticks = app.ticks.subscribe();
    let mut events = app.events.subscribe();
    let mut depth = app.depth.subscribe();
    let mut depth_symbol: Option<SymbolId> = None;
    let snapshot = call(&app, move |e, d| {
        let g = e.account_group(account)?;
        let deals = d
            .history
            .get(&account)
            .map(|d| d[d.len().saturating_sub(HISTORY_PER_ACCOUNT)..].to_vec());
        Some((
            e.account_name(account)?.to_string(),
            g.currency.clone(),
            g.mode,
            e.account_leverage(account)?,
            e.account_state(account)?,
            e.symbols()
                .map(|(id, spec, bid, ask, _)| SymbolInfo {
                    id,
                    spec: spec.clone(),
                    bid,
                    ask,
                    day_open: d.candles.day_open(id, now()),
                })
                .collect::<Vec<_>>(),
            e.positions_of(account),
            e.orders_of(account),
            deals.unwrap_or_default(),
            g.demo,
            d.alerts.of(account),
        ))
    })
    .await?
    .context("account vanished")?;
    let mut watching = vec![false; snapshot.5.len()];
    ws.send(encode(
        &ServerMsg::LoginOk {
            name: snapshot.0,
            currency: snapshot.1,
            mode: snapshot.2,
            leverage: snapshot.3,
            account: snapshot.4,
            symbols: snapshot.5,
            positions: snapshot.6,
            orders: snapshot.7,
            deals: snapshot.8,
            demo: snapshot.9,
            alerts: snapshot.10,
            announcements: &app.announcements,
        },
        binary,
    )?)
    .await?;
    tracing::info!(account, "login");

    // 3. Pump.
    loop {
        tokio::select! {
            msg = ws.recv() => {
                let Some(msg) = msg else { break };
                let msg = msg?;
                if matches!(msg, Message::Close(_)) { break }
                let Some((parsed, _)) = decode(&msg) else { continue };
                let reply = match parsed {
                    Ok(ClientMsg::History { symbol, tf, count }) => {
                        match app.symbol(&symbol) {
                            Some(s) if (60..=86_400).contains(&tf) && tf % 60 == 0 => {
                                let count = if count == 0 { 500 } else { count.min(2_000) } as usize;
                                let bars = call(&app, move |_, d| d.candles.get(s, tf, count)).await?;
                                Some(ServerMsg::Candles { s, tf, bars })
                            }
                            Some(_) => Some(ServerMsg::Error { message: "unsupported timeframe" }),
                            None => Some(ServerMsg::Error { message: "unknown symbol" }),
                        }
                    }
                    Ok(ClientMsg::Depth { symbol }) => {
                        depth_symbol = app.symbol(&symbol);
                        None
                    }
                    Ok(ClientMsg::AlertAdd { symbol, price, note }) => {
                        match app.symbol(&symbol) {
                            Some(s) => {
                                let events = app.events.clone();
                                let result = call(&app, move |e, d| {
                                    let bid = e.quote(s).map(|q| q.0).unwrap_or(0);
                                    let r = d.alerts.add(account, s, price, &note, bid, now());
                                    if r.is_ok() {
                                        let alerts = d.alerts.of(account);
                                        let _ = events.send(Arc::new(Push::Alerts { account, alerts, fired: None }));
                                    }
                                    r
                                }).await?;
                                result.err().map(|message| ServerMsg::Error { message })
                            }
                            None => Some(ServerMsg::Error { message: "unknown symbol" }),
                        }
                    }
                    Ok(ClientMsg::AlertDelete { id }) => {
                        let events = app.events.clone();
                        call(&app, move |_, d| {
                            if d.alerts.delete(account, id) {
                                let alerts = d.alerts.of(account);
                                let _ = events.send(Arc::new(Push::Alerts { account, alerts, fired: None }));
                            }
                        }).await?;
                        None
                    }
                    Ok(ClientMsg::DemoDeposit { amount }) => {
                        let demo = call(&app, move |e, _| e.account_group(account).is_some_and(|g| g.demo)).await?;
                        if !demo {
                            Some(ServerMsg::Error { message: "deposits to live accounts are handled by your broker" })
                        } else if amount <= 0 || amount > 1_000_000 * MONEY_SCALE {
                            Some(ServerMsg::Error { message: "enter an amount between 1 and 1,000,000" })
                        } else {
                            let cmd = Command::Balance { account, amount, comment: "Demo top-up".into(), ts: now() };
                            let _ = app.engine.send(Msg::Cmd(cmd));
                            None
                        }
                    }
                    Ok(m) => handle(&app, account, m, &mut watching),
                    Err(_) => Some(ServerMsg::Error { message: "malformed message" }),
                };
                if let Some(r) = reply {
                    ws.send(encode(&r, binary)?).await?;
                }
            }
            t = ticks.recv() => match t {
                Ok(t) => {
                    if watching.get(t.symbol as usize).copied().unwrap_or(false) {
                        let m = ServerMsg::Tick { s: t.symbol, b: t.bid, a: t.ask, t: t.ts };
                        ws.send(encode(&m, binary)?).await?;
                    }
                }
                // A slow client skips stale quotes; the next tick brings it up to date.
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => break,
            },
            d = depth.recv() => {
                // Depth is a snapshot stream: anything missed is simply replaced by the next one.
                if let Ok(d) = d {
                    if depth_symbol == Some(d.symbol) {
                        let m = ServerMsg::Depth { s: d.symbol, bids: &d.bids, asks: &d.asks, simulated: true };
                        ws.send(encode(&m, binary)?).await?;
                    }
                }
            }
            e = events.recv() => match e {
                Ok(push) => match &*push {
                    Push::Event(ev) if ev.account() == Some(account) => {
                        ws.send(encode(&ServerMsg::Event { event: ev }, binary)?).await?;
                    }
                    Push::Alerts { account: a, alerts, fired } if *a == account => {
                        let m = ServerMsg::Alerts { alerts: alerts.clone(), fired: *fired };
                        ws.send(encode(&m, binary)?).await?;
                    }
                    _ => {}
                },
                // Trade events must not be skipped: drop the client so it logs in again
                // and gets a fresh snapshot.
                Err(_) => break,
            },
        }
    }
    tracing::info!(account, "logout");
    Ok(())
}

fn handle(
    app: &App,
    account: AccountId,
    msg: ClientMsg,
    watching: &mut Vec<bool>,
) -> Option<ServerMsg<'static>> {
    let ts = now();
    let cmd = match msg {
        ClientMsg::Login { .. } => {
            return Some(ServerMsg::Error {
                message: "already logged in",
            })
        }
        ClientMsg::Ping => return Some(ServerMsg::Pong { t: ts }),
        // Answered in the session loop, because they wait for the engine or change session state.
        ClientMsg::History { .. }
        | ClientMsg::Depth { .. }
        | ClientMsg::AlertAdd { .. }
        | ClientMsg::AlertDelete { .. }
        | ClientMsg::DemoDeposit { .. } => return None,
        ClientMsg::Subscribe { symbols } => {
            for i in symbols.iter().filter_map(|s| app.symbol(s)) {
                // Symbols added since this session logged in are beyond the list it started with.
                if i as usize >= watching.len() {
                    watching.resize(i as usize + 1, false);
                }
                watching[i as usize] = true;
            }
            return None;
        }
        ClientMsg::Unsubscribe { symbols } => {
            for i in symbols.iter().filter_map(|s| app.symbol(s)) {
                if let Some(w) = watching.get_mut(i as usize) {
                    *w = false;
                }
            }
            return None;
        }
        ClientMsg::Order {
            client_id,
            symbol,
            side,
            kind,
            volume,
            price,
            sl,
            tp,
            position,
            trail,
        } => {
            let Some(symbol) = app.symbol(&symbol) else {
                return Some(ServerMsg::Error {
                    message: "unknown symbol",
                });
            };
            Command::PlaceOrder {
                req: OrderRequest {
                    account,
                    client_id,
                    symbol,
                    side,
                    kind,
                    volume,
                    price,
                    sl,
                    tp,
                    position,
                    trail,
                    ts,
                },
            }
        }
        ClientMsg::Cancel { order } => Command::CancelOrder { account, order, ts },
        ClientMsg::Modify {
            position,
            sl,
            tp,
            trail,
        } => Command::ModifyPosition {
            account,
            position,
            sl,
            tp,
            trail,
            ts,
        },
        ClientMsg::Close { position, volume } => Command::ClosePosition {
            account,
            position,
            volume,
            ts,
        },
    };
    // The account id always comes from the session, never from the client message.
    let _ = app.engine.send(Msg::Cmd(cmd));
    None
}
