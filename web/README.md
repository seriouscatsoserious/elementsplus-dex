# E+ Swap — web

Vite + React + TypeScript frontend for the Elements+ DEX (ECX Alpha): **Swap**,
**Markets** (chart, order book, limit/market orders, open orders, trades) and
**Launch** (issue a token, register it, optionally list it). Contract: `../SPEC.md`
§2 (offers), §3.3 (wallet provider), §4.1 / §6.1 (server API).

```sh
source ~/.nvm/nvm.sh      # Node 24
npm install
npm run dev               # http://localhost:5173, proxies /api + /llms.txt → http://127.0.0.1:8790
npm run dev:mock          # no server, no extension: mock API + mock wallet
npm test                  # vitest unit tests
npm run typecheck
npm run build             # typecheck + production bundle in dist/
```

## Configuration (env, all optional)

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `/api` | DEX server API base (absolute URL allowed) |
| `DEX_SERVER` | `http://127.0.0.1:8790` | dev/preview proxy target (not bundled) |
| `VITE_POLICY_ASSET` | — | pin the ECX asset id; otherwise `/api/health` → wallet `ep_connect` → most common quote |
| `VITE_EXPLORER_URL` | — | Esplora base for tx links in toasts (`…/tx/<txid>`) |
| `VITE_WALLET_INSTALL_URL` | GitHub repo | "Install wallet" link |
| `VITE_NETWORK_LABEL` | `ECX Alpha` | network pill text before a wallet connects |
| `VITE_MOCK_API=1` | off | serve the API from an in-memory mock (`src/lib/mock/`) |
| `VITE_MOCK_WALLET=1` | off | inject a mock `window.elementsplus` (`src/lib/mockWallet.ts`) |

Mock-only URL flags: `?wallet=none|disconnected|locked|reject`, `?api=down|empty`.
Mock code is loaded via dynamic import behind literal env checks, so production
builds don't contain it.

## Screenshots

```sh
VITE_MOCK_WALLET=1 VITE_MOCK_API=1 npx vite --port 5199 &
BASE_URL=http://127.0.0.1:5199 OUT=/tmp/screens CHROME=/usr/bin/google-chrome npm run screenshots
```

Uses `playwright-core` with a system Chrome/Chromium (no browser download).

## Layout

- `src/lib/amount.ts` — decimal ↔ atomic BigInt, BigInt rational prices. No floats for amounts
  (floats only feed the chart).
- `src/lib/api.ts` — typed client + defensive parsers for every endpoint; errors as
  `ApiError` (`code` from `{ error: { code, message } }`) / `ApiUnavailableError`.
- `src/lib/route.ts` — whole-offer greedy routing (cheapest first, stop before exceeding).
  The live app routes server-side via `GET /api/quote`; this is the mock implementation
  and the reference the tests pin down. Also fee estimates.
- `src/lib/wallet.ts` — `window.elementsplus` wrapper, detection, error mapping.
- `src/state/` — wallet / DEX data / toast React contexts.
- `src/pages/` — Swap, Markets, Launch.

## Behaviour notes

- Prices from the server are quote-atomic per base-atomic (numbers or strings); the UI
  scales by precision. Book prices are recomputed exactly from offer amounts.
- `change_24h` is a fraction (0.042 = +4.2%); candle `volume` is base atomic units.
- Swap re-quotes right before calling `ep_takeSwapOffers` and aborts if the result is
  worse than the slippage bound (offers themselves are fixed-price).
- Your open orders = `GET /api/offers?maker=<address>` merged with offers this browser
  created (localStorage) that are still on the book, because the wallet may pay maker
  legs to fresh addresses.
