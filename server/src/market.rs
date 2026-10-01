//! Market classification, prices and candles.
//!
//! A market is `(base, quote)`. The quote is the policy asset (ECX) whenever
//! one side is ECX; otherwise base/quote are ordered lexicographically by the
//! displayed asset id. Prices are always *quote atomic units per base atomic
//! unit*; UIs scale by `10^(base_precision - quote_precision)`.

use std::collections::BTreeMap;

use elements::AssetId;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    /// Maker gives quote, wants base.
    Bid,
    /// Maker gives base, wants quote.
    Ask,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Bid => "bid",
            Side::Ask => "ask",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "bid" => Some(Side::Bid),
            "ask" => Some(Side::Ask),
            _ => None,
        }
    }
}

/// Exact price as a reduced fraction `quote / base`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ratio {
    pub num: u64,
    pub den: u64,
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

impl Ratio {
    pub fn new(num: u64, den: u64) -> Self {
        let divisor = gcd(num, den).max(1);
        Self {
            num: num / divisor,
            den: den / divisor,
        }
    }

    pub fn to_f64(self) -> f64 {
        if self.den == 0 {
            return 0.0;
        }
        self.num as f64 / self.den as f64
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    pub base: AssetId,
    pub quote: AssetId,
    pub side: Side,
    pub base_amount: u64,
    pub quote_amount: u64,
}

impl Placement {
    pub fn price(&self) -> Ratio {
        Ratio::new(self.quote_amount, self.base_amount)
    }
}

/// Canonical `(base, quote)` ordering for two distinct assets.
pub fn market_for(a: AssetId, b: AssetId, policy: AssetId) -> (AssetId, AssetId) {
    let a_is_base = if a == policy {
        false
    } else if b == policy {
        true
    } else {
        a.to_string() <= b.to_string()
    };
    if a_is_base {
        (a, b)
    } else {
        (b, a)
    }
}

/// Place an offer (maker gives `give`, wants `want`) on its market.
pub fn classify(
    give_asset: AssetId,
    give_amount: u64,
    want_asset: AssetId,
    want_amount: u64,
    policy: AssetId,
) -> Placement {
    let (base, quote) = market_for(give_asset, want_asset, policy);
    if give_asset == base {
        Placement {
            base,
            quote,
            side: Side::Ask,
            base_amount: give_amount,
            quote_amount: want_amount,
        }
    } else {
        Placement {
            base,
            quote,
            side: Side::Bid,
            base_amount: want_amount,
            quote_amount: give_amount,
        }
    }
}

/// Supported candle intervals in seconds.
pub fn parse_interval(value: &str) -> Option<i64> {
    Some(match value {
        "1m" => 60,
        "5m" => 300,
        "15m" => 900,
        "1h" => 3_600,
        "4h" => 14_400,
        "1d" => 86_400,
        "1w" => 604_800,
        _ => return None,
    })
}

#[derive(Clone, Copy, Debug)]
pub struct TradePoint {
    pub time: i64,
    pub price: f64,
    pub base_amount: u64,
    pub quote_amount: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Candle {
    /// Bucket start, unix seconds.
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    /// Base atomic units traded (decimal string).
    pub volume: String,
    /// Quote atomic units traded (decimal string).
    pub quote_volume: String,
    pub trades: u32,
}

/// Aggregate trades (any order; ties keep input order) into OHLCV buckets.
/// Empty buckets are omitted.
pub fn candles(trades: &[TradePoint], interval: i64) -> Vec<Candle> {
    let mut sorted: Vec<&TradePoint> = trades.iter().collect();
    sorted.sort_by_key(|trade| trade.time);
    let mut buckets: BTreeMap<i64, (Candle, u128, u128)> = BTreeMap::new();
    for trade in sorted {
        let start = trade.time - trade.time.rem_euclid(interval);
        let entry = buckets.entry(start).or_insert_with(|| {
            (
                Candle {
                    time: start,
                    open: trade.price,
                    high: trade.price,
                    low: trade.price,
                    close: trade.price,
                    volume: String::new(),
                    quote_volume: String::new(),
                    trades: 0,
                },
                0,
                0,
            )
        });
        let (candle, base, quote) = entry;
        candle.high = candle.high.max(trade.price);
        candle.low = candle.low.min(trade.price);
        candle.close = trade.price;
        candle.trades += 1;
        *base += u128::from(trade.base_amount);
        *quote += u128::from(trade.quote_amount);
    }
    buckets
        .into_values()
        .map(|(mut candle, base, quote)| {
            candle.volume = base.to_string();
            candle.quote_volume = quote.to_string();
            candle
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(byte: u8) -> AssetId {
        AssetId::from_byte_array([byte; 32])
    }

    #[test]
    fn ask_and_bid_against_policy() {
        let policy = asset(0xee);
        let token = asset(0x11);
        let ask = classify(token, 1_000, policy, 5_000, policy);
        assert_eq!((ask.base, ask.quote, ask.side), (token, policy, Side::Ask));
        assert_eq!((ask.base_amount, ask.quote_amount), (1_000, 5_000));
        assert_eq!(ask.price(), Ratio { num: 5, den: 1 });

        let bid = classify(policy, 4_000, token, 1_000, policy);
        assert_eq!((bid.base, bid.quote, bid.side), (token, policy, Side::Bid));
        assert_eq!((bid.base_amount, bid.quote_amount), (1_000, 4_000));
        assert_eq!(bid.price().to_f64(), 4.0);
    }

    #[test]
    fn non_native_pairs_order_lexicographically() {
        let policy = asset(0xee);
        let (low, high) = (asset(0x22), asset(0x33));
        assert!(low.to_string() < high.to_string());
        let ask = classify(low, 10, high, 30, policy);
        assert_eq!((ask.base, ask.quote, ask.side), (low, high, Side::Ask));
        let bid = classify(high, 30, low, 10, policy);
        assert_eq!((bid.base, bid.quote, bid.side), (low, high, Side::Bid));
        assert_eq!(market_for(high, low, policy), market_for(low, high, policy));
    }

    #[test]
    fn ratio_reduces() {
        assert_eq!(Ratio::new(2_500, 1_000), Ratio { num: 5, den: 2 });
        assert_eq!(Ratio::new(7, 3).to_f64(), 7.0 / 3.0);
    }

    #[test]
    fn candles_aggregate_ohlcv() {
        let trade = |time, price, base, quote| TradePoint {
            time,
            price,
            base_amount: base,
            quote_amount: quote,
        };
        let trades = [
            trade(3_700, 6.0, 1, 6),
            trade(3_600, 5.0, 2, 10),
            trade(3_650, 7.0, 3, 21),
            trade(7_300, 4.0, 4, 16),
            trade(10, 1.0, 1, 1),
        ];
        let result = candles(&trades, 3_600);
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].time, 0);
        let hour = &result[1];
        assert_eq!(hour.time, 3_600);
        assert_eq!(
            (hour.open, hour.high, hour.low, hour.close),
            (5.0, 7.0, 5.0, 6.0)
        );
        assert_eq!(
            (hour.volume.as_str(), hour.quote_volume.as_str()),
            ("6", "37")
        );
        assert_eq!(hour.trades, 3);
        assert_eq!(result[2].time, 7_200);
        assert_eq!(parse_interval("1h"), Some(3_600));
        assert_eq!(parse_interval("2h"), None);
    }
}
