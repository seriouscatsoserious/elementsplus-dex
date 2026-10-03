//! Instant (non-custodial fast confirmation) support, following the Instant
//! protocol spec (`elementsplus-wallet-extension/rust/instant/SPEC.md`).
//!
//! * Offer v2 (`kind: "instant-lockbox"`, SPEC §9.1): a maker's lockbox UTXO
//!   with a pre-signed PAIRED owner authorization. Everything is re-derived:
//!   the lockbox script is recompiled from `(genesis, owner, operator,
//!   expiry)` with the `elementsplus-instant` crate and compared with the
//!   funding output; the PAIRED signature is verified over the crate's
//!   `paired_digest` (the exact message the covenant checks).
//! * Operator announcements (SPEC §5.2): signature verified with the crate,
//!   every bond script recompiled and checked on chain (explicit native asset,
//!   at least `MIN_BOND`, unspent, at least 2 confirmations).
//! * Receipt relay (SPEC §5.4, §7, §8 C1): operator promises verified against
//!   the announced operator key, with per-lockbox conflict retention.
//!
//! Nothing here holds keys or signs.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};

use elements::confidential::{Asset, Nonce, Value};
use elements::encode::deserialize;
use elements::secp256k1_zkp::XOnlyPublicKey;
use elements::{AssetId, BlockHash, OutPoint, Script, Transaction, TxOut, Txid};
use elementsplus_instant::{announce, bond, hash, lockbox, policy};
use serde::{Deserialize, Serialize};

use crate::config::Network;
use crate::offer::{script_address, DecodedOffer, OfferError, OfferLeg, MAX_PREVOUT_TX_BYTES};
use crate::util::{decode_hex, parse_amount, parse_asset_id, parse_txid};

pub const OFFER_VERSION: u32 = 2;
pub const OFFER_KIND: &str = "instant-lockbox";
/// SPEC §3 constants re-exported for the API/docs.
pub const PROMISE_MARGIN: u32 = policy::PROMISE_MARGIN;
pub const CHALLENGE_WINDOW: u32 = policy::CHALLENGE_WINDOW;
pub const BOND_MIN_CONFIRMATIONS: u32 = policy::BOND_MIN_CONFIRMATIONS;
pub const MIN_BOND: u64 = bond::MIN_BOND;
/// Maker-order lockboxes live at most this long (SPEC §3 `DEFAULT_LIFETIME`).
pub const MAX_ORDER_LIFETIME: u32 = 4_032;
/// Most promises (lockbox inputs) one relayed receipt may carry.
pub const MAX_RECEIPT_PROMISES: usize = 64;

fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, OfferError> {
    Err(OfferError::new(code, message))
}

// ---------------------------------------------------------------------------
// Small parsers

/// `"<txid>:<vout>"` with a canonical lowercase txid.
pub fn parse_outpoint(value: &str) -> Result<OutPoint, String> {
    let (txid, vout) = value
        .split_once(':')
        .ok_or_else(|| "outpoint must be \"<txid>:<vout>\"".to_owned())?;
    let txid = parse_txid(txid)?;
    if vout.is_empty() || vout.len() > 10 || (vout.len() > 1 && vout.starts_with('0')) {
        return Err("outpoint vout is not a canonical integer".into());
    }
    let vout = vout
        .parse::<u32>()
        .map_err(|_| "outpoint vout is out of range".to_owned())?;
    Ok(OutPoint::new(txid, vout))
}

/// 32-byte BIP340 x-only public key, 64 lowercase hex characters.
pub fn parse_xonly(value: &str) -> Result<XOnlyPublicKey, String> {
    if !crate::util::is_hex32(value) {
        return Err("x-only key must be 64 lowercase hex characters".into());
    }
    XOnlyPublicKey::from_str(value).map_err(|_| "not a valid x-only public key".into())
}

pub fn parse_sig(value: &str) -> Result<[u8; 64], String> {
    if value.len() != 128 {
        return Err("signature must be 64 bytes of hex".into());
    }
    let bytes = hex::decode(value).map_err(|_| "signature is not valid hex".to_owned())?;
    bytes
        .try_into()
        .map_err(|_| "signature must be 64 bytes".into())
}

pub fn parse_hash32(value: &str, what: &str) -> Result<[u8; 32], String> {
    if !crate::util::is_hex32(value) {
        return Err(format!("{what} must be 64 lowercase hex characters"));
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(value, &mut out).map_err(|_| format!("{what} is not valid hex"))?;
    Ok(out)
}

/// Explicit asset / value, null nonce, no proofs, positive value.
pub fn explicit_txout(output: &TxOut, what: &str) -> Result<(AssetId, u64), OfferError> {
    let Asset::Explicit(asset) = output.asset else {
        return fail(
            "confidential_output",
            format!("{what} asset must be explicit"),
        );
    };
    let Value::Explicit(value) = output.value else {
        return fail(
            "confidential_output",
            format!("{what} value must be explicit"),
        );
    };
    if output.nonce != Nonce::Null {
        return fail(
            "confidential_output",
            format!("{what} must have a null nonce"),
        );
    }
    if !output.witness.is_empty() {
        return fail(
            "confidential_output",
            format!("{what} must not carry range/surjection proofs"),
        );
    }
    if value == 0 {
        return fail("invalid_offer", format!("{what} value must be positive"));
    }
    Ok((asset, value))
}

// ---------------------------------------------------------------------------
// Script compilation (cached: SimplicityHL compilation is not free)

type LockboxKey = (BlockHash, [u8; 32], [u8; 32], u32);
type BondKey = (BlockHash, AssetId, [u8; 32], u32);
const CACHE_LIMIT: usize = 4_096;

fn cached<K: std::hash::Hash + Eq + Clone>(
    cache: &'static OnceLock<Mutex<HashMap<K, Script>>>,
    key: K,
    compile: impl FnOnce() -> Result<Script, String>,
) -> Result<Script, String> {
    let cache = cache.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(script) = cache.lock().ok().and_then(|map| map.get(&key).cloned()) {
        return Ok(script);
    }
    let script = compile()?;
    if let Ok(mut map) = cache.lock() {
        if map.len() >= CACHE_LIMIT {
            map.clear();
        }
        map.insert(key, script.clone());
    }
    Ok(script)
}

/// Lockbox scriptPubKey for the given parameters (SPEC §4.1).
pub fn lockbox_script(params: &lockbox::Params) -> Result<Script, String> {
    static CACHE: OnceLock<Mutex<HashMap<LockboxKey, Script>>> = OnceLock::new();
    let key = (
        params.genesis,
        params.owner.serialize(),
        params.operator.serialize(),
        params.expiry,
    );
    cached(&CACHE, key, || {
        Ok(params.compile()?.script_pubkey().clone())
    })
}

/// Pooled bond scriptPubKey for the given parameters (SPEC §4.2).
pub fn bond_script(params: &bond::Params) -> Result<Script, String> {
    static CACHE: OnceLock<Mutex<HashMap<BondKey, Script>>> = OnceLock::new();
    let key = (
        params.genesis,
        params.fee_asset,
        params.operator.serialize(),
        params.refund_height,
    );
    cached(&CACHE, key, || {
        Ok(params.compile()?.script_pubkey().clone())
    })
}

// ---------------------------------------------------------------------------
// Offer v2 (SPEC §9.1)

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct LockboxRef {
    /// `"<txid>:<vout>"` of the maker's lockbox UTXO.
    pub outpoint: String,
    /// Owner (maker) x-only key.
    pub owner: String,
    /// Operator x-only key.
    pub operator: String,
    /// Absolute block height of the owner-only exit path.
    pub expiry: u32,
}

/// Wire format of an instant lockbox order.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct InstantOffer {
    pub version: u32,
    pub kind: String,
    pub network: String,
    pub genesis_hash: String,
    pub lockbox: LockboxRef,
    /// Hex of the consensus-serialized `TxOut` the maker wants at the same
    /// index as its lockbox input (explicit asset/amount/script).
    pub paired_output: String,
    /// BIP340 signature by `owner` over `paired_digest(lockbox, paired_output)`.
    pub paired_sig: String,
    pub give: OfferLeg,
    pub want: OfferLeg,
}

/// Structurally checked instant offer with a verified PAIRED authorization
/// and the recompiled lockbox script; the funding output is not seen yet.
#[derive(Clone, Debug)]
pub struct ParsedInstant {
    pub outpoint: OutPoint,
    pub params: lockbox::Params,
    pub lockbox_script: Script,
    pub paired_output: TxOut,
    pub give_asset: AssetId,
    pub give_amount: u64,
    pub want_asset: AssetId,
    pub want_amount: u64,
}

/// Step 1 (CPU only, no chain access): structure, network, PAIRED signature
/// (crate `hash::paired_digest` + BIP340) and the lockbox script recompiled
/// from the announced parameters.
pub fn parse_instant_offer(
    offer: &InstantOffer,
    network: &Network,
) -> Result<ParsedInstant, OfferError> {
    if offer.version != OFFER_VERSION {
        return fail(
            "unsupported_version",
            format!("unsupported offer version {}", offer.version),
        );
    }
    if offer.kind != OFFER_KIND {
        return fail(
            "unsupported_kind",
            format!("offer v2 kind must be {OFFER_KIND:?}"),
        );
    }
    if offer.network != network.name {
        return fail(
            "wrong_network",
            format!(
                "offer network {:?} does not match {:?}",
                offer.network, network.name
            ),
        );
    }
    if offer.genesis_hash != network.genesis_hash.to_string() {
        return fail(
            "wrong_network",
            "offer genesis hash does not match this network",
        );
    }
    let invalid = |message: String| OfferError::new("invalid_offer", message);
    let give_asset = parse_asset_id(&offer.give.asset_id).map_err(invalid)?;
    let want_asset = parse_asset_id(&offer.want.asset_id).map_err(invalid)?;
    let give_amount = parse_amount(&offer.give.amount).map_err(invalid)?;
    let want_amount = parse_amount(&offer.want.amount).map_err(invalid)?;
    if give_asset == want_asset {
        return fail("invalid_offer", "offer must swap two different assets");
    }
    let outpoint = parse_outpoint(&offer.lockbox.outpoint).map_err(invalid)?;
    let owner = parse_xonly(&offer.lockbox.owner).map_err(invalid)?;
    let operator = parse_xonly(&offer.lockbox.operator).map_err(invalid)?;
    let params = lockbox::Params {
        genesis: network.genesis_hash,
        owner,
        operator,
        expiry: offer.lockbox.expiry,
    };
    params.validate().map_err(invalid)?;

    let bytes = decode_hex(&offer.paired_output, 1_024, "paired_output").map_err(invalid)?;
    let paired_output: TxOut = deserialize(&bytes)
        .map_err(|_| invalid("paired_output is not a consensus-serialized TxOut".into()))?;
    let (out_asset, out_value) = explicit_txout(&paired_output, "paired output")?;
    if paired_output.script_pubkey.is_empty() {
        return fail("invalid_offer", "paired output must pay a script");
    }
    if out_asset != want_asset || out_value != want_amount {
        return fail(
            "offer_mismatch",
            "offer `want` does not match the paired output",
        );
    }
    let paired_sig = parse_sig(&offer.paired_sig)
        .map_err(|message| OfferError::new("bad_signature", message))?;
    let digest = hash::paired_digest(network.genesis_hash, outpoint, &paired_output)
        .map_err(|message| OfferError::new("invalid_offer", message))?;
    if !elementsplus_instant::verify_digest(digest, &paired_sig, &owner) {
        return fail(
            "bad_signature",
            "paired_sig does not verify for the lockbox owner",
        );
    }
    let lockbox_script = lockbox_script(&params).map_err(OfferError::internal)?;
    Ok(ParsedInstant {
        outpoint,
        params,
        lockbox_script,
        paired_output,
        give_asset,
        give_amount,
        want_asset,
        want_amount,
    })
}

/// Step 2: bind to the funding transaction (fetched by the caller and
/// verified here to hash to the lockbox txid).
pub fn verify_instant_funding(
    parsed: &ParsedInstant,
    prevout_raw_tx_hex: &str,
    network: &Network,
) -> Result<DecodedOffer, OfferError> {
    let bytes = decode_hex(
        prevout_raw_tx_hex.trim(),
        MAX_PREVOUT_TX_BYTES,
        "funding tx",
    )
    .map_err(|e| OfferError::new("invalid_prevout", e))?;
    let prev_tx: Transaction = deserialize(&bytes)
        .map_err(|_| OfferError::new("invalid_prevout", "funding tx is not a valid transaction"))?;
    if prev_tx.txid() != parsed.outpoint.txid {
        return fail(
            "prevout_mismatch",
            "funding tx does not hash to the lockbox txid",
        );
    }
    let Some(prevout) = prev_tx.output.get(parsed.outpoint.vout as usize) else {
        return fail(
            "prevout_mismatch",
            "lockbox output index does not exist in the funding tx",
        );
    };
    if prevout.script_pubkey != parsed.lockbox_script {
        return fail(
            "lockbox_mismatch",
            "funding output script is not the lockbox compiled from (genesis, owner, operator, expiry)",
        );
    }
    let (asset, value) = explicit_txout(prevout, "lockbox output")?;
    if asset != parsed.give_asset || value != parsed.give_amount {
        return fail(
            "offer_mismatch",
            "offer `give` does not match the lockbox output",
        );
    }
    Ok(DecodedOffer {
        give_asset: parsed.give_asset,
        give_amount: parsed.give_amount,
        want_asset: parsed.want_asset,
        want_amount: parsed.want_amount,
        outpoint: parsed.outpoint,
        maker_address: script_address(&parsed.paired_output.script_pubkey, &network.address_hrp),
        maker_script: parsed.paired_output.script_pubkey.clone(),
        funding_script: prevout.script_pubkey.clone(),
    })
}

/// `tip + S < expiry` (SPEC §8 B1): operators stop promising at EXPIRY − S.
pub fn lockbox_live(tip: u64, expiry: u32) -> bool {
    tip.saturating_add(u64::from(PROMISE_MARGIN)) < u64::from(expiry)
}

// ---------------------------------------------------------------------------
// Operator announcements (SPEC §5.2)

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct AnnouncedBondWire {
    /// `"<txid>:<vout>"` of a pooled bond output.
    pub outpoint: String,
    pub refund_height: u32,
}

/// JSON form of a signed announcement. `sequence` may be a JSON number or a
/// decimal string (u64).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct AnnouncementWire {
    #[serde(alias = "genesis_hash")]
    pub genesis: String,
    pub fee_asset: String,
    pub operator: String,
    #[serde(with = "u64_number_or_string")]
    pub sequence: u64,
    pub bonds: Vec<AnnouncedBondWire>,
    pub api_url: String,
}

mod u64_number_or_string {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u64(*value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Number(u64),
            Text(String),
        }
        match Raw::deserialize(deserializer)? {
            Raw::Number(value) => Ok(value),
            Raw::Text(text) => crate::util::parse_amount(&text).map_err(de::Error::custom),
        }
    }
}

/// Parse the announcement fields into the crate type (no signature check).
pub fn parse_announcement(
    wire: &AnnouncementWire,
    network: &Network,
) -> Result<announce::Announcement, OfferError> {
    let invalid = |message: String| OfferError::new("invalid_announcement", message);
    let genesis = BlockHash::from_str(&wire.genesis)
        .map_err(|_| invalid("genesis must be a 32-byte hex block hash".into()))?;
    if genesis != network.genesis_hash {
        return fail(
            "wrong_network",
            "announcement genesis does not match this network",
        );
    }
    let fee_asset = parse_asset_id(&wire.fee_asset).map_err(invalid)?;
    if fee_asset != network.policy_asset {
        return fail(
            "wrong_network",
            "announcement fee_asset must be this network's policy asset",
        );
    }
    let operator = parse_xonly(&wire.operator).map_err(invalid)?;
    if wire.bonds.is_empty() || wire.bonds.len() > announce::MAX_BONDS {
        return fail(
            "invalid_announcement",
            format!("announce 1..={} bonds", announce::MAX_BONDS),
        );
    }
    let mut bonds = Vec::with_capacity(wire.bonds.len());
    for b in &wire.bonds {
        let outpoint = parse_outpoint(&b.outpoint).map_err(invalid)?;
        if b.refund_height == 0 || b.refund_height >= 500_000_000 {
            return fail("invalid_announcement", "refund_height must be a block height");
        }
        if bonds
            .iter()
            .any(|seen: &announce::AnnouncedBond| seen.outpoint == outpoint)
        {
            return fail("invalid_announcement", "duplicate bond outpoint");
        }
        bonds.push(announce::AnnouncedBond {
            outpoint,
            refund_height: b.refund_height,
        });
    }
    Ok(announce::Announcement {
        genesis,
        fee_asset,
        operator,
        sequence: wire.sequence,
        bonds,
        api_url: wire.api_url.clone(),
    })
}

/// Signature check (crate `Announcement::verify`; also enforces the
/// https / length / bond-count rules of the digest).
pub fn verify_announcement_signature(
    announcement: &announce::Announcement,
    signature: &str,
) -> Result<(), OfferError> {
    let sig = parse_sig(signature).map_err(|message| OfferError::new("bad_signature", message))?;
    announcement.digest().map_err(|message| {
        OfferError::new("invalid_announcement", message)
    })?;
    announcement
        .verify(&sig)
        .map_err(|message| OfferError::new("bad_signature", message))
}

/// On-chain view of one announced bond.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct BondCheck {
    pub outpoint: String,
    pub refund_height: u32,
    /// Explicit native-asset amount (atomic), when the output exists.
    pub amount: Option<String>,
    pub confirmations: u32,
    pub unspent: bool,
    /// Script equals the recompiled pooled bond, asset is the native asset
    /// (explicit) and amount >= MIN_BOND.
    pub script_ok: bool,
    /// Counts now: script_ok, unspent, >= 2 confirmations and
    /// `refund_height >= tip + S + W`.
    pub eligible: bool,
    pub error: Option<String>,
}

/// Check one bond output against the funding transaction (already verified to
/// hash to the bond txid by the caller). Returns `(script_ok, amount, error)`.
pub fn check_bond_output(
    expected_script: &Script,
    fee_asset: AssetId,
    funding: &Transaction,
    vout: u32,
) -> (bool, Option<u64>, Option<String>) {
    let Some(output) = funding.output.get(vout as usize) else {
        return (false, None, Some("bond output index does not exist".into()));
    };
    let (Asset::Explicit(asset), Value::Explicit(amount)) = (output.asset, output.value) else {
        return (false, None, Some("bond output must be explicit".into()));
    };
    if output.script_pubkey != *expected_script {
        return (
            false,
            Some(amount),
            Some("bond script does not match the recompiled pooled bond".into()),
        );
    }
    if asset != fee_asset {
        return (
            false,
            Some(amount),
            Some("bond asset is not the native asset".into()),
        );
    }
    if amount < MIN_BOND {
        return (
            false,
            Some(amount),
            Some(format!("bond amount below MIN_BOND ({MIN_BOND})")),
        );
    }
    (true, Some(amount), None)
}

/// Summary of an operator's bonds as served by the directory.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BondSummary {
    pub verified: bool,
    pub max_refund_height: u32,
    pub cover: u64,
}

pub fn summarize_bonds(bonds: &[BondCheck]) -> BondSummary {
    let eligible: Vec<&BondCheck> = bonds.iter().filter(|b| b.eligible).collect();
    let cover = eligible
        .iter()
        .filter_map(|b| b.amount.as_deref().and_then(|a| a.parse::<u64>().ok()))
        .map(policy::effective_cover)
        .fold(0u64, u64::saturating_add);
    BondSummary {
        verified: !eligible.is_empty(),
        max_refund_height: eligible.iter().map(|b| b.refund_height).max().unwrap_or(0),
        cover,
    }
}

/// Bond eligibility at `tip` independent of any particular lockbox:
/// SPEC §5.1 step 3 (`tip + S + W <= REFUND_HEIGHT`).
pub fn bond_eligible_now(check: &BondCheck, tip: u64) -> bool {
    check.script_ok
        && check.unspent
        && check.confirmations >= BOND_MIN_CONFIRMATIONS
        && u64::from(check.refund_height)
            >= tip + u64::from(PROMISE_MARGIN) + u64::from(CHALLENGE_WINDOW)
}

// ---------------------------------------------------------------------------
// Receipts (relay)

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PromiseWire {
    /// Input index of the lockbox in the promised transaction.
    pub index: u32,
    /// `"<txid>:<vout>"` of the lockbox.
    pub lockbox: String,
    /// `tx_commitment(T)` as 64 hex characters (raw SHA-256 bytes, not reversed).
    pub commitment: String,
    /// BIP340 signature by the operator over `promise_digest(lockbox, T)`.
    pub sig: String,
}

/// Body of `POST /v1/instant/receipts`: the operator's promise response
/// (`txid`, `promises`, optional signed `receipt`) plus who promised and how
/// much the publisher relies on.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ReceiptWire {
    pub operator: String,
    pub txid: String,
    /// Native-asset atomic units the publisher relies on (SPEC §8 B3).
    #[serde(default)]
    pub value_at_risk: Option<String>,
    pub promises: Vec<PromiseWire>,
    /// The operator's signed receipt envelope (`{seq, in_flight, bonds, ...}`),
    /// stored and served verbatim; its signature layout is not fixed by the
    /// SPEC yet, so it is not interpreted.
    #[serde(default)]
    pub receipt: Option<serde_json::Value>,
    /// Optional: the promised transaction and the TxOut spent by each input,
    /// both hex. When given, `txid`, `commitment` and lockbox indices are
    /// checked against them.
    #[serde(default)]
    pub tx: Option<String>,
    #[serde(default)]
    pub spent: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedPromise {
    pub index: u32,
    pub lockbox: OutPoint,
    pub commitment: [u8; 32],
    pub sig: [u8; 64],
}

#[derive(Clone, Debug)]
pub struct VerifiedReceipt {
    pub operator: XOnlyPublicKey,
    pub txid: Txid,
    pub value_at_risk: u64,
    pub commitment: [u8; 32],
    pub promises: Vec<VerifiedPromise>,
}

/// Verify every promise signature against `operator` and the network
/// genesis. All promises of one receipt share one transaction, hence one
/// commitment.
pub fn verify_receipt(
    wire: &ReceiptWire,
    network: &Network,
) -> Result<VerifiedReceipt, OfferError> {
    let invalid = |message: String| OfferError::new("invalid_receipt", message);
    let operator = parse_xonly(&wire.operator).map_err(invalid)?;
    let txid = parse_txid(&wire.txid).map_err(invalid)?;
    let value_at_risk = match &wire.value_at_risk {
        None => 0,
        Some(value) => parse_amount(value).map_err(invalid)?,
    };
    if wire.promises.is_empty() || wire.promises.len() > MAX_RECEIPT_PROMISES {
        return fail(
            "invalid_receipt",
            format!("a receipt carries 1..={MAX_RECEIPT_PROMISES} promises"),
        );
    }
    let mut promises = Vec::with_capacity(wire.promises.len());
    for p in &wire.promises {
        let lockbox = parse_outpoint(&p.lockbox).map_err(invalid)?;
        let commitment = parse_hash32(&p.commitment, "commitment").map_err(invalid)?;
        let sig = parse_sig(&p.sig).map_err(|m| OfferError::new("bad_signature", m))?;
        if promises
            .iter()
            .any(|seen: &VerifiedPromise| seen.lockbox == lockbox || seen.index == p.index)
        {
            return fail("invalid_receipt", "duplicate lockbox or input index");
        }
        let digest = hash::promise_digest(network.genesis_hash, lockbox, commitment);
        if !elementsplus_instant::verify_digest(digest, &sig, &operator) {
            return fail(
                "bad_signature",
                format!("promise for {} does not verify for the operator", p.lockbox),
            );
        }
        promises.push(VerifiedPromise {
            index: p.index,
            lockbox,
            commitment,
            sig,
        });
    }
    let commitment = promises[0].commitment;
    if promises.iter().any(|p| p.commitment != commitment) {
        return fail(
            "invalid_receipt",
            "all promises of one transaction must share its commitment",
        );
    }
    match (&wire.tx, &wire.spent) {
        (None, None) => {}
        (Some(tx_hex), Some(spent)) => {
            let bytes = decode_hex(tx_hex, MAX_PREVOUT_TX_BYTES, "tx").map_err(invalid)?;
            let tx: Transaction = deserialize(&bytes)
                .map_err(|_| invalid("tx is not a valid transaction".into()))?;
            if tx.txid() != txid {
                return fail("invalid_receipt", "tx does not hash to txid");
            }
            let spent = spent
                .iter()
                .map(|hex| {
                    let bytes = decode_hex(hex, 10_000, "spent TxOut")?;
                    deserialize::<TxOut>(&bytes).map_err(|_| "spent entry is not a TxOut".into())
                })
                .collect::<Result<Vec<_>, String>>()
                .map_err(invalid)?;
            let computed = hash::tx_commitment(&tx, &spent).map_err(invalid)?;
            if computed != commitment {
                return fail(
                    "invalid_receipt",
                    "commitment does not match tx_commitment(tx, spent)",
                );
            }
            for p in &promises {
                if tx.input.get(p.index as usize).map(|i| i.previous_output) != Some(p.lockbox) {
                    return fail(
                        "invalid_receipt",
                        "promise index does not spend its lockbox in tx",
                    );
                }
            }
        }
        _ => {
            return fail("invalid_receipt", "send both `tx` and `spent`, or neither");
        }
    }
    Ok(VerifiedReceipt {
        operator,
        txid,
        value_at_risk,
        commitment,
        promises,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;

    #[test]
    fn outpoints_and_keys_are_strict() {
        let txid = "ab".repeat(32);
        assert_eq!(parse_outpoint(&format!("{txid}:7")).unwrap().vout, 7);
        for bad in [
            txid.clone(),
            format!("{txid}:"),
            format!("{txid}:07"),
            format!("{txid}:-1"),
            format!("{}:1", "AB".repeat(32)),
        ] {
            assert!(parse_outpoint(&bad).is_err(), "{bad}");
        }
        assert!(parse_xonly(&"00".repeat(32)).is_err());
        assert!(parse_sig("00").is_err());
    }

    #[test]
    fn valid_instant_offer_parses_and_binds_to_funding() {
        let network = test_network();
        let fixture = InstantFixture::new(&network, 1, 1_000, 5_000, 900);
        let parsed = parse_instant_offer(&fixture.offer, &network).unwrap();
        assert_eq!(parsed.outpoint, fixture.outpoint());
        assert_eq!(parsed.lockbox_script, fixture.lockbox_script());
        let decoded = verify_instant_funding(&parsed, &fixture.prevout_hex, &network).unwrap();
        assert_eq!(decoded.give_amount, 1_000);
        assert_eq!(decoded.want_amount, 5_000);
        assert!(decoded.maker_address.starts_with("ert1q"));
        assert_eq!(decoded.funding_script, fixture.lockbox_script());
    }

    #[test]
    fn paired_sig_must_verify_for_the_owner() {
        let network = test_network();
        let fixture = InstantFixture::new(&network, 1, 1_000, 5_000, 900);
        let mut offer = fixture.offer.clone();
        // Signed by the operator instead of the owner.
        offer.paired_sig = fixture.sign_paired_with(fixture.operator_key());
        let error = parse_instant_offer(&offer, &network).unwrap_err();
        assert_eq!(error.code, "bad_signature");
        // A signature over another output (amount changed after signing).
        let mut offer = fixture.offer.clone();
        offer.want.amount = "5001".into();
        offer.paired_output = fixture.paired_output_hex_with_amount(5_001);
        assert_eq!(
            parse_instant_offer(&offer, &network).unwrap_err().code,
            "bad_signature"
        );
        // Signed for another outpoint.
        let mut offer = fixture.offer.clone();
        offer.lockbox.outpoint = format!("{}:2", fixture.funding_tx.txid());
        assert_eq!(
            parse_instant_offer(&offer, &network).unwrap_err().code,
            "bad_signature"
        );
    }

    #[test]
    fn lockbox_params_must_match_the_funding_script() {
        let network = test_network();
        let fixture = InstantFixture::new(&network, 1, 1_000, 5_000, 900);
        // Claiming another expiry still verifies the PAIRED sig (it does not
        // commit to the expiry) but recompiles to a different script.
        let mut offer = fixture.offer.clone();
        offer.lockbox.expiry = 901;
        let parsed = parse_instant_offer(&offer, &network).unwrap();
        let error = verify_instant_funding(&parsed, &fixture.prevout_hex, &network).unwrap_err();
        assert_eq!(error.code, "lockbox_mismatch");
        // Another operator key: different script too.
        let mut offer = fixture.offer.clone();
        offer.lockbox.operator = xonly_hex(&other_operator_key());
        let parsed = parse_instant_offer(&offer, &network).unwrap();
        assert_eq!(
            verify_instant_funding(&parsed, &fixture.prevout_hex, &network)
                .unwrap_err()
                .code,
            "lockbox_mismatch"
        );
    }

    #[test]
    fn instant_offer_structure_is_checked() {
        let network = test_network();
        let fixture = InstantFixture::new(&network, 1, 1_000, 5_000, 900);
        let mut offer = fixture.offer.clone();
        offer.kind = "lockbox".into();
        assert_eq!(
            parse_instant_offer(&offer, &network).unwrap_err().code,
            "unsupported_kind"
        );
        let mut offer = fixture.offer.clone();
        offer.network = "ecx-mainnet".into();
        assert_eq!(
            parse_instant_offer(&offer, &network).unwrap_err().code,
            "wrong_network"
        );
        let mut offer = fixture.offer.clone();
        offer.give.amount = "999".into();
        let parsed = parse_instant_offer(&offer, &network).unwrap();
        assert_eq!(
            verify_instant_funding(&parsed, &fixture.prevout_hex, &network)
                .unwrap_err()
                .code,
            "offer_mismatch"
        );
        let mut offer = fixture.offer.clone();
        offer.want.amount = "4999".into();
        assert_eq!(
            parse_instant_offer(&offer, &network).unwrap_err().code,
            "offer_mismatch"
        );
        let mut offer = fixture.offer.clone();
        offer.lockbox.owner = offer.lockbox.operator.clone();
        assert_eq!(
            parse_instant_offer(&offer, &network).unwrap_err().code,
            "invalid_offer"
        );
    }

    #[test]
    fn expiry_margin() {
        assert!(lockbox_live(100, 107));
        assert!(!lockbox_live(100, 106));
    }

    #[test]
    fn announcement_signature_and_network() {
        let network = test_network();
        let op = OperatorFixture::new(&network, 3, 1, vec![(bond_outpoint(1), 5_000)]);
        let parsed = parse_announcement(&op.wire, &network).unwrap();
        verify_announcement_signature(&parsed, &op.signature).unwrap();
        let mut tampered = op.wire.clone();
        tampered.api_url = "https://evil.example".into();
        let parsed = parse_announcement(&tampered, &network).unwrap();
        assert_eq!(
            verify_announcement_signature(&parsed, &op.signature)
                .unwrap_err()
                .code,
            "bad_signature"
        );
        let mut wrong_asset = op.wire.clone();
        wrong_asset.fee_asset = asset(0x77).to_string();
        assert_eq!(
            parse_announcement(&wrong_asset, &network).unwrap_err().code,
            "wrong_network"
        );
        let json = serde_json::json!({
            "genesis_hash": op.wire.genesis, "fee_asset": op.wire.fee_asset,
            "operator": op.wire.operator, "sequence": "3", "bonds": op.wire.bonds,
            "api_url": op.wire.api_url,
        });
        let wire: AnnouncementWire = serde_json::from_value(json).unwrap();
        assert_eq!(wire.sequence, 3);
    }

    #[test]
    fn bond_output_checks() {
        let network = test_network();
        let op = OperatorFixture::new(&network, 3, 1, vec![(bond_outpoint(1), 5_000)]);
        let script = op.bond_script(5_000);
        let funding = op.bond_funding_tx(5_000, MIN_BOND);
        assert_eq!(
            check_bond_output(&script, network.policy_asset, &funding, 0),
            (true, Some(MIN_BOND), None)
        );
        let small = op.bond_funding_tx(5_000, MIN_BOND - 1);
        assert!(!check_bond_output(&script, network.policy_asset, &small, 0).0);
        let other = op.bond_script(5_001);
        assert!(!check_bond_output(&other, network.policy_asset, &funding, 0).0);
        assert!(!check_bond_output(&script, network.policy_asset, &funding, 9).0);
        let mut check = BondCheck {
            script_ok: true,
            unspent: true,
            confirmations: 2,
            refund_height: 1_000,
            amount: Some("80000000".into()),
            ..Default::default()
        };
        assert!(bond_eligible_now(&check, 1_000 - 150));
        assert!(!bond_eligible_now(&check, 1_000 - 149));
        check.confirmations = 1;
        assert!(!bond_eligible_now(&check, 0));
        check.confirmations = 2;
        check.eligible = true;
        let summary = summarize_bonds(&[check]);
        assert_eq!(summary.cover, 70_000_000);
        assert_eq!(summary.max_refund_height, 1_000);
        assert!(summary.verified);
    }

    #[test]
    fn receipts_verify_promises() {
        let network = test_network();
        let op = OperatorFixture::new(&network, 3, 1, vec![(bond_outpoint(1), 5_000)]);
        let lockbox = OutPoint::new(Txid::from_str(&"cd".repeat(32)).unwrap(), 1);
        let receipt = op.receipt(&[lockbox], [7; 32], "ab".repeat(32));
        let verified = verify_receipt(&receipt, &network).unwrap();
        assert_eq!(verified.promises.len(), 1);
        assert_eq!(verified.commitment, [7; 32]);

        let mut forged = receipt.clone();
        forged.promises[0].commitment = hex::encode([8u8; 32]);
        assert_eq!(
            verify_receipt(&forged, &network).unwrap_err().code,
            "bad_signature"
        );
        let mut other_operator = receipt.clone();
        other_operator.operator = xonly_hex(&other_operator_key());
        assert_eq!(
            verify_receipt(&other_operator, &network).unwrap_err().code,
            "bad_signature"
        );
        let second = OutPoint::new(lockbox.txid, 2);
        let mut mixed = op.receipt(&[lockbox, second], [7; 32], "ab".repeat(32));
        let other = op.receipt(&[second], [9; 32], "ab".repeat(32));
        mixed.promises[1] = PromiseWire {
            index: 1,
            ..other.promises[0].clone()
        };
        assert_eq!(
            verify_receipt(&mixed, &network).unwrap_err().code,
            "invalid_receipt"
        );
    }

    #[test]
    fn receipt_with_transaction_checks_commitment() {
        let network = test_network();
        let fixture = InstantFixture::new(&network, 1, 1_000, 5_000, 900);
        let op = OperatorFixture::new(&network, 3, 1, vec![(bond_outpoint(1), 5_000)]);
        let take = fixture.take_tx(true);
        let spent = fixture.take_spent();
        let commitment = hash::tx_commitment(&take, &spent).unwrap();
        let mut receipt = op.receipt(&[fixture.outpoint()], commitment, take.txid().to_string());
        receipt.tx = Some(tx_hex(&take));
        receipt.spent = Some(
            spent
                .iter()
                .map(|o| hex::encode(elements::encode::serialize(o)))
                .collect(),
        );
        verify_receipt(&receipt, &network).unwrap();
        let mut wrong = receipt.clone();
        wrong.txid = "ef".repeat(32);
        assert_eq!(
            verify_receipt(&wrong, &network).unwrap_err().code,
            "invalid_receipt"
        );
    }
}
