//! Environment configuration.

use std::net::SocketAddr;
use std::str::FromStr;

use elements::{AssetId, BlockHash};

/// ECX Alpha mainnet-alpha parameters (mirrors `elementsplus-lwk-adapter`).
pub const DEFAULT_GENESIS_HASH: &str =
    "672af009bd90bfc6527a5a9dda4c83aba0048c15cff3697d07e89a7f96fa5bcd";
pub const DEFAULT_POLICY_ASSET: &str =
    "62dce3bd80dc4b0503e7ccbb3fcfa4d7adfd64b4e0cc78fa5e1754b88f1d2da4";
pub const DEFAULT_NETWORK_NAME: &str = "ecx-alpha";
pub const DEFAULT_ADDRESS_HRP: &str = "elements";
pub const DEFAULT_LISTEN: &str = "127.0.0.1:8790";
pub const DEFAULT_ESPLORA_URL: &str = "http://127.0.0.1:43199/api";
pub const DEFAULT_DB_PATH: &str = "dex.sqlite3";
pub const DEFAULT_CORS_ORIGINS: &str = "http://localhost:5173,http://127.0.0.1:5173";

/// Chain identity the server enforces on every offer.
#[derive(Clone, Debug)]
pub struct Network {
    pub name: String,
    pub genesis_hash: BlockHash,
    pub policy_asset: AssetId,
    /// Bech32 HRP used when rendering maker addresses (`elements` for ECX
    /// Alpha, `ert` for stock Elements regtest).
    pub address_hrp: String,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub esplora_url: String,
    pub listen: SocketAddr,
    pub db_path: String,
    pub network: Network,
    /// Empty = no CORS headers; `*` = any origin.
    pub cors_origins: Vec<String>,
    pub monitor_interval_secs: u64,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let var = |key: &str, default: &str| {
            std::env::var(key)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| default.to_owned())
        };
        let esplora_url = var("ESPLORA_URL", DEFAULT_ESPLORA_URL)
            .trim_end_matches('/')
            .to_owned();
        if !(esplora_url.starts_with("http://") || esplora_url.starts_with("https://")) {
            return Err("ESPLORA_URL must be an http(s) URL".into());
        }
        let listen = SocketAddr::from_str(&var("LISTEN", DEFAULT_LISTEN))
            .map_err(|_| "LISTEN must be host:port".to_owned())?;
        let genesis_hash = BlockHash::from_str(&var("GENESIS_HASH", DEFAULT_GENESIS_HASH))
            .map_err(|_| "GENESIS_HASH must be a 32-byte hex block hash".to_owned())?;
        let policy_asset = AssetId::from_str(&var("POLICY_ASSET", DEFAULT_POLICY_ASSET))
            .map_err(|_| "POLICY_ASSET must be a 32-byte hex asset id".to_owned())?;
        let address_hrp = var("ADDRESS_HRP", DEFAULT_ADDRESS_HRP).to_ascii_lowercase();
        elements::bitcoin::bech32::Hrp::parse(&address_hrp)
            .map_err(|_| "ADDRESS_HRP is not a valid bech32 HRP".to_owned())?;
        let cors_origins = var("CORS_ORIGINS", DEFAULT_CORS_ORIGINS)
            .split(',')
            .map(|origin| origin.trim().trim_end_matches('/').to_owned())
            .filter(|origin| !origin.is_empty())
            .collect();
        let monitor_interval_secs = var("MONITOR_INTERVAL_SECS", "5")
            .parse::<u64>()
            .ok()
            .filter(|secs| (1..=3600).contains(secs))
            .ok_or("MONITOR_INTERVAL_SECS must be 1..=3600")?;
        Ok(Self {
            esplora_url,
            listen,
            db_path: var("DB_PATH", DEFAULT_DB_PATH),
            network: Network {
                name: var("NETWORK_NAME", DEFAULT_NETWORK_NAME),
                genesis_hash,
                policy_asset,
                address_hrp,
            },
            cors_origins,
            monitor_interval_secs,
        })
    }
}
