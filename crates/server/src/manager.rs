//! Manager API: what a broker's back office uses to run the server.
//!
//! REST over HTTP under `/api/manager`. Sign in with `POST /login` and send the
//! returned token as `Authorization: Bearer <token>` on every other call.
//! Prices, volumes and money use the same scaled integers as the trader
//! protocol (see `ntrader_core::types`).

use crate::config::ManagerConfig;
use crate::{call, now, App, Msg};
use anyhow::Result;
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, SaltString};
use argon2::{Argon2, PasswordVerifier};
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use ntrader_core::*;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const SESSION: Duration = Duration::from_secs(12 * 3600);
const MIN_PASSWORD: usize = 8;

// ------------------------------------------------------------------- logins

pub struct Managers {
    /// (login, Argon2 hash)
    creds: Vec<(String, String)>,
    /// token -> (login, expiry)
    sessions: Mutex<HashMap<String, (String, Instant)>>,
}

impl Managers {
    pub fn from_config(cfg: &[ManagerConfig]) -> Result<Managers> {
        let mut creds = Vec::new();
        for m in cfg {
            let hash = if !m.password_hash.is_empty() {
                PasswordHash::new(&m.password_hash)
                    .map_err(|e| anyhow::anyhow!("manager {}: bad password_hash: {e}", m.login))?;
                m.password_hash.clone()
            } else if !m.password.is_empty() {
                tracing::warn!(
                    "manager '{}' has a plain password in the config file - use password_hash in production",
                    m.login
                );
                hash_password(&m.password)?
            } else {
                anyhow::bail!("manager {} needs a password or a password_hash", m.login);
            };
            creds.push((m.login.clone(), hash));
        }
        if creds.is_empty() {
            tracing::warn!("no [[manager]] in the config: the Manager API and admin panel are off");
        }
        Ok(Managers {
            creds,
            sessions: Mutex::new(HashMap::new()),
        })
    }

    fn login_of(&self, token: &str) -> Option<String> {
        let mut sessions = self.sessions.lock().ok()?;
        let now = Instant::now();
        sessions.retain(|_, (_, expiry)| *expiry > now);
        sessions.get(token).map(|(login, _)| login.clone())
    }
}

pub fn hash_password(password: &str) -> Result<String> {
    Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("hashing password: {e}"))
}

// ------------------------------------------------------------------- errors

struct ApiError(StatusCode, String);

impl ApiError {
    fn bad(message: impl Into<String>) -> ApiError {
        ApiError(StatusCode::BAD_REQUEST, message.into())
    }
    fn not_found(message: impl Into<String>) -> ApiError {
        ApiError(StatusCode::NOT_FOUND, message.into())
    }
    fn internal(e: impl std::fmt::Display) -> ApiError {
        tracing::error!("manager api: {e}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
    }
    fn rejected(reason: Reject) -> ApiError {
        let (status, message) = match reason {
            Reject::UnknownAccount => (StatusCode::NOT_FOUND, "no such account"),
            Reject::UnknownSymbol => (StatusCode::NOT_FOUND, "no such symbol"),
            Reject::UnknownGroup => (StatusCode::NOT_FOUND, "no such group"),
            Reject::PositionNotFound => (StatusCode::NOT_FOUND, "no such position"),
            Reject::OrderNotFound => (StatusCode::NOT_FOUND, "no such order"),
            Reject::AlreadyExists => (StatusCode::CONFLICT, "that name or number is already in use"),
            Reject::Immutable => (
                StatusCode::BAD_REQUEST,
                "that setting is fixed once created (currency, mode, digits, contract size, margin mode)",
            ),
            Reject::InvalidSettings => (StatusCode::BAD_REQUEST, "a setting is missing or out of range"),
            Reject::NoMoney => (
                StatusCode::BAD_REQUEST,
                "the account does not have that much free balance",
            ),
            _ => (StatusCode::BAD_REQUEST, "the engine rejected the request"),
        };
        ApiError(status, format!("{message} ({reason:?})"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

type Api<T> = Result<Json<T>, ApiError>;

/// Apply a command on the engine thread and return its events, or the rejection.
async fn exec(app: &App, cmd: Command) -> Result<Vec<Event>, ApiError> {
    let (tx, rx) = oneshot::channel();
    app.engine
        .send(Msg::Exec(cmd, tx))
        .map_err(ApiError::internal)?;
    let events = rx.await.map_err(ApiError::internal)?;
    match events.iter().find_map(|e| match e {
        Event::Rejected { reason, .. } => Some(*reason),
        _ => None,
    }) {
        Some(reason) => Err(ApiError::rejected(reason)),
        None => Ok(events),
    }
}

async fn query<T: Send + 'static>(
    app: &App,
    f: impl FnOnce(&Engine, &mut crate::Derived) -> T + Send + 'static,
) -> Result<T, ApiError> {
    call(app, f).await.map_err(ApiError::internal)
}

// ------------------------------------------------------------------- router

pub fn router(app: Arc<App>) -> Router<Arc<App>> {
    let protected = Router::new()
        .route("/logout", post(logout))
        .route("/summary", get(summary))
        .route("/groups", get(groups).post(add_group))
        .route("/groups/{name}", put(update_group))
        .route("/symbols", get(symbols).post(add_symbol))
        .route("/symbols/{name}", put(update_symbol))
        .route("/accounts", get(accounts).post(create_account))
        .route("/accounts/{id}", get(account).patch(update_account))
        .route("/accounts/{id}/balance", post(balance))
        .route("/accounts/{id}/password", post(password))
        .route("/positions", get(positions))
        .route("/positions/{id}/close", post(close_position))
        .route("/orders", get(orders))
        .route("/orders/{id}", delete(cancel_order))
        .route_layer(middleware::from_fn_with_state(app, auth));
    Router::new().route("/login", post(login)).merge(protected)
}

fn bearer(req: &Request) -> Option<&str> {
    req.headers()
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

async fn auth(State(app): State<Arc<App>>, req: Request, next: Next) -> Response {
    match bearer(&req).and_then(|t| app.managers.login_of(t)) {
        Some(_) => next.run(req).await,
        None => ApiError(StatusCode::UNAUTHORIZED, "sign in first".into()).into_response(),
    }
}

#[derive(Deserialize)]
struct LoginBody {
    login: String,
    password: String,
}

async fn login(State(app): State<Arc<App>>, Json(body): Json<LoginBody>) -> Api<Value> {
    let hash = app
        .managers
        .creds
        .iter()
        .find(|(l, _)| *l == body.login)
        .map(|(_, h)| h.clone());
    let password = body.password;
    let ok = tokio::task::spawn_blocking(move || {
        // Unknown logins cost the same time as wrong passwords.
        const DUMMY: &str = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm8";
        let known = hash.is_some();
        let hash = hash.unwrap_or_else(|| DUMMY.into());
        let valid = PasswordHash::new(&hash)
            .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
            .unwrap_or(false);
        known && valid
    })
    .await
    .map_err(ApiError::internal)?;
    if !ok {
        tracing::warn!(login = %body.login, "manager login failed");
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "wrong login or password".into(),
        ));
    }
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    app.managers
        .sessions
        .lock()
        .map_err(ApiError::internal)?
        .insert(
            token.clone(),
            (body.login.clone(), Instant::now() + SESSION),
        );
    tracing::info!(login = %body.login, "manager login");
    Ok(Json(
        json!({ "token": token, "login": body.login, "expires_in": SESSION.as_secs() }),
    ))
}

async fn logout(State(app): State<Arc<App>>, req: Request) -> Api<Value> {
    if let (Some(token), Ok(mut sessions)) = (bearer(&req), app.managers.sessions.lock()) {
        sessions.remove(token);
    }
    Ok(Json(json!({ "ok": true })))
}

// ------------------------------------------------------------------ summary

#[derive(Serialize, Default)]
struct CurrencyTotals {
    currency: String,
    accounts: usize,
    balance: Money,
    equity: Money,
    margin: Money,
    /// Clients' floating profit. The broker's B-book result is the opposite.
    floating: Money,
}

#[derive(Serialize)]
struct SymbolExposure {
    symbol: String,
    bid: Price,
    ask: Price,
    positions: usize,
    /// Clients' bought and sold volume. The broker's B-book exposure is the opposite of net.
    buy_volume: Volume,
    sell_volume: Volume,
}

async fn summary(State(app): State<Arc<App>>) -> Api<Value> {
    query(&app, |e, _| {
        let mut totals: Vec<CurrencyTotals> = Vec::new();
        for a in e.accounts(|_, _, _| true, usize::MAX) {
            let t = match totals.iter().position(|t| t.currency == a.currency) {
                Some(i) => &mut totals[i],
                None => {
                    totals.push(CurrencyTotals {
                        currency: a.currency.clone(),
                        ..Default::default()
                    });
                    totals.last_mut().unwrap()
                }
            };
            t.accounts += 1;
            t.balance += a.balance;
            t.equity += a.equity;
            t.margin += a.margin;
            t.floating += a.equity - a.balance - a.credit;
        }
        let positions = e.all_positions();
        let exposure: Vec<SymbolExposure> = e
            .symbols()
            .map(|(id, spec, bid, ask, _)| {
                let mine = positions.iter().filter(|p| p.symbol == id);
                let (mut buy, mut sell, mut count) = (0, 0, 0);
                for p in mine {
                    count += 1;
                    match p.side {
                        Side::Buy => buy += p.volume,
                        Side::Sell => sell += p.volume,
                    }
                }
                SymbolExposure {
                    symbol: spec.name.clone(),
                    bid,
                    ask,
                    positions: count,
                    buy_volume: buy,
                    sell_volume: sell,
                }
            })
            .collect();
        json!({
            "accounts": e.account_count(),
            "positions": positions.len(),
            "orders": e.all_orders().len(),
            "totals": totals,
            "exposure": exposure,
            "server_time": now(),
        })
    })
    .await
    .map(Json)
}

// ---------------------------------------------------------- groups, symbols

async fn groups(State(app): State<Arc<App>>) -> Api<Vec<GroupSpec>> {
    query(&app, |e, _| e.groups().cloned().collect())
        .await
        .map(Json)
}

async fn add_group(State(app): State<Arc<App>>, Json(spec): Json<GroupSpec>) -> Api<GroupSpec> {
    exec(&app, Command::AddGroup { spec: spec.clone() }).await?;
    Ok(Json(spec))
}

async fn update_group(
    State(app): State<Arc<App>>,
    Path(name): Path<String>,
    Json(spec): Json<GroupSpec>,
) -> Api<GroupSpec> {
    if spec.name != name {
        return Err(ApiError::bad("a group cannot be renamed"));
    }
    exec(
        &app,
        Command::UpdateGroup {
            spec: spec.clone(),
            ts: now(),
        },
    )
    .await?;
    Ok(Json(spec))
}

#[derive(Serialize)]
struct SymbolRow {
    id: SymbolId,
    #[serde(flatten)]
    spec: SymbolSpec,
    bid: Price,
    ask: Price,
}

async fn symbols(State(app): State<Arc<App>>) -> Api<Vec<SymbolRow>> {
    query(&app, |e, _| {
        e.symbols()
            .map(|(id, spec, bid, ask, _)| SymbolRow {
                id,
                spec: spec.clone(),
                bid,
                ask,
            })
            .collect()
    })
    .await
    .map(Json)
}

async fn add_symbol(State(app): State<Arc<App>>, Json(spec): Json<SymbolSpec>) -> Api<SymbolSpec> {
    let events = exec(&app, Command::AddSymbol { spec: spec.clone() }).await?;
    for ev in events {
        if let Event::SymbolAdded { id, spec } = ev {
            // Traders can use the symbol by name from now on (after they sign in again).
            if let Ok(mut map) = app.symbols.write() {
                map.insert(spec.name, id);
            }
        }
    }
    Ok(Json(spec))
}

async fn update_symbol(
    State(app): State<Arc<App>>,
    Path(name): Path<String>,
    Json(spec): Json<SymbolSpec>,
) -> Api<SymbolSpec> {
    if spec.name != name {
        return Err(ApiError::bad("a symbol cannot be renamed"));
    }
    exec(&app, Command::UpdateSymbol { spec: spec.clone() }).await?;
    Ok(Json(spec))
}

// ----------------------------------------------------------------- accounts

#[derive(Deserialize)]
struct AccountsQuery {
    /// Matches the start of the account number or any part of the name.
    #[serde(default)]
    search: String,
    #[serde(default)]
    group: String,
    #[serde(default)]
    limit: usize,
}

async fn accounts(
    State(app): State<Arc<App>>,
    Query(q): Query<AccountsQuery>,
) -> Api<Vec<AccountRow>> {
    let limit = if q.limit == 0 {
        200
    } else {
        q.limit.min(5_000)
    };
    let search = q.search.trim().to_lowercase();
    query(&app, move |e, _| {
        e.accounts(
            |id, name, group| {
                (q.group.is_empty() || group == q.group)
                    && (search.is_empty()
                        || id.to_string().starts_with(&search)
                        || name.to_lowercase().contains(&search))
            },
            limit,
        )
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
struct CreateAccount {
    /// Leave out to get the next free account number.
    #[serde(default)]
    id: AccountId,
    group: String,
    name: String,
    password: String,
    #[serde(default)]
    leverage: u32,
    /// Opening deposit in millionths of the account currency.
    #[serde(default)]
    deposit: Money,
}

async fn hashed(password: String) -> Result<String, ApiError> {
    if password.chars().count() < MIN_PASSWORD {
        return Err(ApiError::bad(format!(
            "the password needs at least {MIN_PASSWORD} characters"
        )));
    }
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)
}

async fn create_account(
    State(app): State<Arc<App>>,
    Json(body): Json<CreateAccount>,
) -> Api<AccountRow> {
    if body.name.trim().is_empty() {
        return Err(ApiError::bad("the account needs a name"));
    }
    if body.deposit < 0 {
        return Err(ApiError::bad("the opening deposit cannot be negative"));
    }
    let password_hash = hashed(body.password).await?;
    let events = exec(
        &app,
        Command::CreateAccount {
            id: body.id,
            group: body.group,
            name: body.name.trim().to_string(),
            password_hash,
            leverage: body.leverage,
            ts: now(),
        },
    )
    .await?;
    let id = events
        .iter()
        .find_map(|e| match e {
            Event::AccountCreated { account, .. } => Some(*account),
            _ => None,
        })
        .ok_or_else(|| ApiError::internal("account was not created"))?;
    if body.deposit > 0 {
        exec(
            &app,
            Command::Balance {
                account: id,
                amount: body.deposit,
                comment: "Opening deposit".into(),
                ts: now(),
            },
        )
        .await?;
    }
    row(&app, id).await.map(Json)
}

async fn row(app: &App, id: AccountId) -> Result<AccountRow, ApiError> {
    query(app, move |e, _| e.account_row(id))
        .await?
        .ok_or_else(|| ApiError::not_found("no such account"))
}

async fn account(State(app): State<Arc<App>>, Path(id): Path<AccountId>) -> Api<Value> {
    query(&app, move |e, d| {
        let account = e.account_row(id)?;
        let positions: Vec<Value> = e
            .positions_of(id)
            .iter()
            .map(|p| position_json(e, p))
            .collect();
        let deals = d.history.get(&id).cloned().unwrap_or_default();
        Some(json!({
            "account": account,
            "positions": positions,
            "orders": e.orders_of(id),
            "deals": deals,
        }))
    })
    .await?
    .map(Json)
    .ok_or_else(|| ApiError::not_found("no such account"))
}

#[derive(Deserialize)]
struct UpdateAccount {
    name: Option<String>,
    leverage: Option<u32>,
    enabled: Option<bool>,
}

async fn update_account(
    State(app): State<Arc<App>>,
    Path(id): Path<AccountId>,
    Json(body): Json<UpdateAccount>,
) -> Api<AccountRow> {
    exec(
        &app,
        Command::UpdateAccount {
            account: id,
            name: body.name.map(|n| n.trim().to_string()),
            leverage: body.leverage,
            enabled: body.enabled,
            ts: now(),
        },
    )
    .await?;
    row(&app, id).await.map(Json)
}

#[derive(Deserialize)]
struct BalanceBody {
    /// Positive deposits, negative withdraws. Millionths of the account currency.
    amount: Money,
    #[serde(default)]
    comment: String,
}

async fn balance(
    State(app): State<Arc<App>>,
    Path(id): Path<AccountId>,
    Json(body): Json<BalanceBody>,
) -> Api<AccountRow> {
    if body.amount == 0 {
        return Err(ApiError::bad("the amount cannot be zero"));
    }
    exec(
        &app,
        Command::Balance {
            account: id,
            amount: body.amount,
            comment: body.comment.chars().take(80).collect(),
            ts: now(),
        },
    )
    .await?;
    row(&app, id).await.map(Json)
}

#[derive(Deserialize)]
struct PasswordBody {
    password: String,
}

async fn password(
    State(app): State<Arc<App>>,
    Path(id): Path<AccountId>,
    Json(body): Json<PasswordBody>,
) -> Api<Value> {
    let password_hash = hashed(body.password).await?;
    exec(
        &app,
        Command::SetPassword {
            account: id,
            password_hash,
            ts: now(),
        },
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}

// ------------------------------------------------------ positions and orders

fn position_json(e: &Engine, p: &Position) -> Value {
    let mut v = serde_json::to_value(p).unwrap_or(Value::Null);
    if let Some(map) = v.as_object_mut() {
        // Floating profit in the account's currency, swap included.
        map.insert("profit".into(), json!(e.profit_of(p)));
        if let Some(g) = e.account_group(p.account) {
            map.insert("currency".into(), json!(g.currency));
        }
    }
    v
}

async fn positions(State(app): State<Arc<App>>) -> Api<Vec<Value>> {
    query(&app, |e, _| {
        e.all_positions()
            .iter()
            .map(|p| position_json(e, p))
            .collect()
    })
    .await
    .map(Json)
}

async fn close_position(State(app): State<Arc<App>>, Path(id): Path<Id>) -> Api<Value> {
    let owner = query(&app, move |e, _| {
        e.all_positions()
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.account)
    })
    .await?
    .ok_or_else(|| ApiError::not_found("no such position"))?;
    exec(
        &app,
        Command::ClosePosition {
            account: owner,
            position: id,
            volume: 0,
            ts: now(),
        },
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn orders(State(app): State<Arc<App>>) -> Api<Vec<Order>> {
    query(&app, |e, _| e.all_orders()).await.map(Json)
}

async fn cancel_order(State(app): State<Arc<App>>, Path(id): Path<Id>) -> Api<Value> {
    let owner = query(&app, move |e, _| {
        e.all_orders()
            .iter()
            .find(|o| o.id == id)
            .map(|o| o.account)
    })
    .await?
    .ok_or_else(|| ApiError::not_found("no such order"))?;
    exec(
        &app,
        Command::CancelOrder {
            account: owner,
            order: id,
            ts: now(),
        },
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}
