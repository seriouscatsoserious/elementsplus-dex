# Preconfirmations (parked)

Moved here from `elementsplus-wallet-extension` (handoff commit `ae707aa`). It is
not wired into the DEX yet.

Preconfirmations are **not** part of Elements+ consensus. The chain provides
Simplicity covenants. This code adds an off-chain operator that promises a
transaction will be mined and backs that promise with a bonded covenant that
can be slashed. It needs an operator, relays and a watchtower to be meaningful.
See `docs/PRECONFIRMATIONS.md` and `vendor/elementsplus-preconf/OPERATOR-RELAY.md`.

Layout (paths as they were in the wallet repo):

- `services/preconfer-signer/`: operator service (Rust)
- `vendor/elementsplus-preconf/`: bond covenant, receipt verification, relays
- `src/preconf/`: browser receipt client formerly used by the wallet

Before this is enabled for DEX trades, these are still open (from the
2026-10-01 handoff): an automatic watchtower/slashing broadcaster, adversarial
funded tests, and independent bond-state validation.
