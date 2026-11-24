use ntrader_core::*;

const EURUSD: SymbolId = 0;
const USDJPY: SymbolId = 1;
const ACC: AccountId = 1;
const USD: Money = MONEY_SCALE;
const LOT: Volume = VOLUME_SCALE;

fn forex(name: &str, digits: u8, base: &str, profit: &str) -> SymbolSpec {
    SymbolSpec {
        name: name.into(),
        digits,
        contract_size: 100_000,
        base_ccy: base.into(),
        profit_ccy: profit.into(),
        calc: CalcMode::Forex,
        margin_rate_bp: 10_000,
        vol_min: 100,
        vol_max: 100 * LOT,
        vol_step: 100,
        swap_long: -5,
        swap_short: 2,
        trade_enabled: true,
    }
}

fn setup_cmds(mode: AccountMode, deposit: Money) -> Vec<Command> {
    vec![
        Command::AddGroup {
            spec: GroupSpec {
                name: "demo".into(),
                currency: "USD".into(),
                mode,
                leverage: 100,
                margin_call_pct: 100,
                stop_out_pct: 50,
                commission_per_lot: 0,
            },
        },
        Command::AddSymbol {
            spec: forex("EURUSD", 5, "EUR", "USD"),
        },
        Command::AddSymbol {
            spec: forex("USDJPY", 3, "USD", "JPY"),
        },
        Command::CreateAccount {
            id: ACC,
            group: "demo".into(),
            name: "Test".into(),
            password_hash: String::new(),
            leverage: 0,
            ts: 0,
        },
        Command::Balance {
            account: ACC,
            amount: deposit,
            comment: "dep".into(),
            ts: 0,
        },
        tick(EURUSD, 110_000, 110_010),
        tick(USDJPY, 150_000, 150_010),
    ]
}

fn setup(mode: AccountMode, deposit: Money) -> Engine {
    let mut e = Engine::new();
    run(&mut e, setup_cmds(mode, deposit));
    e
}

fn run(e: &mut Engine, cmds: Vec<Command>) -> Vec<Event> {
    let mut out = Vec::new();
    for c in &cmds {
        e.apply(c, &mut out);
    }
    out
}

fn tick(symbol: SymbolId, bid: Price, ask: Price) -> Command {
    Command::Tick {
        symbol,
        bid,
        ask,
        ts: 1,
    }
}

fn order(symbol: SymbolId, side: Side, volume: Volume) -> OrderRequest {
    OrderRequest {
        account: ACC,
        client_id: 7,
        symbol,
        side,
        kind: OrderKind::Market,
        volume,
        price: 0,
        sl: 0,
        tp: 0,
        position: 0,
        ts: 1,
    }
}

fn place(req: OrderRequest) -> Command {
    Command::PlaceOrder { req }
}

fn rejected(events: &[Event]) -> Option<Reject> {
    events.iter().find_map(|e| match e {
        Event::Rejected { reason, .. } => Some(*reason),
        _ => None,
    })
}

fn deals(events: &[Event]) -> Vec<Deal> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::Deal { deal, .. } => Some(*deal),
            _ => None,
        })
        .collect()
}

#[test]
fn hedging_open_revalue_close() {
    let mut e = setup(AccountMode::Hedging, 10_000 * USD);
    let ev = run(&mut e, vec![place(order(EURUSD, Side::Buy, LOT))]);
    assert_eq!(rejected(&ev), None);
    let p = e.positions_of(ACC)[0];
    assert_eq!(p.open_price, 110_010);
    // 100000 EUR / 100 leverage = 1000 EUR, at 1.10000 = 1100 USD.
    assert_eq!(p.margin, 1_100 * USD);
    // Spread cost shows immediately: 10 points on 1 lot = 10 USD.
    assert_eq!(e.account_state(ACC).unwrap().equity, 9_990 * USD);

    run(&mut e, vec![tick(EURUSD, 110_110, 110_120)]);
    let s = e.account_state(ACC).unwrap();
    assert_eq!(s.equity, 10_100 * USD);
    assert_eq!(s.free_margin, 9_000 * USD);

    let ev = run(
        &mut e,
        vec![Command::ClosePosition {
            account: ACC,
            position: p.id,
            volume: 0,
            ts: 2,
        }],
    );
    assert_eq!(deals(&ev)[0].profit, 100 * USD);
    let s = e.account_state(ACC).unwrap();
    assert_eq!(
        (s.balance, s.margin, s.equity),
        (10_100 * USD, 0, 10_100 * USD)
    );
    assert!(e.positions_of(ACC).is_empty());
}

#[test]
fn hedging_holds_both_sides_and_closes_by_ticket() {
    let mut e = setup(AccountMode::Hedging, 10_000 * USD);
    run(
        &mut e,
        vec![
            place(order(EURUSD, Side::Buy, LOT)),
            place(order(EURUSD, Side::Sell, LOT)),
        ],
    );
    let ps = e.positions_of(ACC);
    assert_eq!(ps.len(), 2);
    // Partial close of the buy with an opposite order aimed at its ticket.
    let ev = run(
        &mut e,
        vec![place(OrderRequest {
            position: ps[0].id,
            ..order(EURUSD, Side::Sell, LOT / 2)
        })],
    );
    assert_eq!(rejected(&ev), None);
    let ps = e.positions_of(ACC);
    assert_eq!((ps[0].volume, ps[0].margin), (LOT / 2, 550 * USD));
    assert_eq!(ps[1].volume, LOT);
}

#[test]
fn cross_currency_profit_is_converted() {
    let mut e = setup(AccountMode::Hedging, 10_000 * USD);
    run(
        &mut e,
        vec![
            place(order(USDJPY, Side::Sell, LOT)),
            tick(USDJPY, 149_000, 149_010),
        ],
    );
    let p = e.positions_of(ACC)[0];
    let ev = run(
        &mut e,
        vec![Command::ClosePosition {
            account: ACC,
            position: p.id,
            volume: 0,
            ts: 2,
        }],
    );
    // (150.000 - 149.010) * 100000 = 99000 JPY, / 149.010 = 664.384940 USD.
    assert_eq!(deals(&ev)[0].profit, 664_384_940);
}

#[test]
fn netting_averages_and_reverses() {
    let mut e = setup(AccountMode::Netting, 10_000 * USD);
    run(
        &mut e,
        vec![
            place(order(EURUSD, Side::Buy, LOT)),
            tick(EURUSD, 110_200, 110_210),
            place(order(EURUSD, Side::Buy, LOT)),
        ],
    );
    let ps = e.positions_of(ACC);
    assert_eq!(ps.len(), 1);
    assert_eq!((ps[0].volume, ps[0].open_price), (2 * LOT, 110_110));

    let ev = run(&mut e, vec![place(order(EURUSD, Side::Sell, 3 * LOT))]);
    let d = deals(&ev);
    assert_eq!((d[0].entry, d[0].volume), (Entry::Out, 2 * LOT));
    // 2 lots closed at 1.10200 against an average of 1.10110 = 180 USD.
    assert_eq!(d[0].profit, 180 * USD);
    assert_eq!((d[1].entry, d[1].volume), (Entry::In, LOT));
    let ps = e.positions_of(ACC);
    assert_eq!((ps.len(), ps[0].side, ps[0].volume), (1, Side::Sell, LOT));
}

#[test]
fn stop_loss_and_take_profit_fire() {
    let mut e = setup(AccountMode::Hedging, 10_000 * USD);
    run(
        &mut e,
        vec![
            place(OrderRequest {
                sl: 109_900,
                tp: 110_200,
                ..order(EURUSD, Side::Buy, LOT)
            }),
            place(OrderRequest {
                sl: 110_200,
                tp: 109_900,
                ..order(EURUSD, Side::Sell, LOT)
            }),
        ],
    );
    let ev = run(&mut e, vec![tick(EURUSD, 109_950, 109_960)]);
    assert!(ev.is_empty());
    // Gap through the buy SL and the sell TP: both fill at the market, not at their level.
    let ev = run(&mut e, vec![tick(EURUSD, 109_880, 109_890)]);
    let d = deals(&ev);
    assert_eq!(d.len(), 2);
    let sl = d.iter().find(|d| d.reason == DealReason::StopLoss).unwrap();
    let tp = d
        .iter()
        .find(|d| d.reason == DealReason::TakeProfit)
        .unwrap();
    assert_eq!((sl.price, sl.profit), (109_880, -130 * USD));
    assert_eq!((tp.price, tp.profit), (109_890, 110 * USD));
    assert!(e.positions_of(ACC).is_empty());
    // Nothing left armed.
    assert!(run(
        &mut e,
        vec![
            tick(EURUSD, 109_000, 109_010),
            tick(EURUSD, 111_000, 111_010)
        ]
    )
    .is_empty());
}

#[test]
fn invalid_stops_and_modify() {
    let mut e = setup(AccountMode::Hedging, 10_000 * USD);
    let ev = run(
        &mut e,
        vec![place(OrderRequest {
            sl: 110_050,
            ..order(EURUSD, Side::Buy, LOT)
        })],
    );
    assert_eq!(rejected(&ev), Some(Reject::InvalidStops));
    run(&mut e, vec![place(order(EURUSD, Side::Buy, LOT))]);
    let id = e.positions_of(ACC)[0].id;
    run(
        &mut e,
        vec![Command::ModifyPosition {
            account: ACC,
            position: id,
            sl: 109_990,
            tp: 0,
            ts: 2,
        }],
    );
    let ev = run(&mut e, vec![tick(EURUSD, 109_990, 110_000)]);
    assert_eq!(deals(&ev)[0].reason, DealReason::StopLoss);
}

#[test]
fn pending_orders() {
    let mut e = setup(AccountMode::Hedging, 10_000 * USD);
    let limit = OrderRequest {
        kind: OrderKind::Limit,
        price: 109_950,
        ..order(EURUSD, Side::Buy, LOT)
    };
    // A buy limit above the market is not a limit order.
    let ev = run(
        &mut e,
        vec![place(OrderRequest {
            price: 110_100,
            ..limit
        })],
    );
    assert_eq!(rejected(&ev), Some(Reject::InvalidPrice));

    let stop = OrderRequest {
        kind: OrderKind::Stop,
        price: 109_900,
        ..order(EURUSD, Side::Sell, LOT)
    };
    run(&mut e, vec![place(limit), place(stop)]);
    let orders = e.orders_of(ACC);
    assert_eq!(orders.len(), 2);

    let ev = run(&mut e, vec![tick(EURUSD, 109_940, 109_950)]);
    let d = deals(&ev);
    assert_eq!(
        (d.len(), d[0].price, d[0].reason),
        (1, 109_950, DealReason::Pending)
    );
    assert_eq!(e.orders_of(ACC).len(), 1);

    run(
        &mut e,
        vec![Command::CancelOrder {
            account: ACC,
            order: orders[1].id,
            ts: 2,
        }],
    );
    assert!(e.orders_of(ACC).is_empty());
    assert!(deals(&run(&mut e, vec![tick(EURUSD, 109_800, 109_810)])).is_empty());
}

#[test]
fn margin_is_enforced() {
    let mut e = setup(AccountMode::Hedging, 10_000 * USD);
    let ev = run(&mut e, vec![place(order(EURUSD, Side::Buy, 10 * LOT))]);
    assert_eq!(rejected(&ev), Some(Reject::NoMoney));
    let ev = run(&mut e, vec![place(order(EURUSD, Side::Buy, 9 * LOT))]);
    assert_eq!(rejected(&ev), None);
    // Withdrawals cannot eat into margin in use.
    let ev = run(
        &mut e,
        vec![Command::Balance {
            account: ACC,
            amount: -500 * USD,
            comment: "w".into(),
            ts: 2,
        }],
    );
    assert_eq!(rejected(&ev), Some(Reject::NoMoney));
    assert_eq!(
        rejected(&run(&mut e, vec![place(order(EURUSD, Side::Buy, 55))])),
        Some(Reject::InvalidVolume)
    );
}

#[test]
fn stop_out_closes_worst_position_first() {
    let mut e = setup(AccountMode::Hedging, 2_000 * USD);
    run(
        &mut e,
        vec![
            place(order(EURUSD, Side::Buy, LOT / 2)),
            tick(EURUSD, 109_900, 109_910),
            place(order(EURUSD, Side::Buy, LOT / 2)),
        ],
    );
    // Margin 550 + 549.5. Margin call at 100%, stop-out at 50%.
    let ev = run(&mut e, vec![tick(EURUSD, 109_000, 109_010)]);
    assert!(ev.iter().any(|e| matches!(e, Event::MarginCall { .. })));
    assert!(deals(&ev).is_empty());

    let ev = run(&mut e, vec![tick(EURUSD, 108_400, 108_410)]);
    let d = deals(&ev);
    // Only the worse position (opened at 1.10010) goes; the account then recovers.
    assert_eq!((d.len(), d[0].reason), (1, DealReason::StopOut));
    assert_eq!(d[0].profit, -805 * USD);
    let ps = e.positions_of(ACC);
    assert_eq!((ps.len(), ps[0].open_price), (1, 109_910));
    assert!(e.account_state(ACC).unwrap().margin_level > 50);
}

#[test]
fn rollover_charges_swap() {
    let mut e = setup(AccountMode::Hedging, 10_000 * USD);
    run(
        &mut e,
        vec![
            place(order(EURUSD, Side::Buy, 2 * LOT)),
            Command::Rollover { ts: 3 },
        ],
    );
    // -5 points * 2 lots = -10 USD, carried on the position until it closes.
    assert_eq!(e.positions_of(ACC)[0].swap, -10 * USD);
    assert_eq!(e.account_state(ACC).unwrap().equity, 9_970 * USD);
    let id = e.positions_of(ACC)[0].id;
    let ev = run(
        &mut e,
        vec![Command::ClosePosition {
            account: ACC,
            position: id,
            volume: 0,
            ts: 4,
        }],
    );
    assert_eq!(deals(&ev)[0].swap, -10 * USD);
    assert_eq!(e.account_state(ACC).unwrap().balance, 9_970 * USD);
}

#[test]
fn journal_replay_restores_state() {
    let path = std::env::temp_dir().join(format!("ntrader-journal-{}.log", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let mut out = Vec::new();
    let mut live = Node::open(&path, |_| {}).unwrap();
    let mut cmds = setup_cmds(AccountMode::Hedging, 10_000 * USD);
    cmds.extend([
        place(OrderRequest {
            sl: 109_500,
            ..order(EURUSD, Side::Buy, LOT)
        }),
        tick(USDJPY, 150_500, 150_510),
        tick(EURUSD, 110_050, 110_060),
        tick(EURUSD, 110_070, 110_080),
        place(order(USDJPY, Side::Sell, LOT)),
        place(OrderRequest {
            kind: OrderKind::Limit,
            price: 109_800,
            ..order(EURUSD, Side::Buy, LOT)
        }),
        tick(USDJPY, 151_000, 151_010),
        tick(EURUSD, 109_790, 109_800),
        tick(EURUSD, 109_490, 109_500),
        tick(EURUSD, 109_600, 109_610),
        tick(USDJPY, 150_800, 150_810),
        // Quiet quotes reach the journal with the next logged command.
        Command::Balance {
            account: ACC,
            amount: USD,
            comment: "adj".into(),
            ts: 9,
        },
    ]);
    for c in &cmds {
        live.apply(c, &mut out).unwrap();
    }
    let mut replayed_deals = 0;
    let back = Node::open(&path, |e| {
        replayed_deals += matches!(e, Event::Deal { .. }) as usize
    })
    .unwrap();
    assert_eq!(
        back.engine.account_state(ACC),
        live.engine.account_state(ACC)
    );
    assert_eq!(back.engine.positions_of(ACC), live.engine.positions_of(ACC));
    assert_eq!(back.engine.orders_of(ACC), live.engine.orders_of(ACC));
    assert_eq!(back.engine.quote(EURUSD), live.engine.quote(EURUSD));
    assert_eq!(back.engine.quote(USDJPY), live.engine.quote(USDJPY));
    assert_eq!(replayed_deals, deals(&out).len());
    assert!(replayed_deals >= 4);
    // Far fewer records than commands: quiet ticks are not stored one by one.
    let lines = std::fs::read_to_string(&path).unwrap().lines().count();
    assert!(lines < cmds.len() + 4, "{lines} journal lines");
    let _ = std::fs::remove_file(&path);
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// A random market over many accounts. Returns the commands, for replay tests.
fn random_session(seed: u64, steps: usize, mut each: impl FnMut(&Command)) {
    const GBPUSD: SymbolId = 2;
    let mut rng = Rng(seed);
    let mut cmds = setup_cmds(AccountMode::Hedging, 3_000 * USD);
    cmds.push(Command::AddSymbol {
        spec: forex("GBPUSD", 5, "GBP", "USD"),
    });
    cmds.push(tick(GBPUSD, 127_000, 127_015));
    for id in 2..=40u64 {
        cmds.push(Command::CreateAccount {
            id,
            group: "demo".into(),
            name: String::new(),
            password_hash: String::new(),
            leverage: 0,
            ts: 0,
        });
        cmds.push(Command::Balance {
            account: id,
            amount: (500 + rng.next() % 3_000) as i64 * USD,
            comment: String::new(),
            ts: 0,
        });
    }
    cmds.iter().for_each(&mut each);
    let mut mid = [110_000i64, 150_000, 127_000];
    for step in 0..steps {
        let s = (rng.next() % 3) as usize;
        let cmd = if rng.next().is_multiple_of(6) {
            let side = if rng.next() & 1 == 0 {
                Side::Buy
            } else {
                Side::Sell
            };
            let far = 20 + (rng.next() % 400) as i64;
            let (sl, tp) = match (rng.next() % 3, side) {
                (0, _) => (0, 0),
                (_, Side::Buy) => (mid[s] - far, mid[s] + far),
                (_, Side::Sell) => (mid[s] + far + 20, mid[s] - far),
            };
            place(OrderRequest {
                account: 1 + rng.next() % 40,
                sl,
                tp,
                ts: step as i64,
                ..order(s as SymbolId, side, 100 * (1 + rng.next() % 80) as i64)
            })
        } else {
            // Mostly small steps, sometimes a jump, with a spread that changes.
            let jump: u64 = if rng.next().is_multiple_of(50) {
                400
            } else {
                12
            };
            mid[s] = (mid[s] + (rng.next() % (2 * jump + 1)) as i64 - jump as i64).max(10_000);
            Command::Tick {
                symbol: s as SymbolId,
                bid: mid[s],
                ask: mid[s] + 5 + (rng.next() % 15) as i64,
                ts: step as i64,
            }
        };
        each(&cmd);
    }
}

#[test]
fn stop_out_is_never_missed() {
    // Margin checks are triggered by price levels instead of running on every
    // tick. This checks the result is the same as checking on every tick: no
    // account is ever left at or below the stop-out level, including accounts
    // holding USDJPY, whose profit is converted at a moving rate.
    let mut e = Engine::new();
    let mut out = Vec::new();
    let (mut stop_outs, mut margin_calls, mut opened) = (0, 0, 0);
    random_session(42, 60_000, |cmd| {
        e.apply(cmd, &mut out);
        for ev in out.drain(..) {
            match ev {
                Event::StopOut { .. } => stop_outs += 1,
                Event::MarginCall { .. } => margin_calls += 1,
                Event::Deal { deal, .. } if deal.entry == Entry::In => opened += 1,
                _ => {}
            }
        }
        if matches!(cmd, Command::Tick { .. }) {
            for id in 1..=40 {
                let Some(s) = e.account_state(id) else {
                    continue;
                };
                assert!(
                    s.margin == 0 || s.equity as i128 * 100 > s.margin as i128 * 50,
                    "account {id} left below stop-out: {s:?}"
                );
            }
        }
    });
    // The scenario must actually exercise the path.
    assert!(
        stop_outs > 20 && margin_calls > 20 && opened > 1_000,
        "{stop_outs} {margin_calls} {opened}"
    );
}

#[test]
fn journal_replay_matches_a_long_random_session() {
    let path =
        std::env::temp_dir().join(format!("ntrader-journal-long-{}.log", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let mut live = Node::open(&path, |_| {}).unwrap();
    let mut out = Vec::new();
    let mut n = 0;
    random_session(7, 40_000, |cmd| {
        live.apply(cmd, &mut out).unwrap();
        n += 1;
    });
    live.apply(&Command::Rollover { ts: 99_999 }, &mut out)
        .unwrap();
    let live_deals = deals(&out);
    let mut replayed = Vec::new();
    let back = Node::open(&path, |e| replayed.push(e.clone())).unwrap();
    let replayed = deals(&replayed);
    let first = replayed.iter().zip(&live_deals).position(|(a, b)| a != b);
    assert_eq!(
        first.map(|i| (i, replayed[i], live_deals[i])),
        None,
        "first differing deal"
    );
    assert_eq!(replayed.len(), live_deals.len());
    for id in 1..=40 {
        assert_eq!(back.engine.account_state(id), live.engine.account_state(id));
        assert_eq!(back.engine.positions_of(id), live.engine.positions_of(id));
    }
    let lines = std::fs::read_to_string(&path).unwrap().lines().count();
    assert!(lines < n / 2, "{lines} journal lines for {n} commands");
    let _ = std::fs::remove_file(&path);
}
