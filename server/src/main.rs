use std::time::Duration;

use elementsplus_dex_server::{app_state, db::Db, monitor, router, Config};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info"));
    let json_logs = std::env::var("LOG_FORMAT").is_ok_and(|format| format == "json");
    if json_logs {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            tracing::error!(%error, "invalid configuration");
            std::process::exit(2);
        }
    };
    let db = match Db::open(&config.db_path) {
        Ok(db) => db,
        Err(error) => {
            tracing::error!(%error, path = %config.db_path, "cannot open database");
            std::process::exit(1);
        }
    };
    let state = app_state(config.network.clone(), db, &config.esplora_url);
    tokio::spawn(monitor::run(
        state.clone(),
        Duration::from_secs(config.monitor_interval_secs),
    ));

    let app = router(state, &config.cors_origins);
    let listener = match tokio::net::TcpListener::bind(config.listen).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::error!(%error, listen = %config.listen, "cannot bind");
            std::process::exit(1);
        }
    };
    tracing::info!(
        listen = %config.listen,
        esplora = %config.esplora_url,
        network = %config.network.name,
        genesis = %config.network.genesis_hash,
        policy_asset = %config.network.policy_asset,
        "elementsplus-dex-server listening"
    );
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("shutting down");
    };
    if let Err(error) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
    {
        tracing::error!(%error, "server error");
        std::process::exit(1);
    }
}
