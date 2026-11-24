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
    #[serde(default)]
    pub feed: Feed,
    #[serde(default, rename = "group")]
    pub groups: Vec<GroupSpec>,
    #[serde(default, rename = "symbol")]
    pub symbols: Vec<SymbolConfig>,
    #[serde(default, rename = "account")]
    pub accounts: Vec<AccountConfig>,
}

#[derive(Deserialize, Default)]
pub struct Feed {
    /// Simulated ticks per second per symbol. 0 disables the simulator.
    #[serde(default)]
    pub sim_ticks_per_second: u32,
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
