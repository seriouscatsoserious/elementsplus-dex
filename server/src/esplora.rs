//! Minimal Esplora HTTP client. Every transaction fetched from the explorer is
//! parsed locally and checked against the txid it was requested by, so the
//! explorer is trusted only for liveness/spentness, never for tx contents.

use std::time::Duration;

use elements::encode::deserialize;
use elements::{Transaction, Txid};
use serde::Deserialize;

use crate::util::decode_hex;

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TX_BYTES: usize = 1_000_000;

#[derive(Debug, thiserror::Error)]
pub enum EsploraError {
    #[error("explorer request failed: {0}")]
    Http(String),
    #[error("explorer returned status {0}")]
    Status(u16),
    #[error("explorer response invalid: {0}")]
    Invalid(String),
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct TxStatus {
    #[serde(default)]
    pub confirmed: bool,
    pub block_height: Option<u64>,
    pub block_hash: Option<String>,
    pub block_time: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Outspend {
    pub spent: bool,
    pub txid: Option<String>,
    pub vin: Option<u32>,
    pub status: Option<TxStatus>,
}

#[derive(Clone)]
pub struct Esplora {
    base: String,
    http: reqwest::Client,
}

impl Esplora {
    pub fn new(base: &str) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(5))
            .user_agent(concat!(
                "elementsplus-dex-server/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .expect("static reqwest configuration");
        Self {
            base: base.trim_end_matches('/').to_owned(),
            http,
        }
    }

    /// GET `path`; `Ok(None)` on 404.
    async fn get(&self, path: &str) -> Result<Option<String>, EsploraError> {
        let url = format!("{}{}", self.base, path);
        let mut response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|error| EsploraError::Http(error.without_url().to_string()))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(EsploraError::Status(status.as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|length| length as usize > MAX_RESPONSE_BYTES)
        {
            return Err(EsploraError::Invalid("response too large".into()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| EsploraError::Http(error.without_url().to_string()))?
        {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(EsploraError::Invalid("response too large".into()));
            }
            body.extend_from_slice(&chunk);
        }
        String::from_utf8(body)
            .map(Some)
            .map_err(|_| EsploraError::Invalid("response is not UTF-8".into()))
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
    ) -> Result<Option<T>, EsploraError> {
        match self.get(path).await? {
            None => Ok(None),
            Some(body) => serde_json::from_str(&body)
                .map(Some)
                .map_err(|error| EsploraError::Invalid(error.to_string())),
        }
    }

    /// Raw transaction hex, verified to hash to `txid`.
    pub async fn tx_hex(&self, txid: &Txid) -> Result<Option<String>, EsploraError> {
        let Some(raw) = self.get(&format!("/tx/{txid}/hex")).await? else {
            return Ok(None);
        };
        let raw = raw.trim().to_owned();
        parse_verified_tx(&raw, txid)?;
        Ok(Some(raw))
    }

    /// Parsed transaction, verified to hash to `txid`.
    pub async fn tx(&self, txid: &Txid) -> Result<Option<Transaction>, EsploraError> {
        match self.tx_hex(txid).await? {
            None => Ok(None),
            Some(raw) => parse_verified_tx(&raw, txid).map(Some),
        }
    }

    pub async fn outspend(&self, txid: &Txid, vout: u32) -> Result<Outspend, EsploraError> {
        let outspend: Outspend = self
            .get_json(&format!("/tx/{txid}/outspend/{vout}"))
            .await?
            .ok_or(EsploraError::Status(404))?;
        if outspend.spent && (outspend.txid.is_none() || outspend.vin.is_none()) {
            return Err(EsploraError::Invalid(
                "spent outspend without txid/vin".into(),
            ));
        }
        Ok(outspend)
    }

    pub async fn tx_status(&self, txid: &Txid) -> Result<Option<TxStatus>, EsploraError> {
        self.get_json(&format!("/tx/{txid}/status")).await
    }

    pub async fn tip_height(&self) -> Result<u64, EsploraError> {
        let body = self
            .get("/blocks/tip/height")
            .await?
            .ok_or(EsploraError::Status(404))?;
        body.trim()
            .parse()
            .map_err(|_| EsploraError::Invalid("tip height is not a number".into()))
    }
}

pub fn parse_verified_tx(raw: &str, txid: &Txid) -> Result<Transaction, EsploraError> {
    let bytes = decode_hex(raw, MAX_TX_BYTES, "transaction").map_err(EsploraError::Invalid)?;
    let tx: Transaction = deserialize(&bytes)
        .map_err(|_| EsploraError::Invalid("transaction does not decode".into()))?;
    if tx.txid() != *txid {
        return Err(EsploraError::Invalid(
            "transaction does not hash to the requested txid".into(),
        ));
    }
    Ok(tx)
}
