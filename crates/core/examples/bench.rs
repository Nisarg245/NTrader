//! Throughput benchmark for the trading core.
//!
//!     cargo run --release -p ntrader-core --example bench

use ntrader_core::*;
use std::time::Instant;

const ACCOUNTS: u64 = 10_000;
const SYMBOLS: u32 = 20;
const TICKS: usize = 5_000_000;

/// Small deterministic generator so runs are comparable.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn main() {
    let mut e = Engine::new();
    let mut out = Vec::with_capacity(1024);
    let mut rng = Rng(0x9E3779B97F4A7C15);
    e.apply(
        &Command::AddGroup {
            spec: GroupSpec {
                name: "bench".into(),
                currency: "USD".into(),
                mode: AccountMode::Hedging,
                leverage: 500,
                margin_call_pct: 100,
                stop_out_pct: 50,
                commission_per_lot: 0,
            },
        },
        &mut out,
    );
    let mut mids = Vec::new();
    for s in 0..SYMBOLS {
        e.apply(
            &Command::AddSymbol {
                spec: SymbolSpec {
                    name: format!("S{s:02}USD"),
                    digits: 5,
                    contract_size: 100_000,
                    base_ccy: format!("S{s:02}"),
                    profit_ccy: "USD".into(),
                    calc: CalcMode::Forex,
                    margin_rate_bp: 10_000,
                    vol_min: 100,
                    vol_max: 1_000_000,
                    vol_step: 100,
                    swap_long: 0,
                    swap_short: 0,
                    trade_enabled: true,
                },
            },
            &mut out,
        );
        mids.push(100_000 + s as i64 * 1_000);
        e.apply(
            &Command::Tick {
                symbol: s,
                bid: mids[s as usize],
                ask: mids[s as usize] + 10,
                ts: 0,
            },
            &mut out,
        );
    }
    for a in 1..=ACCOUNTS {
        e.apply(
            &Command::CreateAccount {
                id: a,
                group: "bench".into(),
                name: String::new(),
                password_hash: String::new(),
                leverage: 0,
                ts: 0,
            },
            &mut out,
        );
        e.apply(
            &Command::Balance {
                account: a,
                amount: 100_000 * MONEY_SCALE,
                comment: String::new(),
                ts: 0,
            },
            &mut out,
        );
    }
    out.clear();

    // Orders: every account opens 5 positions with stops, plus a pending order.
    let t = Instant::now();
    let mut orders = 0u64;
    for a in 1..=ACCOUNTS {
        for _ in 0..5 {
            let symbol = (rng.next() % SYMBOLS as u64) as u32;
            let side = if rng.next() & 1 == 0 {
                Side::Buy
            } else {
                Side::Sell
            };
            let mid = mids[symbol as usize];
            let far = 300 + (rng.next() % 2_000) as i64;
            let (sl, tp) = match side {
                Side::Buy => (mid - far, mid + far),
                Side::Sell => (mid + far, mid - far),
            };
            let req = OrderRequest {
                account: a,
                client_id: 0,
                symbol,
                side,
                kind: OrderKind::Market,
                volume: 1_000,
                price: 0,
                sl,
                tp,
                position: 0,
                ts: 0,
            };
            e.apply(&Command::PlaceOrder { req }, &mut out);
            orders += 1;
        }
        let symbol = (rng.next() % SYMBOLS as u64) as u32;
        let req = OrderRequest {
            account: a,
            client_id: 0,
            symbol,
            side: Side::Buy,
            kind: OrderKind::Limit,
            volume: 1_000,
            price: mids[symbol as usize] - 200 - (rng.next() % 1_000) as i64,
            sl: 0,
            tp: 0,
            position: 0,
            ts: 0,
        };
        e.apply(&Command::PlaceOrder { req }, &mut out);
        orders += 1;
        out.clear();
    }
    let dt = t.elapsed();
    println!(
        "orders : {orders} in {:.1} ms  = {:.2} M orders/s  ({:.0} ns each)",
        dt.as_secs_f64() * 1e3,
        orders as f64 / dt.as_secs_f64() / 1e6,
        dt.as_nanos() as f64 / orders as f64
    );
    println!(
        "book   : {} accounts, {} open positions, {SYMBOLS} symbols",
        e.account_count(),
        e.position_count()
    );

    // Ticks: a random walk across all symbols. Each tick checks every stop and
    // pending order on the symbol and revalues every account exposed to it.
    let t = Instant::now();
    let mut events = 0usize;
    let mut worst = 0u128;
    for i in 0..TICKS {
        let symbol = (rng.next() % SYMBOLS as u64) as u32;
        let mid = &mut mids[symbol as usize];
        *mid += (rng.next() % 7) as i64 - 3;
        let t1 = Instant::now();
        e.apply(
            &Command::Tick {
                symbol,
                bid: *mid,
                ask: *mid + 10,
                ts: i as i64,
            },
            &mut out,
        );
        if i % 64 == 0 {
            worst = worst.max(t1.elapsed().as_nanos());
        }
        events += out.len();
        out.clear();
    }
    let dt = t.elapsed();
    println!(
        "ticks  : {TICKS} in {:.1} ms  = {:.2} M ticks/s  ({:.0} ns each, worst sampled {:.1} us)",
        dt.as_secs_f64() * 1e3,
        TICKS as f64 / dt.as_secs_f64() / 1e6,
        dt.as_nanos() as f64 / TICKS as f64,
        worst as f64 / 1e3
    );
    println!(
        "fired  : {events} events, {} positions still open",
        e.position_count()
    );
}
