//! HTTP API (SPEC §4.1, §6.1).

use std::future::Future;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, PathRejection, QueryRejection};
use axum::extract::{DefaultBodyLimit, FromRequest, FromRequestParts, Path, Query, Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use elements::hashes::{sha256, Hash};
use elements::AssetId;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::config::Network;
use crate::db::{self, AssetRecord, Db, IdempotentResponse, NewOffer, OfferRecord, TradeRecord};
use crate::error::{ApiError, ApiResult};
use crate::esplora::{Esplora, EsploraError};
use crate::issuance::{canonical_contract, verify_asset_issuance, IssuanceError};
use crate::market::{self, classify, market_for, Candle, TradePoint};
use crate::offer::{p2wpkh_script_from_address, parse_offer, verify_offer, Offer, OfferError};
use crate::quote::{self, Candidate, QuoteSide};
use crate::util::{now_secs, parse_amount, parse_asset_id, parse_txid};

pub const MAX_BODY_BYTES: usize = 64 * 1024;
pub const DEFAULT_PAGE_LIMIT: u32 = 100;
pub const MAX_PAGE_LIMIT: u32 = 500;
/// Most offers a quote will route through (bounds the taker tx size).
pub const MAX_ROUTE_OFFERS: usize = 50;
pub const IDEMPOTENCY_HEADER: &str = "idempotency-key";
pub const IDEMPOTENT_REPLAY_HEADER: &str = "idempotent-replayed";

pub mod paths {
    pub const HEALTH: &str = "/api/health";
    pub const OPENAPI: &str = "/api/openapi.json";
    pub const LLMS: &str = "/llms.txt";
    pub const ASSETS: &str = "/api/assets";
    pub const ASSET: &str = "/api/assets/{asset_id}";
    pub const MARKETS: &str = "/api/markets";
    pub const BOOK: &str = "/api/markets/{base}/{quote}/book";
    pub const TRADES: &str = "/api/markets/{base}/{quote}/trades";
    pub const CANDLES: &str = "/api/markets/{base}/{quote}/candles";
    pub const QUOTE: &str = "/api/quote";
    pub const OFFERS: &str = "/api/offers";
    pub const OFFER: &str = "/api/offers/{txid}/{vout}";
}

/// Every routed `(method, path)`; the OpenAPI document must describe each.
pub const ROUTES: &[(&str, &str)] = &[
    ("get", paths::HEALTH),
    ("get", paths::OPENAPI),
    ("get", paths::LLMS),
    ("get", paths::ASSETS),
    ("post", paths::ASSETS),
    ("get", paths::ASSET),
    ("get", paths::MARKETS),
    ("get", paths::BOOK),
    ("get", paths::TRADES),
    ("get", paths::CANDLES),
    ("get", paths::QUOTE),
    ("get", paths::OFFERS),
    ("post", paths::OFFERS),
    ("get", paths::OFFER),
];

pub struct AppState {
    pub network: Network,
    pub db: Db,
    pub esplora: Esplora,
}

pub type SharedState = Arc<AppState>;

impl From<EsploraError> for ApiError {
    fn from(error: EsploraError) -> Self {
        ApiError::upstream(error)
    }
}

impl From<OfferError> for ApiError {
    fn from(error: OfferError) -> Self {
        if error.code == "internal_error" {
            return ApiError::internal(error.message);
        }
        ApiError::bad(error.code, error.message)
    }
}

impl From<IssuanceError> for ApiError {
    fn from(error: IssuanceError) -> Self {
        if error.code == "internal_error" {
            return ApiError::internal(error.message);
        }
        ApiError::bad(error.code, error.message)
    }
}

// ---------------------------------------------------------------------------
// Extractors that turn axum's plain-text rejections into JSON errors.

pub struct ApiBody(pub Bytes);

impl<S: Send + Sync> FromRequest<S> for ApiBody {
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, ApiError> {
        Bytes::from_request(request, state)
            .await
            .map(Self)
            .map_err(|rejection: BytesRejection| {
                if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    ApiError::too_large()
                } else {
                    ApiError::bad("invalid_request", rejection.body_text())
                }
            })
    }
}

fn parse_json<T: DeserializeOwned>(body: &Bytes) -> ApiResult<T> {
    serde_json::from_slice(body)
        .map_err(|error| ApiError::bad("invalid_request", format!("invalid JSON body: {error}")))
}

pub struct ApiQuery<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequestParts<S> for ApiQuery<T> {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        Query::<T>::from_request_parts(parts, state)
            .await
            .map(|Query(value)| Self(value))
            .map_err(|rejection: QueryRejection| {
                ApiError::bad("invalid_request", rejection.body_text())
            })
    }
}

pub struct ApiPath<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned + Send> FromRequestParts<S> for ApiPath<T> {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        Path::<T>::from_request_parts(parts, state)
            .await
            .map(|Path(value)| Self(value))
            .map_err(|rejection: PathRejection| {
                ApiError::bad("invalid_request", rejection.body_text())
            })
    }
}

fn asset_param(value: &str) -> ApiResult<AssetId> {
    parse_asset_id(value).map_err(|message| ApiError::bad("invalid_asset_id", message))
}

fn txid_param(value: &str) -> ApiResult<elements::Txid> {
    parse_txid(value).map_err(|message| ApiError::bad("invalid_txid", message))
}

// ---------------------------------------------------------------------------
// Pagination

/// Envelope for every paginated list. Pass `next_cursor` back as `?cursor=`
/// to fetch the next page; `null` means there is nothing more.
#[derive(Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct PageQuery {
    limit: Option<u32>,
    cursor: Option<String>,
}

fn page_limit(limit: Option<u32>) -> ApiResult<u32> {
    match limit {
        None => Ok(DEFAULT_PAGE_LIMIT),
        Some(limit) if (1..=MAX_PAGE_LIMIT).contains(&limit) => Ok(limit),
        Some(_) => Err(ApiError::bad(
            "invalid_limit",
            format!("limit must be 1-{MAX_PAGE_LIMIT}"),
        )),
    }
}

fn invalid_cursor() -> ApiError {
    ApiError::bad(
        "invalid_cursor",
        "cursor is malformed or from another endpoint",
    )
}

fn int_cursor(cursor: Option<&str>) -> ApiResult<Option<i64>> {
    cursor
        .map(|cursor| cursor.parse::<i64>().map_err(|_| invalid_cursor()))
        .transpose()
}

/// Cut a `limit + 1` result set to `limit` and derive the next cursor.
fn paginate<T>(mut items: Vec<T>, limit: u32, cursor_of: impl Fn(&T) -> String) -> Page<T> {
    let next_cursor = if items.len() > limit as usize {
        items.truncate(limit as usize);
        items.last().map(cursor_of)
    } else {
        None
    };
    Page { items, next_cursor }
}

// ---------------------------------------------------------------------------
// Idempotency

/// Run a POST handler under an optional `Idempotency-Key`. Successful (2xx)
/// responses are stored for 24 h and replayed for the same key and identical
/// body; reusing a key with a different body is rejected.
async fn idempotent<F, Fut>(
    state: &SharedState,
    route: &'static str,
    headers: &HeaderMap,
    body: &Bytes,
    handler: F,
) -> ApiResult<Response>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ApiResult<(StatusCode, Value)>>,
{
    let key = match headers.get(IDEMPOTENCY_HEADER) {
        None => None,
        Some(value) => {
            let key = value
                .to_str()
                .ok()
                .filter(|key| (1..=255).contains(&key.len()))
                .filter(|key| key.bytes().all(|byte| byte.is_ascii_graphic()))
                .ok_or_else(|| {
                    ApiError::bad(
                        "invalid_idempotency_key",
                        "Idempotency-Key must be 1-255 visible ASCII characters",
                    )
                })?;
            Some(key.to_owned())
        }
    };
    let Some(key) = key else {
        let (status, value) = handler().await?;
        return Ok((status, Json(value)).into_response());
    };

    let request_hash = sha256::Hash::hash(body).to_string();
    let now = now_secs();
    let lookup_key = key.clone();
    let stored = state
        .db
        .call(move |conn| Ok(db::find_idempotent(conn, route, &lookup_key, now)?))
        .await?;
    if let Some(stored) = stored {
        if stored.request_hash != request_hash {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "idempotency_key_reused",
                "this Idempotency-Key was already used with a different request body",
            ));
        }
        let status = StatusCode::from_u16(stored.status).map_err(ApiError::internal)?;
        let mut response = (
            status,
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            )],
            stored.body,
        )
            .into_response();
        response.headers_mut().insert(
            HeaderName::from_static(IDEMPOTENT_REPLAY_HEADER),
            HeaderValue::from_static("true"),
        );
        return Ok(response);
    }

    let (status, value) = handler().await?;
    if status.is_success() {
        let record = IdempotentResponse {
            request_hash,
            status: status.as_u16(),
            body: serde_json::to_string(&value).map_err(ApiError::internal)?,
        };
        state
            .db
            .call(move |conn| Ok(db::store_idempotent(conn, route, &key, &record, now)?))
            .await?;
    }
    Ok((status, Json(value)).into_response())
}

fn to_value<T: Serialize>(value: &T) -> ApiResult<Value> {
    serde_json::to_value(value).map_err(ApiError::internal)
}

// ---------------------------------------------------------------------------

pub fn router(state: SharedState, cors_origins: &[String]) -> Router {
    let api = Router::new()
        .route(paths::HEALTH, get(health))
        .route(paths::OPENAPI, get(openapi))
        .route(paths::LLMS, get(llms_txt))
        .route(paths::ASSETS, get(list_assets).post(register_asset))
        .route(paths::ASSET, get(get_asset))
        .route(paths::MARKETS, get(list_markets))
        .route(paths::BOOK, get(book))
        .route(paths::TRADES, get(trades))
        .route(paths::CANDLES, get(candles))
        .route(paths::QUOTE, get(get_quote))
        .route(paths::OFFERS, get(maker_offers).post(post_offer))
        .route(paths::OFFER, get(get_offer))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
        .layer(TraceLayer::new_for_http());
    match cors_layer(cors_origins) {
        Some(cors) => api.layer(cors),
        None => api,
    }
}

fn cors_layer(origins: &[String]) -> Option<CorsLayer> {
    if origins.is_empty() {
        return None;
    }
    let allow = if origins.iter().any(|origin| origin == "*") {
        AllowOrigin::any()
    } else {
        AllowOrigin::list(
            origins
                .iter()
                .filter_map(|origin| HeaderValue::from_str(origin).ok()),
        )
    };
    Some(
        CorsLayer::new()
            .allow_origin(allow)
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers([
                header::CONTENT_TYPE,
                HeaderName::from_static(IDEMPOTENCY_HEADER),
            ])
            .expose_headers([HeaderName::from_static(IDEMPOTENT_REPLAY_HEADER)])
            .max_age(std::time::Duration::from_secs(600)),
    )
}

async fn not_found() -> ApiError {
    ApiError::not_found("route_not_found", "no such endpoint; see /api/openapi.json")
}

async fn method_not_allowed() -> ApiError {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
        "method not allowed for this endpoint",
    )
}

// ---------------------------------------------------------------------------
// Health and discovery

async fn health(State(state): State<SharedState>) -> Response {
    let network = &state.network;
    let mut body = json!({
        "ok": true,
        "tip": null,
        "network": network.name,
        "genesis_hash": network.genesis_hash.to_string(),
        "policy_asset": network.policy_asset.to_string(),
    });
    match state.esplora.tip_height().await {
        Ok(tip) => {
            body["tip"] = json!(tip);
            Json(body).into_response()
        }
        Err(error) => {
            tracing::warn!(%error, "health check: explorer unavailable");
            body["ok"] = json!(false);
            body["error"] =
                json!({ "code": "upstream_error", "message": "block explorer unavailable" });
            (StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response()
        }
    }
}

async fn openapi() -> Json<Value> {
    Json(crate::openapi::document())
}

async fn llms_txt(State(state): State<SharedState>) -> Response {
    (
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        crate::openapi::llms_txt(&state.network),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Asset registry

async fn list_assets(
    State(state): State<SharedState>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> ApiResult<Json<Page<AssetRecord>>> {
    let limit = page_limit(query.limit)?;
    let before = int_cursor(query.cursor.as_deref())?;
    let rows = state
        .db
        .call(move |conn| Ok(db::list_assets(conn, limit + 1, before)?))
        .await?;
    let page = paginate(rows, limit, |(rowid, _)| rowid.to_string());
    Ok(Json(Page {
        items: page.items.into_iter().map(|(_, asset)| asset).collect(),
        next_cursor: page.next_cursor,
    }))
}

async fn get_asset(
    State(state): State<SharedState>,
    ApiPath(asset_id): ApiPath<String>,
) -> ApiResult<Json<AssetRecord>> {
    asset_param(&asset_id)?;
    state
        .db
        .call(move |conn| Ok(db::find_asset(conn, &asset_id)?))
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("unknown_asset", "asset is not in the registry"))
}

#[derive(Deserialize)]
struct AssetRegistration {
    issuance_txid: String,
    vin: u32,
    contract: Value,
    #[serde(default)]
    icon_url: Option<String>,
}

async fn register_asset(
    State(state): State<SharedState>,
    headers: HeaderMap,
    ApiBody(body): ApiBody,
) -> ApiResult<Response> {
    idempotent(&state, paths::ASSETS, &headers, &body, || {
        register_asset_inner(&state, &body)
    })
    .await
}

async fn register_asset_inner(state: &SharedState, body: &Bytes) -> ApiResult<(StatusCode, Value)> {
    let request: AssetRegistration = parse_json(body)?;
    let txid = txid_param(&request.issuance_txid)?;
    if request.icon_url.is_some() {
        return Err(ApiError::bad(
            "unsupported_field",
            "icon_url is not supported yet; send null",
        ));
    }
    if request.vin > 10_000 {
        return Err(ApiError::bad("invalid_issuance", "vin out of range"));
    }
    // Cheap validation before touching the explorer.
    canonical_contract(&request.contract)?;
    let raw = state
        .esplora
        .tx_hex(&txid)
        .await?
        .ok_or_else(|| ApiError::bad("issuance_not_found", "issuance transaction not found"))?;
    let verified = verify_asset_issuance(&raw, &txid, request.vin, &request.contract)?;
    if verified.asset_id == state.network.policy_asset.to_string() {
        return Err(ApiError::bad(
            "invalid_issuance",
            "the policy asset cannot be registered",
        ));
    }
    let record = AssetRecord {
        asset_id: verified.asset_id.clone(),
        token_id: verified.token_id.clone(),
        contract: serde_json::from_str(&verified.canonical_contract).map_err(ApiError::internal)?,
        contract_hash: verified.contract_hash.clone(),
        issuance_txid: request.issuance_txid,
        issuance_vin: request.vin,
        icon_url: None,
        created_at: now_secs(),
    };
    let canonical = verified.canonical_contract;
    let (inserted, stored) = state
        .db
        .call(move |conn| {
            let inserted = db::insert_asset(conn, &record, &canonical)?;
            let stored = db::find_asset(conn, &record.asset_id)?
                .ok_or_else(|| ApiError::internal("asset vanished after insert"))?;
            Ok((inserted, stored))
        })
        .await?;
    let status = if inserted {
        tracing::info!(asset_id = %stored.asset_id, "asset registered");
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, to_value(&stored)?))
}

// ---------------------------------------------------------------------------
// Markets

fn parse_market(state: &AppState, base: &str, quote: &str) -> ApiResult<(AssetId, AssetId)> {
    let base_id = asset_param(base)?;
    let quote_id = asset_param(quote)?;
    if base_id == quote_id {
        return Err(ApiError::bad("same_asset", "base and quote must differ"));
    }
    let canonical = market_for(base_id, quote_id, state.network.policy_asset);
    if canonical != (base_id, quote_id) {
        return Err(ApiError::bad(
            "non_canonical_market",
            format!(
                "not a canonical market; use /api/markets/{}/{}",
                canonical.0, canonical.1
            ),
        ));
    }
    Ok((base_id, quote_id))
}

#[derive(Serialize)]
struct MarketSummary {
    base: String,
    quote: String,
    last_price: Option<f64>,
    /// Fractional change vs. the price 24 h ago (0.05 = +5 %).
    change_24h: Option<f64>,
    /// Quote atomic units traded in the last 24 h.
    volume_24h: String,
    /// Base atomic units traded in the last 24 h.
    base_volume_24h: String,
    trades_24h: usize,
    best_bid: Option<f64>,
    best_ask: Option<f64>,
    bids: u32,
    asks: u32,
}

fn summarize(
    conn: &rusqlite::Connection,
    base: String,
    quote: String,
    now: i64,
) -> ApiResult<MarketSummary> {
    let since = now - 86_400;
    let top = db::book_top(conn, &base, &quote)?;
    let last = db::recent_trades(conn, &base, &quote, 1, None)?
        .into_iter()
        .next();
    let window = db::trades_between(conn, &base, &quote, since, i64::MAX)?;
    let reference =
        db::last_trade_before(conn, &base, &quote, since)?.or_else(|| window.first().cloned());
    let change_24h = match (&last, &reference) {
        (Some(last), Some(reference)) if reference.price > 0.0 => {
            Some((last.price - reference.price) / reference.price)
        }
        _ => None,
    };
    let (mut base_volume, mut quote_volume) = (0u128, 0u128);
    for trade in &window {
        base_volume += u128::from(parse_amount(&trade.base_amount).unwrap_or(0));
        quote_volume += u128::from(parse_amount(&trade.quote_amount).unwrap_or(0));
    }
    Ok(MarketSummary {
        base,
        quote,
        last_price: last.map(|trade| trade.price),
        change_24h,
        volume_24h: quote_volume.to_string(),
        base_volume_24h: base_volume.to_string(),
        trades_24h: window.len(),
        best_bid: top.best_bid,
        best_ask: top.best_ask,
        bids: top.bids,
        asks: top.asks,
    })
}

async fn list_markets(
    State(state): State<SharedState>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> ApiResult<Json<Page<MarketSummary>>> {
    let limit = page_limit(query.limit)?;
    let after = match query.cursor.as_deref() {
        None => None,
        Some(cursor) => {
            let (base, quote) = cursor.split_once(':').ok_or_else(invalid_cursor)?;
            asset_param(base).map_err(|_| invalid_cursor())?;
            asset_param(quote).map_err(|_| invalid_cursor())?;
            Some((base.to_owned(), quote.to_owned()))
        }
    };
    let now = now_secs();
    let markets = state
        .db
        .call(move |conn| {
            db::active_markets(conn)?
                .into_iter()
                .filter(|pair| after.as_ref().is_none_or(|after| pair > after))
                .take(limit as usize + 1)
                .map(|(base, quote)| summarize(conn, base, quote, now))
                .collect::<ApiResult<Vec<_>>>()
        })
        .await?;
    Ok(Json(paginate(markets, limit, |market| {
        format!("{}:{}", market.base, market.quote)
    })))
}

#[derive(Serialize)]
struct Book {
    base: String,
    quote: String,
    /// Best (highest) price first.
    bids: Vec<OfferRecord>,
    /// Best (lowest) price first.
    asks: Vec<OfferRecord>,
}

#[derive(Deserialize)]
struct BookQuery {
    limit: Option<u32>,
}

async fn book(
    State(state): State<SharedState>,
    ApiPath((base, quote)): ApiPath<(String, String)>,
    ApiQuery(query): ApiQuery<BookQuery>,
) -> ApiResult<Json<Book>> {
    parse_market(&state, &base, &quote)?;
    let limit = page_limit(query.limit)?;
    let book = state
        .db
        .call(move |conn| {
            Ok(Book {
                bids: db::market_offers(conn, &base, &quote, "bid", limit)?,
                asks: db::market_offers(conn, &base, &quote, "ask", limit)?,
                base,
                quote,
            })
        })
        .await?;
    Ok(Json(book))
}

async fn trades(
    State(state): State<SharedState>,
    ApiPath((base, quote)): ApiPath<(String, String)>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> ApiResult<Json<Page<TradeRecord>>> {
    parse_market(&state, &base, &quote)?;
    let limit = page_limit(query.limit)?;
    let before = match query.cursor.as_deref() {
        None => None,
        Some(cursor) => {
            let (time, id) = cursor.split_once('.').ok_or_else(invalid_cursor)?;
            Some((
                time.parse::<i64>().map_err(|_| invalid_cursor())?,
                id.parse::<i64>().map_err(|_| invalid_cursor())?,
            ))
        }
    };
    let trades = state
        .db
        .call(move |conn| Ok(db::recent_trades(conn, &base, &quote, limit + 1, before)?))
        .await?;
    Ok(Json(paginate(trades, limit, |trade| {
        format!("{}.{}", trade.time, trade.id)
    })))
}

#[derive(Deserialize)]
struct CandlesQuery {
    interval: Option<String>,
    limit: Option<u32>,
    cursor: Option<String>,
}

/// Candles for the `limit` buckets ending before `cursor` (unix seconds,
/// default now), oldest first. `next_cursor` pages further back in time.
async fn candles(
    State(state): State<SharedState>,
    ApiPath((base, quote)): ApiPath<(String, String)>,
    ApiQuery(query): ApiQuery<CandlesQuery>,
) -> ApiResult<Json<Page<Candle>>> {
    parse_market(&state, &base, &quote)?;
    let interval_name = query.interval.unwrap_or_else(|| "1h".into());
    let interval = market::parse_interval(&interval_name).ok_or_else(|| {
        ApiError::bad(
            "invalid_interval",
            "interval must be one of 1m, 5m, 15m, 1h, 4h, 1d, 1w",
        )
    })?;
    let limit = match query.limit {
        None => 300,
        Some(limit) if (1..=1_000).contains(&limit) => limit,
        Some(_) => return Err(ApiError::bad("invalid_limit", "limit must be 1-1000")),
    };
    let until = match int_cursor(query.cursor.as_deref())? {
        Some(cursor) => cursor,
        None => {
            let now = now_secs();
            now - now.rem_euclid(interval) + interval
        }
    };
    let since = until - interval * i64::from(limit);
    let (trades, older) = state
        .db
        .call(move |conn| {
            let trades = db::trades_between(conn, &base, &quote, since, until)?;
            let older = db::last_trade_before(conn, &base, &quote, since)?.is_some();
            Ok((trades, older))
        })
        .await?;
    let points: Vec<TradePoint> = trades
        .iter()
        .map(|trade| TradePoint {
            time: trade.time,
            price: trade.price,
            base_amount: parse_amount(&trade.base_amount).unwrap_or(0),
            quote_amount: parse_amount(&trade.quote_amount).unwrap_or(0),
        })
        .collect();
    Ok(Json(Page {
        items: market::candles(&points, interval),
        next_cursor: older.then(|| since.to_string()),
    }))
}

// ---------------------------------------------------------------------------
// Quote

#[derive(Deserialize)]
struct QuoteQuery {
    sell: String,
    buy: String,
    amount: String,
    side: Option<String>,
}

#[derive(Serialize)]
struct QuoteResponse {
    side: &'static str,
    sell_asset: String,
    buy_asset: String,
    /// The requested amount (sell units for exact_in, buy units for exact_out).
    amount: String,
    base: String,
    quote: String,
    /// Offers to pass to `ep_takeSwapOffers`, best first.
    offers: Vec<OfferRecord>,
    sell_amount: String,
    buy_amount: String,
    /// Average price in market terms (quote atomic per base atomic).
    price: Option<f64>,
    price_impact_bps: Option<u64>,
    /// Part of `amount` that could not be matched with whole offers.
    unfilled: String,
}

async fn get_quote(
    State(state): State<SharedState>,
    ApiQuery(query): ApiQuery<QuoteQuery>,
) -> ApiResult<Json<QuoteResponse>> {
    let sell = asset_param(&query.sell)?;
    let buy = asset_param(&query.buy)?;
    if sell == buy {
        return Err(ApiError::bad("same_asset", "sell and buy must differ"));
    }
    let amount = parse_amount(&query.amount)
        .ok()
        .filter(|amount| *amount > 0)
        .ok_or_else(|| {
            ApiError::bad(
                "invalid_amount",
                "amount must be a positive decimal string of atomic units",
            )
        })?;
    let side = QuoteSide::parse(query.side.as_deref().unwrap_or("exact_in"))
        .ok_or_else(|| ApiError::bad("invalid_side", "side must be exact_in or exact_out"))?;
    let (sell_hex, buy_hex) = (sell.to_string(), buy.to_string());
    // Maker gives what the taker buys and wants what the taker sells.
    let offers = state
        .db
        .call(move |conn| Ok(db::offers_for_pair(conn, &buy_hex, &sell_hex)?))
        .await?;
    let candidates = offers
        .iter()
        .filter_map(|offer| {
            Some(Candidate {
                id: offer.id,
                sell: parse_amount(&offer.wire.want.amount).ok()?,
                buy: parse_amount(&offer.wire.give.amount).ok()?,
            })
        })
        .collect();
    let route = quote::route(candidates, side, amount, MAX_ROUTE_OFFERS);
    let (base, quote_asset) = market_for(sell, buy, state.network.policy_asset);
    let price = (route.buy_amount > 0).then(|| {
        let (sell_total, buy_total) = (route.sell_amount as f64, route.buy_amount as f64);
        if buy == base {
            sell_total / buy_total
        } else {
            buy_total / sell_total
        }
    });
    let mut by_id: std::collections::HashMap<i64, OfferRecord> =
        offers.into_iter().map(|offer| (offer.id, offer)).collect();
    let selected = route
        .selected
        .iter()
        .filter_map(|candidate| by_id.remove(&candidate.id))
        .collect();
    Ok(Json(QuoteResponse {
        side: side.as_str(),
        sell_asset: sell.to_string(),
        buy_asset: buy.to_string(),
        amount: amount.to_string(),
        base: base.to_string(),
        quote: quote_asset.to_string(),
        offers: selected,
        sell_amount: route.sell_amount.to_string(),
        buy_amount: route.buy_amount.to_string(),
        price,
        price_impact_bps: route.price_impact_bps,
        unfilled: route.unfilled.to_string(),
    }))
}

// ---------------------------------------------------------------------------
// Offers

async fn post_offer(
    State(state): State<SharedState>,
    headers: HeaderMap,
    ApiBody(body): ApiBody,
) -> ApiResult<Response> {
    idempotent(&state, paths::OFFERS, &headers, &body, || {
        post_offer_inner(&state, &body)
    })
    .await
}

async fn post_offer_inner(state: &SharedState, body: &Bytes) -> ApiResult<(StatusCode, Value)> {
    let offer: Offer = parse_json(body)?;
    let network = &state.network;
    let parsed = parse_offer(&offer, network)?;
    let txid = parsed.outpoint.txid;
    let vout = parsed.outpoint.vout;

    let txid_hex = txid.to_string();
    let exists = state
        .db
        .call(move |conn| Ok(db::find_offer(conn, &txid_hex, vout)?.is_some()))
        .await?;
    if exists {
        return Err(ApiError::conflict(
            "duplicate_offer",
            "an offer for this output is already listed",
        ));
    }

    let prevout_hex = state
        .esplora
        .tx_hex(&txid)
        .await?
        .ok_or_else(|| ApiError::bad("prevout_not_found", "funding transaction not found"))?;
    let decoded = verify_offer(&parsed, &prevout_hex, network)?;
    let outspend = state.esplora.outspend(&txid, vout).await?;
    if outspend.spent {
        return Err(ApiError::bad(
            "offer_spent",
            "offered output is already spent",
        ));
    }

    let placement = classify(
        decoded.give_asset,
        decoded.give_amount,
        decoded.want_asset,
        decoded.want_amount,
        network.policy_asset,
    );
    let price = placement.price();
    let canonical_offer = Offer {
        tx: offer.tx.to_ascii_lowercase(),
        ..offer
    };
    let new = NewOffer {
        txid: txid.to_string(),
        vout,
        offer_json: serde_json::to_string(&canonical_offer).map_err(ApiError::internal)?,
        give_asset: decoded.give_asset.to_string(),
        give_amount: decoded.give_amount.to_string(),
        want_asset: decoded.want_asset.to_string(),
        want_amount: decoded.want_amount.to_string(),
        maker_script: hex::encode(decoded.maker_script.as_bytes()),
        maker_address: decoded.maker_address.clone(),
        funding_script: hex::encode(decoded.funding_script.as_bytes()),
        base: placement.base.to_string(),
        quote: placement.quote.to_string(),
        side: placement.side.as_str().into(),
        base_amount: placement.base_amount.to_string(),
        quote_amount: placement.quote_amount.to_string(),
        price_num: price.num.to_string(),
        price_den: price.den.to_string(),
        price: price.to_f64(),
        created_at: now_secs(),
    };
    let record = state
        .db
        .call(move |conn| Ok(db::insert_offer(conn, &new)?))
        .await?
        .ok_or_else(|| {
            ApiError::conflict(
                "duplicate_offer",
                "an offer for this output is already listed",
            )
        })?;
    tracing::info!(
        outpoint = %record.outpoint,
        side = %record.side,
        base = %record.base,
        quote = %record.quote,
        price = record.price,
        "offer listed"
    );
    Ok((StatusCode::CREATED, to_value(&record)?))
}

#[derive(Deserialize)]
struct MakerQuery {
    maker: Option<String>,
    limit: Option<u32>,
    cursor: Option<String>,
}

async fn maker_offers(
    State(state): State<SharedState>,
    ApiQuery(query): ApiQuery<MakerQuery>,
) -> ApiResult<Json<Page<OfferRecord>>> {
    let maker = query
        .maker
        .ok_or_else(|| ApiError::bad("invalid_request", "query parameter `maker` is required"))?;
    let limit = page_limit(query.limit)?;
    let before = int_cursor(query.cursor.as_deref())?;
    let script = p2wpkh_script_from_address(&maker)?;
    let script_hex = hex::encode(script.as_bytes());
    let offers = state
        .db
        .call(move |conn| Ok(db::maker_offers(conn, &script_hex, limit + 1, before)?))
        .await?;
    Ok(Json(paginate(offers, limit, |offer| offer.id.to_string())))
}

async fn get_offer(
    State(state): State<SharedState>,
    ApiPath((txid, vout)): ApiPath<(String, u32)>,
) -> ApiResult<Json<OfferRecord>> {
    txid_param(&txid)?;
    state
        .db
        .call(move |conn| Ok(db::find_offer(conn, &txid, vout)?))
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("offer_not_found", "offer not found"))
}
