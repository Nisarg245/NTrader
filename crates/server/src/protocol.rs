//! Client gateway protocol.
//!
//! One WebSocket per trader. Binary frames are MessagePack, text frames are
//! JSON with the same shape; the server answers in whichever the client's
//! login frame used. All prices, volumes and money are scaled integers, see
//! `ntrader_core::types`.

use ntrader_core::*;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(tag = "type")]
pub enum ClientMsg {
    Login {
        account: AccountId,
        password: String,
    },
    Subscribe {
        symbols: Vec<String>,
    },
    Unsubscribe {
        symbols: Vec<String>,
    },
    Order {
        #[serde(default)]
        client_id: u64,
        symbol: String,
        side: Side,
        kind: OrderKind,
        volume: Volume,
        #[serde(default)]
        price: Price,
        #[serde(default)]
        sl: Price,
        #[serde(default)]
        tp: Price,
        #[serde(default)]
        position: Id,
    },
    Cancel {
        order: Id,
    },
    Modify {
        position: Id,
        #[serde(default)]
        sl: Price,
        #[serde(default)]
        tp: Price,
    },
    Close {
        position: Id,
        #[serde(default)]
        volume: Volume,
    },
    Ping,
}

#[derive(Serialize)]
pub struct SymbolInfo {
    pub id: SymbolId,
    #[serde(flatten)]
    pub spec: SymbolSpec,
    pub bid: Price,
    pub ask: Price,
}

#[derive(Serialize)]
#[serde(tag = "type")]
pub enum ServerMsg<'a> {
    LoginOk {
        name: String,
        currency: String,
        mode: AccountMode,
        account: AccountState,
        symbols: Vec<SymbolInfo>,
        positions: Vec<Position>,
        orders: Vec<Order>,
        /// Most recent deals, oldest first.
        deals: Vec<Deal>,
    },
    Error {
        message: &'a str,
    },
    /// s = symbol id, b = bid, a = ask, t = time in ms.
    Tick {
        s: SymbolId,
        b: Price,
        a: Price,
        t: Ts,
    },
    Event {
        event: &'a Event,
    },
    Pong,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messagepack_and_json_carry_the_same_messages() {
        let json = r#"{"type":"Order","client_id":5,"symbol":"EURUSD","side":"Sell","kind":"Limit","volume":2500,"price":108900}"#;
        let value: serde_json::Value = serde_json::from_str(json).unwrap();
        let packed = rmp_serde::to_vec_named(&value).unwrap();
        for msg in [
            serde_json::from_str::<ClientMsg>(json).unwrap(),
            rmp_serde::from_slice::<ClientMsg>(&packed).unwrap(),
        ] {
            let ClientMsg::Order {
                client_id,
                symbol,
                side,
                kind,
                volume,
                price,
                sl,
                ..
            } = msg
            else {
                panic!("wrong variant");
            };
            assert_eq!(
                (client_id, symbol.as_str(), side, kind),
                (5, "EURUSD", Side::Sell, OrderKind::Limit)
            );
            assert_eq!((volume, price, sl), (2500, 108_900, 0));
        }

        let out = ServerMsg::Tick {
            s: 3,
            b: 108_500,
            a: 108_508,
            t: 1,
        };
        let back: serde_json::Value =
            rmp_serde::from_slice(&rmp_serde::to_vec_named(&out).unwrap()).unwrap();
        assert_eq!(back, serde_json::to_value(&out).unwrap());
    }
}
