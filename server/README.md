# elementsplus-dex-server

Order book, trade history and verified asset registry for the Elements+
(ECX Alpha) DEX. Explicit (non-confidential) outputs only. The server holds no
keys and never signs: makers sign swap offers in their wallet
(`SIGHASH_SINGLE|ANYONECANPAY`), the server verifies and lists them, and a
background monitor watches the chain to record fills and cancellations.

Contract: `../SPEC.md` §1.2 (verification algorithms), §2 (offer format),
§4.1 and §6.1 (endpoints). Machine-readable reference: `GET /api/openapi.json`;
agent guide: `GET /llms.txt`.

## Run

Toolchain is pinned by `rust-toolchain.toml` (Rust 1.89).

```sh
cd server
cargo run --release
```

Against the local regtest node + Esplora bridge (`npm run regtest:start` in the
wallet repo):

```sh
ESPLORA_URL=http://127.0.0.1:43199/api \
GENESIS_HASH=<regtest genesis> POLICY_ASSET=<regtest pegged asset> \
ADDRESS_HRP=ert DB_PATH=./dex-regtest.sqlite3 \
cargo run
```

| Variable | Default | Meaning |
|---|---|---|
| `ESPLORA_URL` | `http://127.0.0.1:43199/api` | Esplora-compatible API base (needs `/tx/:txid/hex`, `/tx/:txid/status`, `/tx/:txid/outspend/:vout`, `/blocks/tip/height`) |
| `LISTEN` | `127.0.0.1:8790` | Bind address |
| `DB_PATH` | `dex.sqlite3` | SQLite file (created on start) |
| `GENESIS_HASH` | ECX Alpha genesis | Offers must carry this `genesis_hash` |
| `POLICY_ASSET` | ECX Alpha policy asset | Quote asset of native markets |
| `NETWORK_NAME` | `ecx-alpha` | Offers must carry this `network` |
| `ADDRESS_HRP` | `elements` | HRP used to render `maker_address` (`ert` on stock regtest) |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma list; `*` = any; empty = no CORS |
| `MONITOR_INTERVAL_SECS` | `5` | Offer monitor period |
| `RUST_LOG` / `LOG_FORMAT=json` | `info` | tracing filter / JSON logs |

## Endpoints (summary)

| Method & path | Notes |
|---|---|
| `GET /api/health` | `{ok, tip, network, genesis_hash, policy_asset}` (503 if the explorer is down) |
| `GET /api/openapi.json`, `GET /llms.txt` | API reference / agent guide |
| `GET /api/assets` · `GET /api/assets/{id}` · `POST /api/assets` | Verified registry; POST `{issuance_txid, vin, contract}` |
| `GET /api/markets` | Pairs with an open offer or a trade |
| `GET /api/markets/{base}/{quote}/book` | `{base, quote, bids, asks}`; `limit` per side |
| `GET /api/markets/{base}/{quote}/trades` | Fills, newest first |
| `GET /api/markets/{base}/{quote}/candles?interval=1h` | OHLCV, oldest first |
| `GET /api/quote?sell=&buy=&amount=&side=exact_in\|exact_out` | Whole-offer greedy routing |
| `POST /api/offers` · `GET /api/offers?maker=<addr>` · `GET /api/offers/{txid}/{vout}` | List / a maker's open offers / one offer |

Conventions: amounts are decimal strings of atomic units; prices are numbers in
quote-atomic per base-atomic (plus exact `price_num`/`price_den`). Lists return
`{items, next_cursor}` and accept `?limit=` (1-500, default 100) and
`?cursor=`. Errors are `{"error": {"code", "message"}}` with stable snake_case
codes. POSTs accept `Idempotency-Key` (successful responses replayed for 24 h,
`Idempotent-Replayed: true`). Request bodies are capped at 64 KiB.

## Development

```sh
cargo test                                  # unit + mocked-Esplora integration tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

Test fixtures (`tests/common/mod.rs`) build real signed offers and issuance
transactions with the `elements` crate and throwaway keys; they are compiled
only into tests.
