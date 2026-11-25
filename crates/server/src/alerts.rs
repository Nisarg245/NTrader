//! Price alerts. Kept on the server so they survive closing the browser, and
//! saved to a small JSON file next to the journal.

use ntrader_core::{AccountId, Price, SymbolId, Ts};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const MAX_PER_ACCOUNT: usize = 50;
const MAX_NOTE: usize = 80;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Alert {
    pub id: u64,
    #[serde(default)]
    pub account: AccountId,
    pub symbol: SymbolId,
    /// Fires when the bid rises to `price` (true) or falls to it (false).
    pub above: bool,
    pub price: Price,
    pub note: String,
    pub created: Ts,
    /// When it fired, 0 while still waiting.
    pub fired: Ts,
}

#[derive(Default)]
pub struct Alerts {
    list: Vec<Alert>,
    next_id: u64,
    path: Option<PathBuf>,
}

impl Alerts {
    pub fn load(path: PathBuf) -> Alerts {
        let list: Vec<Alert> = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Alerts {
            next_id: list.iter().map(|a| a.id).max().unwrap_or(0) + 1,
            list,
            path: Some(path),
        }
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        let result = serde_json::to_vec(&self.list).map(|b| std::fs::write(path, b));
        if !matches!(result, Ok(Ok(()))) {
            tracing::warn!("could not save alerts to {}", path.display());
        }
    }

    pub fn of(&self, account: AccountId) -> Vec<Alert> {
        self.list
            .iter()
            .filter(|a| a.account == account)
            .cloned()
            .collect()
    }

    /// Add an alert. `bid` is the current price, which decides the direction.
    pub fn add(
        &mut self,
        account: AccountId,
        symbol: SymbolId,
        price: Price,
        note: &str,
        bid: Price,
        now: Ts,
    ) -> Result<(), &'static str> {
        if price <= 0 || bid <= 0 || price == bid {
            return Err("alert price must differ from the current price");
        }
        if self.list.iter().filter(|a| a.account == account).count() >= MAX_PER_ACCOUNT {
            return Err("too many alerts, delete some first");
        }
        let id = self.next_id.max(1);
        self.list.push(Alert {
            id,
            account,
            symbol,
            above: price > bid,
            price,
            note: note.chars().take(MAX_NOTE).collect(),
            created: now,
            fired: 0,
        });
        self.next_id = id + 1;
        self.save();
        Ok(())
    }

    pub fn delete(&mut self, account: AccountId, id: u64) -> bool {
        let before = self.list.len();
        self.list.retain(|a| !(a.account == account && a.id == id));
        let changed = self.list.len() != before;
        if changed {
            self.save();
        }
        changed
    }

    /// Mark alerts reached by this tick as fired. Returns (account, alert id) for each.
    pub fn on_tick(&mut self, symbol: SymbolId, bid: Price, now: Ts) -> Vec<(AccountId, u64)> {
        let mut fired = Vec::new();
        for a in &mut self.list {
            if a.fired == 0
                && a.symbol == symbol
                && ((a.above && bid >= a.price) || (!a.above && bid <= a.price))
            {
                a.fired = now;
                fired.push((a.account, a.id));
            }
        }
        if !fired.is_empty() {
            self.save();
        }
        fired
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alerts_fire_once_in_their_direction() {
        let mut a = Alerts::default();
        a.add(7, 0, 110, "up", 100, 1).unwrap();
        a.add(7, 0, 90, "down", 100, 1).unwrap();
        a.add(8, 1, 110, "other symbol", 100, 1).unwrap();
        assert!(a.add(7, 0, 100, "same as price", 100, 1).is_err());

        assert!(a.on_tick(0, 105, 2).is_empty());
        assert_eq!(a.on_tick(0, 110, 3), vec![(7, 1)]);
        assert!(a.on_tick(0, 120, 4).is_empty(), "already fired");
        assert_eq!(a.on_tick(0, 89, 5), vec![(7, 2)]);
        assert_eq!(
            a.of(7).iter().map(|x| x.fired).collect::<Vec<_>>(),
            vec![3, 5]
        );
        assert_eq!(a.of(8)[0].fired, 0);

        assert!(!a.delete(8, 1), "cannot delete another account's alert");
        assert!(a.delete(7, 1));
        assert_eq!(a.of(7).len(), 1);
    }
}
