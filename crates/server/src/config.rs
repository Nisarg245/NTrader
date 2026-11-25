use ntrader_core::{GroupSpec, SymbolSpec};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
pub struct Config {
    pub listen: String,
    pub journal: PathBuf,
    /// fsync the journal after every record.
    #[serde(default)]
    pub journal_sync: bool,
    /// Folder with the built Web Trader (web/dist). Served at "/" when set.
    #[serde(default)]
    pub web_root: Option<PathBuf>,
    #[serde(default)]
    pub feed: Feed,
    #[serde(default, rename = "group")]
    pub groups: Vec<GroupSpec>,
    #[serde(default, rename = "symbol")]
    pub symbols: Vec<SymbolConfig>,
    #[serde(default, rename = "account")]
    pub accounts: Vec<AccountConfig>,
    /// People allowed to use the Manager API and the admin panel. Read at every start.
    #[serde(default, rename = "manager")]
    pub managers: Vec<ManagerConfig>,
    /// Calendar entries and news shown to traders. Read at every start.
    #[serde(default, rename = "announcement")]
    pub announcements: Vec<Announcement>,
}

#[derive(Deserialize)]
pub struct ManagerConfig {
    pub login: String,
    /// Plain password, for development only.
    #[serde(default)]
    pub password: String,
    /// Argon2 hash in PHC format. Use this instead of `password` in production.
    #[serde(default)]
    pub password_hash: String,
}

/// One calendar entry or news item, published by the broker.
#[derive(Deserialize, serde::Serialize, Clone)]
pub struct Announcement {
    /// "calendar" (economic event) or "news".
    pub kind: String,
    /// Shown as written, for example "25 Nov 18:00 UTC".
    pub time: String,
    pub title: String,
    #[serde(default)]
    pub currency: String,
    /// Calendar: "High", "Medium" or "Low".
    #[serde(default)]
    pub impact: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Deserialize, Default)]
pub struct Feed {
    /// Simulated ticks per second per symbol. 0 disables the simulator.
    #[serde(default)]
    pub sim_ticks_per_second: u32,
    /// Minutes of made-up chart history to create at start, so charts are not
    /// empty in development. Only used while the simulator is on.
    #[serde(default)]
    pub sim_history_minutes: u32,
}

#[derive(Deserialize)]
pub struct SymbolConfig {
    #[serde(flatten)]
    pub spec: SymbolSpec,
    /// Simulator: starting mid price, as a plain decimal (1.0850).
    #[serde(default)]
    pub sim_price: f64,
    /// Simulator: spread in points.
    #[serde(default)]
    pub sim_spread: i64,
    /// Simulator: typical move per tick, in points.
    #[serde(default)]
    pub sim_step: f64,
}

/// Accounts created on first start only (when the journal is empty).
#[derive(Deserialize)]
pub struct AccountConfig {
    pub id: u64,
    pub group: String,
    pub name: String,
    pub password: String,
    /// Initial deposit in whole currency units.
    #[serde(default)]
    pub deposit: f64,
}
