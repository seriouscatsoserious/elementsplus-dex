# Elements+ DEX

Non-custodial order-book DEX and token launchpad for ECX Alpha (Elements+).
Swaps are LiquiDEX-style atomic swaps: makers sign `SINGLE|ANYONECANPAY`
offers, takers complete them in one transaction. The server only relays
signed offers and indexes trades; it never holds keys.

- `server/`: Rust API (offers, order book, trades, asset registry)
- `web/`: React app (Swap, Markets, Launch)
- `preconf/`: preconfirmation code moved from the wallet, parked
- `SPEC.md`: shared contract with the wallet (`window.elementsplus` provider, offer format)

Work in progress.
