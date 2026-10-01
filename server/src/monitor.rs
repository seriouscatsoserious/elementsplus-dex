//! Background offer monitor: every few seconds, check each open offer's
//! outpoint. A spend that pays the maker's exact output at the same index as
//! the maker input is a fill (recorded as a trade); any other spend cancels.

use std::time::Duration;

use crate::api::SharedState;
use crate::db::{self, OfferRecord};
use crate::esplora::EsploraError;
use crate::offer::{parse_offer, spend_fills_offer};
use crate::util::{now_secs, parse_txid};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MonitorStats {
    pub checked: usize,
    pub filled: usize,
    pub cancelled: usize,
    pub errors: usize,
    pub confirmed: usize,
}

enum Outcome {
    Open,
    Filled,
    Cancelled,
}

pub async fn run(state: SharedState, interval: Duration) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        match run_once(&state).await {
            Ok(stats) if stats.filled + stats.cancelled + stats.confirmed + stats.errors > 0 => {
                tracing::info!(?stats, "offer monitor pass");
            }
            Ok(stats) => tracing::debug!(?stats, "offer monitor pass"),
            Err(error) => tracing::error!(%error, "offer monitor pass failed"),
        }
    }
}

pub async fn run_once(state: &SharedState) -> Result<MonitorStats, crate::error::ApiError> {
    let offers = state.db.call(|conn| Ok(db::open_offers(conn)?)).await?;
    let mut stats = MonitorStats::default();
    for offer in offers {
        stats.checked += 1;
        match check_offer(state, &offer).await {
            Ok(Outcome::Open) => {}
            Ok(Outcome::Filled) => stats.filled += 1,
            Ok(Outcome::Cancelled) => stats.cancelled += 1,
            Err(error) => {
                stats.errors += 1;
                tracing::warn!(outpoint = %offer.outpoint, %error, "offer check failed");
            }
        }
    }
    confirm_trades(state, &mut stats).await?;
    Ok(stats)
}

/// Fills first seen unconfirmed carry the detection time; replace it with the
/// block time once the spending transaction confirms.
async fn confirm_trades(
    state: &SharedState,
    stats: &mut MonitorStats,
) -> Result<(), crate::error::ApiError> {
    let pending = state
        .db
        .call(|conn| Ok(db::unconfirmed_trades(conn)?))
        .await?;
    for (id, txid) in pending {
        let Ok(parsed) = parse_txid(&txid) else {
            continue;
        };
        match state.esplora.tx_status(&parsed).await {
            Ok(Some(status)) if status.confirmed => {
                let Some(block_time) = status.block_time else {
                    continue;
                };
                state
                    .db
                    .call(move |conn| Ok(db::confirm_trade(conn, id, block_time)?))
                    .await?;
                stats.confirmed += 1;
            }
            Ok(_) => {}
            Err(error) => {
                stats.errors += 1;
                tracing::warn!(%txid, %error, "trade status check failed");
            }
        }
    }
    Ok(())
}

async fn check_offer(state: &SharedState, offer: &OfferRecord) -> Result<Outcome, CheckError> {
    let txid = parse_txid(&offer.txid).map_err(CheckError::Data)?;
    let outspend = state.esplora.outspend(&txid, offer.vout).await?;
    if !outspend.spent {
        return Ok(Outcome::Open);
    }
    let spend_txid =
        parse_txid(outspend.txid.as_deref().unwrap_or_default()).map_err(CheckError::Data)?;
    let vin = outspend.vin.unwrap_or_default() as usize;
    let spend = state
        .esplora
        .tx(&spend_txid)
        .await?
        .ok_or_else(|| CheckError::Data("spending transaction not found".into()))?;
    let parsed = parse_offer(&offer.wire, &state.network)
        .map_err(|error| CheckError::Data(error.to_string()))?;
    let now = now_secs();
    let spend_txid = spend_txid.to_string();
    let id = offer.id;
    if spend_fills_offer(&spend, vin, &parsed.outpoint, &parsed.maker_output) {
        let status = outspend.status.unwrap_or_default();
        let confirmed = status.confirmed;
        let time = status.block_time.filter(|_| confirmed).unwrap_or(now);
        let record = offer.clone();
        let txid_for_log = spend_txid.clone();
        state
            .db
            .call(move |conn| {
                Ok(db::record_fill(
                    conn,
                    &record,
                    &spend_txid,
                    time,
                    confirmed,
                    now,
                )?)
            })
            .await
            .map_err(|error| CheckError::Data(error.to_string()))?;
        tracing::info!(outpoint = %offer.outpoint, spend_txid = %txid_for_log, "offer filled");
        Ok(Outcome::Filled)
    } else {
        let txid_for_log = spend_txid.clone();
        state
            .db
            .call(move |conn| Ok(db::mark_cancelled(conn, id, &spend_txid, now)?))
            .await
            .map_err(|error| CheckError::Data(error.to_string()))?;
        tracing::info!(outpoint = %offer.outpoint, spend_txid = %txid_for_log, "offer cancelled");
        Ok(Outcome::Cancelled)
    }
}

#[derive(Debug, thiserror::Error)]
enum CheckError {
    #[error(transparent)]
    Esplora(#[from] EsploraError),
    #[error("{0}")]
    Data(String),
}
