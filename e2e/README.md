# Full-product e2e (regtest)

`run.mjs` drives two real Chrome profiles (Maker, Taker) with the regtest build
of the Elements+ wallet extension, the DEX web app and the DEX server on a live
Elements+ regtest chain. Raw CDP over a pipe (no browser download, no npm
dependencies); the extension is loaded with `Extensions.loadUnpacked` because
branded Chrome ignores `--load-extension`. Runs `--headless=new`
(`E2E_HEADED=1` for a visible browser).

Scenario: onboard two new wallets in the extension UI → fund from `miner` →
Maker launches + lists a token on Launch → Taker fills it on Swap → Maker
places and cancels a limit sell on Markets → Maker sends tokens from the wallet
Send screen. Every signature is approved in the extension's approval window.

Prerequisites (not started by the test): the regtest node with a funded
`miner` wallet, the Esplora bridge on 43199, the DEX server on 8790, and the
regtest extension built in the wallet repo (`node scripts/build-regtest.mjs`).
The test starts the Vite dev server on 5173 if nothing is serving there.

```sh
source ~/.nvm/nvm.sh
E2E_OUT=/tmp/dex-e2e node run.mjs
```

| Variable | Default |
|---|---|
| `WALLET_REPO` | `../../elementsplus-wallet-extension` |
| `EXTENSION_DIST` | `$WALLET_REPO/.regtest/dist/chromium` |
| `ELEMENTS_CLI` / `ELEMENTS_DATADIR` / `ELEMENTS_RPC_PORT` | wallet repo's functional-test CLI, `.regtest/node`, `18884` |
| `DEX_API` / `DEX_WEB` / `ESPLORA_URL` | `http://127.0.0.1:8790/api`, `http://127.0.0.1:5173`, `http://127.0.0.1:43199/api` |
| `CHROME_BIN` | `/usr/bin/google-chrome` |
| `E2E_OUT` | `$TMPDIR/elementsplus-dex-e2e` (screenshots, `results.json`, console logs) |
| `E2E_KEEP_PROFILES=1` | keep the temporary Chrome profiles |
