//! One-minute bars per symbol, kept in memory and built from ticks. Longer
//! timeframes are aggregated on request. Not persisted: history restarts with
//! the server until phase 3 adds storage.

use crate::protocol::Bar;
use ntrader_core::{Price, SymbolId, Ts};
use std::collections::HashMap;

const MAX_BARS: usize = 20_000;

#[derive(Default)]
pub struct Candles {
    m1: HashMap<SymbolId, Vec<Bar>>,
}

impl Candles {
    pub fn tick(&mut self, symbol: SymbolId, price: Price, ts: Ts) {
        let t = ts / 60_000 * 60;
        let bars = self.m1.entry(symbol).or_default();
        match bars.last_mut() {
            Some(b) if b.0 == t => {
                b.2 = b.2.max(price);
                b.3 = b.3.min(price);
                b.4 = price;
                b.5 += 1;
            }
            // Ignore ticks older than the current bar.
            Some(b) if b.0 > t => {}
            _ => {
                if bars.len() >= MAX_BARS {
                    bars.drain(..MAX_BARS / 2);
                }
                bars.push(Bar(t, price, price, price, price, 1));
            }
        }
    }

    /// Insert ready-made bars (simulator history). Must be oldest first.
    pub fn seed(&mut self, symbol: SymbolId, bars: Vec<Bar>) {
        self.m1.insert(symbol, bars);
    }

    /// The first price of the UTC day containing `now`, or the latest price
    /// before it when the day has no bar yet. 0 when nothing is known.
    pub fn day_open(&self, symbol: SymbolId, now: Ts) -> Price {
        let Some(bars) = self.m1.get(&symbol) else {
            return 0;
        };
        let start = now / 86_400_000 * 86_400;
        let i = bars.partition_point(|b| b.0 < start);
        match bars.get(i) {
            Some(b) => b.1,
            None => bars.last().map(|b| b.4).unwrap_or(0),
        }
    }

    /// The last `count` bars of `tf` seconds, oldest first.
    pub fn get(&self, symbol: SymbolId, tf: u32, count: usize) -> Vec<Bar> {
        let tf = tf as i64;
        let mut out: Vec<Bar> = Vec::new();
        for b in self.m1.get(&symbol).map(Vec::as_slice).unwrap_or(&[]) {
            let t = b.0 / tf * tf;
            match out.last_mut() {
                Some(o) if o.0 == t => {
                    o.2 = o.2.max(b.2);
                    o.3 = o.3.min(b.3);
                    o.4 = b.4;
                    o.5 += b.5;
                }
                _ => out.push(Bar(t, b.1, b.2, b.3, b.4, b.5)),
            }
        }
        let skip = out.len().saturating_sub(count);
        out.split_off(skip)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_and_aggregates_bars() {
        let mut c = Candles::default();
        // Three minutes of ticks: 10:00, 10:01, 10:05 (minutes since epoch 600..605).
        for (sec, price) in [
            (36_000, 100),
            (36_010, 104),
            (36_050, 98),
            (36_060, 101),
            (36_300, 107),
        ] {
            c.tick(0, price, sec * 1000);
        }
        let m1 = c.get(0, 60, 10);
        assert_eq!(m1.len(), 3);
        assert_eq!(
            (m1[0].0, m1[0].1, m1[0].2, m1[0].3, m1[0].4, m1[0].5),
            (36_000, 100, 104, 98, 98, 3)
        );
        let m5 = c.get(0, 300, 10);
        assert_eq!(m5.len(), 2);
        assert_eq!(
            (m5[0].1, m5[0].2, m5[0].3, m5[0].4, m5[0].5),
            (100, 104, 98, 101, 4)
        );
        assert_eq!(c.get(0, 60, 2).len(), 2);
        assert!(c.get(9, 60, 10).is_empty());
    }
}
