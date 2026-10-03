//! SQLite persistence. All access goes through `Db::call`, which runs the
//! closure on the blocking pool with exclusive access to the connection.

use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use crate::error::{ApiError, ApiResult};
use crate::instant::{BondCheck, PromiseWire, CHALLENGE_WINDOW};
use crate::offer::AnyOffer;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS offers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    txid          TEXT    NOT NULL,
    vout          INTEGER NOT NULL,
    offer_json    TEXT    NOT NULL,
    give_asset    TEXT    NOT NULL,
    give_amount   TEXT    NOT NULL,
    want_asset    TEXT    NOT NULL,
    want_amount   TEXT    NOT NULL,
    maker_script  TEXT    NOT NULL,
    maker_address TEXT    NOT NULL,
    funding_script TEXT   NOT NULL,
    base          TEXT    NOT NULL,
    quote         TEXT    NOT NULL,
    side          TEXT    NOT NULL CHECK (side IN ('bid', 'ask')),
    base_amount   TEXT    NOT NULL,
    quote_amount  TEXT    NOT NULL,
    price_num     TEXT    NOT NULL,
    price_den     TEXT    NOT NULL,
    price         REAL    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
    created_at    INTEGER NOT NULL,
    closed_at     INTEGER,
    spend_txid    TEXT,
    kind          INTEGER NOT NULL DEFAULT 1,
    instant_operator TEXT,
    lockbox_expiry INTEGER,
    lockbox_owner TEXT,
    UNIQUE (txid, vout)
);
CREATE INDEX IF NOT EXISTS offers_market ON offers (base, quote, status, price);
CREATE INDEX IF NOT EXISTS offers_maker ON offers (maker_script, status);
CREATE INDEX IF NOT EXISTS offers_funding ON offers (funding_script, status);
CREATE INDEX IF NOT EXISTS offers_status ON offers (status);

CREATE TABLE IF NOT EXISTS trades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id     INTEGER NOT NULL UNIQUE REFERENCES offers (id),
    txid         TEXT    NOT NULL,
    base         TEXT    NOT NULL,
    quote        TEXT    NOT NULL,
    side         TEXT    NOT NULL,
    price_num    TEXT    NOT NULL,
    price_den    TEXT    NOT NULL,
    price        REAL    NOT NULL,
    base_amount  TEXT    NOT NULL,
    quote_amount TEXT    NOT NULL,
    time         INTEGER NOT NULL,
    confirmed    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_market ON trades (base, quote, time);

CREATE TABLE IF NOT EXISTS idempotency (
    route        TEXT    NOT NULL,
    key          TEXT    NOT NULL,
    request_hash TEXT    NOT NULL,
    status       INTEGER NOT NULL,
    body         TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (route, key)
);

CREATE TABLE IF NOT EXISTS instant_operators (
    operator          TEXT PRIMARY KEY,
    sequence          TEXT    NOT NULL,
    signed_json       TEXT    NOT NULL,
    api_url           TEXT    NOT NULL,
    verified          INTEGER NOT NULL DEFAULT 0,
    bonds_json        TEXT    NOT NULL DEFAULT '[]',
    max_refund_height INTEGER NOT NULL DEFAULT 0,
    cover             TEXT    NOT NULL DEFAULT '0',
    error             TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    checked_at        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS instant_receipts (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    operator      TEXT    NOT NULL,
    txid          TEXT    NOT NULL,
    commitment    TEXT    NOT NULL,
    value_at_risk TEXT    NOT NULL,
    promises_json TEXT    NOT NULL,
    receipt_json  TEXT,
    received_at   INTEGER NOT NULL,
    confirmed     INTEGER NOT NULL DEFAULT 0,
    conflict      INTEGER NOT NULL DEFAULT 0,
    checked_at    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (operator, txid)
);
CREATE INDEX IF NOT EXISTS instant_receipts_operator ON instant_receipts (operator, seq);
CREATE INDEX IF NOT EXISTS instant_receipts_pending ON instant_receipts (confirmed, checked_at);

CREATE TABLE IF NOT EXISTS instant_promises (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    operator    TEXT    NOT NULL,
    lockbox     TEXT    NOT NULL,
    commitment  TEXT    NOT NULL,
    sig         TEXT    NOT NULL,
    receipt_seq INTEGER NOT NULL REFERENCES instant_receipts (seq),
    UNIQUE (operator, lockbox, commitment)
);
CREATE INDEX IF NOT EXISTS instant_promises_lockbox ON instant_promises (operator, lockbox);

CREATE TABLE IF NOT EXISTS assets (
    asset_id      TEXT PRIMARY KEY,
    token_id      TEXT,
    contract_json TEXT    NOT NULL,
    contract_hash TEXT    NOT NULL,
    issuance_txid TEXT    NOT NULL,
    issuance_vin  INTEGER NOT NULL,
    icon_url      TEXT,
    created_at    INTEGER NOT NULL
);
"#;

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // WAL is unavailable for in-memory databases; ignore the answer.
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub async fn call<F, R>(&self, f: F) -> ApiResult<R>
    where
        F: FnOnce(&mut Connection) -> ApiResult<R> + Send + 'static,
        R: Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn
                .lock()
                .map_err(|_| ApiError::internal("database mutex poisoned"))?;
            f(&mut guard)
        })
        .await
        .map_err(ApiError::internal)?
    }
}

/// Add columns introduced after the first release to existing databases.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let mut statement = conn.prepare("PRAGMA table_info(offers)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (name, definition) in [
        ("kind", "INTEGER NOT NULL DEFAULT 1"),
        ("instant_operator", "TEXT"),
        ("lockbox_expiry", "INTEGER"),
        ("lockbox_owner", "TEXT"),
    ] {
        if !columns.iter().any(|column| column == name) {
            conn.execute_batch(&format!("ALTER TABLE offers ADD COLUMN {name} {definition}"))?;
        }
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS offers_owner ON offers (lockbox_owner, status);\n\
         CREATE INDEX IF NOT EXISTS offers_operator ON offers (instant_operator, status);",
    )
}

/// Stored offer, also the JSON served for book/maker listings. The original
/// offer fields are flattened at the top level *and* repeated under `offer`
/// so clients can hand `entry.offer` to the wallet unchanged.
#[derive(Clone, Debug, Serialize)]
pub struct OfferRecord {
    #[serde(flatten)]
    pub wire: AnyOffer,
    pub offer: AnyOffer,
    pub id: i64,
    pub outpoint: String,
    pub txid: String,
    pub vout: u32,
    pub maker_address: String,
    #[serde(skip)]
    pub maker_script: String,
    pub base: String,
    pub quote: String,
    pub side: String,
    pub base_amount: String,
    pub quote_amount: String,
    /// Quote atomic per base atomic, for sorting/display only.
    pub price: f64,
    /// Exact price `price_num / price_den` (quote atomic / base atomic).
    pub price_num: String,
    pub price_den: String,
    pub status: String,
    pub created_at: i64,
    pub closed_at: Option<i64>,
    pub spend_txid: Option<String>,
    /// Instant lockbox order (offer v2) whose operator is announced with a
    /// verified bond that outlives the lockbox expiry by the challenge window.
    /// Evaluated at read time.
    pub instant: bool,
    /// Operator x-only key of an instant lockbox order (null for v1 offers).
    pub operator: Option<String>,
    /// Lockbox EXPIRY height (null for v1 offers).
    pub lockbox_expiry: Option<u32>,
}

pub const OFFER_COLUMNS: &str = concat!(
    "id, txid, vout, offer_json, maker_script, maker_address, base, quote, side, ",
    "base_amount, quote_amount, price_num, price_den, price, status, created_at, closed_at, spend_txid, ",
    "instant_operator, lockbox_expiry, ",
    "(kind = 2 AND EXISTS (SELECT 1 FROM instant_operators op ",
    "WHERE op.operator = offers.instant_operator AND op.verified = 1 ",
    "AND op.max_refund_height >= offers.lockbox_expiry + 144)) AS instant_live"
);

// The literal above must use the protocol's challenge window.
const _: () = assert!(CHALLENGE_WINDOW == 144);

pub fn offer_from_row(row: &Row<'_>) -> rusqlite::Result<OfferRecord> {
    let txid: String = row.get(1)?;
    let vout: u32 = row.get(2)?;
    let json: String = row.get(3)?;
    let wire: AnyOffer = serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(OfferRecord {
        offer: wire.clone(),
        wire,
        id: row.get(0)?,
        outpoint: format!("{txid}:{vout}"),
        txid,
        vout,
        maker_script: row.get(4)?,
        maker_address: row.get(5)?,
        base: row.get(6)?,
        quote: row.get(7)?,
        side: row.get(8)?,
        base_amount: row.get(9)?,
        quote_amount: row.get(10)?,
        price_num: row.get(11)?,
        price_den: row.get(12)?,
        price: row.get(13)?,
        status: row.get(14)?,
        created_at: row.get(15)?,
        closed_at: row.get(16)?,
        spend_txid: row.get(17)?,
        operator: row.get(18)?,
        lockbox_expiry: row.get(19)?,
        instant: row.get(20)?,
    })
}

pub struct NewOffer {
    pub txid: String,
    pub vout: u32,
    pub offer_json: String,
    pub give_asset: String,
    pub give_amount: String,
    pub want_asset: String,
    pub want_amount: String,
    pub maker_script: String,
    pub maker_address: String,
    pub funding_script: String,
    pub base: String,
    pub quote: String,
    pub side: String,
    pub base_amount: String,
    pub quote_amount: String,
    pub price_num: String,
    pub price_den: String,
    pub price: f64,
    pub created_at: i64,
    /// 1 = v1 explicit offer, 2 = Instant lockbox order.
    pub kind: u32,
    pub instant_operator: Option<String>,
    pub lockbox_expiry: Option<u32>,
    pub lockbox_owner: Option<String>,
}

pub fn find_offer(
    conn: &Connection,
    txid: &str,
    vout: u32,
) -> rusqlite::Result<Option<OfferRecord>> {
    conn.query_row(
        &format!("SELECT {OFFER_COLUMNS} FROM offers WHERE txid = ?1 AND vout = ?2"),
        params![txid, vout],
        offer_from_row,
    )
    .optional()
}

/// Insert an offer; returns `None` if the outpoint is already listed.
pub fn insert_offer(conn: &Connection, offer: &NewOffer) -> rusqlite::Result<Option<OfferRecord>> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO offers (txid, vout, offer_json, give_asset, give_amount, want_asset, \
         want_amount, maker_script, maker_address, funding_script, base, quote, side, base_amount, \
         quote_amount, price_num, price_den, price, created_at, kind, instant_operator, lockbox_expiry, \
         lockbox_owner) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, \
         ?20, ?21, ?22, ?23)",
        params![
            offer.txid,
            offer.vout,
            offer.offer_json,
            offer.give_asset,
            offer.give_amount,
            offer.want_asset,
            offer.want_amount,
            offer.maker_script,
            offer.maker_address,
            offer.funding_script,
            offer.base,
            offer.quote,
            offer.side,
            offer.base_amount,
            offer.quote_amount,
            offer.price_num,
            offer.price_den,
            offer.price,
            offer.created_at,
            offer.kind,
            offer.instant_operator,
            offer.lockbox_expiry,
            offer.lockbox_owner,
        ],
    )?;
    if inserted == 0 {
        return Ok(None);
    }
    find_offer(conn, &offer.txid, offer.vout)
}

/// Open offers in which the maker gives `give_asset` and wants `want_asset`.
pub fn offers_for_pair(
    conn: &Connection,
    give_asset: &str,
    want_asset: &str,
) -> rusqlite::Result<Vec<OfferRecord>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {OFFER_COLUMNS} FROM offers WHERE give_asset = ?1 AND want_asset = ?2 \
         AND status = 'open' ORDER BY id LIMIT 5000"
    ))?;
    let rows = statement.query_map(params![give_asset, want_asset], offer_from_row)?;
    rows.collect()
}

pub fn open_offers(conn: &Connection) -> rusqlite::Result<Vec<OfferRecord>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {OFFER_COLUMNS} FROM offers WHERE status = 'open' ORDER BY id"
    ))?;
    let rows = statement.query_map([], offer_from_row)?;
    rows.collect()
}

pub fn market_offers(
    conn: &Connection,
    base: &str,
    quote: &str,
    side: &str,
    limit: u32,
) -> rusqlite::Result<Vec<OfferRecord>> {
    let order = if side == "bid" { "DESC" } else { "ASC" };
    let mut statement = conn.prepare(&format!(
        "SELECT {OFFER_COLUMNS} FROM offers WHERE base = ?1 AND quote = ?2 AND side = ?3 \
         AND status = 'open' ORDER BY price {order}, id ASC LIMIT ?4"
    ))?;
    let rows = statement.query_map(params![base, quote, side, limit], offer_from_row)?;
    rows.collect()
}

/// Open offers whose receive output *or* offered funding output pays `script`.
/// Newest first; `before_id` is the pagination cursor.
pub fn maker_offers(
    conn: &Connection,
    maker_script: &str,
    limit: u32,
    before_id: Option<i64>,
) -> rusqlite::Result<Vec<OfferRecord>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {OFFER_COLUMNS} FROM offers WHERE (maker_script = ?1 OR funding_script = ?1) \
         AND status = 'open' AND (?3 IS NULL OR id < ?3) ORDER BY id DESC LIMIT ?2"
    ))?;
    let rows = statement.query_map(params![maker_script, limit, before_id], offer_from_row)?;
    rows.collect()
}

/// Open instant offers of a lockbox owner (x-only key), newest first.
pub fn owner_offers(
    conn: &Connection,
    owner: &str,
    limit: u32,
    before_id: Option<i64>,
) -> rusqlite::Result<Vec<OfferRecord>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {OFFER_COLUMNS} FROM offers WHERE lockbox_owner = ?1 \
         AND status = 'open' AND (?3 IS NULL OR id < ?3) ORDER BY id DESC LIMIT ?2"
    ))?;
    let rows = statement.query_map(params![owner, limit, before_id], offer_from_row)?;
    rows.collect()
}

/// Close an open offer without a spend (instant lockbox past EXPIRY − S).
pub fn mark_expired(conn: &Connection, id: i64, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE offers SET status = 'cancelled', closed_at = ?2 WHERE id = ?1 AND status = 'open'",
        params![id, now],
    )?;
    Ok(())
}

pub fn mark_cancelled(
    conn: &Connection,
    id: i64,
    spend_txid: &str,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE offers SET status = 'cancelled', closed_at = ?2, spend_txid = ?3 \
         WHERE id = ?1 AND status = 'open'",
        params![id, now, spend_txid],
    )?;
    Ok(())
}

/// Mark an offer filled and record its trade atomically.
pub fn record_fill(
    conn: &mut Connection,
    offer: &OfferRecord,
    spend_txid: &str,
    time: i64,
    confirmed: bool,
    now: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    let updated = tx.execute(
        "UPDATE offers SET status = 'filled', closed_at = ?2, spend_txid = ?3 \
         WHERE id = ?1 AND status = 'open'",
        params![offer.id, now, spend_txid],
    )?;
    if updated == 1 {
        tx.execute(
            "INSERT OR IGNORE INTO trades (offer_id, txid, base, quote, side, price_num, price_den, \
             price, base_amount, quote_amount, time, confirmed) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                offer.id,
                spend_txid,
                offer.base,
                offer.quote,
                offer.side,
                offer.price_num,
                offer.price_den,
                offer.price,
                offer.base_amount,
                offer.quote_amount,
                time,
                confirmed,
            ],
        )?;
    }
    tx.commit()
}

/// `(trade id, spending txid)` for trades seen only in the mempool so far.
pub fn unconfirmed_trades(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut statement =
        conn.prepare("SELECT id, txid FROM trades WHERE confirmed = 0 ORDER BY id LIMIT 1000")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

/// Once the fill confirms, its time becomes the block time.
pub fn confirm_trade(conn: &Connection, id: i64, block_time: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE trades SET confirmed = 1, time = ?2 WHERE id = ?1",
        params![id, block_time],
    )?;
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
pub struct TradeRecord {
    #[serde(skip)]
    pub id: i64,
    pub txid: String,
    pub price: f64,
    pub price_num: String,
    pub price_den: String,
    pub base_amount: String,
    pub quote_amount: String,
    pub time: i64,
    /// Side of the maker order that was filled (`ask` = taker bought base).
    pub maker_side: String,
    pub confirmed: bool,
}

fn trade_from_row(row: &Row<'_>) -> rusqlite::Result<TradeRecord> {
    Ok(TradeRecord {
        txid: row.get(0)?,
        price: row.get(1)?,
        price_num: row.get(2)?,
        price_den: row.get(3)?,
        base_amount: row.get(4)?,
        quote_amount: row.get(5)?,
        time: row.get(6)?,
        maker_side: row.get(7)?,
        confirmed: row.get(8)?,
        id: row.get(9)?,
    })
}

const TRADE_COLUMNS: &str =
    "txid, price, price_num, price_den, base_amount, quote_amount, time, side, confirmed, id";

/// Most recent trades first; `before` = `(time, id)` pagination cursor.
pub fn recent_trades(
    conn: &Connection,
    base: &str,
    quote: &str,
    limit: u32,
    before: Option<(i64, i64)>,
) -> rusqlite::Result<Vec<TradeRecord>> {
    let (time, id) = before.unzip();
    let mut statement = conn.prepare(&format!(
        "SELECT {TRADE_COLUMNS} FROM trades WHERE base = ?1 AND quote = ?2 \
         AND (?4 IS NULL OR time < ?4 OR (time = ?4 AND id < ?5)) \
         ORDER BY time DESC, id DESC LIMIT ?3"
    ))?;
    let rows = statement.query_map(params![base, quote, limit, time, id], trade_from_row)?;
    rows.collect()
}

/// Trades with `since <= time < until`, oldest first.
pub fn trades_between(
    conn: &Connection,
    base: &str,
    quote: &str,
    since: i64,
    until: i64,
) -> rusqlite::Result<Vec<TradeRecord>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {TRADE_COLUMNS} FROM trades WHERE base = ?1 AND quote = ?2 AND time >= ?3 \
         AND time < ?4 ORDER BY time ASC, id ASC LIMIT 100000"
    ))?;
    let rows = statement.query_map(params![base, quote, since, until], trade_from_row)?;
    rows.collect()
}

/// Last trade strictly before `before`.
pub fn last_trade_before(
    conn: &Connection,
    base: &str,
    quote: &str,
    before: i64,
) -> rusqlite::Result<Option<TradeRecord>> {
    conn.query_row(
        &format!(
            "SELECT {TRADE_COLUMNS} FROM trades WHERE base = ?1 AND quote = ?2 AND time < ?3 \
             ORDER BY time DESC, id DESC LIMIT 1"
        ),
        params![base, quote, before],
        trade_from_row,
    )
    .optional()
}

/// Every pair with at least one open offer or one trade.
pub fn active_markets(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut statement = conn.prepare(
        "SELECT base, quote FROM offers WHERE status = 'open' \
         UNION SELECT base, quote FROM trades ORDER BY 1, 2",
    )?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

#[derive(Clone, Debug, Serialize)]
pub struct AssetRecord {
    pub asset_id: String,
    pub token_id: Option<String>,
    pub contract: serde_json::Value,
    pub contract_hash: String,
    pub issuance_txid: String,
    pub issuance_vin: u32,
    pub icon_url: Option<String>,
    pub created_at: i64,
}

fn asset_from_row(row: &Row<'_>) -> rusqlite::Result<AssetRecord> {
    let json: String = row.get(2)?;
    let contract = serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(AssetRecord {
        asset_id: row.get(0)?,
        token_id: row.get(1)?,
        contract,
        contract_hash: row.get(3)?,
        issuance_txid: row.get(4)?,
        issuance_vin: row.get(5)?,
        icon_url: row.get(6)?,
        created_at: row.get(7)?,
    })
}

const ASSET_COLUMNS: &str =
    "asset_id, token_id, contract_json, contract_hash, issuance_txid, issuance_vin, icon_url, created_at";

pub fn find_asset(conn: &Connection, asset_id: &str) -> rusqlite::Result<Option<AssetRecord>> {
    conn.query_row(
        &format!("SELECT {ASSET_COLUMNS} FROM assets WHERE asset_id = ?1"),
        params![asset_id],
        asset_from_row,
    )
    .optional()
}

/// Newest registrations first, as `(rowid, record)`; `before` is the cursor.
pub fn list_assets(
    conn: &Connection,
    limit: u32,
    before: Option<i64>,
) -> rusqlite::Result<Vec<(i64, AssetRecord)>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {ASSET_COLUMNS}, rowid FROM assets WHERE (?2 IS NULL OR rowid < ?2) \
         ORDER BY rowid DESC LIMIT ?1"
    ))?;
    let rows = statement.query_map(params![limit, before], |row| {
        Ok((row.get(8)?, asset_from_row(row)?))
    })?;
    rows.collect()
}

/// Insert a verified asset; returns `false` if it was already registered.
pub fn insert_asset(
    conn: &Connection,
    asset: &AssetRecord,
    canonical_contract: &str,
) -> rusqlite::Result<bool> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO assets (asset_id, token_id, contract_json, contract_hash, \
         issuance_txid, issuance_vin, icon_url, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            asset.asset_id,
            asset.token_id,
            canonical_contract,
            asset.contract_hash,
            asset.issuance_txid,
            asset.issuance_vin,
            asset.icon_url,
            asset.created_at,
        ],
    )?;
    Ok(inserted == 1)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct BookTop {
    pub best_bid: Option<f64>,
    pub best_ask: Option<f64>,
    pub bids: u32,
    pub asks: u32,
}

pub fn book_top(conn: &Connection, base: &str, quote: &str) -> rusqlite::Result<BookTop> {
    conn.query_row(
        "SELECT MAX(CASE WHEN side = 'bid' THEN price END), MIN(CASE WHEN side = 'ask' THEN price END), \
         COALESCE(SUM(side = 'bid'), 0), COALESCE(SUM(side = 'ask'), 0) \
         FROM offers WHERE base = ?1 AND quote = ?2 AND status = 'open'",
        params![base, quote],
        |row| {
            Ok(BookTop {
                best_bid: row.get(0)?,
                best_ask: row.get(1)?,
                bids: row.get(2)?,
                asks: row.get(3)?,
            })
        },
    )
}

/// Stored response for an `Idempotency-Key`.
pub struct IdempotentResponse {
    pub request_hash: String,
    pub status: u16,
    pub body: String,
}

/// Keys are kept for 24 hours.
pub const IDEMPOTENCY_TTL_SECS: i64 = 86_400;

pub fn find_idempotent(
    conn: &Connection,
    route: &str,
    key: &str,
    now: i64,
) -> rusqlite::Result<Option<IdempotentResponse>> {
    conn.query_row(
        "SELECT request_hash, status, body FROM idempotency \
         WHERE route = ?1 AND key = ?2 AND created_at > ?3",
        params![route, key, now - IDEMPOTENCY_TTL_SECS],
        |row| {
            Ok(IdempotentResponse {
                request_hash: row.get(0)?,
                status: row.get(1)?,
                body: row.get(2)?,
            })
        },
    )
    .optional()
}

pub fn store_idempotent(
    conn: &Connection,
    route: &str,
    key: &str,
    response: &IdempotentResponse,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM idempotency WHERE created_at <= ?1",
        params![now - IDEMPOTENCY_TTL_SECS],
    )?;
    conn.execute(
        "INSERT OR REPLACE INTO idempotency (route, key, request_hash, status, body, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            route,
            key,
            response.request_hash,
            response.status,
            response.body,
            now
        ],
    )?;
    Ok(())
}
