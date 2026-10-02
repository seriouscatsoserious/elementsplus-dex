//! Hand-written OpenAPI 3.1 document and `/llms.txt` (SPEC §6.1). A test
//! asserts that every routed path/method in `api::ROUTES` is described here.

use serde_json::{json, Value};

use crate::config::Network;

const ASSET: &str = "5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225";
const POLICY: &str = "62dce3bd80dc4b0503e7ccbb3fcfa4d7adfd64b4e0cc78fa5e1754b88f1d2da4";
const TXID: &str = "b87cf1c9a3ecf831d8b488ab97671d795e51b8c4642705cb4490bf49bb3a63f4";
const GENESIS: &str = "672af009bd90bfc6527a5a9dda4c83aba0048c15cff3697d07e89a7f96fa5bcd";

fn schema_ref(name: &str) -> Value {
    json!({ "$ref": format!("#/components/schemas/{name}") })
}

fn json_content(schema: Value, example: Value) -> Value {
    json!({ "application/json": { "schema": schema, "example": example } })
}

fn ok(description: &str, schema: Value, example: Value) -> Value {
    json!({ "description": description, "content": json_content(schema, example) })
}

fn error_response(description: &str, code: &str, message: &str) -> Value {
    ok(
        description,
        schema_ref("Error"),
        json!({ "error": { "code": code, "message": message } }),
    )
}

fn page_of(item: &str) -> Value {
    json!({
        "type": "object",
        "required": ["items", "next_cursor"],
        "properties": {
            "items": { "type": "array", "items": schema_ref(item) },
            "next_cursor": { "type": ["string", "null"], "description": "Pass as `cursor` to fetch the next page; null when exhausted." }
        }
    })
}

fn param_ref(name: &str) -> Value {
    json!({ "$ref": format!("#/components/parameters/{name}") })
}

fn example_offer() -> Value {
    json!({
        "version": 1,
        "network": "ecx-beta",
        "genesis_hash": GENESIS,
        "tx": "020000000101f4633a…(hex)…",
        "give": { "asset_id": ASSET, "amount": "1000000000" },
        "want": { "asset_id": POLICY, "amount": "50000000" }
    })
}

fn example_offer_entry() -> Value {
    let offer = example_offer();
    let mut entry = offer.clone();
    let extra = json!({
        "offer": offer,
        "id": 7,
        "outpoint": format!("{TXID}:2"),
        "txid": TXID,
        "vout": 2,
        "maker_address": "elements1qn04gjfjfcdr2ekpurzadgu46uqvk6wrrq7x0kl",
        "base": ASSET,
        "quote": POLICY,
        "side": "ask",
        "base_amount": "1000000000",
        "quote_amount": "50000000",
        "price": 0.05,
        "price_num": "1",
        "price_den": "20",
        "status": "open",
        "created_at": 1790891139,
        "closed_at": null,
        "spend_txid": null
    });
    for (key, value) in extra.as_object().expect("object").clone() {
        entry[key] = value;
    }
    entry
}

fn example_asset() -> Value {
    json!({
        "asset_id": ASSET,
        "token_id": "ec847bf729bc903e0bfe81b02f5bffc55ca212a427280429bc08d3a720a1ea5f",
        "contract": { "name": "Smoke Coin", "precision": 2, "ticker": "SMK", "version": 0 },
        "contract_hash": "f9276ccee6f34ec4ad9c931bfc8e2d0dd6f1a8577b94b5596d35141a6974e88e",
        "issuance_txid": "ff03b9ca50a98449a306d0986e5a07ce8940748ec583c19f7bdcefaf958f3dd0",
        "issuance_vin": 0,
        "icon_url": null,
        "created_at": 1790891116
    })
}

fn example_trade() -> Value {
    json!({
        "txid": "a893ef2de6751d03ccb4a844b9999f3d5709e3695f2911d9e82ca0e9ff6fe0df",
        "price": 0.05, "price_num": "1", "price_den": "20",
        "base_amount": "1000000000", "quote_amount": "50000000",
        "time": 1790891161, "maker_side": "ask", "confirmed": true
    })
}

fn schemas() -> Value {
    let hex32 = json!({ "type": "string", "pattern": "^[0-9a-f]{64}$" });
    let amount = json!({ "type": "string", "pattern": "^(0|[1-9][0-9]{0,19})$", "description": "Atomic units as a decimal string." });
    json!({
        "Hex32": hex32,
        "Amount": amount,
        "Error": {
            "type": "object",
            "required": ["error"],
            "properties": {
                "error": {
                    "type": "object",
                    "required": ["code", "message"],
                    "properties": {
                        "code": { "type": "string", "description": "Stable snake_case code, e.g. offer_spent, bad_signature, wrong_sighash, offer_mismatch, prevout_mismatch, prevout_not_found, duplicate_offer, confidential_output, unsupported_script, wrong_network, invalid_offer, unknown_asset, contract_mismatch, invalid_contract, invalid_issuance, issuance_not_found, offer_not_found, non_canonical_market, same_asset, invalid_asset_id, invalid_txid, invalid_address, invalid_amount, invalid_side, invalid_interval, invalid_limit, invalid_cursor, invalid_request, invalid_idempotency_key, idempotency_key_reused, payload_too_large, route_not_found, method_not_allowed, upstream_error, internal_error." },
                        "message": { "type": "string" }
                    }
                }
            }
        },
        "OfferLeg": {
            "type": "object",
            "required": ["asset_id", "amount"],
            "properties": { "asset_id": schema_ref("Hex32"), "amount": schema_ref("Amount") }
        },
        "Offer": {
            "type": "object",
            "description": "SPEC §2 swap offer: a 1-input/1-output explicit Elements tx signed SIGHASH_SINGLE|ANYONECANPAY (0x83). give/want are convenience copies re-derived and checked by the server.",
            "required": ["version", "network", "genesis_hash", "tx", "give", "want"],
            "properties": {
                "version": { "type": "integer", "const": 1 },
                "network": { "type": "string" },
                "genesis_hash": schema_ref("Hex32"),
                "tx": { "type": "string", "pattern": "^[0-9a-fA-F]+$", "maxLength": 8192 },
                "give": schema_ref("OfferLeg"),
                "want": schema_ref("OfferLeg")
            },
            "example": example_offer()
        },
        "OfferEntry": {
            "description": "A listed offer: the Offer fields at top level (and again under `offer`, ready to hand to the wallet) plus book metadata. Prices are quote atomic per base atomic.",
            "allOf": [
                schema_ref("Offer"),
                {
                    "type": "object",
                    "properties": {
                        "offer": schema_ref("Offer"),
                        "id": { "type": "integer" },
                        "outpoint": { "type": "string", "description": "txid:vout of the offered UTXO" },
                        "txid": schema_ref("Hex32"),
                        "vout": { "type": "integer" },
                        "maker_address": { "type": "string" },
                        "base": schema_ref("Hex32"),
                        "quote": schema_ref("Hex32"),
                        "side": { "type": "string", "enum": ["bid", "ask"] },
                        "base_amount": schema_ref("Amount"),
                        "quote_amount": schema_ref("Amount"),
                        "price": { "type": "number" },
                        "price_num": schema_ref("Amount"),
                        "price_den": schema_ref("Amount"),
                        "status": { "type": "string", "enum": ["open", "filled", "cancelled"] },
                        "created_at": { "type": "integer" },
                        "closed_at": { "type": ["integer", "null"] },
                        "spend_txid": { "type": ["string", "null"] }
                    }
                }
            ],
            "example": example_offer_entry()
        },
        "Asset": {
            "type": "object",
            "properties": {
                "asset_id": schema_ref("Hex32"),
                "token_id": { "type": ["string", "null"] },
                "contract": {
                    "type": "object",
                    "required": ["name", "ticker", "precision", "version"],
                    "properties": {
                        "name": { "type": "string", "minLength": 1, "maxLength": 255 },
                        "ticker": { "type": "string", "pattern": "^[A-Za-z0-9.\\-]{3,24}$" },
                        "precision": { "type": "integer", "minimum": 0, "maximum": 8 },
                        "version": { "type": "integer", "const": 0 },
                        "issuer_pubkey": { "type": "string", "pattern": "^0[23][0-9a-f]{64}$" }
                    },
                    "additionalProperties": false
                },
                "contract_hash": schema_ref("Hex32"),
                "issuance_txid": schema_ref("Hex32"),
                "issuance_vin": { "type": "integer" },
                "icon_url": { "type": ["string", "null"] },
                "created_at": { "type": "integer" }
            },
            "example": example_asset()
        },
        "Market": {
            "type": "object",
            "properties": {
                "base": schema_ref("Hex32"),
                "quote": schema_ref("Hex32"),
                "last_price": { "type": ["number", "null"] },
                "change_24h": { "type": ["number", "null"], "description": "Fraction, 0.05 = +5 %." },
                "volume_24h": { "allOf": [schema_ref("Amount")], "description": "Quote atomic units." },
                "base_volume_24h": schema_ref("Amount"),
                "trades_24h": { "type": "integer" },
                "best_bid": { "type": ["number", "null"] },
                "best_ask": { "type": ["number", "null"] },
                "bids": { "type": "integer" },
                "asks": { "type": "integer" }
            }
        },
        "Book": {
            "type": "object",
            "properties": {
                "base": schema_ref("Hex32"),
                "quote": schema_ref("Hex32"),
                "bids": { "type": "array", "items": schema_ref("OfferEntry"), "description": "Highest price first." },
                "asks": { "type": "array", "items": schema_ref("OfferEntry"), "description": "Lowest price first." }
            }
        },
        "Trade": {
            "type": "object",
            "properties": {
                "txid": schema_ref("Hex32"),
                "price": { "type": "number" },
                "price_num": schema_ref("Amount"),
                "price_den": schema_ref("Amount"),
                "base_amount": schema_ref("Amount"),
                "quote_amount": schema_ref("Amount"),
                "time": { "type": "integer", "description": "Block time, or detection time while unconfirmed." },
                "maker_side": { "type": "string", "enum": ["bid", "ask"] },
                "confirmed": { "type": "boolean" }
            },
            "example": example_trade()
        },
        "Candle": {
            "type": "object",
            "properties": {
                "time": { "type": "integer", "description": "Bucket start (unix seconds)." },
                "open": { "type": "number" }, "high": { "type": "number" },
                "low": { "type": "number" }, "close": { "type": "number" },
                "volume": { "allOf": [schema_ref("Amount")], "description": "Base atomic units." },
                "quote_volume": schema_ref("Amount"),
                "trades": { "type": "integer" }
            }
        },
        "Quote": {
            "type": "object",
            "properties": {
                "side": { "type": "string", "enum": ["exact_in", "exact_out"] },
                "sell_asset": schema_ref("Hex32"),
                "buy_asset": schema_ref("Hex32"),
                "amount": schema_ref("Amount"),
                "base": schema_ref("Hex32"),
                "quote": schema_ref("Hex32"),
                "offers": { "type": "array", "items": schema_ref("OfferEntry"), "description": "Whole offers to take, best first. Pass each entry's `offer` to ep_takeSwapOffers." },
                "sell_amount": schema_ref("Amount"),
                "buy_amount": schema_ref("Amount"),
                "price": { "type": ["number", "null"], "description": "Average price, quote atomic per base atomic." },
                "price_impact_bps": { "type": ["integer", "null"], "description": "Average cost vs. the best offer in the book." },
                "unfilled": { "allOf": [schema_ref("Amount")], "description": "Part of `amount` not matched by whole offers." }
            }
        },
        "Health": {
            "type": "object",
            "properties": {
                "ok": { "type": "boolean" },
                "tip": { "type": ["integer", "null"] },
                "network": { "type": "string" },
                "genesis_hash": schema_ref("Hex32"),
                "policy_asset": schema_ref("Hex32")
            }
        }
    })
}

fn parameters() -> Value {
    json!({
        "Limit": { "name": "limit", "in": "query", "required": false, "schema": { "type": "integer", "minimum": 1, "maximum": 500, "default": 100 } },
        "Cursor": { "name": "cursor", "in": "query", "required": false, "schema": { "type": "string" }, "description": "Opaque `next_cursor` from the previous page." },
        "Base": { "name": "base", "in": "path", "required": true, "schema": schema_ref("Hex32"), "example": ASSET },
        "Quote": { "name": "quote", "in": "path", "required": true, "schema": schema_ref("Hex32"), "example": POLICY, "description": "The policy asset unless both assets are non-native (then lexicographic order)." },
        "IdempotencyKey": { "name": "Idempotency-Key", "in": "header", "required": false, "schema": { "type": "string", "minLength": 1, "maxLength": 255 }, "description": "Retries with the same key and body within 24 h replay the first successful response (header `Idempotent-Replayed: true`); a different body is rejected with 422 idempotency_key_reused." }
    })
}

fn bad_request() -> Value {
    error_response(
        "Invalid request",
        "invalid_asset_id",
        "asset id must be 64 lowercase hex characters",
    )
}

fn paths() -> Value {
    json!({
        "/api/health": { "get": {
            "operationId": "getHealth",
            "summary": "Liveness, chain tip and chain parameters",
            "responses": {
                "200": ok("Explorer reachable", schema_ref("Health"), json!({ "ok": true, "tip": 102, "network": "ecx-beta", "genesis_hash": GENESIS, "policy_asset": POLICY })),
                "503": ok("Explorer unreachable", schema_ref("Health"), json!({ "ok": false, "tip": null, "network": "ecx-beta", "genesis_hash": GENESIS, "policy_asset": POLICY, "error": { "code": "upstream_error", "message": "block explorer unavailable" } }))
            }
        }},
        "/api/openapi.json": { "get": {
            "operationId": "getOpenApi",
            "summary": "This document",
            "responses": { "200": { "description": "OpenAPI 3.1 document", "content": { "application/json": {} } } }
        }},
        "/llms.txt": { "get": {
            "operationId": "getLlmsTxt",
            "summary": "Plain-text guide for agents",
            "responses": { "200": { "description": "Guide", "content": { "text/plain": { "example": "# Elements+ DEX\n…" } } } }
        }},
        "/api/assets": {
            "get": {
                "operationId": "listAssets",
                "summary": "Verified asset registry, newest first",
                "parameters": [param_ref("Limit"), param_ref("Cursor")],
                "responses": {
                    "200": ok("Page of assets", page_of("Asset"), json!({ "items": [example_asset()], "next_cursor": null })),
                    "400": error_response("Bad pagination", "invalid_cursor", "cursor is malformed or from another endpoint")
                }
            },
            "post": {
                "operationId": "registerAsset",
                "summary": "Register an asset by proving its issuance commits to the contract",
                "description": "Fetches the issuance tx from the explorer, verifies its txid, checks the input at `vin` is a new issuance whose asset_entropy equals SHA256(canonical contract JSON), and derives asset/token ids.",
                "parameters": [param_ref("IdempotencyKey")],
                "requestBody": { "required": true, "content": json_content(
                    json!({ "type": "object", "required": ["issuance_txid", "vin", "contract"], "properties": {
                        "issuance_txid": schema_ref("Hex32"),
                        "vin": { "type": "integer", "minimum": 0 },
                        "contract": { "type": "object" },
                        "icon_url": { "type": "null" }
                    }}),
                    json!({ "issuance_txid": "ff03b9ca50a98449a306d0986e5a07ce8940748ec583c19f7bdcefaf958f3dd0", "vin": 0, "contract": { "name": "Smoke Coin", "ticker": "SMK", "precision": 2, "version": 0 } })
                )},
                "responses": {
                    "201": ok("Registered", schema_ref("Asset"), example_asset()),
                    "200": ok("Already registered", schema_ref("Asset"), example_asset()),
                    "400": error_response("Verification failed", "contract_mismatch", "issuance does not commit to this contract"),
                    "413": error_response("Body too large", "payload_too_large", "request body too large"),
                    "422": error_response("Idempotency key reused", "idempotency_key_reused", "this Idempotency-Key was already used with a different request body"),
                    "502": error_response("Explorer failure", "upstream_error", "the block explorer request failed")
                }
            }
        },
        "/api/assets/{asset_id}": { "get": {
            "operationId": "getAsset",
            "summary": "One registry entry",
            "parameters": [{ "name": "asset_id", "in": "path", "required": true, "schema": schema_ref("Hex32"), "example": ASSET }],
            "responses": {
                "200": ok("Asset", schema_ref("Asset"), example_asset()),
                "400": bad_request(),
                "404": error_response("Not registered", "unknown_asset", "asset is not in the registry")
            }
        }},
        "/api/markets": { "get": {
            "operationId": "listMarkets",
            "summary": "Pairs with at least one open offer or trade",
            "parameters": [param_ref("Limit"), param_ref("Cursor")],
            "responses": {
                "200": ok("Page of markets", page_of("Market"), json!({ "items": [{ "base": ASSET, "quote": POLICY, "last_price": 0.05, "change_24h": 0.0, "volume_24h": "50000000", "base_volume_24h": "1000000000", "trades_24h": 1, "best_bid": 0.04, "best_ask": 0.06, "bids": 1, "asks": 2 }], "next_cursor": null }))
            }
        }},
        "/api/markets/{base}/{quote}/book": { "get": {
            "operationId": "getOrderBook",
            "summary": "Open offers on a market",
            "description": "`limit` applies per side; the book is not cursor-paginated.",
            "parameters": [param_ref("Base"), param_ref("Quote"), param_ref("Limit")],
            "responses": {
                "200": ok("Order book", schema_ref("Book"), json!({ "base": ASSET, "quote": POLICY, "bids": [], "asks": [example_offer_entry()] })),
                "400": error_response("Bad market", "non_canonical_market", "not a canonical market; use /api/markets/{base}/{quote}")
            }
        }},
        "/api/markets/{base}/{quote}/trades": { "get": {
            "operationId": "listTrades",
            "summary": "Fills, newest first",
            "parameters": [param_ref("Base"), param_ref("Quote"), param_ref("Limit"), param_ref("Cursor")],
            "responses": {
                "200": ok("Page of trades", page_of("Trade"), json!({ "items": [example_trade()], "next_cursor": null })),
                "400": bad_request()
            }
        }},
        "/api/markets/{base}/{quote}/candles": { "get": {
            "operationId": "listCandles",
            "summary": "OHLCV buckets from fills, oldest first",
            "description": "Returns the `limit` buckets ending before `cursor` (unix seconds; default: the current bucket). `next_cursor` pages further back when older trades exist. Empty buckets are omitted.",
            "parameters": [
                param_ref("Base"), param_ref("Quote"),
                { "name": "interval", "in": "query", "required": false, "schema": { "type": "string", "enum": ["1m", "5m", "15m", "1h", "4h", "1d", "1w"], "default": "1h" } },
                { "name": "limit", "in": "query", "required": false, "schema": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 300 } },
                param_ref("Cursor")
            ],
            "responses": {
                "200": ok("Page of candles", page_of("Candle"), json!({ "items": [{ "time": 1790888400, "open": 0.05, "high": 0.05, "low": 0.05, "close": 0.05, "volume": "1000000000", "quote_volume": "50000000", "trades": 1 }], "next_cursor": null })),
                "400": error_response("Bad interval", "invalid_interval", "interval must be one of 1m, 5m, 15m, 1h, 4h, 1d, 1w")
            }
        }},
        "/api/quote": { "get": {
            "operationId": "getQuote",
            "summary": "Route a swap through whole offers (greedy, best price first)",
            "description": "Candidate offers give `buy` and want `sell`, sorted by the taker's cost per unit bought. Each is taken if it fits in what remains of `amount` (sell units for exact_in, buy units for exact_out), else skipped; at most 50 offers. Never exceeds `amount`; the remainder is `unfilled`. Network fees are not included.",
            "parameters": [
                { "name": "sell", "in": "query", "required": true, "schema": schema_ref("Hex32"), "example": POLICY },
                { "name": "buy", "in": "query", "required": true, "schema": schema_ref("Hex32"), "example": ASSET },
                { "name": "amount", "in": "query", "required": true, "schema": schema_ref("Amount"), "example": "50000000" },
                { "name": "side", "in": "query", "required": false, "schema": { "type": "string", "enum": ["exact_in", "exact_out"], "default": "exact_in" } }
            ],
            "responses": {
                "200": ok("Quote", schema_ref("Quote"), json!({ "side": "exact_in", "sell_asset": POLICY, "buy_asset": ASSET, "amount": "50000000", "base": ASSET, "quote": POLICY, "offers": [example_offer_entry()], "sell_amount": "50000000", "buy_amount": "1000000000", "price": 0.05, "price_impact_bps": 0, "unfilled": "0" })),
                "400": error_response("Bad parameters", "invalid_amount", "amount must be a positive decimal string of atomic units")
            }
        }},
        "/api/offers": {
            "get": {
                "operationId": "listMakerOffers",
                "summary": "A maker's open offers, newest first",
                "description": "Matches offers whose receive output or offered UTXO pays the address's P2WPKH script (any HRP).",
                "parameters": [
                    { "name": "maker", "in": "query", "required": true, "schema": { "type": "string" }, "example": "elements1qn04gjfjfcdr2ekpurzadgu46uqvk6wrrq7x0kl" },
                    param_ref("Limit"), param_ref("Cursor")
                ],
                "responses": {
                    "200": ok("Page of offers", page_of("OfferEntry"), json!({ "items": [example_offer_entry()], "next_cursor": null })),
                    "400": error_response("Bad address", "invalid_address", "only unconfidential P2WPKH addresses are supported")
                }
            },
            "post": {
                "operationId": "postOffer",
                "summary": "List a signed swap offer",
                "description": "Validates the offer tx, fetches and txid-checks the funding tx, verifies the 0x83 signature against the segwit v0 sighash, checks the UTXO is unspent and the network matches, then stores it. Fills/cancels are detected on-chain by the monitor (~5 s).",
                "parameters": [param_ref("IdempotencyKey")],
                "requestBody": { "required": true, "content": json_content(schema_ref("Offer"), example_offer()) },
                "responses": {
                    "201": ok("Listed", schema_ref("OfferEntry"), example_offer_entry()),
                    "400": error_response("Invalid offer", "bad_signature", "signature does not verify"),
                    "409": error_response("Already listed", "duplicate_offer", "an offer for this output is already listed"),
                    "413": error_response("Body too large", "payload_too_large", "request body too large"),
                    "422": error_response("Idempotency key reused", "idempotency_key_reused", "this Idempotency-Key was already used with a different request body"),
                    "502": error_response("Explorer failure", "upstream_error", "the block explorer request failed")
                }
            }
        },
        "/api/offers/{txid}/{vout}": { "get": {
            "operationId": "getOffer",
            "summary": "One offer by outpoint, any status",
            "parameters": [
                { "name": "txid", "in": "path", "required": true, "schema": schema_ref("Hex32"), "example": TXID },
                { "name": "vout", "in": "path", "required": true, "schema": { "type": "integer", "minimum": 0 }, "example": 2 }
            ],
            "responses": {
                "200": ok("Offer", schema_ref("OfferEntry"), example_offer_entry()),
                "404": error_response("Unknown", "offer_not_found", "offer not found")
            }
        }}
    })
}

pub fn document() -> Value {
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "Elements+ DEX API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Order book and verified asset registry for explicit (non-confidential) swap offers on Elements+ (ECX Alpha). The server holds no keys; offers are signed by the maker's wallet and taken by any wallet. Amounts are decimal strings of atomic units. Errors are `{error:{code,message}}`."
        },
        "servers": [{ "url": "/" }],
        "paths": paths(),
        "components": {
            "schemas": schemas(),
            "parameters": parameters()
        }
    })
}

pub fn llms_txt(network: &Network) -> String {
    format!(
        "# Elements+ DEX

> Order book for explicit (non-confidential) atomic swaps on Elements+ ({name}).
> The server never holds keys. Makers sign offers in their wallet; anyone can take them.

Chain: network={name} genesis_hash={genesis} policy_asset={policy} (ECX, 8 decimals)
API reference (OpenAPI 3.1): /api/openapi.json
Offer format: SPEC.md section 2 (elementsplus-dex repo)

## Conventions
- Amounts are decimal strings of atomic units (\"2500000\"), never floats.
- Market = (base, quote); quote is the policy asset unless both are non-native
  (then lexicographic by asset id). price = quote atomic per base atomic.
- Errors: {{\"error\": {{\"code\": \"offer_spent\", \"message\": \"...\"}}}} with stable snake_case codes.
- Lists: ?limit=&cursor= -> {{\"items\": [...], \"next_cursor\": \"...\"|null}}.
- POSTs accept an Idempotency-Key header (24 h replay of successful responses).

## Discover
GET /api/health                              -> tip and chain parameters
GET /api/assets, /api/assets/{{asset_id}}       -> verified token metadata (name, ticker, precision)
GET /api/markets                             -> pairs, last price, 24 h volume, best bid/ask
GET /api/markets/{{base}}/{{quote}}/book         -> open offers (bids high->low, asks low->high)
GET /api/markets/{{base}}/{{quote}}/trades|candles

## Take (swap)
1. GET /api/quote?sell=<asset>&buy=<asset>&amount=<atomic>&side=exact_in|exact_out
   -> whole offers to take, totals, price impact, unfilled remainder.
2. Pass each returned entry's `offer` to the wallet (ep_takeSwapOffers, or `epw swap`).
   The wallet builds one tx: maker input/output pairs first, then taker inputs/outputs, fee last.
3. The server notices the spend within ~5 s and records the trade.

## Make (limit order)
1. Wallet signs an offer (ep_makeSwapOffer): one UTXO in, one output paying the maker
   `want`, signed SIGHASH_SINGLE|ANYONECANPAY (0x83). Whole-UTXO only, no partial fills.
2. POST /api/offers with the offer JSON. The server verifies the signature, funding tx
   and unspent status, then lists it.
3. Cancel by spending the UTXO back to yourself (ep_cancelSwapOffer); the server marks it cancelled.
   GET /api/offers?maker=<address> lists your open offers.

## Launch a token
Issue with the wallet (ep_issueAsset), then POST /api/assets {{issuance_txid, vin, contract}}.
The contract {{name, ticker, precision, version: 0}} is committed via SHA256 of its canonical
(sorted-key, no-whitespace) JSON in the issuance input.
",
        name = network.name,
        genesis = network.genesis_hash,
        policy = network.policy_asset,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ROUTES;

    #[test]
    fn every_route_is_documented_and_nothing_else() {
        let doc = document();
        let paths = doc["paths"].as_object().unwrap();
        for (method, path) in ROUTES {
            let operation = &paths
                .get(*path)
                .unwrap_or_else(|| panic!("{path} missing from OpenAPI"))[*method];
            assert!(
                operation.is_object(),
                "{method} {path} missing from OpenAPI"
            );
            assert!(
                operation["responses"].is_object(),
                "{method} {path} has no responses"
            );
        }
        for (path, item) in paths {
            for method in item
                .as_object()
                .unwrap()
                .keys()
                .filter(|key| *key != "parameters")
            {
                assert!(
                    ROUTES.contains(&(method.as_str(), path.as_str())),
                    "OpenAPI documents unrouted {method} {path}"
                );
            }
        }
    }

    #[test]
    fn refs_resolve() {
        let doc = document();
        let text = doc.to_string();
        for part in text.split("\"$ref\":\"#/components/").skip(1) {
            let reference = part.split('"').next().unwrap();
            let (kind, name) = reference.split_once('/').unwrap();
            assert!(
                doc["components"][kind][name].is_object(),
                "dangling $ref {reference}"
            );
        }
        assert_eq!(doc["openapi"], "3.1.0");
    }
}
