//! End-to-end API test against a mocked Esplora (axum on a loopback port):
//! POST offers → book/markets → monitor detects fill and cancel → trades,
//! candles, asset registry.

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use elements::Transaction;
use serde_json::{json, Value};

use elementsplus_dex_server::{app_state, db::Db, monitor, router};
pub use elementsplus_dex_server::{Network, Offer, OfferLeg};

use common::*;

#[derive(Default)]
struct MockChain {
    txs: HashMap<String, String>,
    outspends: HashMap<(String, u32), Value>,
    statuses: HashMap<String, Value>,
}

type Mock = Arc<Mutex<MockChain>>;

impl MockChain {
    fn add_tx(&mut self, tx: &Transaction) {
        self.txs.insert(tx.txid().to_string(), tx_hex(tx));
    }

    fn spend(
        &mut self,
        outpoint: elements::OutPoint,
        by: &Transaction,
        vin: u32,
        block_time: Option<i64>,
    ) {
        self.add_tx(by);
        let status = match block_time {
            Some(time) => {
                json!({"confirmed": true, "block_height": 10, "block_hash": "00".repeat(32), "block_time": time})
            }
            None => json!({"confirmed": false}),
        };
        self.statuses.insert(by.txid().to_string(), status.clone());
        self.outspends.insert(
            (outpoint.txid.to_string(), outpoint.vout),
            json!({"spent": true, "txid": by.txid().to_string(), "vin": vin, "status": status}),
        );
    }
}

async fn mock_tx_hex(State(mock): State<Mock>, Path(txid): Path<String>) -> impl IntoResponse {
    match mock.lock().unwrap().txs.get(&txid) {
        Some(hex) => (StatusCode::OK, format!("{hex}\n")),
        None => (StatusCode::NOT_FOUND, "Transaction not found".to_owned()),
    }
}

async fn mock_status(State(mock): State<Mock>, Path(txid): Path<String>) -> impl IntoResponse {
    match mock.lock().unwrap().statuses.get(&txid) {
        Some(status) => (StatusCode::OK, Json(status.clone())).into_response(),
        None => (StatusCode::NOT_FOUND, "Transaction not found").into_response(),
    }
}

async fn mock_outspend(
    State(mock): State<Mock>,
    Path((txid, vout)): Path<(String, u32)>,
) -> Json<Value> {
    let chain = mock.lock().unwrap();
    Json(
        chain
            .outspends
            .get(&(txid, vout))
            .cloned()
            .unwrap_or_else(|| json!({"spent": false})),
    )
}

async fn start_mock(mock: Mock) -> String {
    let app = Router::new()
        .route("/api/tx/{txid}/hex", get(mock_tx_hex))
        .route("/api/tx/{txid}/outspend/{vout}", get(mock_outspend))
        .route("/api/tx/{txid}/status", get(mock_status))
        .route("/api/blocks/tip/height", get(|| async { "123" }))
        .with_state(mock);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}/api")
}

struct Harness {
    base: String,
    http: reqwest::Client,
    state: elementsplus_dex_server::SharedState,
}

impl Harness {
    async fn start(network: &Network, esplora: &str) -> Self {
        let state = app_state(network.clone(), Db::open_in_memory().unwrap(), esplora);
        let app = router(state.clone(), &["http://localhost:5173".to_owned()]);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            base: format!("http://{address}"),
            http: reqwest::Client::new(),
            state,
        }
    }

    async fn get(&self, path: &str) -> (StatusCode, Value) {
        let response = self
            .http
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .unwrap();
        let status = StatusCode::from_u16(response.status().as_u16()).unwrap();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn post(&self, path: &str, body: &Value) -> (StatusCode, Value) {
        let (status, _, body) = self.post_keyed(path, body, None).await;
        (status, body)
    }

    /// POST with an optional Idempotency-Key; also returns whether it was replayed.
    async fn post_keyed(
        &self,
        path: &str,
        body: &Value,
        key: Option<&str>,
    ) -> (StatusCode, bool, Value) {
        let mut request = self.http.post(format!("{}{path}", self.base)).json(body);
        if let Some(key) = key {
            request = request.header("Idempotency-Key", key);
        }
        let response = request.send().await.unwrap();
        let status = StatusCode::from_u16(response.status().as_u16()).unwrap();
        let replayed = response.headers().get("idempotent-replayed").is_some();
        (
            status,
            replayed,
            response.json().await.unwrap_or(Value::Null),
        )
    }
}

fn code(body: &Value) -> &str {
    body["error"]["code"]
        .as_str()
        .unwrap_or_else(|| panic!("no error code in {body}"))
}

#[tokio::test]
async fn offer_lifecycle_against_mock_esplora() {
    let network = test_network();
    let token = asset(0x11);
    let policy = network.policy_asset;

    // Two asks (5 and 6 ECX-atomic per token-atomic) and one bid at 4.
    let ask = Fixture::general(&network, 1, token, 1_000, policy, 5_000);
    let ask_to_cancel = Fixture::general(&network, 3, token, 500, policy, 3_000);
    let bid = Fixture::general(&network, 2, policy, 8_000, token, 2_000);
    let spent_already = Fixture::general(&network, 4, token, 10, policy, 10);

    let mock: Mock = Arc::default();
    {
        let mut chain = mock.lock().unwrap();
        for fixture in [&ask, &ask_to_cancel, &bid, &spent_already] {
            chain.add_tx(&fixture.funding_tx);
        }
        let spender = spent_already.taker_tx(false);
        chain.spend(spent_already.outpoint(), &spender, 0, None);
    }
    let esplora = start_mock(mock.clone()).await;
    let dex = Harness::start(&network, &esplora).await;

    // Health exposes chain parameters.
    let (status, health) = dex.get("/api/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["ok"], true);
    assert_eq!(health["tip"], 123);
    assert_eq!(health["network"], "ecx-alpha");
    assert_eq!(health["genesis_hash"], TEST_GENESIS);
    assert_eq!(health["policy_asset"], policy.to_string());

    // Listing; the first POST is idempotent and replays on retry.
    let (status, replayed, first) = dex
        .post_keyed("/api/offers", &json!(ask.offer), Some("ask-1"))
        .await;
    assert_eq!((status, replayed), (StatusCode::CREATED, false), "{first}");
    let (status, replayed, again) = dex
        .post_keyed("/api/offers", &json!(ask.offer), Some("ask-1"))
        .await;
    assert_eq!((status, replayed), (StatusCode::CREATED, true));
    assert_eq!(again, first);
    let (status, _, body) = dex
        .post_keyed("/api/offers", &json!(bid.offer), Some("ask-1"))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(code(&body), "idempotency_key_reused");

    for fixture in [&ask_to_cancel, &bid] {
        let (status, body) = dex.post("/api/offers", &json!(fixture.offer)).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["status"], "open");
        assert_eq!(body["offer"], json!(fixture.offer));
    }
    let (status, body) = dex.post("/api/offers", &json!(ask.offer)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(code(&body), "duplicate_offer");

    let (status, body) = dex.post("/api/offers", &json!(spent_already.offer)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&body), "offer_spent");

    let mut tampered = Fixture::general(&network, 5, token, 100, policy, 100);
    mock.lock().unwrap().add_tx(&tampered.funding_tx);
    tampered.offer.give.amount = "99".into();
    let (status, body) = dex.post("/api/offers", &json!(tampered.offer)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&body), "offer_mismatch");

    let bad_sig = Fixture::general(&network, 5, token, 100, policy, 100).build_offer(OfferTweaks {
        corrupt_signature: true,
        ..Default::default()
    });
    let (status, body) = dex.post("/api/offers", &json!(bad_sig)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&body), "bad_signature");

    let unknown_funding = Fixture::general(&network, 6, token, 100, policy, 100);
    let (status, body) = dex.post("/api/offers", &json!(unknown_funding.offer)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&body), "prevout_not_found");

    let (status, body) = dex.post("/api/offers", &json!({"version": 1})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&body), "invalid_request");

    // Book.
    let book_path = format!("/api/markets/{token}/{policy}/book");
    let (status, book) = dex.get(&book_path).await;
    assert_eq!(status, StatusCode::OK);
    let asks = book["asks"].as_array().unwrap();
    let bids = book["bids"].as_array().unwrap();
    assert_eq!(asks.len(), 2);
    assert_eq!(bids.len(), 1);
    assert_eq!(asks[0]["price"], 5.0);
    assert_eq!(asks[1]["price"], 6.0);
    assert_eq!(bids[0]["price"], 4.0);
    assert_eq!(bids[0]["base_amount"], "2000");
    assert_eq!(bids[0]["quote_amount"], "8000");
    assert_eq!(asks[0]["tx"], json!(ask.offer.tx));
    let (_, limited) = dex.get(&format!("{book_path}?limit=1")).await;
    assert_eq!(limited["asks"].as_array().unwrap().len(), 1);

    let (status, body) = dex
        .get(&format!("/api/markets/{policy}/{token}/book"))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&body), "non_canonical_market");

    // Quotes: buy the token with ECX.
    let quote = |amount: &str, side: &str| {
        format!("/api/quote?sell={policy}&buy={token}&amount={amount}&side={side}")
    };
    let (status, q) = dex.get(&quote("8000", "exact_in")).await;
    assert_eq!(status, StatusCode::OK, "{q}");
    // Asks cost 5 and 6 per token; both (5000 + 3000) fit in 8000.
    assert_eq!(q["offers"].as_array().unwrap().len(), 2);
    assert_eq!(
        q["offers"][0]["outpoint"],
        format!("{}:1", ask.funding_txid())
    );
    assert_eq!(
        (q["sell_amount"].as_str(), q["buy_amount"].as_str()),
        (Some("8000"), Some("1500"))
    );
    assert_eq!(q["unfilled"], "0");
    assert_eq!(q["base"], token.to_string());
    let price = q["price"].as_f64().unwrap();
    assert!((price - 8000.0 / 1500.0).abs() < 1e-9);
    assert_eq!(q["price_impact_bps"], 667);
    let (_, q) = dex.get(&quote("7000", "exact_in")).await;
    assert_eq!(q["offers"].as_array().unwrap().len(), 1);
    assert_eq!(q["unfilled"], "2000");
    let (_, q) = dex.get(&quote("600", "exact_out")).await;
    assert_eq!(
        (q["buy_amount"].as_str(), q["unfilled"].as_str()),
        (Some("500"), Some("100"))
    );
    // Sell the token for ECX: hits the bid.
    let (_, q) = dex
        .get(&format!("/api/quote?sell={token}&buy={policy}&amount=2000"))
        .await;
    assert_eq!(q["offers"][0]["side"], "bid");
    assert_eq!(q["buy_amount"], "8000");
    assert_eq!(q["price"], 4.0);
    let (status, body) = dex.get(&quote("0", "exact_in")).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "invalid_amount")
    );
    let (status, body) = dex.get(&quote("5", "both")).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "invalid_side")
    );

    // Maker listing by receive address, paginated.
    let maker_address = asks[0]["maker_address"].as_str().unwrap().to_owned();
    let (status, mine) = dex.get(&format!("/api/offers?maker={maker_address}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mine["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        mine["items"][0]["outpoint"],
        format!("{}:1", ask.funding_txid())
    );
    assert_eq!(mine["next_cursor"], Value::Null);
    let (status, body) = dex.get("/api/offers").await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "invalid_request")
    );

    // Markets.
    let (_, markets) = dex.get("/api/markets").await;
    let items = markets["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["base"], token.to_string());
    assert_eq!(items[0]["quote"], policy.to_string());
    assert_eq!(items[0]["best_bid"], 4.0);
    assert_eq!(items[0]["best_ask"], 5.0);
    assert_eq!(items[0]["last_price"], Value::Null);

    // Nothing spent yet.
    let stats = monitor::run_once(&dex.state).await.unwrap();
    assert_eq!(
        (stats.checked, stats.filled, stats.cancelled, stats.errors),
        (3, 0, 0, 0)
    );

    // Take the 5.0 ask (seen in the mempool first), cancel the 6.0 ask.
    let fill_time = 1_700_000_000;
    {
        let mut chain = mock.lock().unwrap();
        chain.spend(ask.outpoint(), &ask.taker_tx(true), 0, None);
        chain.spend(
            ask_to_cancel.outpoint(),
            &ask_to_cancel.taker_tx(false),
            0,
            None,
        );
    }
    let stats = monitor::run_once(&dex.state).await.unwrap();
    assert_eq!(
        (stats.checked, stats.filled, stats.cancelled, stats.errors),
        (3, 1, 1, 0)
    );
    let trades_path = format!("/api/markets/{token}/{policy}/trades");
    let (_, trades) = dex.get(&trades_path).await;
    assert_eq!(trades["items"][0]["confirmed"], false);

    // The fill confirms: the next pass adopts the block time.
    mock.lock().unwrap().statuses.insert(
        ask.taker_tx(true).txid().to_string(),
        json!({"confirmed": true, "block_height": 11, "block_time": fill_time}),
    );
    let stats = monitor::run_once(&dex.state).await.unwrap();
    assert_eq!((stats.checked, stats.confirmed, stats.errors), (1, 1, 0));

    let (_, book) = dex.get(&book_path).await;
    assert_eq!(book["asks"].as_array().unwrap().len(), 0);
    assert_eq!(book["bids"].as_array().unwrap().len(), 1);

    let (_, filled) = dex
        .get(&format!("/api/offers/{}/1", ask.funding_txid()))
        .await;
    assert_eq!(filled["status"], "filled");
    assert_eq!(filled["spend_txid"], ask.taker_tx(true).txid().to_string());
    let (_, cancelled) = dex
        .get(&format!("/api/offers/{}/1", ask_to_cancel.funding_txid()))
        .await;
    assert_eq!(cancelled["status"], "cancelled");
    let (status, body) = dex
        .get(&format!("/api/offers/{}/9", ask.funding_txid()))
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::NOT_FOUND, "offer_not_found")
    );

    let (_, trades) = dex.get(&trades_path).await;
    let items = trades["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["txid"], ask.taker_tx(true).txid().to_string());
    assert_eq!(items[0]["price"], 5.0);
    assert_eq!(items[0]["base_amount"], "1000");
    assert_eq!(items[0]["quote_amount"], "5000");
    assert_eq!(items[0]["time"], fill_time);
    assert_eq!(items[0]["confirmed"], true);
    let (status, body) = dex.get(&format!("{trades_path}?cursor=garbage")).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "invalid_cursor")
    );
    let (status, body) = dex.get(&format!("{trades_path}?limit=0")).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "invalid_limit")
    );

    // Candles: the fill is far in the past, so use the widest window.
    let candles_path = format!("/api/markets/{token}/{policy}/candles");
    let (status, candles) = dex
        .get(&format!("{candles_path}?interval=1w&limit=1000"))
        .await;
    assert_eq!(status, StatusCode::OK);
    let items = candles["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["open"], 5.0);
    assert_eq!(items[0]["volume"], "1000");
    assert_eq!(candles["next_cursor"], Value::Null);
    // A short window misses it but points further back.
    let (_, recent) = dex
        .get(&format!("{candles_path}?interval=1h&limit=2"))
        .await;
    assert_eq!(recent["items"].as_array().unwrap().len(), 0);
    let cursor = recent["next_cursor"].as_str().unwrap().to_owned();
    assert!(cursor.parse::<i64>().unwrap() > fill_time);
    let (status, body) = dex.get(&format!("{candles_path}?interval=7m")).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "invalid_interval")
    );

    let (_, markets) = dex.get("/api/markets").await;
    assert_eq!(markets["items"][0]["last_price"], 5.0);
    assert_eq!(markets["items"][0]["best_ask"], Value::Null);
}

#[tokio::test]
async fn pagination_walks_every_item_once() {
    let network = test_network();
    let policy = network.policy_asset;
    let mock: Mock = Arc::default();
    // One maker (seed 1 keys) cannot hold 5 funding txs with these fixtures,
    // so page through markets instead: 5 distinct tokens.
    let fixtures: Vec<Fixture> = (0..5u8)
        .map(|n| Fixture::general(&network, 20 + n, asset(0x40 + n), 10, policy, 20))
        .collect();
    for fixture in &fixtures {
        mock.lock().unwrap().add_tx(&fixture.funding_tx);
    }
    let esplora = start_mock(mock).await;
    let dex = Harness::start(&network, &esplora).await;
    for fixture in &fixtures {
        let (status, body) = dex.post("/api/offers", &json!(fixture.offer)).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let path = match &cursor {
            Some(cursor) => format!("/api/markets?limit=2&cursor={cursor}"),
            None => "/api/markets?limit=2".to_owned(),
        };
        let (status, page) = dex.get(&path).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        let items = page["items"].as_array().unwrap();
        assert!(items.len() <= 2);
        seen.extend(
            items
                .iter()
                .map(|item| item["base"].as_str().unwrap().to_owned()),
        );
        match page["next_cursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => break,
        }
    }
    let mut expected: Vec<String> = fixtures.iter().map(|f| f.give_asset.to_string()).collect();
    expected.sort();
    assert_eq!(seen, expected);
}

#[tokio::test]
async fn every_documented_route_is_served() {
    let network = test_network();
    let esplora = start_mock(Arc::default()).await;
    let dex = Harness::start(&network, &esplora).await;
    let (status, doc) = dex.get("/api/openapi.json").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(doc["openapi"], "3.1.0");
    let token = asset(0x11).to_string();
    let policy = network.policy_asset.to_string();
    for (method, path) in elementsplus_dex_server::api::ROUTES {
        assert!(
            doc["paths"][*path][*method].is_object(),
            "{method} {path} undocumented"
        );
        let concrete = path
            .replace("{asset_id}", &token)
            .replace("{base}", &token)
            .replace("{quote}", &policy)
            .replace("{txid}", &"ab".repeat(32))
            .replace("{vout}", "0");
        let url = format!("{}{concrete}", dex.base);
        let response = match *method {
            "get" => dex.http.get(&url).send().await.unwrap(),
            "post" => dex.http.post(&url).json(&json!({})).send().await.unwrap(),
            other => panic!("unexpected method {other}"),
        };
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        let error_code = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|body| body["error"]["code"].as_str().map(str::to_owned));
        assert!(
            error_code.as_deref() != Some("route_not_found") && status != 405,
            "{method} {path} is documented but not routed ({status} {text})"
        );
    }
    let response = dex
        .http
        .get(format!("{}/llms.txt", dex.base))
        .send()
        .await
        .unwrap();
    assert!(response.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/plain"));
    let text = response.text().await.unwrap();
    assert!(text.contains("/api/openapi.json") && text.contains(TEST_GENESIS));
}

#[tokio::test]
async fn asset_registry_against_mock_esplora() {
    let network = test_network();
    let mock: Mock = Arc::default();
    let issuance = IssuanceFixture::new(sample_contract(), true);
    mock.lock().unwrap().add_tx(&issuance.tx);
    let esplora = start_mock(mock.clone()).await;
    let dex = Harness::start(&network, &esplora).await;

    // Keys in a different order must canonicalise to the same commitment.
    let request = json!({
        "issuance_txid": issuance.tx.txid().to_string(),
        "vin": issuance.vin,
        "contract": {"version": 0, "ticker": "TST", "precision": 2, "name": "Test Coin"},
    });
    let (status, entry) = dex.post("/api/assets", &request).await;
    assert_eq!(status, StatusCode::CREATED, "{entry}");
    let asset_id = entry["asset_id"].as_str().unwrap().to_owned();
    assert!(entry["token_id"].is_string());
    assert_eq!(entry["contract"]["ticker"], "TST");
    assert_eq!(entry["issuance_vin"], 1);
    assert_eq!(entry["icon_url"], Value::Null);

    let (status, _) = dex.post("/api/assets", &request).await;
    assert_eq!(status, StatusCode::OK);

    let (status, listed) = dex.get("/api/assets").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert_eq!(listed["next_cursor"], Value::Null);
    let (status, one) = dex.get(&format!("/api/assets/{asset_id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(one["asset_id"], asset_id);
    let (status, body) = dex.get(&format!("/api/assets/{}", "ab".repeat(32))).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::NOT_FOUND, "unknown_asset")
    );
    let (status, body) = dex.get("/api/assets/XYZ").await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "invalid_asset_id")
    );

    let mut forged = request.clone();
    forged["contract"]["name"] = json!("Forged Coin");
    let (status, body) = dex.post("/api/assets", &forged).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "contract_mismatch")
    );

    let mut bad_ticker = request.clone();
    bad_ticker["contract"]["ticker"] = json!("T$T");
    let (status, body) = dex.post("/api/assets", &bad_ticker).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "invalid_contract")
    );

    let mut missing = request.clone();
    missing["issuance_txid"] = json!("cd".repeat(32));
    let (status, body) = dex.post("/api/assets", &missing).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "issuance_not_found")
    );

    // Generic error handling.
    let (status, body) = dex.get("/api/nope").await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::NOT_FOUND, "route_not_found")
    );
    let response = dex
        .http
        .delete(format!("{}/api/assets", dex.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 405);
    let body: Value = response.json().await.unwrap();
    assert_eq!(code(&body), "method_not_allowed");
    let huge = json!({ "issuance_txid": "a".repeat(200_000) });
    let (status, body) = dex.post("/api/assets", &huge).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large")
    );
    let (status, _, body) = dex
        .post_keyed("/api/assets", &request, Some("bad key"))
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "invalid_idempotency_key")
    );
}
