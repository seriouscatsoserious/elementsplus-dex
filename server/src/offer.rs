//! Swap offer format (SPEC §2) and `decode_offer` (SPEC §1.2).
//!
//! An offer is a 1-input / 1-output Elements transaction signed by the maker
//! with `SIGHASH_SINGLE|ANYONECANPAY`. Nothing in the offer JSON is trusted:
//! the offered asset and amount come from the funding transaction, which the
//! caller fetches separately and which must hash to the input's txid.

use elements::confidential::{Asset, Nonce, Value};
use elements::encode::deserialize;
use elements::hashes::{hash160, Hash};
use elements::secp256k1_zkp::{ecdsa, Message, PublicKey, Secp256k1};
use elements::sighash::SighashCache;
use elements::{AssetId, EcdsaSighashType, OutPoint, PubkeyHash, Script, Transaction, TxOut};
use serde::{Deserialize, Serialize};

use crate::config::Network;
use crate::util::{decode_hex, parse_amount, parse_asset_id};

/// Offers are tiny; anything bigger than this is not a 1-in/1-out offer.
pub const MAX_OFFER_TX_BYTES: usize = 4_096;
/// Upper bound for a funding transaction fetched from the explorer.
pub const MAX_PREVOUT_TX_BYTES: usize = 1_000_000;
pub const OFFER_VERSION: u32 = 1;
pub const SIGHASH_SINGLE_ANYONECANPAY: u8 = 0x83;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct OfferLeg {
    pub asset_id: String,
    pub amount: String,
}

/// Wire format of a swap offer (SPEC §2). Unknown fields are ignored on input
/// and never echoed back: the server only stores and serves these fields.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Offer {
    pub version: u32,
    pub network: String,
    pub genesis_hash: String,
    pub tx: String,
    pub give: OfferLeg,
    pub want: OfferLeg,
}

/// Validation failure with a stable machine-readable `code`.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{code}: {message}")]
pub struct OfferError {
    pub code: &'static str,
    pub message: String,
}

impl OfferError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal_error", message)
    }
}

/// Any offer the book accepts: v1 explicit P2WPKH offers (SPEC §2) and v2
/// Instant lockbox orders (Instant SPEC §9.1). Serialized without a tag, so
/// each variant round-trips as its own wire format.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum AnyOffer {
    Instant(crate::instant::InstantOffer),
    Plain(Offer),
}

impl AnyOffer {
    pub fn give(&self) -> &OfferLeg {
        match self {
            Self::Instant(offer) => &offer.give,
            Self::Plain(offer) => &offer.give,
        }
    }

    pub fn want(&self) -> &OfferLeg {
        match self {
            Self::Instant(offer) => &offer.want,
            Self::Plain(offer) => &offer.want,
        }
    }

    pub fn is_instant(&self) -> bool {
        matches!(self, Self::Instant(_))
    }
}

fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, OfferError> {
    Err(OfferError::new(code, message))
}

/// Structurally checked offer whose funding transaction has not been seen yet.
#[derive(Clone, Debug)]
pub struct ParsedOffer {
    pub tx: Transaction,
    pub outpoint: OutPoint,
    pub give_asset: AssetId,
    pub give_amount: u64,
    pub want_asset: AssetId,
    pub want_amount: u64,
    pub maker_output: TxOut,
}

/// Fully verified offer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedOffer {
    pub give_asset: AssetId,
    pub give_amount: u64,
    pub want_asset: AssetId,
    pub want_amount: u64,
    pub outpoint: OutPoint,
    /// Script the maker is paid to (output 0 of the offer).
    pub maker_script: Script,
    /// `maker_script` rendered with the configured HRP.
    pub maker_address: String,
    /// The offered funding output's script (also maker-owned).
    pub funding_script: Script,
}

/// Render a v0 P2WPKH script as an unconfidential bech32 address.
pub fn p2wpkh_address(script: &Script, hrp: &str) -> Result<String, OfferError> {
    use elements::bitcoin::bech32::{segwit, Hrp};
    if !script.is_v0_p2wpkh() {
        return fail(
            "unsupported_script",
            "only explicit P2WPKH scripts are supported",
        );
    }
    let hrp =
        Hrp::parse(hrp).map_err(|_| OfferError::new("internal_error", "invalid address HRP"))?;
    segwit::encode(hrp, segwit::VERSION_0, &script.as_bytes()[2..])
        .map_err(|_| OfferError::new("internal_error", "address encoding failed"))
}

/// Render a maker script as an unconfidential segwit address: v0 P2WPKH
/// (bech32) or v1 Taproot such as an Instant lockbox (bech32m). Anything else
/// is rendered as `script:<hex>`.
pub fn script_address(script: &Script, hrp: &str) -> String {
    use elements::bitcoin::bech32::{segwit, Hrp};
    let encoded = Hrp::parse(hrp).ok().and_then(|hrp| {
        if script.is_v0_p2wpkh() {
            segwit::encode(hrp, segwit::VERSION_0, &script.as_bytes()[2..]).ok()
        } else if script.is_v1_p2tr() {
            segwit::encode(hrp, segwit::VERSION_1, &script.as_bytes()[2..]).ok()
        } else {
            None
        }
    });
    encoded.unwrap_or_else(|| format!("script:{}", hex::encode(script.as_bytes())))
}

/// Parse an unconfidential P2WPKH (bech32) or Taproot (bech32m) address of
/// any HRP into its script (used for lookups).
pub fn script_from_address(address: &str) -> Result<Script, OfferError> {
    use elements::bitcoin::bech32::segwit;
    if address.len() > 120 || address != address.to_ascii_lowercase() {
        return fail(
            "invalid_address",
            "address must be canonical lowercase bech32",
        );
    }
    let (_, version, program) = segwit::decode(address)
        .map_err(|_| OfferError::new("invalid_address", "invalid bech32 address"))?;
    let prefix = match (version, program.len()) {
        (segwit::VERSION_0, 20) => [0x00, 0x14],
        (segwit::VERSION_1, 32) => [0x51, 0x20],
        _ => {
            return fail(
                "invalid_address",
                "only unconfidential P2WPKH or Taproot addresses are supported",
            )
        }
    };
    let mut bytes = prefix.to_vec();
    bytes.extend(program);
    Ok(Script::from(bytes))
}

fn explicit_output(output: &TxOut, what: &str) -> Result<(AssetId, u64), OfferError> {
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

/// Step 1: everything that can be checked without the funding transaction.
pub fn parse_offer(offer: &Offer, network: &Network) -> Result<ParsedOffer, OfferError> {
    if offer.version != OFFER_VERSION {
        return fail(
            "unsupported_version",
            format!("unsupported offer version {}", offer.version),
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
    let give_asset =
        parse_asset_id(&offer.give.asset_id).map_err(|e| OfferError::new("invalid_offer", e))?;
    let want_asset =
        parse_asset_id(&offer.want.asset_id).map_err(|e| OfferError::new("invalid_offer", e))?;
    let give_amount =
        parse_amount(&offer.give.amount).map_err(|e| OfferError::new("invalid_offer", e))?;
    let want_amount =
        parse_amount(&offer.want.amount).map_err(|e| OfferError::new("invalid_offer", e))?;

    let bytes = decode_hex(&offer.tx, MAX_OFFER_TX_BYTES, "offer tx")
        .map_err(|e| OfferError::new("invalid_offer", e))?;
    let tx: Transaction = deserialize(&bytes)
        .map_err(|_| OfferError::new("invalid_offer", "offer tx is not a valid transaction"))?;
    if tx.input.len() != 1 || tx.output.len() != 1 {
        return fail(
            "invalid_offer",
            "offer tx must have exactly one input and one output",
        );
    }
    let input = &tx.input[0];
    if input.is_pegin() || input.has_issuance() {
        return fail(
            "invalid_offer",
            "offer input must not be a peg-in or issuance",
        );
    }
    if !input.script_sig.is_empty() {
        return fail("invalid_offer", "offer input must have an empty scriptSig");
    }
    if input.witness.amount_rangeproof.is_some()
        || input.witness.inflation_keys_rangeproof.is_some()
        || !input.witness.pegin_witness.is_empty()
    {
        return fail(
            "invalid_offer",
            "offer input witness must only contain the script witness",
        );
    }
    if input.witness.script_witness.len() != 2 {
        return fail(
            "invalid_offer",
            "offer input witness must be [signature, pubkey]",
        );
    }
    let maker_output = tx.output[0].clone();
    let (out_asset, out_value) = explicit_output(&maker_output, "offer output")?;
    if !maker_output.script_pubkey.is_v0_p2wpkh() {
        return fail(
            "unsupported_script",
            "offer output must pay an explicit P2WPKH script",
        );
    }
    if out_asset != want_asset || out_value != want_amount {
        return fail(
            "offer_mismatch",
            "offer `want` does not match the offer output",
        );
    }
    if give_asset == want_asset {
        return fail("invalid_offer", "offer must swap two different assets");
    }
    let outpoint = input.previous_output;
    Ok(ParsedOffer {
        tx,
        outpoint,
        give_asset,
        give_amount,
        want_asset,
        want_amount,
        maker_output,
    })
}

/// Step 2: bind the offer to its funding output and verify the signature.
pub fn verify_offer(
    parsed: &ParsedOffer,
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
            "funding tx does not hash to the offered input's txid",
        );
    }
    let Some(prevout) = prev_tx.output.get(parsed.outpoint.vout as usize) else {
        return fail(
            "prevout_mismatch",
            "offered output index does not exist in the funding tx",
        );
    };
    let (asset, value) = explicit_output(prevout, "offered output")?;
    if !prevout.script_pubkey.is_v0_p2wpkh() {
        return fail(
            "unsupported_script",
            "offered output must be an explicit P2WPKH output",
        );
    }
    if asset != parsed.give_asset || value != parsed.give_amount {
        return fail(
            "offer_mismatch",
            "offer `give` does not match the offered output",
        );
    }

    let witness = &parsed.tx.input[0].witness.script_witness;
    let (sig_bytes, pubkey_bytes) = (&witness[0], &witness[1]);
    let Some((&hash_type, der)) = sig_bytes.split_last() else {
        return fail("bad_signature", "empty signature");
    };
    if hash_type != SIGHASH_SINGLE_ANYONECANPAY {
        return fail(
            "wrong_sighash",
            format!("signature hash type must be SINGLE|ANYONECANPAY (0x83), got {hash_type:#04x}"),
        );
    }
    let signature = ecdsa::Signature::from_der(der)
        .map_err(|_| OfferError::new("bad_signature", "signature is not valid DER"))?;
    if signature.serialize_der().as_ref() != der {
        return fail("bad_signature", "signature is not strict DER");
    }
    let mut normalized = signature;
    normalized.normalize_s();
    if normalized != signature {
        return fail("bad_signature", "signature must use low-S form");
    }
    if pubkey_bytes.len() != 33 {
        return fail("bad_signature", "public key must be compressed");
    }
    let pubkey = PublicKey::from_slice(pubkey_bytes)
        .map_err(|_| OfferError::new("bad_signature", "invalid public key"))?;
    let pubkey_hash = hash160::Hash::hash(pubkey_bytes);
    if prevout.script_pubkey.as_bytes()[2..] != pubkey_hash.to_byte_array()[..] {
        return fail(
            "bad_signature",
            "public key does not match the offered output's script",
        );
    }

    let script_code = Script::new_p2pkh(&PubkeyHash::from_raw_hash(pubkey_hash));
    let sighash = SighashCache::new(&parsed.tx).segwitv0_sighash(
        0,
        &script_code,
        prevout.value,
        EcdsaSighashType::SinglePlusAnyoneCanPay,
    );
    let message = Message::from_digest(sighash.to_byte_array());
    Secp256k1::verification_only()
        .verify_ecdsa(&message, &signature, &pubkey)
        .map_err(|_| OfferError::new("bad_signature", "signature does not verify"))?;

    Ok(DecodedOffer {
        give_asset: parsed.give_asset,
        give_amount: parsed.give_amount,
        want_asset: parsed.want_asset,
        want_amount: parsed.want_amount,
        outpoint: parsed.outpoint,
        maker_address: p2wpkh_address(&parsed.maker_output.script_pubkey, &network.address_hrp)?,
        maker_script: parsed.maker_output.script_pubkey.clone(),
        funding_script: prevout.script_pubkey.clone(),
    })
}

/// `decode_offer(offer_json, prevout_raw_tx_hex)` from SPEC §1.2.
pub fn decode_offer(
    offer: &Offer,
    prevout_raw_tx_hex: &str,
    network: &Network,
) -> Result<DecodedOffer, OfferError> {
    verify_offer(&parse_offer(offer, network)?, prevout_raw_tx_hex, network)
}

/// True if `spend` pays exactly the maker's output at the index of the input
/// spending `outpoint` — i.e. the offer was taken rather than cancelled.
pub fn spend_fills_offer(
    spend: &Transaction,
    vin: usize,
    outpoint: &OutPoint,
    maker: &TxOut,
) -> bool {
    let input_matches = spend
        .input
        .get(vin)
        .is_some_and(|input| input.previous_output == *outpoint);
    let output_matches = spend.output.get(vin).is_some_and(|output| {
        output.asset == maker.asset
            && output.value == maker.value
            && output.nonce == maker.nonce
            && output.script_pubkey == maker.script_pubkey
    });
    input_matches && output_matches
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;

    fn setup() -> (Network, Fixture) {
        let network = test_network();
        let fixture = Fixture::new(&network, 1_000, 5_000);
        (network, fixture)
    }

    #[test]
    fn valid_offer_decodes() {
        let (network, fixture) = setup();
        let decoded = decode_offer(&fixture.offer, &fixture.prevout_hex, &network).unwrap();
        assert_eq!(decoded.give_asset, fixture.give_asset);
        assert_eq!(decoded.give_amount, 1_000);
        assert_eq!(decoded.want_asset, network.policy_asset);
        assert_eq!(decoded.want_amount, 5_000);
        assert_eq!(decoded.outpoint, fixture.outpoint());
        assert!(decoded.maker_address.starts_with("ert1q"));
        assert_eq!(
            script_from_address(&decoded.maker_address).unwrap(),
            decoded.maker_script
        );
        let taproot = Script::from([[0x51, 0x20].as_slice(), &[7u8; 32]].concat());
        let address = script_address(&taproot, "ert");
        assert!(address.starts_with("ert1p"), "{address}");
        assert_eq!(script_from_address(&address).unwrap(), taproot);
        assert!(script_address(&Script::new(), "ert").starts_with("script:"));
    }

    #[test]
    fn wrong_sighash_type_is_rejected() {
        let (network, fixture) = setup();
        let offer = fixture.build_offer(OfferTweaks {
            sighash: EcdsaSighashType::All,
            ..Default::default()
        });
        let error = decode_offer(&offer, &fixture.prevout_hex, &network).unwrap_err();
        assert!(error.message.contains("0x83"), "{error}");
        assert_eq!(error.code, "wrong_sighash");
    }

    #[test]
    fn appended_0x83_over_sighash_all_signature_is_rejected() {
        let (network, fixture) = setup();
        let offer = fixture.build_offer(OfferTweaks {
            sighash: EcdsaSighashType::All,
            hash_type_byte: Some(0x83),
            ..Default::default()
        });
        let error = decode_offer(&offer, &fixture.prevout_hex, &network).unwrap_err();
        assert_eq!(error.message, "signature does not verify");
        assert_eq!(error.code, "bad_signature");
    }

    #[test]
    fn bad_signature_is_rejected() {
        let (network, fixture) = setup();
        let offer = fixture.build_offer(OfferTweaks {
            wrong_key: true,
            ..Default::default()
        });
        // Wrong key signs and is placed in the witness: hash160 mismatch.
        let error = decode_offer(&offer, &fixture.prevout_hex, &network).unwrap_err();
        assert!(error.message.contains("does not match"), "{error}");
        assert_eq!(error.code, "bad_signature");

        let offer = fixture.build_offer(OfferTweaks {
            corrupt_signature: true,
            ..Default::default()
        });
        let error = decode_offer(&offer, &fixture.prevout_hex, &network).unwrap_err();
        assert_eq!(error.message, "signature does not verify");
        assert_eq!(error.code, "bad_signature");
    }

    #[test]
    fn mismatched_convenience_fields_are_rejected() {
        let (network, fixture) = setup();
        let mut offer = fixture.offer.clone();
        offer.give.amount = "999".into();
        let error = decode_offer(&offer, &fixture.prevout_hex, &network).unwrap_err();
        assert!(error.message.contains("`give`"), "{error}");
        assert_eq!(error.code, "offer_mismatch");

        let mut offer = fixture.offer.clone();
        offer.want.amount = "5001".into();
        let error = decode_offer(&offer, &fixture.prevout_hex, &network).unwrap_err();
        assert!(error.message.contains("`want`"), "{error}");
        assert_eq!(error.code, "offer_mismatch");

        let mut offer = fixture.offer.clone();
        offer.give.asset_id = network.policy_asset.to_string();
        assert!(decode_offer(&offer, &fixture.prevout_hex, &network).is_err());
    }

    #[test]
    fn prevout_txid_mismatch_is_rejected() {
        let (network, fixture) = setup();
        let other = Fixture::new(&network, 1_000, 5_000).with_seed(9);
        let error = decode_offer(&fixture.offer, &other.prevout_hex, &network).unwrap_err();
        assert!(error.message.contains("does not hash"), "{error}");
        assert_eq!(error.code, "prevout_mismatch");
    }

    #[test]
    fn confidential_output_is_rejected() {
        let (network, fixture) = setup();
        let offer = fixture.build_offer(OfferTweaks {
            confidential_nonce: true,
            ..Default::default()
        });
        let error = decode_offer(&offer, &fixture.prevout_hex, &network).unwrap_err();
        assert!(error.message.contains("null nonce"), "{error}");
        assert_eq!(error.code, "confidential_output");

        let offer = fixture.build_offer(OfferTweaks {
            confidential_value: true,
            ..Default::default()
        });
        let error = decode_offer(&offer, &fixture.prevout_hex, &network).unwrap_err();
        assert!(error.message.contains("explicit"), "{error}");
        assert_eq!(error.code, "confidential_output");
    }

    #[test]
    fn wrong_network_is_rejected() {
        let (network, fixture) = setup();
        let mut offer = fixture.offer.clone();
        offer.network = "liquidv1".into();
        assert!(decode_offer(&offer, &fixture.prevout_hex, &network).is_err());
        let mut offer = fixture.offer.clone();
        offer.genesis_hash = "00".repeat(32);
        assert!(decode_offer(&offer, &fixture.prevout_hex, &network).is_err());
    }

    #[test]
    fn structural_limits() {
        let (network, fixture) = setup();
        let offer = fixture.build_offer(OfferTweaks {
            extra_output: true,
            ..Default::default()
        });
        let error = decode_offer(&offer, &fixture.prevout_hex, &network).unwrap_err();
        assert!(error.message.contains("exactly one"), "{error}");
        assert_eq!(error.code, "invalid_offer");

        let mut offer = fixture.offer.clone();
        offer.tx = "00".repeat(MAX_OFFER_TX_BYTES + 1);
        assert!(decode_offer(&offer, &fixture.prevout_hex, &network).is_err());
    }

    #[test]
    fn fill_detection() {
        let (network, fixture) = setup();
        let parsed = parse_offer(&fixture.offer, &network).unwrap();
        let take = fixture.taker_tx(true);
        assert!(spend_fills_offer(
            &take,
            0,
            &parsed.outpoint,
            &parsed.maker_output
        ));
        let cancel = fixture.taker_tx(false);
        assert!(!spend_fills_offer(
            &cancel,
            0,
            &parsed.outpoint,
            &parsed.maker_output
        ));
    }
}
