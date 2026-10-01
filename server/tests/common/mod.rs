//! Test fixtures: builds signed swap offers and issuance transactions with the
//! `elements` crate and throwaway keys. Shared by unit tests (via `#[path]`)
//! and the integration test. Never compiled into the server binary.
#![allow(dead_code)]

use std::str::FromStr;

use elements::confidential::{Asset, AssetBlindingFactor, Nonce, Value, ValueBlindingFactor};
use elements::encode::serialize;
use elements::hashes::{hash160, Hash};
use elements::secp256k1_zkp::{Message, PublicKey, Secp256k1, SecretKey};
use elements::sighash::SighashCache;
use elements::{
    AssetId, AssetIssuance, BlockHash, ContractHash, EcdsaSighashType, LockTime, OutPoint,
    PubkeyHash, Script, Sequence, Transaction, TxIn, TxInWitness, TxOut, TxOutWitness, Txid,
    WPubkeyHash,
};

use super::{Network, Offer, OfferLeg};

pub const TEST_GENESIS: &str = "11a6f2a6b33e3e1ab1a8a4d7f0a1c4f7fd6e4dd4cfd1c6c19ff26bd8f1d2a3b4";
pub const TEST_POLICY: &str = "5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225";

pub fn test_network() -> Network {
    Network {
        name: "ecx-alpha".into(),
        genesis_hash: BlockHash::from_str(TEST_GENESIS).unwrap(),
        policy_asset: AssetId::from_str(TEST_POLICY).unwrap(),
        address_hrp: "ert".into(),
    }
}

pub fn asset(byte: u8) -> AssetId {
    AssetId::from_byte_array([byte; 32])
}

fn key(seed: u8, salt: u8) -> SecretKey {
    let mut bytes = [0x5au8; 32];
    bytes[0] = seed;
    bytes[1] = salt;
    SecretKey::from_slice(&bytes).unwrap()
}

pub fn p2wpkh(public: &PublicKey) -> Script {
    Script::new_v0_wpkh(&WPubkeyHash::hash(&public.serialize()))
}

pub fn explicit(asset: AssetId, value: u64, script: Script) -> TxOut {
    TxOut {
        asset: Asset::Explicit(asset),
        value: Value::Explicit(value),
        nonce: Nonce::Null,
        script_pubkey: script,
        witness: TxOutWitness::default(),
    }
}

pub fn input(previous_output: OutPoint) -> TxIn {
    TxIn {
        previous_output,
        is_pegin: false,
        script_sig: Script::new(),
        sequence: Sequence::MAX,
        asset_issuance: AssetIssuance::null(),
        witness: TxInWitness::default(),
    }
}

pub fn tx_hex(tx: &Transaction) -> String {
    hex::encode(serialize(tx))
}

#[derive(Clone, Copy, Debug)]
pub struct OfferTweaks {
    pub sighash: EcdsaSighashType,
    /// Override the trailing hash-type byte (signature still made with `sighash`).
    pub hash_type_byte: Option<u8>,
    pub wrong_key: bool,
    pub corrupt_signature: bool,
    pub confidential_nonce: bool,
    pub confidential_value: bool,
    pub extra_output: bool,
}

impl Default for OfferTweaks {
    fn default() -> Self {
        Self {
            sighash: EcdsaSighashType::SinglePlusAnyoneCanPay,
            hash_type_byte: None,
            wrong_key: false,
            corrupt_signature: false,
            confidential_nonce: false,
            confidential_value: false,
            extra_output: false,
        }
    }
}

/// A maker with one funding UTXO (at vout 1 of `funding_tx`) and a signed offer.
#[derive(Clone)]
pub struct Fixture {
    pub network: Network,
    pub seed: u8,
    pub give_asset: AssetId,
    pub give_amount: u64,
    pub want_asset: AssetId,
    pub want_amount: u64,
    pub funding_tx: Transaction,
    pub prevout_hex: String,
    pub offer: Offer,
}

impl Fixture {
    /// Ask on the `asset(0x11)`/policy market: give base, want policy.
    pub fn new(network: &Network, give_amount: u64, want_amount: u64) -> Self {
        Self::general(
            network,
            1,
            asset(0x11),
            give_amount,
            network.policy_asset,
            want_amount,
        )
    }

    pub fn general(
        network: &Network,
        seed: u8,
        give_asset: AssetId,
        give_amount: u64,
        want_asset: AssetId,
        want_amount: u64,
    ) -> Self {
        let secp = Secp256k1::new();
        let maker = PublicKey::from_secret_key(&secp, &key(seed, 0));
        let funding_tx = Transaction {
            version: 2,
            lock_time: LockTime::ZERO,
            input: vec![input(OutPoint::new(Txid::from_byte_array([seed; 32]), 0))],
            output: vec![
                explicit(network.policy_asset, 777, p2wpkh(&maker)),
                explicit(give_asset, give_amount, p2wpkh(&maker)),
                explicit(network.policy_asset, 100, Script::new()),
            ],
        };
        let mut fixture = Self {
            network: network.clone(),
            seed,
            give_asset,
            give_amount,
            want_asset,
            want_amount,
            prevout_hex: tx_hex(&funding_tx),
            funding_tx,
            offer: Offer {
                version: 1,
                network: String::new(),
                genesis_hash: String::new(),
                tx: String::new(),
                give: OfferLeg {
                    asset_id: String::new(),
                    amount: String::new(),
                },
                want: OfferLeg {
                    asset_id: String::new(),
                    amount: String::new(),
                },
            },
        };
        fixture.offer = fixture.build_offer(OfferTweaks::default());
        fixture
    }

    /// Same assets/amounts, different keys and funding tx.
    pub fn with_seed(self, seed: u8) -> Self {
        Self::general(
            &self.network,
            seed,
            self.give_asset,
            self.give_amount,
            self.want_asset,
            self.want_amount,
        )
    }

    pub fn funding_txid(&self) -> Txid {
        self.funding_tx.txid()
    }

    pub fn outpoint(&self) -> OutPoint {
        OutPoint::new(self.funding_txid(), 1)
    }

    fn maker_secret(&self) -> SecretKey {
        key(self.seed, 0)
    }

    pub fn maker_receive_script(&self) -> Script {
        let secp = Secp256k1::new();
        p2wpkh(&PublicKey::from_secret_key(&secp, &key(self.seed, 1)))
    }

    pub fn maker_output(&self) -> TxOut {
        explicit(
            self.want_asset,
            self.want_amount,
            self.maker_receive_script(),
        )
    }

    pub fn build_offer(&self, tweaks: OfferTweaks) -> Offer {
        let secp = Secp256k1::new();
        let mut output = self.maker_output();
        if tweaks.confidential_nonce {
            output.nonce = Nonce::Confidential(PublicKey::from_secret_key(&secp, &key(99, 9)));
        }
        if tweaks.confidential_value {
            output.value = Value::new_confidential_from_assetid(
                &secp,
                self.want_amount,
                self.want_asset,
                ValueBlindingFactor::from_slice(&[7u8; 32]).unwrap(),
                AssetBlindingFactor::from_slice(&[3u8; 32]).unwrap(),
            );
        }
        let mut outputs = vec![output];
        if tweaks.extra_output {
            outputs.push(explicit(self.give_asset, 1, self.maker_receive_script()));
        }
        let mut tx = Transaction {
            version: 2,
            lock_time: LockTime::ZERO,
            input: vec![input(self.outpoint())],
            output: outputs,
        };
        let secret = if tweaks.wrong_key {
            key(self.seed, 7)
        } else {
            self.maker_secret()
        };
        let public = PublicKey::from_secret_key(&secp, &secret);
        let script_code = Script::new_p2pkh(&PubkeyHash::from_raw_hash(hash160::Hash::hash(
            &public.serialize(),
        )));
        let sighash = SighashCache::new(&tx).segwitv0_sighash(
            0,
            &script_code,
            Value::Explicit(self.give_amount),
            tweaks.sighash,
        );
        let digest = if tweaks.corrupt_signature {
            [0x42; 32]
        } else {
            sighash.to_byte_array()
        };
        let signature = secp.sign_ecdsa(&Message::from_digest(digest), &secret);
        let mut sig = signature.serialize_der().to_vec();
        sig.push(tweaks.hash_type_byte.unwrap_or(tweaks.sighash as u8));
        tx.input[0].witness.script_witness = vec![sig, public.serialize().to_vec()];
        Offer {
            version: 1,
            network: self.network.name.clone(),
            genesis_hash: self.network.genesis_hash.to_string(),
            tx: tx_hex(&tx),
            give: OfferLeg {
                asset_id: self.give_asset.to_string(),
                amount: self.give_amount.to_string(),
            },
            want: OfferLeg {
                asset_id: self.want_asset.to_string(),
                amount: self.want_amount.to_string(),
            },
        }
    }

    /// A transaction spending the offered outpoint at input 0. `fill` pays the
    /// maker output at index 0 (a take); otherwise funds go elsewhere (cancel).
    pub fn taker_tx(&self, fill: bool) -> Transaction {
        let secp = Secp256k1::new();
        let taker = p2wpkh(&PublicKey::from_secret_key(&secp, &key(200, self.seed)));
        let first = if fill {
            self.maker_output()
        } else {
            explicit(
                self.give_asset,
                self.give_amount,
                self.maker_receive_script(),
            )
        };
        Transaction {
            version: 2,
            lock_time: LockTime::ZERO,
            input: vec![
                input(self.outpoint()),
                input(OutPoint::new(
                    Txid::from_byte_array([200; 32]),
                    self.seed as u32,
                )),
            ],
            output: vec![
                first,
                explicit(self.give_asset, self.give_amount, taker),
                explicit(self.network.policy_asset, 50, Script::new()),
            ],
        }
    }
}

/// Canonical contract JSON + an issuance transaction committing to it at `vin`.
pub struct IssuanceFixture {
    pub contract: serde_json::Value,
    pub tx: Transaction,
    pub vin: u32,
    pub with_token: bool,
}

impl IssuanceFixture {
    pub fn new(contract: serde_json::Value, with_token: bool) -> Self {
        let canonical = serde_json::to_string(&contract).unwrap();
        let contract_hash = ContractHash::from_json_contract(&canonical).unwrap();
        let mut issuing = input(OutPoint::new(Txid::from_byte_array([0x33; 32]), 2));
        issuing.asset_issuance = AssetIssuance {
            asset_blinding_nonce: elements::secp256k1_zkp::ZERO_TWEAK,
            asset_entropy: contract_hash.to_byte_array(),
            amount: Value::Explicit(21_000_000),
            inflation_keys: if with_token {
                Value::Explicit(1)
            } else {
                Value::Null
            },
        };
        let tx = Transaction {
            version: 2,
            lock_time: LockTime::ZERO,
            input: vec![
                input(OutPoint::new(Txid::from_byte_array([0x44; 32]), 0)),
                issuing,
            ],
            output: vec![explicit(asset(0x01), 1, Script::new())],
        };
        Self {
            contract,
            tx,
            vin: 1,
            with_token,
        }
    }

    pub fn issuing_outpoint(&self) -> OutPoint {
        self.tx.input[self.vin as usize].previous_output
    }
}

pub fn sample_contract() -> serde_json::Value {
    serde_json::json!({
        "name": "Test Coin",
        "ticker": "TST",
        "precision": 2,
        "version": 0
    })
}
