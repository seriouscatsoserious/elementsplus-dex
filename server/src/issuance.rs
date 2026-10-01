//! Asset registry verification (`verify_asset_issuance`, SPEC §1.2).
//!
//! An entry is trusted only if the issuance input in the referenced
//! transaction commits to the contract: the issuance's `asset_entropy` field
//! must equal the contract hash, and the asset id is re-derived from the
//! issuing prevout and that hash.

use elements::confidential::Value;
use elements::encode::deserialize;
use elements::hashes::Hash;
use elements::secp256k1_zkp::ZERO_TWEAK;
use elements::{AssetId, ContractHash, Transaction, Txid};
use serde::Serialize;
use serde_json::{Map, Value as Json};

use crate::util::decode_hex;

pub const MAX_ISSUANCE_TX_BYTES: usize = 1_000_000;
const CONTRACT_KEYS: [&str; 5] = ["issuer_pubkey", "name", "precision", "ticker", "version"];

/// Verification failure with a stable machine-readable `code`.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{code}: {message}")]
pub struct IssuanceError {
    pub code: &'static str,
    pub message: String,
}

fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, IssuanceError> {
    Err(IssuanceError {
        code,
        message: message.into(),
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VerifiedIssuance {
    pub asset_id: String,
    pub token_id: Option<String>,
    pub contract_hash: String,
    /// Canonical (sorted-key, no-whitespace) contract JSON that was hashed.
    #[serde(skip)]
    pub canonical_contract: String,
}

/// Validate the contract fields and return its canonical JSON serialisation.
pub fn canonical_contract(contract: &Json) -> Result<String, IssuanceError> {
    let Json::Object(fields) = contract else {
        return fail("invalid_contract", "contract must be a JSON object");
    };
    if let Some(key) = fields
        .keys()
        .find(|key| !CONTRACT_KEYS.contains(&key.as_str()))
    {
        return fail(
            "invalid_contract",
            format!("unsupported contract field {key:?}"),
        );
    }
    let name = fields
        .get("name")
        .and_then(Json::as_str)
        .unwrap_or_default();
    let name_chars = name.chars().count();
    if !(1..=255).contains(&name_chars) || name.chars().any(char::is_control) {
        return fail(
            "invalid_contract",
            "contract name must be 1-255 printable characters",
        );
    }
    let ticker = fields
        .get("ticker")
        .and_then(Json::as_str)
        .unwrap_or_default();
    if !(3..=24).contains(&ticker.len())
        || !ticker
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    {
        return fail(
            "invalid_contract",
            "contract ticker must be 3-24 characters of [A-Za-z0-9.-]",
        );
    }
    match fields.get("precision").and_then(Json::as_u64) {
        Some(0..=8) => {}
        _ => {
            return fail(
                "invalid_contract",
                "contract precision must be an integer 0-8",
            )
        }
    }
    if fields.get("version").and_then(Json::as_u64) != Some(0) {
        return fail("invalid_contract", "contract version must be 0");
    }
    if let Some(issuer) = fields.get("issuer_pubkey") {
        let valid = issuer.as_str().is_some_and(|key| {
            key.len() == 66
                && (key.starts_with("02") || key.starts_with("03"))
                && key
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        });
        if !valid {
            return fail(
                "invalid_contract",
                "contract issuer_pubkey must be a 33-byte compressed hex key",
            );
        }
    }
    // serde_json's Map is a BTreeMap here (no `preserve_order`), so this
    // serialises with lexicographically sorted keys and no whitespace.
    let sorted: Map<String, Json> = fields.clone().into_iter().collect();
    serde_json::to_string(&Json::Object(sorted)).map_err(|error| IssuanceError {
        code: "internal_error",
        message: error.to_string(),
    })
}

pub fn contract_hash(canonical: &str) -> Result<ContractHash, IssuanceError> {
    ContractHash::from_json_contract(canonical).map_err(|_| IssuanceError {
        code: "invalid_contract",
        message: "contract is not valid JSON".into(),
    })
}

/// `verify_asset_issuance({raw_tx_hex, expected_txid, vin, contract})`.
pub fn verify_asset_issuance(
    raw_tx_hex: &str,
    expected_txid: &Txid,
    vin: u32,
    contract: &Json,
) -> Result<VerifiedIssuance, IssuanceError> {
    let canonical = canonical_contract(contract)?;
    let hash = contract_hash(&canonical)?;
    let bytes =
        decode_hex(raw_tx_hex.trim(), MAX_ISSUANCE_TX_BYTES, "issuance tx").map_err(|message| {
            IssuanceError {
                code: "invalid_issuance",
                message,
            }
        })?;
    let tx: Transaction = deserialize(&bytes).map_err(|_| IssuanceError {
        code: "invalid_issuance",
        message: "issuance tx is not a valid transaction".into(),
    })?;
    if tx.txid() != *expected_txid {
        return fail(
            "invalid_issuance",
            "issuance tx does not hash to the expected txid",
        );
    }
    let Some(input) = tx.input.get(vin as usize) else {
        return fail("invalid_issuance", "issuance input index out of range");
    };
    if !input.has_issuance() {
        return fail("invalid_issuance", "input carries no asset issuance");
    }
    let issuance = &input.asset_issuance;
    if issuance.asset_blinding_nonce != ZERO_TWEAK {
        return fail(
            "invalid_issuance",
            "input is a reissuance, not a new issuance",
        );
    }
    if issuance.asset_entropy != hash.to_byte_array() {
        return fail(
            "contract_mismatch",
            "issuance does not commit to this contract",
        );
    }
    let explicit_or_null = |value: &Value| matches!(value, Value::Null | Value::Explicit(_));
    if !explicit_or_null(&issuance.amount) || !explicit_or_null(&issuance.inflation_keys) {
        return fail("invalid_issuance", "issuance amounts must be explicit");
    }
    let entropy = AssetId::generate_asset_entropy(input.previous_output, hash);
    let asset_id = AssetId::from_entropy(entropy);
    let token_id = matches!(issuance.inflation_keys, Value::Explicit(amount) if amount > 0)
        .then(|| AssetId::reissuance_token_from_entropy(entropy, false).to_string());
    Ok(VerifiedIssuance {
        asset_id: asset_id.to_string(),
        token_id,
        contract_hash: hash.to_string(),
        canonical_contract: canonical,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;
    use serde_json::json;

    #[test]
    fn canonical_form_sorts_keys_without_whitespace() {
        let contract = json!({"version": 0, "ticker": "ABC", "precision": 8, "name": "A b"});
        assert_eq!(
            canonical_contract(&contract).unwrap(),
            r#"{"name":"A b","precision":8,"ticker":"ABC","version":0}"#
        );
    }

    #[test]
    fn contract_hash_matches_elements_reference() {
        // Equivalent but differently ordered/spaced JSON must hash identically.
        let a = contract_hash(r#"{"ticker":"ABC","name":"A","precision":0,"version":0}"#).unwrap();
        let b = contract_hash(
            &canonical_contract(&json!({"name":"A","ticker":"ABC","precision":0,"version":0}))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(a, b);
        // Hash of the canonical bytes is plain SHA256 (displayed reversed like txids).
        let canonical = r#"{"name":"A","precision":0,"ticker":"ABC","version":0}"#;
        let digest = elements::hashes::sha256::Hash::hash(canonical.as_bytes());
        assert_eq!(a.to_byte_array(), digest.to_byte_array());
    }

    #[test]
    fn contract_field_validation() {
        let base = sample_contract();
        assert!(canonical_contract(&base).is_ok());
        let cases = [
            ("name", json!("")),
            ("name", json!("x".repeat(256))),
            ("ticker", json!("AB")),
            ("ticker", json!("A".repeat(25))),
            ("ticker", json!("AB C")),
            ("precision", json!(9)),
            ("precision", json!(-1)),
            ("precision", json!("2")),
            ("version", json!(1)),
            ("issuer_pubkey", json!("04abcd")),
            ("domain", json!("example.com")),
        ];
        for (key, value) in cases {
            let mut contract = base.clone();
            contract[key] = value.clone();
            assert!(
                canonical_contract(&contract).is_err(),
                "{key}={value} accepted"
            );
        }
        let mut with_issuer = base.clone();
        with_issuer["issuer_pubkey"] = json!(format!("02{}", "ab".repeat(32)));
        assert!(canonical_contract(&with_issuer).is_ok());
        assert!(canonical_contract(&json!([1, 2])).is_err());
    }

    #[test]
    fn verifies_issuance_and_derives_ids() {
        for with_token in [false, true] {
            let fixture = IssuanceFixture::new(sample_contract(), with_token);
            let raw = tx_hex(&fixture.tx);
            let verified =
                verify_asset_issuance(&raw, &fixture.tx.txid(), fixture.vin, &fixture.contract)
                    .unwrap();
            let canonical = canonical_contract(&fixture.contract).unwrap();
            let hash = ContractHash::from_json_contract(&canonical).unwrap();
            let expected = AssetId::new_issuance(fixture.issuing_outpoint(), hash);
            assert_eq!(verified.asset_id, expected.to_string());
            assert_eq!(verified.contract_hash, hash.to_string());
            assert_eq!(
                verified.token_id,
                with_token.then(|| AssetId::new_reissuance_token(
                    fixture.issuing_outpoint(),
                    hash,
                    false
                )
                .to_string())
            );
        }
    }

    #[test]
    fn rejects_mismatched_issuance() {
        let fixture = IssuanceFixture::new(sample_contract(), true);
        let raw = tx_hex(&fixture.tx);
        let txid = fixture.tx.txid();
        let mut other = fixture.contract.clone();
        other["name"] = json!("Other Coin");
        let error = verify_asset_issuance(&raw, &txid, fixture.vin, &other).unwrap_err();
        assert!(error.message.contains("does not commit"), "{error}");
        assert_eq!(error.code, "contract_mismatch");
        assert!(verify_asset_issuance(&raw, &txid, 0, &fixture.contract).is_err());
        assert!(verify_asset_issuance(&raw, &txid, 5, &fixture.contract).is_err());
        let wrong_txid = Txid::from_byte_array([9; 32]);
        let error = verify_asset_issuance(&raw, &wrong_txid, 1, &fixture.contract).unwrap_err();
        assert!(error.message.contains("expected txid"), "{error}");
    }
}
