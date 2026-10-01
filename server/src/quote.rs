//! Whole-offer greedy routing for `GET /api/quote` (SPEC §6.1).
//!
//! The taker sells `sell` and buys `buy`, so the candidate offers are those
//! whose maker gives `buy` and wants `sell`. Offers cannot be partially
//! filled. Candidates are sorted best-first by the taker's cost per unit
//! bought (`want / give`, compared exactly), then walked in order: an offer is
//! taken if it fits in what is left of the constrained amount, otherwise it is
//! skipped and the walk continues. Neither side ever exceeds `amount`:
//!
//! * `exact_in`: `amount` is the most the taker will sell.
//! * `exact_out`: `amount` is the most the taker wants to receive.
//!
//! `unfilled` is the part of `amount` that could not be matched. Network fees
//! (paid by the taker in the policy asset) are not included.

use std::cmp::Ordering;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteSide {
    ExactIn,
    ExactOut,
}

impl QuoteSide {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "exact_in" => Some(Self::ExactIn),
            "exact_out" => Some(Self::ExactOut),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExactIn => "exact_in",
            Self::ExactOut => "exact_out",
        }
    }
}

/// One maker offer from the taker's point of view.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// Caller's handle (e.g. database id); also the final tie-breaker.
    pub id: i64,
    /// What the taker pays (the maker's `want` amount).
    pub sell: u64,
    /// What the taker receives (the maker's `give` amount).
    pub buy: u64,
}

/// Best (cheapest per unit bought) first.
pub fn compare(a: &Candidate, b: &Candidate) -> Ordering {
    let cost_a = u128::from(a.sell) * u128::from(b.buy);
    let cost_b = u128::from(b.sell) * u128::from(a.buy);
    cost_a
        .cmp(&cost_b)
        .then(b.buy.cmp(&a.buy))
        .then(a.id.cmp(&b.id))
}

#[derive(Clone, Debug, PartialEq)]
pub struct Route {
    /// Selected candidates, best first.
    pub selected: Vec<Candidate>,
    pub sell_amount: u128,
    pub buy_amount: u128,
    pub unfilled: u64,
    /// Average cost relative to the best candidate in the book, in basis
    /// points (0 = everything at the best price). `None` if nothing matched.
    pub price_impact_bps: Option<u64>,
}

pub fn route(
    mut candidates: Vec<Candidate>,
    side: QuoteSide,
    amount: u64,
    max_offers: usize,
) -> Route {
    candidates.retain(|candidate| candidate.sell > 0 && candidate.buy > 0);
    candidates.sort_by(compare);
    let best = candidates.first().copied();
    let mut remaining = amount;
    let mut selected = Vec::new();
    let (mut sell_amount, mut buy_amount) = (0u128, 0u128);
    for candidate in candidates {
        if remaining == 0 || selected.len() >= max_offers {
            break;
        }
        let constrained = match side {
            QuoteSide::ExactIn => candidate.sell,
            QuoteSide::ExactOut => candidate.buy,
        };
        if constrained > remaining {
            continue;
        }
        remaining -= constrained;
        sell_amount += u128::from(candidate.sell);
        buy_amount += u128::from(candidate.buy);
        selected.push(candidate);
    }
    let price_impact_bps = match (best, buy_amount) {
        (Some(best), buy) if buy > 0 => {
            let average = sell_amount as f64 / buy as f64;
            let reference = best.sell as f64 / best.buy as f64;
            Some(((average / reference - 1.0) * 10_000.0).round().max(0.0) as u64)
        }
        _ => None,
    };
    Route {
        selected,
        sell_amount,
        buy_amount,
        unfilled: remaining,
        price_impact_bps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer(id: i64, sell: u64, buy: u64) -> Candidate {
        Candidate { id, sell, buy }
    }

    fn ids(route: &Route) -> Vec<i64> {
        route
            .selected
            .iter()
            .map(|candidate| candidate.id)
            .collect()
    }

    #[test]
    fn sorts_by_exact_unit_cost() {
        // costs: 2.0, 1.5, 3.0, 1.5 (larger first on ties)
        let mut book = [
            offer(1, 200, 100),
            offer(2, 150, 100),
            offer(3, 300, 100),
            offer(4, 300, 200),
        ];
        book.sort_by(compare);
        assert_eq!(
            book.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec![4, 2, 1, 3]
        );
    }

    #[test]
    fn exact_in_takes_cheapest_offers_that_fit() {
        let book = vec![
            offer(1, 100, 50),
            offer(2, 100, 40),
            offer(3, 500, 300),
            offer(4, 50, 20),
        ];
        // cost: #3 1.67, #1 2.0, #4 2.5, #2 2.5 → #3 doesn't fit in 250, skip.
        let route = route(book, QuoteSide::ExactIn, 250, 10);
        assert_eq!(ids(&route), vec![1, 2, 4]);
        assert_eq!(route.sell_amount, 250);
        assert_eq!(route.buy_amount, 110);
        assert_eq!(route.unfilled, 0);
        // average 250/110 = 2.2727 vs best-in-book 500/300 = 1.6667 → +3636 bps
        assert_eq!(route.price_impact_bps, Some(3_636));
    }

    #[test]
    fn exact_out_never_overshoots() {
        let book = vec![offer(1, 100, 50), offer(2, 120, 50), offer(3, 30, 10)];
        let route = route(book, QuoteSide::ExactOut, 70, 10);
        assert_eq!(ids(&route), vec![1, 3]);
        assert_eq!(route.buy_amount, 60);
        assert_eq!(route.sell_amount, 130);
        assert_eq!(route.unfilled, 10);
    }

    #[test]
    fn empty_and_capped() {
        let empty = route(Vec::new(), QuoteSide::ExactIn, 10, 10);
        assert!(empty.selected.is_empty());
        assert_eq!((empty.unfilled, empty.price_impact_bps), (10, None));

        let book = (0..10).map(|id| offer(id, 10, 10)).collect();
        let capped = route(book, QuoteSide::ExactIn, 1_000, 3);
        assert_eq!(capped.selected.len(), 3);
        assert_eq!(capped.unfilled, 970);
        assert_eq!(capped.price_impact_bps, Some(0));
    }

    #[test]
    fn large_amounts_do_not_overflow() {
        let book = vec![
            offer(1, u64::MAX, u64::MAX),
            offer(2, u64::MAX, u64::MAX - 1),
        ];
        let route = route(book, QuoteSide::ExactOut, u64::MAX, 10);
        assert_eq!(ids(&route), vec![1]);
        assert_eq!(route.sell_amount, u128::from(u64::MAX));
    }
}
