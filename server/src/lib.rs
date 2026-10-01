//! Elements+ (ECX Alpha) DEX server: verified swap-offer book, trade history
//! derived from on-chain fills, and a verified asset registry. The server holds
//! no keys and never signs anything.

pub mod api;
pub mod config;
pub mod db;
pub mod error;
pub mod esplora;
pub mod issuance;
pub mod market;
pub mod monitor;
pub mod offer;
pub mod openapi;
pub mod quote;
pub mod util;

use std::sync::Arc;

pub use api::{router, AppState, SharedState};
pub use config::{Config, Network};
pub use offer::{Offer, OfferLeg};

/// Build the shared state for a configuration and database.
pub fn app_state(network: Network, db: db::Db, esplora_url: &str) -> SharedState {
    Arc::new(AppState {
        network,
        db,
        esplora: esplora::Esplora::new(esplora_url),
    })
}

#[cfg(test)]
#[path = "../tests/common/mod.rs"]
mod test_support;
